/**
 * `prism-cli enable kirocrew`: install or update the PRISM Kiro Crew app
 * bundled with this CLI.
 *
 * The bundled app (dist/assets/kirocrew-app) is copied to ~/.prism/kirocrew-app,
 * then `kirocrew app install` or `kirocrew app update --source` copies it into
 * Kiro Crew. Kiro Crew keeps the app's data in its own apps folder
 * (~/.kiro/crew/apps/prism/data by default), never in the source folder, so
 * replacing ~/.prism/kirocrew-app cannot touch it.
 *
 * Kiro Crew itself is never installed, and trusting the app is left to the
 * person: Kiro Crew refuses to run a third-party app until they do.
 */
import { createInterface } from 'node:readline';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, type RunResult } from '../../utils/exec.js';
import { bundledAppDir, ENABLE_KIROCREW_CMD, findKirocrew, KIROCREW_APP_NAME as APP, KIROCREW_INSTALL_DOCS, readManifest } from '../../utils/kirocrew.js';
import { compareVersions, findPackageDir, installsOnPath } from '../_top/version.js';
import { runGuarded } from './security.js';

/** `kirocrew app info` and `cron list` take a few seconds (a Python CLI); install and update wait on the gateway. */
const READ_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 180_000;

/** Never copied from the bundle: test files, caches, and app data (Kiro Crew keeps that elsewhere). */
const EXCLUDED = new Set(['tests', 'data', '__pycache__', '.pytest_cache']);

export interface KirocrewDeps {
  home: string;
  pathEnv: string;
  /** The bundled app folder; null when this CLI was not built. */
  bundleDir: string | null;
  /** This CLI's package folder and version, for the prism-cli PATH check. */
  ownPackageDir: string;
  ownVersion: string;
  run: (file: string, args: string[], timeoutMs: number) => RunResult;
  isTTY: boolean;
  ask: (question: string) => Promise<string>;
  log: (line?: string) => void;
  error: (line: string) => void;
}

export interface KirocrewOptions {
  yes?: boolean;
  dryRun?: boolean;
  status?: boolean;
  uninstall?: boolean;
  purgeData?: boolean;
}

/** What `kirocrew app info prism` reports, reduced to what this command uses. */
export interface AppInfo {
  version: string;
  source: string;
  enabled: boolean;
  approvedGrantsStored: boolean;
  approvedApi: string[];
  manifestApi: string[];
}

export type PlanAction = 'install' | 'update' | 'current' | 'move' | 'newer';

export interface Plan {
  action: PlanAction;
  target: string;
  from: string | null;
  to: string;
  /** Installed source differs from the target folder (a git worktree, a clone). */
  sourceMoves: boolean;
}

const yes = (a: string) => ['y', 'yes'].includes(a.trim().toLowerCase());
/** Kiro Crew prints its log lines first and the error last. */
const lastLine = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

export const targetDir = (home: string) => join(home, '.prism', 'kirocrew-app');

/** `~` for the home folder in printed paths (also when a path names the home folder's real path). */
function tilde(p: string, home: string): string {
  for (const h of new Set([home, realOrSelf(home)])) {
    if (p === h || p.startsWith(h + '/')) return '~' + p.slice(h.length);
  }
  return p;
}

function realOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

const samePath = (a: string, b: string) => realOrSelf(a) === realOrSelf(b);

/**
 * The JSON object in kirocrew's stdout. Kiro Crew can print log lines (config
 * warnings) before it, so parsing starts at the first line that opens an object.
 */
export function parseJsonAfterLogs(out: string): any {
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith('{')) continue;
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* a log line that starts with { */ }
  }
  throw new Error('kirocrew app info printed no JSON');
}

export function toAppInfo(j: any): AppInfo {
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    version: String(j?.version ?? j?.manifest?.version ?? ''),
    source: typeof j?.source === 'string' ? j.source : '',
    enabled: j?.enabled === true,
    approvedGrantsStored: j?.approvedGrantsStored === true,
    approvedApi: strs(j?.approvedGrants?.api),
    manifestApi: strs(j?.manifest?.permissions?.api),
  };
}

