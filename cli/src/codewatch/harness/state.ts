/**
 * Session state of the harness loop: `.prism/harness/<session>.json` holds the
 * baseline snapshot and the round counter, `.prism/harness/cache/` the review
 * cache by diff hash. The directory is excluded from git through
 * `.git/info/exclude` (docs/DESIGN-harness-loop.md section 5).
 *
 * The file is not signed: an agent that edits it directly is outside the
 * loop's threat model (section 6.2). Values in an unexpected shape are ignored,
 * and a file that does not parse is renamed to `.bad` and never blocks.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureDirExcluded } from '../results.js';
import { HARNESS_DIR, revParse, snapshotTree } from './diff.js';

export const STATE_VERSION = 1;
export const MAX_STATE_FILES = 200;
export const CACHE_TTL_MS = 24 * 3600 * 1000;
const SHA = /^[0-9a-f]{40,64}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

export type Verdict = 'pass' | 'fix' | 'stop';

export interface LastRun { hash: string; verdict: Verdict; human_why: string | null; at: string }

export interface SessionState {
  version: typeof STATE_VERSION;
  session: string;
  client: string | null;
  started_at: string;
  head: string | null;
  baseline_tree: string | null;
  rounds: number;
  last: LastRun | null;
}

/** A client's session id reduced to `[A-Za-z0-9_-]{1,100}`, or null when nothing is left. */
export function sanitizeSession(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const s = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
  return s || null;
}

export const harnessDir = (repoRoot: string) => resolve(repoRoot, HARNESS_DIR);
export const statePath = (repoRoot: string, session: string) => join(harnessDir(repoRoot), `${session}.json`);

export function ensureHarnessDir(repoRoot: string): void {
  try { ensureDirExcluded(repoRoot, HARNESS_DIR, 'prism-cli harness loop state (local)'); } catch { /* never fail over this */ }
  mkdirSync(harnessDir(repoRoot), { recursive: true, mode: 0o700 });
}

function atomicWrite(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

/** Reads a session's state. Returns null when absent; a corrupt file is renamed to `.bad` with a warning. */
export function loadState(repoRoot: string, session: string, warnings: string[] = []): SessionState | null {
  const p = statePath(repoRoot, session);
  let text: string;
  try { text = readFileSync(p, 'utf8'); } catch { return null; }
  let v: any; // any: untrusted JSON, every field is checked below
  try { v = JSON.parse(text); } catch { v = null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    try { renameSync(p, `${p}.bad`); } catch { /* ignore */ }
    warnings.push(`harness state for session ${session} could not be read; renamed it to ${session}.json.bad and started again at round 1`);
    return null;
  }
  const str = (x: unknown, re?: RegExp) => (typeof x === 'string' && (!re || re.test(x)) ? x : null);
  const lv = v.last && typeof v.last === 'object' ? v.last : null;
  const last: LastRun | null = lv && str(lv.hash, HASH) && ['pass', 'fix', 'stop'].includes(lv.verdict)
    ? { hash: lv.hash, verdict: lv.verdict, human_why: str(lv.human_why), at: str(lv.at) || '' }
    : null;
  return {
    version: STATE_VERSION,
    session,
    client: str(v.client),
    started_at: str(v.started_at) || new Date().toISOString(),
    head: str(v.head, SHA),
    baseline_tree: str(v.baseline_tree, SHA),
    rounds: Number.isInteger(v.rounds) && v.rounds >= 0 && v.rounds <= 100 ? v.rounds : 0,
    last,
  };
}

export function saveState(repoRoot: string, s: SessionState): void {
  ensureHarnessDir(repoRoot);
  atomicWrite(statePath(repoRoot, s.session), s);
}

export function deleteState(repoRoot: string, session: string): void {
  rmSync(statePath(repoRoot, session), { force: true });
}

/**
 * SessionStart: snapshot the working tree as this session's baseline. A
 * session that already has a baseline (resume, clear, compact) keeps it, so
 * the agent's earlier edits stay attributed to it.
 */
export function recordBaseline(repoRoot: string, session: string, client: string | null, now = new Date()): SessionState {
  const warnings: string[] = [];
  const existing = loadState(repoRoot, session, warnings);
  if (existing?.baseline_tree) return existing;
  ensureHarnessDir(repoRoot);
  const s: SessionState = {
    version: STATE_VERSION, session, client, started_at: now.toISOString(),
    head: revParse(repoRoot, 'HEAD^{commit}'), baseline_tree: snapshotTree(repoRoot), rounds: existing?.rounds ?? 0, last: existing?.last ?? null,
  };
  saveState(repoRoot, s);
  return s;
}

/** Deletes state older than `ttlDays`, keeps at most MAX_STATE_FILES, and drops cache entries older than a day. */
export function cleanupState(repoRoot: string, ttlDays: number, now = Date.now()): void {
  const dir = harnessDir(repoRoot);
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  const files = names
    .filter((n) => n.endsWith('.json') || n.endsWith('.json.bad'))
    .map((n) => { try { return { p: join(dir, n), m: statSync(join(dir, n)).mtimeMs }; } catch { return null; } })
    .filter((x): x is { p: string; m: number } => !!x)
    .sort((a, b) => b.m - a.m);
  files.forEach((f, i) => {
    if (i >= MAX_STATE_FILES || now - f.m > ttlDays * 24 * 3600 * 1000) rmSync(f.p, { force: true });
  });
  const cache = join(dir, 'cache');
  let cached: string[] = [];
  try { cached = readdirSync(cache); } catch { return; }
  for (const n of cached) {
    try { if (now - statSync(join(cache, n)).mtimeMs > CACHE_TTL_MS) rmSync(join(cache, n), { force: true }); } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------ review cache

export interface CachedReview {
  hash: string;
  tool: string;
  model: string | null;
  findings: import('../results.js').Finding[];
  summary: string | null;
  score: number | null;
}

const cacheFile = (repoRoot: string, hash: string) => join(harnessDir(repoRoot), 'cache', `${hash.replace(/^sha256:/, '')}.json`);

export function readCache(repoRoot: string, hash: string, now = Date.now()): CachedReview | null {
  const f = cacheFile(repoRoot, hash);
  try {
    if (now - statSync(f).mtimeMs > CACHE_TTL_MS) return null;
    const v = JSON.parse(readFileSync(f, 'utf8'));
    return v && v.hash === hash && Array.isArray(v.findings) ? v : null;
  } catch { return null; }
}

export function writeCache(repoRoot: string, c: CachedReview): void {
  try {
    ensureHarnessDir(repoRoot);
    mkdirSync(join(harnessDir(repoRoot), 'cache'), { recursive: true, mode: 0o700 });
    atomicWrite(cacheFile(repoRoot, c.hash), c);
  } catch { /* a cache that cannot be written only costs a review */ }
}
