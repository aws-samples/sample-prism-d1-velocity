/**
 * `prism-cli enable codeburn`: install codeburn if missing, connect its sync to
 * the PRISM OTEL collector, and schedule `codeburn sync push`.
 *
 * This is the former `bootstrapper setup-otel-sync` (now a deprecated alias),
 * with three additions: it installs codeburn after a confirmation, `--dry-run`
 * prints the plan, and a re-run reports what is already in place instead of
 * prompting again.
 */
import { createInterface } from 'node:readline';
import { platform, homedir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { run, runInteractive, type RunResult } from '../../utils/exec.js';
import { withPrivateTemp } from '../../utils/tempfile.js';
import {
  CRON_MARKER, PLIST_LABEL, SCHTASK_NAME, otelLogDir, otelLogFile, codeburnSyncConfigPath,
  linuxCrontabAvailable, crontabLines, darwinPlistPath, scheduleExists, schedulerName,
  CODEBURN_INSTALL_ARGS, ENABLE_CODEBURN_CMD, SYNC_SINCE, syncArgs,
} from '../../utils/otel-sync-schedule.js';
import { runGuarded } from './security.js';

// ---- Constants ----

// Marker, label and task name are shared with the dashboard's setup check.
const LOG_DIR = otelLogDir();

/** Exact install command, printed before it runs and in every hint. */
export const INSTALL_CMD = `npm ${CODEBURN_INSTALL_ARGS.join(' ')}`;

/** Oldest codeburn with `sync push --attribution`. */
const MIN_CODEBURN = [0, 9, 16];

/** Window of the one-time backfill on first setup (the server keeps >14d in DDB/S3). */
const BACKFILL_SINCE = '30d';

// ---- Scheduler helpers per OS ----

export function getCodeburnPath(): string | null {
  const result = platform() === 'win32'
    ? run('where', ['codeburn'])
    : run('which', ['codeburn']);
  return result.ok ? result.stdout.split('\n')[0].trim() : null;
}

// ---- Linux: user crontab ----

/**
 * Single-quotes a value for the crontab line.
 *
 * A crontab entry is interpreted by /bin/sh, so unlike our argv call sites
 * this one genuinely does need quoting -- the shell is the scheduler's, not
 * ours, and we cannot pass it argv. Wrapping in single quotes and encoding any
 * embedded single quote as '\'' is the only form with no escape sequences to
 * get wrong. Paths under a home directory containing a space would otherwise
 * split into two arguments.
 */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function linuxInstallSchedule(codeburnPath: string, intervalHours: number): boolean {
  if (!linuxCrontabAvailable()) {
    console.warn('\n⚠️  crontab not found — skipping automatic schedule installation.');
    console.warn('   Run "codeburn sync push --since 7d" manually, or install cronie:');
    console.warn('   sudo yum install cronie -y  # then re-run this command\n');
    return false;
  }
  const lines = crontabLines(run('crontab', ['-l'])).filter(l => !l.includes(CRON_MARKER));
  const logFile = join(LOG_DIR, 'otel-sync.log');
  const cronExpr = `0 */${intervalHours} * * *`;
  const command = [shQuote(codeburnPath), ...syncArgs(SYNC_SINCE)].join(' ');
  lines.push(`${CRON_MARKER}`);
  lines.push(`${cronExpr} ${command} >> ${shQuote(logFile)} 2>&1`);
  const result = withPrivateTemp('crontab', lines.join('\n') + '\n', f => run('crontab', [f]));
  if (!result.ok) throw new Error(`Failed to install crontab: ${result.stderr}`);
  return true;
}

function linuxRemoveSchedule(): void {
  if (!linuxCrontabAvailable()) return;
  const existing = run('crontab', ['-l']);
  if (!existing.ok) return;
  const lines = existing.stdout.split('\n').filter(l => !l.includes(CRON_MARKER) && !l.includes('codeburn sync push'));
  withPrivateTemp('crontab', lines.join('\n') + '\n', f => run('crontab', [f]));
}

// ---- macOS: LaunchAgent ----

/**
 * Escapes a value for use inside a plist <string> element.
 *
 * The plist is generated XML, so a path containing `&` or `<` -- both legal in
 * macOS filenames -- would otherwise produce a malformed document that
 * launchctl refuses to load, reported only as a generic load failure.
 */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function darwinInstallSchedule(codeburnPath: string, intervalHours: number): void {
  const logFile = join(LOG_DIR, 'otel-sync.log');
  const argElements = [codeburnPath, ...syncArgs(SYNC_SINCE)]
    .map(a => `    <string>${xmlEscape(a)}</string>`)
    .join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argElements}
  </array>
  <key>StartInterval</key>
  <integer>${intervalHours * 3600}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;
  const plistPath = darwinPlistPath();
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(plistPath, plist);
  // Unload first so a reinstall replaces rather than conflicts. A missing
  // agent makes this fail, which is expected and ignored -- run() captures
  // stderr rather than leaking it, so no shell redirect is needed.
  run('launchctl', ['unload', plistPath]);
  const result = run('launchctl', ['load', plistPath]);
  if (!result.ok) throw new Error(`Failed to load LaunchAgent: ${result.stderr}`);
}