/** The installed app, null when Kiro Crew says it is not installed; throws on any other failure. */
export function readAppInfo(kc: string, d: Pick<KirocrewDeps, 'run'>): AppInfo | null {
  const r = d.run(kc, ['app', 'info', APP], READ_TIMEOUT_MS);
  if (!r.ok) {
    if (/is not installed/i.test(r.stderr)) return null;
    throw new Error(`kirocrew app info ${APP} failed: ${lastLine(r.stderr) || 'no output'}`);
  }
  return toAppInfo(parseJsonAfterLogs(r.stdout));
}

export function makePlan(info: AppInfo | null, bundled: string, home: string): Plan {
  const target = targetDir(home);
  if (!info) return { action: 'install', target, from: null, to: bundled, sourceMoves: false };
  const sourceMoves = !info.source || !samePath(info.source, target);
  const cmp = compareVersions(info.version, bundled);
  const action: PlanAction = cmp < 0 ? 'update' : cmp > 0 ? 'newer' : sourceMoves ? 'move' : 'current';
  return { action, target, from: info.version, to: bundled, sourceMoves };
}

/** The kirocrew argv for a plan; null when nothing runs. */
export function planArgs(p: Plan): string[] | null {
  if (p.action === 'install') return ['app', 'install', p.target];
  if (p.action === 'update' || p.action === 'move') return ['app', 'update', APP, '--source', p.target];
  return null;
}

/**
 * Copies the bundle to a temp folder beside `target`, then renames it into
 * place. An existing target is kept as `<target>.prev` until `commit()`
 * (after Kiro Crew accepted the copy) or put back by `restore()`.
 */
