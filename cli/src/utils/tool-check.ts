/**
 * "Is this tool installed, and which version?" -- shared by workshop
 * verify-setup, codewatch's reviewer detection and the dashboard checklist.
 *
 * No shell: PATH is scanned directly and the version probe is argv-only.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { readJson, writePrivateJson } from './private-json.js';

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

export function checkTool(binary: string, opts: { pathEnv?: string; versionArgs?: string[]; versionCache?: string } = {}): ToolInfo {
  const path = findOnPath(binary, opts.pathEnv);
  if (!path) return { installed: false, path: null, version: null };
  const version = opts.versionCache ? cachedToolVersion(path, opts.versionArgs, opts.versionCache) : toolVersion(path, opts.versionArgs);
  return { installed: true, path, version };
}

/**
 * toolVersion, remembered in `cacheFile` per binary (symlinks resolved) and
 * args, and reused while the binary's mtime and size are unchanged. An upgrade
 * replaces or rewrites the binary, so it runs the probe again. A failed probe
 * (null) is not cached.
 */
export function cachedToolVersion(path: string, args: string[] = ['--version'], cacheFile: string): string | null {
  const stamp = binaryStamp(path);
  if (!stamp) return toolVersion(path, args);
  const key = `${stamp.real}\0${args.join(' ')}`;
  const { mtimeMs, size } = stamp;
  const all = readJson(cacheFile);
  const entries: Record<string, { mtimeMs: number; size: number; version: string }> = all?.schema === TOOL_VERSION_SCHEMA && all.entries && typeof all.entries === 'object' ? all.entries : {};
  const hit = Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : undefined;
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size && typeof hit.version === 'string') return hit.version;
  const version = toolVersion(path, args);
  if (version !== null) {
    try {
      writePrivateJson(cacheFile, { schema: TOOL_VERSION_SCHEMA, entries: { ...entries, [key]: { mtimeMs, size, version } } });
    } catch { /* a cache that cannot be written only costs the probe next time */ }
  }
  return version;
}

export const TOOL_VERSION_SCHEMA = 'prism.tool-versions.v1';

/** A binary's real path, mtime and size: what changes when it is installed, upgraded or replaced. null when it cannot be read. */
export function binaryStamp(path: string): { real: string; mtimeMs: number; size: number } | null {
  try {
    const real = realpathSync(path);
    const st = statSync(real);
    return { real, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** binaryStamp of `binary` on PATH as one string; null when it is not on PATH. */
export function binaryStampOnPath(binary: string, pathEnv?: string): string | null {
  const p = findOnPath(binary, pathEnv);
  const s = p ? binaryStamp(p) : null;
  return s ? `${s.real}\0${s.mtimeMs}\0${s.size}` : null;
}