function darwinRemoveSchedule(): void {
  const plistPath = darwinPlistPath();
  if (existsSync(plistPath)) {
    run('launchctl', ['unload', plistPath]);
    unlinkSync(plistPath);
  }
}

// ---- Windows: schtasks ----

/** Path of the generated batch wrapper the scheduled task invokes. */
function windowsWrapperPath(): string {
  return join(homedir(), '.prism', 'otel-sync.cmd');
}

/**
 * Installs the Windows scheduled task via a generated .cmd wrapper.
 *
 * The previous version nested the whole command inside schtasks' /tr argument:
 *
 *   /tr "cmd /c <codeburnPath> sync push ... >> "<logFile>" 2>&1"
 *
 * and tried to make that legal with cmd.replace(/"/g, '\\"'). That is three
 * quoting layers deep -- our shell, schtasks' own /tr parser, then cmd.exe --
 * and the replacement handled exactly one metacharacter of one of them. It did
 * not escape backslashes, which is not a corner case on Windows: every path
 * here is backslash-separated, so a trailing separator turns the closing \"
 * into an escaped quote and unbalances the argument. cmd.exe also does not
 * treat \" the way that replacement assumes, so the escaping was aimed at the
 * wrong grammar to begin with.
 *
 * Writing the command to a file removes every one of those layers. The task
 * runs one fixed argument -- the wrapper path -- and the redirection lives in
 * a batch file where it needs no escaping at all. This also sidesteps the
 * documented 261-character limit on /tr, which the inlined form could exceed
 * with a long install path.
 */
function windowsInstallSchedule(codeburnPath: string, intervalHours: number): void {
  const logFile = join(LOG_DIR, 'otel-sync.log');
  const args = syncArgs(SYNC_SINCE).join(' ');
  const wrapper = [
    '@echo off',
    'REM Generated by prism-cli enable codeburn. Do not edit.',
    `"${codeburnPath}" ${args} >> "${logFile}" 2>&1`,
    '',
  ].join('\r\n');

  mkdirSync(join(homedir(), '.prism'), { recursive: true });
  writeFileSync(windowsWrapperPath(), wrapper);

  const result = run('schtasks', [
    '/create',
    '/tn', SCHTASK_NAME,
    '/sc', 'hourly',
    '/mo', String(intervalHours),
    '/tr', windowsWrapperPath(),
    '/f',
  ]);
  if (!result.ok) throw new Error(`Failed to create scheduled task: ${result.stderr}`);
}

function windowsRemoveSchedule(): void {
  run('schtasks', ['/delete', '/tn', SCHTASK_NAME, '/f']);
  const wrapper = windowsWrapperPath();
  if (existsSync(wrapper)) unlinkSync(wrapper);
}

// ---- Unified scheduler interface ----

function installSchedule(codeburnPath: string, intervalHours: number): boolean {
  mkdirSync(LOG_DIR, { recursive: true });
  switch (platform()) {
    case 'darwin': darwinInstallSchedule(codeburnPath, intervalHours); return true;
    case 'win32': windowsInstallSchedule(codeburnPath, intervalHours); return true;
    default: return linuxInstallSchedule(codeburnPath, intervalHours);
  }
}

