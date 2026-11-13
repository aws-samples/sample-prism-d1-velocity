/**
 * `prism-cli version`: this CLI's version, whether npm has a newer one, and
 * any other prism-cli on PATH that shadows this one or differs from it (an old
 * /usr/bin/prism-cli under a system Node is the usual case).
 *
 * The npm check never fails the command: a timeout, no network or no npm is
 * reported as "not checked". `--offline` skips it. `prism-cli --version` stays
 * the bare version string from commander.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { ENABLE_KIROCREW_CMD, KIROCREW_APP_NAME, kirocrewAppState, type KirocrewAppState } from '../../utils/kirocrew.js';

export const PACKAGE_NAME = '@prism-d1/cli';
const BIN_NAME = 'prism-cli';
/** Short: this runs on every `version` call and must not stall a terminal. */
const NPM_TIMEOUT_MS = 5000;

export interface Install {
  /** The PATH entry. */
  path: string;
  /** Where it resolves after symlinks. */
  realpath: string;
  /** From the package.json next to it; null when it cannot be found. */
  version: string | null;
  /** True when it is this running CLI. */
  isThis: boolean;
}

export interface VersionReport {
  schema: 'prism.version.v1';
  version: string;
  node: string;
  latest: string | null;
  updateAvailable: boolean | null;
  /** Why latest is null: 'offline', or the npm failure. */
  latestNote: string | null;
  onPath: Install[];
  warnings: string[];
  /** The PRISM Kiro Crew app; null when kirocrew is not on this machine. */
  kirocrewApp: KirocrewAppState | null;
}

export interface VersionDeps {
  /** The directory holding this CLI's package.json. */
  ownPackageDir: string;
  pathEnv: string;
  /** `npm view @prism-d1/cli version`: the version, or an error message. */
  npmLatest: () => { version: string | null; error?: string };
  /** Installed and bundled Kiro Crew app versions; file reads only, no kirocrew call. */
  kirocrewApp?: () => KirocrewAppState | null;
}

/** Walks up from `start` to the package.json of @prism-d1/cli, at most 6 levels. */
export function findPackageDir(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === PACKAGE_NAME) return dir;
      } catch { /* not ours */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** This prism-cli's own version, from its package.json; 'unknown' when it cannot be read. */
export function ownVersion(): string {
  return packageVersion(findPackageDir(dirname(fileURLToPath(import.meta.url)))) ?? 'unknown';
}

function packageVersion(dir: string | null): string | null {
  if (!dir) return null;
  try {
    return String(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version);
  } catch {
    return null;
  }
}

/** -1, 0 or 1, comparing dotted numeric versions; pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

/**
 * Every prism-cli on PATH, in PATH order, deduplicated by real path (e.g.
 * /bin -> /usr/bin).
 *
 * shortcut: on Windows, npm's .cmd shims do not resolve to their package, so
 * other installs there show version unknown; parse the shim if that matters.
 */
export function installsOnPath(pathEnv: string, ownPackageDir: string): Install[] {
  const seen = new Set<string>();
  const out: Install[] = [];
  const exts = process.platform === 'win32' ? ['.cmd', ''] : [''];
  const own = realOrSelf(ownPackageDir);
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, BIN_NAME + ext);
      try {
        if (!statSync(p).isFile()) continue;
      } catch { continue; }
      const real = realOrSelf(p);
      if (seen.has(real)) continue;
      seen.add(real);
      const pkgDir = findPackageDir(dirname(real));
      out.push({ path: p, realpath: real, version: packageVersion(pkgDir), isThis: !!pkgDir && realOrSelf(pkgDir) === own });
    }
  }
  return out;
}

function realOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

