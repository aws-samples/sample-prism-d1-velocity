import { createInterface } from 'node:readline';
import { platform, homedir, tmpdir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run, runInteractive } from '../../utils/exec.js';

function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

// ---- Constants ----

const CRON_MARKER = '# prism-otel-sync';
const PLIST_LABEL = 'com.prism.otel-sync';
const SCHTASK_NAME = 'PrismOtelSync';
const LOG_DIR = join(homedir(), '.prism', 'logs');

/** Window the recurring sync pushes on every run. */
const SYNC_SINCE = '7d';

// ---- Scheduler helpers per OS ----

function getCodeburnPath(): string | null {
  const result = platform() === 'win32'
    ? run('where', ['codeburn'])
    : run('which', ['codeburn']);
  return result.ok ? result.stdout.split('\n')[0].trim() : null;
}

/**
 * The argv of the recurring sync, shared by every platform.
 *
 * This is the single source of truth on purpose. It previously existed only as
 * a Linux helper, and the Windows branch open-coded its own command string
 * that omitted --attribution. That silently reduced Windows machines to usage
 * telemetry with no commit attribution, so those developers counted toward the
 * Attribution Coverage denominator (CI sees their commits) while contributing
 * nothing to the numerator -- indistinguishable on the dashboard from someone
 * who never onboarded. Any new platform branch must call this.
 */
function syncArgs(since: string): string[] {
  return ['sync', 'push', '--since', since, '--attribution'];
}

// ---- Linux: user crontab ----

function linuxScheduleExists(): boolean {
  if (!linuxCrontabAvailable()) return false;
  const result = run('crontab', ['-l']);
  return result.ok && result.stdout.includes(CRON_MARKER);
}

function linuxCrontabAvailable(): boolean {
  return run('which', ['crontab']).ok;
}

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

/**
 * Writes `content` to a private temp file, passes its path to `use`, and always
 * removes the containing directory afterwards.
 *
 * mkdtemp gives a 0700 directory with an unpredictable name. The previous
 * fixed '/tmp/prism-crontab.tmp' let any local user pre-create or race that
 * path between our write and crontab's read, which would install arbitrary
 * entries into this user's crontab.
 *
 * The callback shape exists so the directory is reclaimed on every path. The
 * first version of this helper returned the path and left callers to unlink
 * only the file, which leaked one empty directory per install or remove, and
 * unlinked before throwing on failure so error paths leaked the file as well.
 */
function withPrivateTemp<T>(name: string, content: string, use: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'prism-'));
  try {
    const file = join(dir, name);
    writeFileSync(file, content, { mode: 0o600 });
    return use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function linuxInstallSchedule(codeburnPath: string, intervalHours: number): boolean {
  if (!linuxCrontabAvailable()) {
    console.warn('\n⚠️  crontab not found — skipping automatic schedule installation.');
    console.warn('   Run "codeburn sync push --since 7d" manually, or install cronie:');
    console.warn('   sudo yum install cronie -y  # then re-run this command\n');
    return false;
  }
  const existing = run('crontab', ['-l']);
  const lines = existing.ok ? existing.stdout.split('\n').filter(l => !l.includes(CRON_MARKER)) : [];
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

function darwinPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
}

function darwinScheduleExists(): boolean {
  return existsSync(darwinPlistPath());
}

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

function windowsScheduleExists(): boolean {
  const result = run('schtasks', ['/query', '/tn', SCHTASK_NAME, '/fo', 'CSV']);
  return result.ok;
}

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
    'REM Generated by prism-cli bootstrapper setup-otel-sync. Do not edit.',
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

function scheduleExists(): boolean {
  switch (platform()) {
    case 'darwin': return darwinScheduleExists();
    case 'win32': return windowsScheduleExists();
    default: return linuxScheduleExists();
  }
}

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

function schedulerName(): string {
  switch (platform()) {
    case 'darwin': return 'LaunchAgent';
    case 'win32': return 'Scheduled Task';
    default: return 'crontab';
  }
}

// ---- Status ----

function showStatus(codeburnPath: string | null): void {
  console.log('\n📊 OTEL Sync Status\n');

  // Codeburn installed?
  if (codeburnPath) {
    console.log(`  ✓ codeburn found: ${codeburnPath}`);
    const ver = run(codeburnPath, ['--version']);
    if (ver.ok) console.log(`    version: ${ver.stdout}`);
  } else {
    console.log('  ✗ codeburn not found in PATH');
  }

  // Sync configured?
  const configPath = join(homedir(), '.config', 'codeburn', 'sync.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      console.log(`  ✓ sync configured: ${cfg.baseUrl || cfg.endpoint || cfg.url || '(configured)'}`);
    } catch {
      console.log(`  ✓ sync config exists: ${configPath}`);
    }
  } else {
    console.log('  ✗ sync not configured (run setup first)');
  }

  // Schedule exists?
  if (scheduleExists()) {
    console.log(`  ✓ ${schedulerName()} schedule active`);
  } else {
    console.log(`  ✗ no ${schedulerName()} schedule found`);
  }

  // Last log?
  const logFile = join(LOG_DIR, 'otel-sync.log');
  if (existsSync(logFile)) {
    // Read in process rather than shelling out to tail, which does not exist
    // on Windows -- the platform this command explicitly supports. The old
    // `tail -5` silently produced no output there, making a working schedule
    // look like it had never run.
    const tail = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-5);
    if (tail.length) {
      console.log(`  Last sync output (${logFile}):`);
      for (const line of tail) {
        console.log(`    ${line}`);
      }
    }
  }
  console.log('');
}