export function stageApp(bundle: string, target: string): { commit: () => void; restore: () => void } {
  const parent = dirname(target);
  const tmp = join(parent, `.${basename(target)}.tmp-${process.pid}`);
  const prev = `${target}.prev`;
  mkdirSync(parent, { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  cpSync(bundle, tmp, { recursive: true, filter: (src) => !EXCLUDED.has(basename(src)) || src === bundle });
  rmSync(prev, { recursive: true, force: true });
  const hadTarget = existsSync(target);
  if (hadTarget) renameSync(target, prev);
  try {
    renameSync(tmp, target);
  } catch (e) {
    if (hadTarget) renameSync(prev, target);
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return {
    commit: () => rmSync(prev, { recursive: true, force: true }),
    restore: () => {
      rmSync(target, { recursive: true, force: true });
      if (hadTarget) renameSync(prev, target);
    },
  };
}

const PLAN_TEXT: Record<PlanAction, (p: Plan) => string> = {
  install: (p) => `install ${APP} ${p.to}`,
  update: (p) => `update ${p.from} -> ${p.to}`,
  move: (p) => `${p.to} is installed from another folder; update it from the prism-cli folder`,
  current: (p) => `already current (${p.to}); nothing to do`,
  newer: (p) => `installed ${p.from} is newer than the bundled ${p.to}; nothing to do (update prism-cli: npm i -g @prism-d1/cli)`,
};

/** Warns when `prism-cli` on PATH, which the app's MCP server runs, is another, older copy. */
function checkPrismCliOnPath(d: KirocrewDeps): void {
  const first = installsOnPath(d.pathEnv, d.ownPackageDir)[0];
  if (!first) {
    d.log('  ⚠ prism-cli is not on PATH. The app finds nvm, Volta and ~/.local/bin installs; else set cliPath in its data/config.json.');
  } else if (!first.isThis && first.version && compareVersions(first.version, d.ownVersion) < 0) {
    d.log(`  ⚠ "prism-cli" on PATH is ${tilde(first.path, d.home)} (${first.version}), older than this one (${d.ownVersion}). The app's tools run that copy.`);
  }
}

function humanSteps(d: KirocrewDeps): void {
  d.log('\n  Left for you (Kiro Crew asks a person for these):');
  d.log(`    1. Trust the app and approve /api/apps/${APP}/* under Apps -> PRISM in the Kiro Crew dashboard.`);
  d.log('    2. Reload the dashboard: the PRISM entry appears in the sidebar.');
}

async function confirm(question: string, opts: KirocrewOptions, d: KirocrewDeps): Promise<boolean> {
  if (opts.yes) return true;
  if (!d.isTTY) {
    d.error('Error: no terminal to confirm. Re-run with --yes, or --dry-run to see the plan.');
    return false;
  }
  if (yes(await d.ask(question))) return true;
  d.error('Nothing changed.');
  return false;
}

// ---- --status ----

function cronLine(kc: string, cronName: string, d: KirocrewDeps): string {
  const r = d.run(kc, ['cron', 'list'], READ_TIMEOUT_MS);
  if (!r.ok) return `not checked (kirocrew cron list failed: ${lastLine(r.stderr)})`;
  return parseCronList(r.stdout, `${APP}/${cronName}`);
}

/** The digest cron's state from `kirocrew cron list` text. */
export function parseCronList(out: string, job: string): string {
  const line = out.split('\n').find((l) => l.split(/\s+/).includes(job));
  if (!line) return 'not found (it is registered once the app is enabled and trusted)';
  return line.trimStart().startsWith('✅') ? `present (${job})` : `present but not active (${job})`;
}

export function grantsLine(info: AppInfo): string {
  if (!info.manifestApi.length) return 'none requested';
  const missing = info.manifestApi.filter((g) => !info.approvedApi.includes(g));
  if (!info.approvedGrantsStored || missing.length === info.manifestApi.length) return `not approved: ${info.manifestApi.join(', ')} (Apps -> PRISM)`;
  if (missing.length) return `partly approved; waiting: ${missing.join(', ')}`;
  return `approved: ${info.manifestApi.join(', ')}`;
}

function showStatus(kc: string, info: AppInfo | null, bundled: Record<string, any> | null, d: KirocrewDeps): number {
  const target = targetDir(d.home);
  d.log('\n📊 Kiro Crew app status\n');
  d.log(`  ✓ kirocrew: ${tilde(kc, d.home)}`);
  d.log(`  Installed:   ${info ? `${APP} ${info.version}` : 'not installed'}`);
  d.log(`  Bundled:     ${bundled?.version ?? 'none (this prism-cli has no bundled app; run npm run build)'}`);
  if (info) {
    const fromTarget = info.source && samePath(info.source, target);
    d.log(`  Source:      ${info.source ? tilde(info.source, d.home) : 'unknown'}${fromTarget ? '' : ` (not ${tilde(target, d.home)}; ${ENABLE_KIROCREW_CMD} moves it)`}`);
    d.log(`  Enabled:     ${info.enabled ? 'yes' : 'no'}`);
    d.log(`  Trust:       ${info.enabled ? 'granted when it was enabled (Kiro Crew refuses to enable an untrusted app)' : 'not trusted or not enabled yet (Apps -> PRISM)'}`);
    d.log(`  API grants:  ${grantsLine(info)}`);
    const cron = Array.isArray(bundled?.crons) && bundled!.crons[0]?.name ? String(bundled!.crons[0].name) : 'prism-daily-digest';
    d.log(`  Digest cron: ${cronLine(kc, cron, d)}`);
  }
  if (!info || (bundled?.version && compareVersions(info.version, bundled.version) < 0)) d.log(`\n  → ${ENABLE_KIROCREW_CMD}`);
  d.log('');
  return 0;
}

// ---- --uninstall ----

async function uninstall(kc: string, info: AppInfo | null, opts: KirocrewOptions, d: KirocrewDeps): Promise<number> {
  const target = targetDir(d.home);
  const args = ['app', 'uninstall', APP, ...(opts.purgeData ? ['--purge-data'] : [])];
  d.log(opts.dryRun ? '\n🔌 enable kirocrew --uninstall — dry run, nothing is changed\n' : '\n🔌 enable kirocrew --uninstall\n');
  if (info) d.log(`  → ${opts.dryRun ? 'would run' : 'runs'}: kirocrew ${args.join(' ')}`);
  else d.log(`  ${APP} is not installed in Kiro Crew.`);
  if (existsSync(target)) d.log(`  → ${opts.dryRun ? 'would remove' : 'removes'} ${tilde(target, d.home)}`);
  if (opts.purgeData) {
    d.log('  ⚠ --purge-data permanently deletes the app\'s data in Kiro Crew (~/.kiro/crew/apps/prism/data by default:');
    d.log('    digest state, data/config.json). This cannot be undone.');
  } else if (info) {
    d.log('  Kiro Crew keeps the app\'s data (~/.kiro/crew/apps/prism/data by default); --purge-data deletes it.');
  }
  if (!info && !existsSync(target)) { d.log('  Nothing to remove.\n'); return 0; }
  if (opts.dryRun) { d.log(''); return 0; }
  if (!await confirm(opts.purgeData ? '  Uninstall and DELETE the app data? [y/N] ' : '  Uninstall? [y/N] ', opts, d)) return 1;
  if (info) {
    const r = d.run(kc, args, WRITE_TIMEOUT_MS);
    if (!r.ok) {
      d.error(`Error: kirocrew ${args.join(' ')} failed: ${lastLine(r.stderr)}`);
      return 1;
    }
    d.log(`  ✓ kirocrew ${args.join(' ')}`);
  }
  for (const p of [target, `${target}.prev`]) rmSync(p, { recursive: true, force: true });
  d.log(`  ✓ Removed ${tilde(target, d.home)}\n`);
  return 0;
}

// ---- Main ----

export async function enableKirocrew(opts: KirocrewOptions, d: KirocrewDeps): Promise<number> {
  if (opts.purgeData && !opts.uninstall) {
    d.error('Error: --purge-data only applies with --uninstall.');
    return 1;
  }
  const kc = findKirocrew(d.pathEnv, d.home);
  if (!kc) {
    d.error('Kiro Crew is not installed: no kirocrew on PATH or in ~/.local/bin. Nothing was changed.');
    d.error(`  Install Kiro Crew first: ${KIROCREW_INSTALL_DOCS}`);
    return 1;
  }
  const bundled = d.bundleDir ? readManifest(d.bundleDir) : null;
  const info = readAppInfo(kc, d);

  if (opts.status) return showStatus(kc, info, bundled, d);
  if (opts.uninstall) return uninstall(kc, info, opts, d);

  if (!d.bundleDir || typeof bundled?.version !== 'string') {
    d.error('Error: this prism-cli has no bundled Kiro Crew app (dist/assets/kirocrew-app). Reinstall it: npm i -g @prism-d1/cli');
    return 1;
  }
  const dry = !!opts.dryRun;
  const plan = makePlan(info, bundled.version, d.home);
  const args = planArgs(plan);

  d.log(dry ? '\n🔌 enable kirocrew — dry run, nothing is changed\n' : '\n🔌 enable kirocrew\n');
  d.log(`  ✓ kirocrew: ${tilde(kc, d.home)}`);
  d.log(`  Installed: ${info ? `${APP} ${info.version} from ${info.source ? tilde(info.source, d.home) : 'an unknown folder'}${info.enabled ? '' : ' (not enabled)'}` : 'not installed'}`);
  d.log(`  Bundled:   ${APP} ${bundled.version} (prism-cli ${d.ownVersion})`);
  d.log(`  Target:    ${tilde(plan.target, d.home)}`);
  d.log(`  Plan:      ${PLAN_TEXT[plan.action](plan)}`);
  if (plan.action === 'update' && plan.sourceMoves) d.log(`             and move its source from ${tilde(info!.source || 'an unknown folder', d.home)} to ${tilde(plan.target, d.home)}`);
  checkPrismCliOnPath(d);
  if (!args) {
    if (info && !info.enabled) d.log(`\n  The app is installed but not enabled: kirocrew app enable ${APP}`);
    d.log('');
    return 0;
  }
  const verb = dry ? '  → would' : '  →';
  d.log(`${verb} copy the bundled app to ${tilde(plan.target, d.home)} (the previous copy is kept as .prev until Kiro Crew accepts it)`);
  d.log(`${verb} run: kirocrew ${args.map((a) => tilde(a, d.home)).join(' ')}`);
  if (!info) d.log(`${verb} run: kirocrew app enable ${APP}`);
  d.log('    Kiro Crew keeps the app\'s data in its own apps folder (~/.kiro/crew/apps/prism/data by default); it is not touched.');
  if (dry) {
    d.log('\n  Dry run complete. Re-run without --dry-run to apply.\n');
    return 0;
  }
  if (!await confirm('\n  Proceed? [y/N] ', opts, d)) return 1;

  const staged = stageApp(d.bundleDir, plan.target);
  d.log(`  ✓ Copied the app to ${tilde(plan.target, d.home)}`);
  const r = d.run(kc, args, WRITE_TIMEOUT_MS);
  if (!r.ok) {
    staged.restore();
    d.error(`Error: kirocrew ${args[0]} ${args[1]} failed: ${lastLine(r.stderr) || 'no output'}`);
    if (args[1] === 'update') d.error('  kirocrew app update needs a running Kiro Crew gateway.');
    d.error(`  ${tilde(plan.target, d.home)} was put back as it was.`);
    return 1;
  }
  staged.commit();
  d.log(`  ✓ kirocrew ${args.map((a) => tilde(a, d.home)).join(' ')}`);

  if (!info) {
    const e = d.run(kc, ['app', 'enable', APP], WRITE_TIMEOUT_MS);
    if (e.ok) d.log(`  ✓ kirocrew app enable ${APP}`);
    else if (/app_execution_denied|trust/i.test(e.stderr)) d.log(`  - kirocrew app enable ${APP} was refused until you trust the app. That is expected: trust it in the dashboard (below).`);
    else d.log(`  ⚠ kirocrew app enable ${APP} failed: ${lastLine(e.stderr)}. Enable it under Apps -> PRISM.`);
  }

  d.log(`\n  ✅ ${APP} ${plan.to} ${plan.action === 'install' ? 'installed' : 'updated'} from ${tilde(plan.target, d.home)}.`);
  humanSteps(d);
  d.log(`\n  Check:  ${ENABLE_KIROCREW_CMD} --status`);
  d.log(`  Remove: ${ENABLE_KIROCREW_CMD} --uninstall\n`);
  return 0;
}

export function defaultDeps(): KirocrewDeps {
  const ownPackageDir = findPackageDir(dirname(fileURLToPath(import.meta.url))) ?? process.cwd();
  return {
    home: homedir(),
    pathEnv: process.env.PATH || '',
    bundleDir: bundledAppDir(),
    ownPackageDir,
    ownVersion: packageVersion(ownPackageDir),
    run: (file, args, timeoutMs) => run(file, args, undefined, timeoutMs),
    isTTY: !!(process.stdin.isTTY && process.stdout.isTTY),
    ask: (q) => new Promise((done) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(q, (a) => { rl.close(); done(a.trim()); });
    }),
    log: (line = '') => console.log(line),
    error: (line) => console.error(line),
  };
}

function packageVersion(pkgDir: string): string {
  try {
    return String(JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version);
  } catch {
    return 'unknown';
  }
}

export interface KirocrewHooks {
  deps?: () => KirocrewDeps;
  error?: (line: string) => void;
  exit?: (code: number) => void;
}

export async function runEnableKirocrew(opts: KirocrewOptions, hooks: KirocrewHooks = {}): Promise<void> {
  await runGuarded(() => enableKirocrew(opts, (hooks.deps ?? defaultDeps)()), hooks);
}

export default {
  description: 'Install or update the PRISM Kiro Crew app bundled with this prism-cli (a PRISM page, the PRISM MCP tools, a fix-findings skill and a daily digest)',
  options: [
    { flags: '--yes', description: 'Do not ask before installing, updating or uninstalling' },
    { flags: '--dry-run', description: 'Print the plan with the exact kirocrew commands; change nothing' },
    { flags: '--status', description: 'Show the installed and bundled app versions, its source folder, enabled, API grants and the digest cron (read-only)' },
    { flags: '--uninstall', description: 'kirocrew app uninstall prism (keeps the app data), then remove ~/.prism/kirocrew-app' },
    { flags: '--purge-data', description: 'With --uninstall: also delete the app data in Kiro Crew permanently' },
  ],
  action: runEnableKirocrew,
};
