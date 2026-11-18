/**
 * The one set of rules for the pentest target's paths, health path and port,
 * used by `prism-cli security pentest` (pentest.ts) and by the dashboard's
 * picker and its check route (dashboard/security-pentest.ts), so the CLI
 * refuses exactly what the picker refuses.
 */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, posix, sep } from 'node:path';

/** Longest path or health path accepted (the dashboard's stdio transport caps a query value at 512). */
export const MAX_TARGET_INPUT = 400;
export const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Why `input` cannot name a path inside a repo, from its text alone (no file access); null when it can. */
export function repoPathTextError(input: string): string | null {
  const v = input.trim();
  if (!v) return 'enter a path relative to the repo root';
  if (v.length > MAX_TARGET_INPUT) return `the path is longer than ${MAX_TARGET_INPUT} characters`;
  if (CONTROL_RE.test(v)) return 'the path has a control character';
  if (isAbsolute(v) || posix.isAbsolute(v) || /^~/.test(v) || /^[A-Za-z]:/.test(v) || v.startsWith('\\')) return 'use a path relative to the repo root, not an absolute path';
  if (v.split(/[\\/]/).includes('..')) return 'the path must stay inside the repo (no ..)';
  return null;
}

export type PathCheck = { ok: true; rel: string; isDir: boolean } | { ok: false; error: string };

/**
 * A path checked against the repo: repoPathTextError, then it exists and its
 * real path (symlinks followed) stays inside the repo. `rel` is the normalized
 * repo-relative form ("." for the top).
 */
export function checkRepoPath(root: string, input: string): PathCheck {
  const e = repoPathTextError(input);
  if (e) return { ok: false, error: e };
  const rel = normalize(input.trim()).replace(/\\/g, '/').replace(/\/+$/, '') || '.';
  let top: string, real: string;
  try { top = realpathSync(root); } catch { return { ok: false, error: 'the repo folder cannot be read' }; }
  try { real = realpathSync(join(top, rel)); } catch { return { ok: false, error: `${rel} is not in the repo` }; }
  if (real !== top && !real.startsWith(top + sep)) return { ok: false, error: `${rel} points outside the repo (through a symlink)` };
  let isDir: boolean;
  try { const s = statSync(real); if (!s.isDirectory() && !s.isFile()) return { ok: false, error: `${rel} is not a file or folder` }; isDir = s.isDirectory(); } catch { return { ok: false, error: `${rel} cannot be read` }; }
  return { ok: true, rel, isDir };
}

/** Why `hp` is not a health check path (starts with /, at most MAX_TARGET_INPUT characters, no control character); null when it is. */
export function healthPathError(hp: string): string | null {
  if (!hp.startsWith('/')) return 'the health path must start with /';
  if (hp.length > MAX_TARGET_INPUT || CONTROL_RE.test(hp)) return 'the health path is too long or has a control character';
  return null;
}

/** A TCP port from its text (digits only, 1-65535), else null. */
export function parsePort(s: string): number | null {
  const v = s.trim();
  const n = /^\d{1,5}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}
