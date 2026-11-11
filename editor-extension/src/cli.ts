/**
 * Finding and running prism-cli. Always execFile with an argv array and
 * shell:false: no path or recorded text is ever part of a shell string.
 * No vscode import.
 */
import { execFile, type ExecFileOptions } from 'node:child_process';
import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export const CLI_NAME = 'prism-cli';
/** `--fresh` reruns the codeburn exports, which can take tens of seconds. */
export const DASHBOARD_TIMEOUT_MS = 120_000;
export const REPORT_TIMEOUT_MS = 60_000;
export const GIT_TIMEOUT_MS = 10_000;
export const MAX_BUFFER = 64 * 1024 * 1024;

export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch { return false; }
}

/**
 * The prism.cliPath value to use: only the user (global) value. The setting is
 * machine-scoped in package.json, and reading globalValue alone means a
 * workspace or folder value is ignored even by an editor that does not honour
 * the scope.
 */
export function configuredCliPath(inspected: { globalValue?: unknown } | undefined): string | null {
  const v = inspected?.globalValue;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** First executable `name` on PATH (with .exe on Windows). */
export function findOnPath(name: string, pathEnv: string | undefined, platform: NodeJS.Platform = process.platform, isExec = isExecutableFile): string | null {
  // shortcut: .cmd/.bat npm shims cannot run without a shell, so Windows finds only a .exe; set prism.cliPath there.
  const names = platform === 'win32' ? [`${name}.exe`] : [name];
  for (const dir of (pathEnv || '').split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir || !isAbsolute(dir)) continue; // a relative PATH entry would resolve inside the workspace
    for (const n of names) {
      const p = join(dir, n);
      if (isExec(p)) return p;
    }
  }
  return null;
}

/** Reads used to look through per-user install folders; injectable for tests. */
export interface DirReader {
  readDir(p: string): string[];
  readText(p: string): string | null;
}

const realFs: DirReader = {
  readDir: (p) => { try { return readdirSync(p); } catch { return []; } },
  readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
};

const semverParts = (v: string) => v.slice(1).split('.').map(Number);
const semverDesc = (a: string, b: string) => {
  const x = semverParts(a), y = semverParts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
};

/** The installed version (e.g. v20.20.2) that ~/.nvm/alias/default names, or null. `versions` is sorted newest first. */
function nvmDefault(home: string, versions: string[], fsx: DirReader): string | null {
  let alias = fsx.readText(join(home, '.nvm', 'alias', 'default'))?.trim();
  // An alias can name another alias (default -> lts/* -> lts/krypton -> v24.x); follow a few hops.
  for (let hops = 0; alias && hops < 4; hops++) {
    if (alias === 'node' || alias === 'stable') return versions[0] ?? null;
    const m = /^v?(\d+(?:\.\d+){0,2})$/.exec(alias);
    if (m) return versions.find((v) => v === `v${m[1]}` || v.startsWith(`v${m[1]}.`)) ?? null;
    if (isAbsolute(alias) || alias.split('/').includes('..')) return null;
    alias = fsx.readText(join(home, '.nvm', 'alias', alias))?.trim();
  }
  return null;
}

/** nvm bin folders: the default alias's version first, then the rest newest first. */
function nvmBinDirs(home: string, fsx: DirReader): string[] {
  const root = join(home, '.nvm', 'versions', 'node');
  const versions = fsx.readDir(root).filter((v) => /^v\d+\.\d+\.\d+$/.test(v)).sort(semverDesc);
  const def = nvmDefault(home, versions, fsx);
  return (def ? [def, ...versions.filter((v) => v !== def)] : versions).map((v) => join(root, v, 'bin'));
}

/**
 * Per-user install folders, in search order, for an editor whose PATH lacks
 * them (a Remote-SSH extension host does not load .bashrc, so nvm is missing).
 * No shell is run to find them. `expandNvm: false` gives the nvm entry as a
 * `*` pattern, for messages.
 */