function removeSchedule(): void {
  switch (platform()) {
    case 'darwin': return darwinRemoveSchedule();
    case 'win32': return windowsRemoveSchedule();
    default: return linuxRemoveSchedule();
  }
}

// ---- Dependencies (faked in tests) ----

export interface CodeburnDeps {
  run: (file: string, args: string[]) => RunResult;
  runInteractive: (file: string, args: string[]) => boolean;
  findCodeburn: () => string | null;
  home: string;
  isTTY: boolean;
  ask: (question: string) => Promise<string>;
  log: (line?: string) => void;
  error: (line: string) => void;
  scheduleExists: () => boolean;
  schedulerName: () => string;
  installSchedule: (codeburnPath: string, intervalHours: number) => boolean;
  removeSchedule: () => void;
}

export function defaultDeps(): CodeburnDeps {
  return {
    run,
    runInteractive,
    findCodeburn: getCodeburnPath,
    home: homedir(),
    isTTY: !!(process.stdin.isTTY && process.stdout.isTTY),
    ask: (q) => new Promise((done) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(q, (a) => { rl.close(); done(a.trim()); });
    }),
    log: (line = '') => console.log(line),
    error: (line) => console.error(line),
    scheduleExists,
    schedulerName,
    installSchedule,
    removeSchedule,
  };
}

/** The sync endpoint codeburn has stored, or null when sync is not set up. '' when the file is unreadable. */
export function configuredSyncUrl(home: string): string | null {
  const configPath = codeburnSyncConfigPath(home);
  if (!existsSync(configPath)) return null;
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    return String(cfg.baseUrl || cfg.endpoint || cfg.url || '');
  } catch {
    return '';
  }
}

/** True when `version` (e.g. "0.9.24") is at least MIN_CODEBURN. */
export function codeburnVersionOk(version: string): boolean {
  const parts = version.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < MIN_CODEBURN.length; i++) {
    if ((parts[i] ?? 0) !== MIN_CODEBURN[i]) return (parts[i] ?? 0) > MIN_CODEBURN[i];
  }
  return true;
}

function isHttpUrl(value: string): boolean {
  try {
    const p = new URL(value).protocol;
    return p === 'https:' || p === 'http:';
  } catch {
    return false;
  }
}

const yes = (answer: string) => ['y', 'yes'].includes(answer.trim().toLowerCase());
const cmdLine = (args: string[]) => `codeburn ${args.join(' ')}`;

/** Prints `codeburn sync status`, indented. Non-fatal: a failure is one warning line. */
function reportSyncStatus(cb: string, d: CodeburnDeps): void {
  const r = d.run(cb, ['sync', 'status']);
  const text = (r.ok ? r.stdout : r.stderr).split('\n').filter(Boolean);
  d.log(r.ok ? '  codeburn sync status:' : '  ⚠ codeburn sync status failed:');
  for (const line of text.slice(0, 20)) d.log(`    ${line}`);
}

