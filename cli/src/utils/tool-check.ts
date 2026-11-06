/**
 * "Is this tool installed, and which version?" -- shared by workshop
 * verify-setup, codewatch's reviewer detection and the dashboard checklist.
 *
 * No shell: PATH is scanned directly and the version probe is argv-only.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Resolves an executable on PATH without spawning `which`. */
export function findOnPath(binary: string, pathEnv: string | undefined = process.env.PATH): string | null {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (pathEnv || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, binary + ext);
      try {
        if (statSync(p).isFile()) {
          accessSync(p, constants.X_OK);
          return p;
        }
      } catch { /* not here */ }
    }
  }
  return null;
}

/** First line of `<binary> <args>` (default `--version`), or null. */
export function toolVersion(binary: string, args: string[] = ['--version']): string | null {
  const r = spawnSync(binary, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return null;
  return ((r.stdout || r.stderr || '').trim().split('\n')[0] || '').trim() || null;
}

export interface ToolInfo {
  installed: boolean;
  path: string | null;
  version: string | null;
}

export function checkTool(binary: string, opts: { pathEnv?: string; versionArgs?: string[] } = {}): ToolInfo {
  const path = findOnPath(binary, opts.pathEnv);
  if (!path) return { installed: false, path: null, version: null };
  return { installed: true, path, version: toolVersion(path, opts.versionArgs) };
}
