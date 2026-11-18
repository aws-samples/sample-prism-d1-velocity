/**
 * ~/.prism/dashboard.json: the dashboard's own user-level settings, shared by
 * every host of the same server code (the browser, VS Code, Kiro Crew). Local
 * only: no AWS, nothing in a repo, nothing in browser storage (a srcdoc or
 * opaque-origin frame has none that lasts).
 *
 * 1.21.8 keeps one key, securityAgentRepo: the real path of the repo last
 * picked on the Security Agent page. It leaves the server only as that repo's
 * id, and only while the repo is still in the discovered list. Reading never
 * writes: a path that is no longer discovered is ignored, and replaced by the
 * next pick. A file that is not a JSON object is ignored (and left alone)
 * until the next pick replaces it.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ScanRepo } from './actions.js';

export const DASHBOARD_PREFS_FILE = join('.prism', 'dashboard.json');
export const SECURITY_AGENT_REPO_KEY = 'securityAgentRepo';

export const prefsPath = (home: string) => join(home, DASHBOARD_PREFS_FILE);

const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

/** The file as an object; null when it is missing or not a JSON object. */
function readPrefs(home: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(prefsPath(home), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/**
 * Changes the file: re-reads it just before the write, so a key another dashboard
 * (the browser server, --serve-stdio) wrote since is kept, then writes through a
 * temp file and a rename, so a crash never leaves half of it. The temp file is
 * removed when the write or the rename fails.
 */
function updatePrefs(home: string, change: (prefs: Record<string, unknown>) => Record<string, unknown>): void {
  const file = prefsPath(home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(change(readPrefs(home) ?? {}), null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * The id of the remembered Security Agent repo when its path is still one of
 * `repos` (compared as real paths), else null. Never writes the file.
 */
export function rememberedRepo(home: string, repos: ScanRepo[]): string | null {
  const want = readPrefs(home)?.[SECURITY_AGENT_REPO_KEY];
  if (typeof want !== 'string' || !want) return null;
  return repos.find((r) => r.path === want || real(r.path) === want)?.id ?? null;
}

/** Saves `repo` (one of the server's own discovered repos) as the remembered one, keeping every other key. */
export function rememberRepo(home: string, repo: ScanRepo): void {
  const path = real(repo.path) ?? repo.path;
  updatePrefs(home, (prefs) => ({ ...prefs, [SECURITY_AGENT_REPO_KEY]: path }));
}