// ---- Main ----

export default {
  description: 'Set up automated codeburn OTEL sync (pushes AI usage telemetry every 12h)',
  options: [
    { flags: '--url <url>', description: 'OTEL collector URL (from CDK deploy output OtelCollectorUrl)' },
    { flags: '--interval <hours>', description: 'Sync interval in hours (default: 12)' },
    { flags: '--status', description: 'Show current sync schedule status' },
    { flags: '--remove', description: 'Remove the sync schedule' },
  ],
  async action(opts: { url?: string; interval?: string; status?: boolean; remove?: boolean }) {
    const codeburnPath = getCodeburnPath();

    // --status
    if (opts.status) {
      showStatus(codeburnPath);
      return;
    }

    // --remove
    if (opts.remove) {
      if (scheduleExists()) {
        removeSchedule();
        console.log(`\n  ✓ ${schedulerName()} schedule removed.\n`);
      } else {
        console.log(`\n  No ${schedulerName()} schedule found — nothing to remove.\n`);
      }
      return;
    }

    // ---- Setup flow ----
    console.log('\n🔄 OTEL Sync Setup\n');
    console.log('This will configure automated codeburn telemetry sync to your PRISM');
    console.log('OTEL collector. Runs every 12 hours to keep dashboards fresh.\n');

    // 1. Check codeburn version
    if (!codeburnPath) {
      console.error('Error: codeburn not found. Install with: npm install -g codeburn');
      process.exit(1);
    }
    const verResult = run(codeburnPath, ['--version']);
    if (verResult.ok) {
      const ver = verResult.stdout.replace(/[^0-9.]/g, '');
      const parts = ver.split('.').map(Number);
      if (parts[0] === 0 && parts[1] < 9 || (parts[1] === 9 && parts[2] < 16)) {
        console.error(`Error: codeburn >= 0.9.16 required (found ${ver}). Run: npm update -g codeburn`);
        process.exit(1);
      }
      console.log(`  ✓ codeburn ${ver}`);
    }

    // 2. Get the OTEL collector URL
    const otelUrl = opts.url || await prompt('OTEL collector URL (from CDK deploy output OtelCollectorUrl)');
    if (!otelUrl) {
      console.error('Error: OTEL collector URL is required.');
      process.exit(1);
    }
    // Reject anything that is not a real http(s) URL before it is persisted
    // into codeburn's sync config, where a malformed value surfaces later as an
    // opaque push failure from the scheduled job rather than here.
    try {
      const parsed = new URL(otelUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('unsupported protocol');
      }
    } catch {
      console.error(`Error: "${otelUrl}" is not a valid http(s) URL.`);
      console.error('  Expected the OtelCollectorUrl value from the CDK stack outputs.');
      process.exit(1);
    }

    // 3. Check if codeburn sync is already configured for this URL
    const configPath = join(homedir(), '.config', 'codeburn', 'sync.json');
    let needsSetup = true;
    if (existsSync(configPath)) {
      try {
        const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
        const existingUrl = cfg.baseUrl || cfg.endpoint || cfg.url || '';
        if (existingUrl === otelUrl || existingUrl.startsWith(otelUrl)) {
          console.log(`  ✓ codeburn sync already configured for this endpoint.`);
          needsSetup = false;
        } else {
          console.log(`  ⚠ codeburn sync configured for different endpoint: ${existingUrl}`);
          const override = await prompt('Reconfigure for the new URL? (y/N)', 'N');
          if (override.toLowerCase() !== 'y') {
            console.log('  Keeping existing configuration.');
            needsSetup = false;
          }
        }
      } catch {
        // Corrupt config — re-setup
      }
    }

    // 4. Run codeburn sync setup (opens browser for OIDC)
    if (needsSetup) {
      console.log('\n  Running: codeburn sync setup ' + otelUrl);
      console.log('  (This will open a browser for OIDC authentication)\n');
      // argv, not a command string: otelUrl comes straight from prompt() and
      // previously reached execSync as shell source.
      if (runInteractive(codeburnPath, ['sync', 'setup', otelUrl])) {
        console.log('\n  ✓ codeburn sync configured.');
      } else {
        console.error(`\n  ✗ codeburn sync setup failed. Ensure Cognito user exists and try again.`);
        process.exit(1);
      }
    }

    // 5. Initial backfill push (30d — server drops >14d from CloudWatch, keeps in DDB/S3)
    console.log('\n  Pushing initial backfill (last 30 days of telemetry)...');
    const backfill = run(codeburnPath, syncArgs('30d'));
    if (backfill.ok) {
      console.log('  ✓ Backfill push complete.');
      if (backfill.stdout) console.log(`    ${backfill.stdout.split('\n').slice(-1)[0]}`);
    } else {
      console.log(`  ⚠ Backfill push failed (non-fatal): ${backfill.stderr.split('\n')[0]}`);
      console.log('    The schedule will retry. Check ~/.prism/logs/otel-sync.log');
    }

    // 6. Install OS schedule
    const intervalHours = opts.interval ? parseInt(opts.interval, 10) : 12;
    if (isNaN(intervalHours) || intervalHours < 1) {
      console.error('Error: --interval must be a positive integer (hours).');
      process.exit(1);
    }

    if (scheduleExists()) {
      console.log(`\n  ✓ ${schedulerName()} schedule already exists — updating.`);
      removeSchedule();
    }

    const scheduled = installSchedule(codeburnPath, intervalHours);
    if (scheduled) {
      console.log(`  ✓ ${schedulerName()} schedule installed (every ${intervalHours}h).`);
    }

    // Summary
    console.log('\n════════════════════════════════════════════════');
    console.log('  ✅ OTEL sync setup complete!');
    console.log('════════════════════════════════════════════════');
    console.log(`\n  Endpoint:  ${otelUrl}`);
    if (scheduled) {
      console.log(`  Schedule:  every ${intervalHours}h via ${schedulerName()}`);
    } else {
      console.log(`  Schedule:  ⚠️  not installed (run manually: codeburn sync push --since 7d)`);
    }
    console.log(`  Backfill:  last 30d pushed (dashboard shows last 14d)`);
    console.log(`  Logs:      ${join(LOG_DIR, 'otel-sync.log')}`);
    console.log(`\n  Run \`prism-cli bootstrapper setup-otel-sync --status\` to check health.`);
    console.log(`  Run \`prism-cli bootstrapper setup-otel-sync --remove\` to uninstall.\n`);
  },
};
