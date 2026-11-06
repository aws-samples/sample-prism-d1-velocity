/**
 * The local record that `prism-cli enable security` finished in this repo:
 * `.prism/security.local.json`. Ids, account and region only, never a secret.
 * It is per developer and never committed (`.prism/config.json` stays safe to
 * commit for the team reviewer). The dashboard's Security Agent row reads it,
 * so the dashboard stays credential-free.
 *
 * Earlier versions wrote the same block as `security` inside
 * `.prism/config.json`. Readers fall back to it, and the next successful
 * `enable security` run moves it here.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { RunResult } from '../utils/exec.js';
import { CONFIG_PATH, readPrismConfig } from '../codewatch/config.js';

export const MARKER_PATH = '.prism/security.local.json';

export interface SecurityMarker {
  agentSpaceId: string;
  applicationId: string;
  codeReviewId: string;
  region: string;
  account: string;
  setupAt: string;
}

const REQUIRED: (keyof SecurityMarker)[] = ['agentSpaceId', 'codeReviewId', 'region', 'account'];

function parseMarker(s: any): SecurityMarker | null {
  if (!s || typeof s !== 'object') return null;
  for (const k of REQUIRED) if (typeof s[k] !== 'string' || !s[k]) return null;
  return {
    agentSpaceId: s.agentSpaceId, applicationId: typeof s.applicationId === 'string' ? s.applicationId : '',
    codeReviewId: s.codeReviewId, region: s.region, account: s.account,
    setupAt: typeof s.setupAt === 'string' ? s.setupAt : '',
  };
}

function readLocal(repoRoot: string): SecurityMarker | null {
  try { return parseMarker(JSON.parse(readFileSync(resolve(repoRoot, MARKER_PATH), 'utf8'))); } catch { return null; }
}

/** The marker and where it came from: the local file first, else the legacy `security` block. */
export function readSecurityMarkerWithSource(repoRoot: string): { marker: SecurityMarker; source: 'local' | 'legacy' } | null {
  const local = readLocal(repoRoot);
  if (local) return { marker: local, source: 'local' };
  const legacy = parseMarker(readPrismConfig(repoRoot).security);
  return legacy ? { marker: legacy, source: 'legacy' } : null;
}

/** The marker, or null when it is absent or incomplete. */
export function readSecurityMarker(repoRoot: string): SecurityMarker | null {
  return readSecurityMarkerWithSource(repoRoot)?.marker ?? null;
}

/** The indent a JSON file uses (its first indented line), so a rewrite keeps the look. */
function detectIndent(text: string): string | number {
  const m = /\n([ \t]+)"/.exec(text);
  return m ? m[1] : 2;
}

/**
 * Removes only the `security` key from `.prism/config.json`, keeping every
 * other key, its order, the indent and the trailing newline. Returns true when
 * the key was there.
 */
export function removeLegacyBlock(repoRoot: string): boolean {
  const p = resolve(repoRoot, CONFIG_PATH);
  let text: string;
  let cfg: any;
  try { text = readFileSync(p, 'utf8'); cfg = JSON.parse(text); } catch { return false; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || !('security' in cfg)) return false;
  delete cfg.security;
  writeFileSync(p, JSON.stringify(cfg, null, detectIndent(text)) + (text.endsWith('\n') ? '\n' : ''));
  return true;
}

export interface MarkerWrite {
  path: string;
  /** False when the file already held the same ids (setupAt is then kept). */
  wrote: boolean;
  /** A legacy `security` block was removed from `.prism/config.json`. */
  migrated: boolean;
}

/**
 * Writes `.prism/security.local.json`. setupAt is kept when nothing else
 * changed, so a re-run that changes nothing leaves the file as it was. A
 * legacy block in `.prism/config.json` is removed after the new file is written.
 */
export function writeSecurityMarker(repoRoot: string, m: Omit<SecurityMarker, 'setupAt'>, now: Date): MarkerWrite {
  const p = resolve(repoRoot, MARKER_PATH);
  const prev = readSecurityMarkerWithSource(repoRoot);
  const pm = prev?.marker;
  const same = !!pm && pm.agentSpaceId === m.agentSpaceId && pm.applicationId === m.applicationId
    && pm.codeReviewId === m.codeReviewId && pm.region === m.region && pm.account === m.account && !!pm.setupAt;
  let wrote = false;
  if (!(same && prev!.source === 'local')) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ ...m, setupAt: same ? pm!.setupAt : now.toISOString() }, null, 2) + '\n');
    wrote = !same;
  }
  const migrated = removeLegacyBlock(repoRoot);
  return { path: p, wrote, migrated };
}

/**
 * Makes sure git ignores the marker in this clone, without touching the repo's
 * .gitignore: when `git check-ignore` says it is not ignored, the path is added
 * to `info/exclude` (resolved with `git rev-parse --git-path`, so linked
 * worktrees use the right file). Returns the exclude file when it was changed.
 */
export function ensureMarkerIgnored(repoRoot: string, git: (args: string[]) => RunResult): string | null {
  if (git(['-C', repoRoot, 'check-ignore', '-q', MARKER_PATH]).ok) return null;
  const r = git(['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
  if (!r.ok || !r.stdout) return null;
  const exclude = r.stdout.trim();
  const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (text.split('\n').some((l) => l.trim() === MARKER_PATH || l.trim() === `/${MARKER_PATH}`)) return null;
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}# prism-cli enable security: per-developer record, never committed\n${MARKER_PATH}\n`);
  return exclude;
}