/** Whether the schedule exists, or the error when that cannot be told (an unreadable crontab). */
function probeSchedule(d: CodeburnDeps): boolean | Error {
  try {
    return d.scheduleExists();
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

// ---- Status ----

function showStatus(d: CodeburnDeps): void {
  const codeburnPath = d.findCodeburn();
  d.log('\n📊 OTEL Sync Status\n');

  if (codeburnPath) {
    d.log(`  ✓ codeburn found: ${codeburnPath}`);
    const ver = d.run(codeburnPath, ['--version']);
    if (ver.ok) d.log(`    version: ${ver.stdout}`);
  } else {
    d.log(`  ✗ codeburn not found in PATH (run ${ENABLE_CODEBURN_CMD})`);
  }

  const url = configuredSyncUrl(d.home);
  if (url === null) d.log(`  ✗ sync not configured (run ${ENABLE_CODEBURN_CMD})`);
  else if (url) d.log(`  ✓ sync configured: ${url}`);
  else d.log(`  ✓ sync config exists: ${codeburnSyncConfigPath(d.home)}`);

  const schedule = probeSchedule(d);
  if (schedule instanceof Error) d.log(`  ⚠ ${schedule.message}`);
  else if (schedule) d.log(`  ✓ ${d.schedulerName()} schedule active`);
  else d.log(`  ✗ no ${d.schedulerName()} schedule found`);

  const logFile = otelLogFile(d.home);
  if (existsSync(logFile)) {
    // Read in process rather than shelling out to tail, which does not exist
    // on Windows -- the platform this command explicitly supports.
    const tail = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-5);
    if (tail.length) {
      d.log(`  Last sync output (${logFile}):`);
      for (const line of tail) d.log(`    ${line}`);
    }
  }
  if (codeburnPath) reportSyncStatus(codeburnPath, d);
  d.log('');
}

// ---- Main ----

export interface CodeburnOptions {
  url?: string;
  interval?: string;
  status?: boolean;
  remove?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

/**
 * Step 1: codeburn on PATH, installing it after a confirmation when missing.
 * Returns its path, `null` on a dry run without it, or an exit code on refusal.
 */
async function ensureCodeburn(opts: CodeburnOptions, d: CodeburnDeps): Promise<string | null | number> {
  const found = d.findCodeburn();
  if (found) {
    d.log(`  ✓ codeburn installed: ${found}`);
    return found;
  }
  d.log('  ✗ codeburn is not installed.');
  if (opts.dryRun) {
    d.log(`  → would run: ${INSTALL_CMD}`);
    return null;
  }
  if (!opts.yes) {
    if (!d.isTTY) {
      d.error(`Error: codeburn is not installed and there is no terminal to confirm the install.`);
      d.error(`  Run "${INSTALL_CMD}" yourself, or re-run with --yes.`);
      return 1;
    }
    if (!yes(await d.ask(`  Install it now with "${INSTALL_CMD}"? [y/N] `))) {
      d.error(`Not installed. Run "${INSTALL_CMD}" yourself, then re-run ${ENABLE_CODEBURN_CMD}.`);
      return 1;
    }
  }
  d.log(`  Running: ${INSTALL_CMD}`);
  // shortcut: argv `npm` does not resolve npm.cmd on Windows, so the install
  // fails there and the hint below asks the user to run it; add a shell-free
  // npm.cmd path if Windows users hit this often.
  if (!d.runInteractive('npm', CODEBURN_INSTALL_ARGS)) {
    d.error(`Error: "${INSTALL_CMD}" failed. Run it yourself, then re-run ${ENABLE_CODEBURN_CMD}.`);
    return 1;
  }
  const installed = d.findCodeburn();
  if (!installed) {
    d.error('Error: codeburn was installed but is not on PATH. Add the directory from "npm prefix -g" (its bin/) to PATH, then re-run.');
    return 1;
  }
  d.log(`  ✓ codeburn installed: ${installed}`);
  return installed;
}

/**
 * The setup flow. Returns the exit code; every change is skipped on --dry-run,
 * which prints each step it would take with the exact command.
 */
export async function enableCodeburn(opts: CodeburnOptions, d: CodeburnDeps): Promise<number> {
  if (opts.status) {
    showStatus(d);
    return 0;
  }

  if (opts.remove) {
    if (!d.scheduleExists()) {
      d.log(`\n  No ${d.schedulerName()} schedule found — nothing to remove.\n`);
    } else if (opts.dryRun) {
      d.log(`\n  → would remove the ${d.schedulerName()} schedule.\n`);
    } else {
      d.removeSchedule();
      d.log(`\n  ✓ ${d.schedulerName()} schedule removed.\n`);
    }
    return 0;
  }

  const dry = !!opts.dryRun;
  const intervalHours = opts.interval ? parseInt(opts.interval, 10) : 12;
  if (isNaN(intervalHours) || intervalHours < 1) {
    d.error('Error: --interval must be a positive integer (hours).');
    return 1;
  }

  d.log(dry ? '\n🔄 enable codeburn — dry run, nothing is changed\n' : '\n🔄 enable codeburn\n');

  // 1. codeburn installed, and new enough for --attribution
  const ensured = await ensureCodeburn(opts, d);
  if (typeof ensured === 'number') return ensured;
  const cb = ensured;
  if (cb) {
    const ver = d.run(cb, ['--version']);
    if (ver.ok) {
      const v = ver.stdout.replace(/[^0-9.]/g, '');
      if (!codeburnVersionOk(v)) {
        d.error(`Error: codeburn >= ${MIN_CODEBURN.join('.')} required (found ${v}). Run: npm update -g codeburn`);
        return 1;
      }
      d.log(`  ✓ codeburn ${v}`);
    }
  }
  const bin = cb || 'codeburn';

  // 2. The OTEL collector URL: --url, else the one codeburn already syncs to, else ask.
  const existingUrl = configuredSyncUrl(d.home);
  let otelUrl = opts.url || existingUrl || '';
  if (!otelUrl) {
    if (dry) {
      d.log('  → would ask for the OTEL collector URL (pass --url <OtelCollectorUrl> to skip)');
    } else {
      otelUrl = await d.ask('  OTEL collector URL (from CDK deploy output OtelCollectorUrl): ');
      if (!otelUrl) {
        d.error('Error: OTEL collector URL is required. Pass --url <OtelCollectorUrl>.');
        return 1;
      }
    }
  }
  // Reject anything that is not a real http(s) URL before it is persisted
  // into codeburn's sync config, where a malformed value surfaces later as an
  // opaque push failure from the scheduled job rather than here.
  if (otelUrl && !isHttpUrl(otelUrl)) {
    d.error(`Error: "${otelUrl}" is not a valid http(s) URL.`);
    d.error('  Expected the OtelCollectorUrl value from the CDK stack outputs.');
    return 1;
  }
  const shownUrl = otelUrl || '<OtelCollectorUrl>';

  // 3. codeburn sync setup, unless already configured for this endpoint.
  let needsSetup = true;
  if (existingUrl && otelUrl && (existingUrl === otelUrl || existingUrl.startsWith(otelUrl))) {
    d.log(`  ✓ codeburn sync already configured for ${existingUrl}`);
    needsSetup = false;
  } else if (existingUrl && otelUrl) {
    d.log(`  ⚠ codeburn sync configured for a different endpoint: ${existingUrl}`);
    if (dry) {
      d.log('  → would ask whether to reconfigure it for the new URL (--yes reconfigures)');
    } else if (!opts.yes && !yes(await d.ask('  Reconfigure for the new URL? [y/N] '))) {
      d.log('  Keeping existing configuration.');
      needsSetup = false;
    }
  }
  const setupArgs = ['sync', 'setup', shownUrl];
  if (needsSetup) {
    if (dry) {
      d.log(`  → would run: ${cmdLine(setupArgs)} (opens a browser to sign in)`);
    } else {
      d.log(`\n  Running: ${cmdLine(setupArgs)}`);
      d.log('  (This will open a browser for OIDC authentication)\n');
      // argv, not a command string: otelUrl comes from the prompt or a flag.
      if (!d.runInteractive(bin, setupArgs)) {
        d.error('\n  ✗ codeburn sync setup failed. Ensure your Cognito user exists and try again.');
        return 1;
      }
      d.log('\n  ✓ codeburn sync configured.');
    }
  }

  // 4. One-time backfill, only when sync or the schedule is new: the push is
  // incremental, so a re-run of an installed setup has nothing to backfill.
  // An unreadable crontab stops the install here, before the backfill uploads anything.
  const schedule = probeSchedule(d);
  if (schedule instanceof Error && !dry) {
    d.error(`Error: ${schedule.message}`);
    return 1;
  }
  const hadSchedule = schedule === true;
  const sched = d.schedulerName();
  if (needsSetup || !hadSchedule) {
    const backfillArgs = syncArgs(BACKFILL_SINCE);
    if (dry) {
      d.log(`  → would run: ${cmdLine(backfillArgs)} (initial backfill)`);
    } else {
      d.log(`\n  Pushing initial backfill (last ${BACKFILL_SINCE} of telemetry)...`);
      const backfill = d.run(bin, backfillArgs);
      if (backfill.ok) {
        d.log('  ✓ Backfill push complete.');
        if (backfill.stdout) d.log(`    ${backfill.stdout.split('\n').slice(-1)[0]}`);
      } else {
        d.log(`  ⚠ Backfill push failed (non-fatal): ${backfill.stderr.split('\n')[0]}`);
        d.log(`    The schedule will retry. Check ${otelLogFile(d.home)}`);
      }
    }
  } else {
    d.log('  ✓ sync and schedule already in place; no backfill needed.');
  }

  // 5. OS schedule. An existing one is reinstalled so its command and interval
  // are current (an older Windows entry lacked --attribution).
  const pushCmd = cmdLine(syncArgs(SYNC_SINCE));
  let scheduled = true;
  if (dry && schedule instanceof Error) {
    d.log(`  ⚠ would not install the ${sched} schedule: ${schedule.message}`);
  } else if (dry) {
    d.log(`  → would ${hadSchedule ? 'refresh the existing' : 'install a'} ${sched} schedule: ${pushCmd}, every ${intervalHours}h`);
  } else {
    if (hadSchedule) {
      d.log(`  ✓ ${sched} schedule already installed — refreshing it.`);
      d.removeSchedule();
    }
    scheduled = d.installSchedule(bin, intervalHours);
    if (scheduled) d.log(`  ✓ ${sched} schedule installed (every ${intervalHours}h): ${pushCmd}`);
  }

  // 6. What codeburn itself reports.
  if (dry) {
    d.log('  → would run: codeburn sync status');
    d.log('\n  Dry run complete. Re-run without --dry-run to apply.\n');
    return 0;
  }
  d.log('');
  reportSyncStatus(bin, d);

  d.log('\n════════════════════════════════════════════════');
  d.log(needsSetup || !hadSchedule ? '  ✅ codeburn sync is set up.' : '  ✅ codeburn sync was already set up; nothing new to do.');
  d.log('════════════════════════════════════════════════');
  d.log(`\n  Endpoint:  ${otelUrl}`);
  d.log(scheduled
    ? `  Schedule:  every ${intervalHours}h via ${sched}`
    : `  Schedule:  ⚠  not installed (run manually: prism-cli export otel)`);
  d.log(`  Logs:      ${otelLogFile(d.home)}`);
  d.log(`\n  Run \`${ENABLE_CODEBURN_CMD} --status\` to check health.`);
  d.log(`  Run \`${ENABLE_CODEBURN_CMD} --remove\` to uninstall the schedule.`);
  d.log('  Run `prism-cli export otel` to push now.\n');
  return 0;
}

export const CODEBURN_OPTIONS = [
  { flags: '--url <url>', description: 'OTEL collector URL (from CDK deploy output OtelCollectorUrl; default: the URL codeburn already syncs to)' },
  { flags: '--interval <hours>', description: 'Sync interval in hours (default: 12)' },
  { flags: '--yes', description: `Install codeburn (${INSTALL_CMD}) and reconfigure a different endpoint without a prompt` },
  { flags: '--dry-run', description: 'Print the plan with the exact commands; change nothing' },
  { flags: '--status', description: 'Show codeburn, sync and schedule status' },
  { flags: '--remove', description: 'Remove the sync schedule' },
];

/** Test seams: everything else uses the real runners, console and process. */
export interface CodeburnHooks {
  deps?: () => CodeburnDeps;
  error?: (line: string) => void;
  exit?: (code: number) => void;
  env?: NodeJS.ProcessEnv;
}

/** The one entry point for `enable codeburn` and its `bootstrapper setup-otel-sync` alias. */
export async function runEnableCodeburn(opts: CodeburnOptions, hooks: CodeburnHooks = {}): Promise<void> {
  await runGuarded(() => enableCodeburn(opts, (hooks.deps ?? defaultDeps)()), hooks);
}

export default {
  description: 'Install codeburn and schedule its OTEL sync (pushes AI usage and commit attribution every 12h)',
  options: CODEBURN_OPTIONS,
  action: runEnableCodeburn,
};
