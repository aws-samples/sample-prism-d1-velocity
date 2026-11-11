/**
 * Finding and running prism-cli. Always execFile with an argv array and
 * shell:false: no path or recorded text is ever part of a shell string.
 * No vscode import.
 */
import { execFile, type ExecFileOptions } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

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

export type CliLocation = { ok: true; path: string } | { ok: false; reason: string };

export function resolveCli(setting: string | null, pathEnv: string | undefined, platform: NodeJS.Platform = process.platform, isExec = isExecutableFile): CliLocation {
  if (setting) {
    if (!isAbsolute(setting)) return { ok: false, reason: 'prism.cliPath must be an absolute path' };
    return isExec(setting) ? { ok: true, path: setting } : { ok: false, reason: 'prism.cliPath is not an executable file' };
  }
  const found = findOnPath(CLI_NAME, pathEnv, platform, isExec);
  return found ? { ok: true, path: found } : { ok: false, reason: `${CLI_NAME} is not on PATH` };
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

export function execOptions(cwd: string, timeout: number): ExecFileOptions & { shell: false } {
  return { cwd, shell: false, timeout, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' };
}

export type ExecFileFn = (file: string, args: string[], opts: ExecFileOptions, cb: (err: Error | null, stdout: string, stderr: string) => void) => unknown;

export class CliError extends Error {
  constructor(message: string, readonly notFound = false) { super(message); }
}

/** Runs `bin args` and resolves with stdout. Rejects with the last stderr line on failure. */
export function runFile(bin: string, args: string[], cwd: string, timeout: number, exec: ExecFileFn = execFile as unknown as ExecFileFn): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    exec(bin, args, execOptions(cwd, timeout), (err, stdout, stderr) => {
      if (!err) return resolvePromise(String(stdout));
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === 'ENOENT') return reject(new CliError(`${bin} could not be started`, true));
      if (e.killed) return reject(new CliError(`${args[0] ?? bin} timed out after ${Math.round(timeout / 1000)} s`));
      const last = String(stderr || '').trim().split('\n').pop() || e.message;
      reject(new CliError(last));
    });
  });
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
