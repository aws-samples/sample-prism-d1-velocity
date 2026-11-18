/**
 * ~/.prism/dashboard.json: the dashboard's own user-level settings, shared by
 * every host of the same server code (the browser, VS Code, Kiro Crew). Local
 * only: no AWS, nothing in a repo, nothing in browser storage (a srcdoc or
 * opaque-origin frame has none that lasts).
 *
 * 1.21.8 keeps one key, securityAgentRepo: the real path of the repo last
 * picked on the Security Agent page. It leaves the server only as that repo's
 * id, and only while the repo is still in the discovered list; a path that is
 * not is dropped from the file. A file that is not a JSON object is ignored
 * (and left alone) until the next pick replaces it.
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
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

/** Writes the whole file through a temp file and a rename, so a crash never leaves half of it. */
function writePrefs(home: string, prefs: Record<string, unknown>): void {
  const file = prefsPath(home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(prefs, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * The id of the remembered Security Agent repo when its path is still one of
 * `repos` (compared as real paths), else null. A remembered path that is no
 * longer listed is removed from the file; a write that fails is not an error.
 */
export function rememberedRepo(home: string, repos: ScanRepo[]): string | null {
  const prefs = readPrefs(home);
  const want = prefs?.[SECURITY_AGENT_REPO_KEY];
  if (typeof want !== 'string' || !want) return null;
  const hit = repos.find((r) => r.path === want || real(r.path) === want);
  if (hit) return hit.id;
  const { [SECURITY_AGENT_REPO_KEY]: _gone, ...rest } = prefs!;
  try { writePrefs(home, rest); } catch { /* the stale entry stays; it is ignored again next time */ }
  return null;
}

/** Saves `repo` (one of the server's own discovered repos) as the remembered one, keeping every other key. */
export function rememberRepo(home: string, repo: ScanRepo): void {
  writePrefs(home, { ...(readPrefs(home) ?? {}), [SECURITY_AGENT_REPO_KEY]: real(repo.path) ?? repo.path });
}