export function userInstallDirs(home: string, env: NodeJS.ProcessEnv, fsx: DirReader = realFs, expandNvm = true): string[] {
  const dirs = [
    env.NVM_BIN,
    ...(expandNvm ? nvmBinDirs(home, fsx) : [join(home, '.nvm', 'versions', 'node', '*', 'bin')]),
    env.VOLTA_HOME ? join(env.VOLTA_HOME, 'bin') : join(home, '.volta', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    env.NPM_CONFIG_PREFIX ? join(env.NPM_CONFIG_PREFIX, 'bin') : undefined,
  ];
  return [...new Set(dirs.filter((d): d is string => !!d && isAbsolute(d)))];
}

export type CliLocation = { ok: true; path: string } | { ok: false; reason: string; searched?: string[] };

export interface ResolveDeps {
  platform?: NodeJS.Platform;
  isExec?: (p: string) => boolean;
  home?: string;
  fs?: DirReader;
}

export function resolveCli(setting: string | null, env: NodeJS.ProcessEnv, deps: ResolveDeps = {}): CliLocation {
  const platform = deps.platform ?? process.platform;
  const isExec = deps.isExec ?? isExecutableFile;
  if (setting) {
    if (!isAbsolute(setting)) return { ok: false, reason: 'prism.cliPath must be an absolute path' };
    return isExec(setting) ? { ok: true, path: setting } : { ok: false, reason: 'prism.cliPath is not an executable file' };
  }
  const found = findOnPath(CLI_NAME, env.PATH, platform, isExec);
  if (found) return { ok: true, path: found };
  // shortcut: no per-user folder search on Windows (only .exe can run without a shell there); set prism.cliPath.
  if (platform === 'win32') return { ok: false, reason: `${CLI_NAME} is not on PATH`, searched: ['PATH'] };
  const home = deps.home ?? homedir();
  for (const dir of userInstallDirs(home, env, deps.fs)) {
    const p = join(dir, CLI_NAME);
    if (isExec(p)) return { ok: true, path: p };
  }
  return { ok: false, reason: `${CLI_NAME} is not on PATH or in the usual install folders`, searched: ['PATH', ...userInstallDirs(home, env, deps.fs, false)] };
}

/**
 * The environment for running prism-cli: process.env with the CLI's own folder
 * first on PATH, so its `#!/usr/bin/env node` finds the node installed next to
 * it (nvm, Volta) even when the editor's PATH has no node.
 */
export function cliEnv(cliPath: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const key = platform === 'win32' ? (Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path') : 'PATH';
  const rest = env[key];
  const dir = dirname(cliPath);
  return { ...env, [key]: rest ? `${dir}${platform === 'win32' ? ';' : delimiter}${rest}` : dir };
}

/** `--root <repo>` keeps the scan inside this repo instead of the whole home directory. */
export function dashboardArgs(repoRoot: string, fresh: boolean): string[] {
  return ['dashboard', '--json', '--root', repoRoot, ...(fresh ? ['--fresh'] : [])];
}

/** Result ids are file names in .prism/results/; anything else (or an option-looking value) is refused. */
export function isResultId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id);
}

export function reportArgs(repoRoot: string, id: string, output: string): string[] {
  if (!isResultId(id)) throw new Error('not a codewatch result id');
  return ['codewatch', 'report', '--repo', repoRoot, '--id', id, '--format', 'html', '--output', output];
}

export function execOptions(cwd: string, timeout: number, env?: NodeJS.ProcessEnv): ExecFileOptions & { shell: false } {
  return { cwd, shell: false, timeout, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8', ...(env ? { env } : {}) };
}

export type ExecFileFn = (file: string, args: string[], opts: ExecFileOptions, cb: (err: Error | null, stdout: string, stderr: string) => void) => unknown;

export class CliError extends Error {
  constructor(message: string, readonly notFound = false) { super(message); }
}

/** Runs `bin args` and resolves with stdout. Rejects with the last stderr line on failure. */
export function runFile(bin: string, args: string[], cwd: string, timeout: number, exec: ExecFileFn = execFile as unknown as ExecFileFn, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    exec(bin, args, execOptions(cwd, timeout, env), (err, stdout, stderr) => {
      if (!err) return resolvePromise(String(stdout));
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === 'ENOENT') return reject(new CliError(`${bin} could not be started`, true));
      if (e.killed) return reject(new CliError(`${args[0] ?? bin} timed out after ${Math.round(timeout / 1000)} s`));
      const last = String(stderr || '').trim().split('\n').pop() || e.message;
      reject(new CliError(last));
    });
  });
}

/** Runs prism-cli with cliEnv, so its folder is first on PATH. */
export function runCli(cliPath: string, args: string[], cwd: string, timeout: number, exec?: ExecFileFn, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return runFile(cliPath, args, cwd, timeout, exec, cliEnv(cliPath, env));
}

/** The repo containing `folder`, or null. */
export async function gitToplevel(folder: string, exec?: ExecFileFn): Promise<string | null> {
  try { return (await runFile('git', ['rev-parse', '--show-toplevel'], folder, GIT_TIMEOUT_MS, exec)).trim() || null; } catch { return null; }
}

/** The checked-out branch, or null when detached or unknown. */
export async function currentBranch(repoRoot: string, exec?: ExecFileFn): Promise<string | null> {
  try {
    const b = (await runFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, GIT_TIMEOUT_MS, exec)).trim();
    return b && b !== 'HEAD' ? b : null;
  } catch { return null; }
}