export function buildReport(opts: { offline?: boolean }, d: VersionDeps): VersionReport {
  const version = packageVersion(d.ownPackageDir) ?? 'unknown';
  const warnings: string[] = [];

  const onPath = installsOnPath(d.pathEnv, d.ownPackageDir);
  const first = onPath[0];
  if (!first) {
    warnings.push(`${BIN_NAME} is not on PATH; this copy runs only by its full path.`);
  } else if (!first.isThis) {
    warnings.push(`"${BIN_NAME}" on PATH runs ${first.path} (${first.version ?? 'version unknown'}), not this CLI (${version}, ${d.ownPackageDir}).`);
  }
  const others = onPath.filter((i, n) => !i.isThis && n > 0 && i.version !== version);
  for (const o of others) {
    warnings.push(`Another ${BIN_NAME} on PATH: ${o.path} (${o.version ?? 'version unknown'}), shadowed by ${first.path}. A different Node or shell may run it; remove it with that Node's "npm uninstall -g ${PACKAGE_NAME}".`);
  }

  let latest: string | null = null;
  let latestNote: string | null = null;
  if (opts.offline) {
    latestNote = 'offline';
  } else {
    const r = d.npmLatest();
    latest = r.version;
    if (!latest) latestNote = r.error || 'npm returned no version';
  }
  const updateAvailable = latest && version !== 'unknown' ? compareVersions(latest, version) > 0 : null;

  let kirocrewApp: KirocrewAppState | null = null;
  try { kirocrewApp = d.kirocrewApp?.() ?? null; } catch { /* optional line: never fails `version` */ }

  return { schema: 'prism.version.v1', version, node: process.version, latest, updateAvailable, latestNote, onPath, warnings, kirocrewApp };
}

/** True when an installed Kiro Crew app is older than the bundled one. */
export function appOutdated(s: KirocrewAppState | null | undefined): boolean {
  return !!(s?.installed && s.bundled && compareVersions(s.installed, s.bundled) < 0);
}

/** The `prism-cli version` line for an outdated Kiro Crew app; null otherwise. */
export function kirocrewVersionLine(s: KirocrewAppState | null | undefined): string | null {
  if (!appOutdated(s)) return null;
  return `Kiro Crew app ${KIROCREW_APP_NAME} ${s!.installed} installed, ${s!.bundled} bundled: run ${ENABLE_KIROCREW_CMD}`;
}

function realNpmLatest(): { version: string | null; error?: string } {
  const o = { encoding: 'utf8' as const, timeout: NPM_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  // Windows resolves npm.cmd only through a shell. The command is a constant
  // with no user input, so the shell parses nothing it was given.
  const r = process.platform === 'win32'
    ? spawnSync(`npm view ${PACKAGE_NAME} version`, { ...o, shell: true })
    : spawnSync('npm', ['view', PACKAGE_NAME, 'version'], o);
  if (r.error) return { version: null, error: (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? `npm did not answer within ${NPM_TIMEOUT_MS / 1000}s` : r.error.message };
  if (r.status !== 0) return { version: null, error: (r.stderr || '').trim().split('\n')[0] || `npm exited ${r.status}` };
  const v = (r.stdout || '').trim();
  return /^\d+\.\d+\.\d+/.test(v) ? { version: v } : { version: null, error: 'unexpected npm output' };
}

export function defaultDeps(): VersionDeps {
  return {
    ownPackageDir: findPackageDir(dirname(fileURLToPath(import.meta.url))) ?? process.cwd(),
    pathEnv: process.env.PATH || '',
    npmLatest: realNpmLatest,
    kirocrewApp: () => kirocrewAppState({ home: homedir() }),
  };
}

export function printReport(r: VersionReport, log: (l: string) => void = console.log): void {
  log(`${BIN_NAME} ${r.version} (Node ${r.node})`);
  if (r.updateAvailable) log(`Update available: ${r.latest}. Run: npm install -g ${PACKAGE_NAME}`);
  else if (r.latest) log(`Up to date (latest on npm: ${r.latest}).`);
  else if (r.latestNote === 'offline') log('Update check skipped (--offline).');
  else log(`Update check: not checked (${r.latestNote}).`);
  for (const w of r.warnings) log(`⚠  ${w}`);
  const kc = kirocrewVersionLine(r.kirocrewApp);
  if (kc) log(kc);
}

export default {
  description: 'Print the CLI version, check npm for a newer release, and warn about other prism-cli copies on PATH',
  options: [
    { flags: '--json', description: 'Print the report as JSON' },
    { flags: '--offline', description: 'Skip the npm check' },
  ],
  async action(opts: { json?: boolean; offline?: boolean }) {
    const report = buildReport(opts, defaultDeps());
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
  },
};
