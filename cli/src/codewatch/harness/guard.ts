/**
 * Tamper paths, and who changed them (decision D6, docs/DESIGN-harness-loop.md).
 *
 * A session can last a long time (Kiro IDE keeps one session per opened
 * folder), so the person edits files during it too. Hooks around every agent
 * tool call record a hash of each guarded file in
 * `<git common dir>/prism/harness/<session>.guard.json` (outside the worktree):
 *
 * - `pre` (PreToolUse): changes since the last snapshot happened while no
 *   agent tool ran, so they are the person's, unless a window is still open (a
 *   parallel call, or a PreToolUse with no PostToolUse: crash, timeout) or an
 *   event was missed, in which case they stay the agent's. Then a window
 *   opens. An open window that never closes stops counting after WINDOW_TTL_MS.
 * - `post` (PostToolUse): changes inside the window are the agent's; the
 *   window closes.
 * - `start` (SessionStart): the first snapshot. Nothing is the person's yet.
 *
 * The finish and push checks never fold anything themselves, so a change
 * after the last PostToolUse counts as the agent's. A guarded file is the
 * person's only while it still holds exactly the content they left, and never
 * once the agent changed it inside a window during this session. Only tamper
 * attribution uses this: secrets in session lines block whoever wrote them.
 *
 * shortcut: an agent that edits a guarded file from a detached background
 * process between tool calls is taken for the person, and one that writes the
 * record itself (it is not signed) can claim a change. Deliberate evasion is a
 * non-goal (section 1); the push-time secret scan and the CI gate still apply.
 */
import { createHash, randomBytes } from 'node:crypto';
import { linkSync, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHarnessDir, harnessDir } from './state.js';

/** Paths whose change during a session ends the loop (section 6.2). PRISM's own output
 * (`.prism/results/**`, and the harness state, which lives in the git directory) never appears
 * in a diff or snapshot, so it is not listed (the section 6.2 non-goal). */
export const TAMPER_GLOBS = [
  '.gitleaksignore', '.gitleaks.toml', '.prism/gitleaks-baseline.json',
  '.prism/config.json', '.prism/review/rules.md',
  '.kiro/steering/code-review.md', '.github/workflows/prism-*.yml', '.prism/gitlab-workflows/**',
  '.claude/settings*.json', 'claude-plugin/hooks/**', '.cursor/hooks.json', '.codex/hooks.json', '.codex/config.toml', '.kiro/hooks/**',
];
/** Tamper globs are anchored at the repo root, unlike skip_paths. */
const TAMPER_RES = TAMPER_GLOBS.map((g) => new RegExp(`^${g.split('**').map((p) => p.split('*').map((s) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^/]*')).join('.*')}$`));
export const isTamperPath = (p: string) => TAMPER_RES.some((re) => re.test(p));

/** Most guarded files hashed per snapshot. A snapshot cut off there attributes nothing to the person. */
const MAX_FILES = 500;
/**
 * Files larger than this get a fixed fingerprint of their stat key instead of a content hash.
 * Guarded files are configs and hook files of a few KB; this only bounds a pathological one.
 */
const MAX_HASH_BYTES = 16 * 1024 * 1024;

/** Guarded paths without a wildcard: checked with one lstat each, no directory listing. */
const EXACT = TAMPER_GLOBS.filter((g) => !g.includes('*'));
/** Directories a wildcard entry can match in (`.github/workflows`, `.kiro/hooks` ...), and whether to walk them. */
const GLOB_DIRS: [string, boolean][] = [...new Map(TAMPER_GLOBS.filter((g) => g.includes('*')).map((g) => {
  const parts = g.split('/');
  return [parts.slice(0, parts.findIndex((s) => s.includes('*'))).join('/'), g.includes('**')] as [string, boolean];
}).sort((a, b) => Number(a[1]) - Number(b[1]))).entries()];

/** What changes when a file's content or identity does; ctime cannot be set back by a tool. */
const statKey = (st: { size: number; mtimeMs: number; ctimeMs: number; ino: number }) => `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;

export interface Snapshot {
  /** sha256 of every guarded file that exists, by repo-relative path. */
  hashes: Record<string, string>;
  /** Their stat keys: a file whose key is unchanged is not read again. */
  stats: Record<string, string>;
  /** False when MAX_FILES cut the snapshot off. */
  complete: boolean;
}

/**
 * The guarded files now. No git call: this runs around every tool. A file whose stat key matches
 * `prev` keeps its hash without being read.
 */
export function tamperHashes(repoRoot: string, prev?: Pick<Snapshot, 'hashes' | 'stats'> | null): Snapshot {
  const hashes: Record<string, string> = {};
  const stats: Record<string, string> = {};
  let complete = true;
  const add = (p: string): boolean => {
    let st;
    try { st = lstatSync(join(repoRoot, p)); } catch { return true; } // absent
    if (st.isDirectory()) return true;
    if (!(st.isFile() || st.isSymbolicLink()) || !isTamperPath(p) || p in hashes) return true;
    if (Object.keys(hashes).length >= MAX_FILES) { complete = false; return false; }
    const key = statKey(st);
    stats[p] = key;
    if (prev?.stats[p] === key && prev.hashes[p]) { hashes[p] = prev.hashes[p]; return true; }
    const h = createHash('sha256');
    try {
      // A symlink is fingerprinted by its target, so replacing a guarded file with a link is a change.
      if (st.isSymbolicLink()) h.update(`symlink:${readlinkSync(join(repoRoot, p))}`);
      else if (st.size > MAX_HASH_BYTES) h.update(`large:${key}`);
      else h.update(readFileSync(join(repoRoot, p)));
      hashes[p] = h.digest('hex');
    } catch {
      // Present but unreadable: a fixed fingerprint, so it is never mistaken for a deletion.
      hashes[p] = createHash('sha256').update(`unreadable:${p}`).digest('hex');
    }
    return true;
  };
  const walk = (rel: string, deep: boolean): boolean => {
    let names: string[];
    try { names = readdirSync(join(repoRoot, rel)); } catch { return true; } // no such directory: nothing guarded there
    for (const name of names) {
      const p = rel ? `${rel}/${name}` : name;
      if (deep) { try { if (lstatSync(join(repoRoot, p)).isDirectory()) { if (!walk(p, true)) return false; continue; } } catch { continue; } }
      if (!add(p)) return false;
    }
    return true;
  };
  for (const p of EXACT) if (!add(p)) break;
  if (complete) for (const [dir, deep] of GLOB_DIRS) if (!walk(dir, deep)) break;
  return { hashes, stats, complete };
}

/** A window with an id that never closes (no PostToolUse) stops counting as open after this long. */
export const WINDOW_TTL_MS = 30 * 60 * 1000;

export interface Guard {
  version: 3;
  /**
   * Open windows without an id (Kiro sends none), as the times they opened: a PostToolUse closes
   * the oldest. A count, not a flag, so overlapping calls keep the window open until all closed.
   */
  anon: number[];
  /**
   * Open windows by tool-call id (Claude Code's tool_use_id), with the time each opened, so
   * parallel tool calls and subagents keep a window open until each has closed.
   */
  windows: Record<string, number>;
  /** The guarded files at the last snapshot, and their stat keys. */
  hashes: Record<string, string>;
  stats: Record<string, string>;
  /** Guarded files the person changed, with the content they left (null: they deleted it). */
  person: Record<string, string | null>;
  /** Guarded files that changed while a window was open: never the person's for the rest of the session. */
  agent: Record<string, true>;
}

export const guardPath = (repoRoot: string, session: string) => join(harnessDir(repoRoot), `${session}.guard.json`);

const isHashMap = (v: unknown, nullable: boolean): v is Record<string, string | null> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.values(v as object).every((h) => (nullable && h === null) || (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)));
const isStringMap = (v: unknown): v is Record<string, string> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((s) => typeof s === 'string');

/** The session's guard, or null when absent or not in the expected shape (then nothing is the person's). */
export function loadGuard(repoRoot: string, session: string): Guard | null {
  let v: any; // any: untrusted JSON, checked below
  try { v = JSON.parse(readFileSync(guardPath(repoRoot, session), 'utf8')); } catch { return null; }
  if (!v || v.version !== 3 || !Array.isArray(v.anon) || !isHashMap(v.hashes, false) || !isHashMap(v.person, true) || !isStringMap(v.stats)) return null;
  const windows: Record<string, number> = {};
  if (v.windows && typeof v.windows === 'object') for (const [id, t] of Object.entries(v.windows)) if (Number.isFinite(t)) windows[id] = t as number;
  const agent: Record<string, true> = {};
  if (v.agent && typeof v.agent === 'object') for (const k of Object.keys(v.agent)) agent[k] = true;
  return { version: 3, anon: v.anon.filter(Number.isFinite), windows, hashes: v.hashes as Record<string, string>, stats: v.stats, person: v.person, agent };
}

function saveGuard(repoRoot: string, session: string, g: Guard): void {
  ensureHarnessDir(repoRoot);
  const p = guardPath(repoRoot, session);
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(g) + '\n', { mode: 0o600 });
    renameSync(tmp, p);
  } finally { rmSync(tmp, { force: true }); }
}

export type GuardEvent = 'start' | 'pre' | 'post';

/**
 * Who changed what, from the last snapshot to now (pure, see the module comment). `windowOpen` is
 * true when a window was open since the last snapshot, or an event may have been missed.
 */
export function attribute(
  prev: Pick<Guard, 'hashes' | 'person' | 'agent'> | null,
  now: Record<string, string>,
  event: GuardEvent,
  windowOpen: boolean,
  complete: boolean,
): { person: Record<string, string | null>; agent: Record<string, true> } {
  const person = { ...(prev?.person ?? {}) };
  const agent = { ...(prev?.agent ?? {}) };
  if (!prev) return { person, agent };
  const changed = [...new Set([...Object.keys(prev.hashes), ...Object.keys(now)])].filter((p) => prev.hashes[p] !== now[p]);
  // A cut-off snapshot cannot tell an unhashed file from a deleted one: attribute nothing to the person then.
  if (event === 'pre' && !windowOpen && complete) {
    for (const p of changed) if (!agent[p]) person[p] = now[p] ?? null;
  } else if (event === 'post' || windowOpen) {
    // Changed inside a window: the agent's, and a later edit by the person does not hide it.
    for (const p of changed) { agent[p] = true; delete person[p]; }
  }
  return { person, agent };
}

/** A lock held longer than the window hooks' own timeout (15 s) has no live holder. */
const LOCK_STALE_MS = 15_000;

/** True when the holder named in a lock file (`pid:time:nonce`) is dead or older than LOCK_STALE_MS. */
const holderGone = (content: string): boolean => {
  const [pid, at] = content.split(':').map(Number);
  // Lock files are created complete (createExclusive), so unparseable content is not a half-written lock.
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(at)) return true;
  if (Date.now() - at > LOCK_STALE_MS) return true;
  try { process.kill(pid, 0); return false; } catch (e: any) { return e?.code === 'ESRCH'; } // any: signal error, code only
};

/**
 * Creates `path` holding `token`, only if it does not exist (false then). The content is written
 * to a private file first and hard-linked into place, so no reader ever sees an empty lock.
 */
function createExclusive(path: string, token: string): boolean {
  const tmp = `${path}.${token.replace(/:/g, '-')}.new`;
  try {
    writeFileSync(tmp, token, { flag: 'wx', mode: 0o600 });
    linkSync(tmp, path);
    return true;
  } catch (e: any) { // any: fs error, code only
    if (e?.code === 'EEXIST') return false;
    throw e;
  } finally { rmSync(tmp, { force: true }); }
}

/**
 * Takes `<guard>.lock` (an exclusive create holding pid:time:nonce) without waiting. A lock whose
 * holder is dead or older than LOCK_STALE_MS is broken only by the one process that creates
 * `<lock>.break` (exclusive too): it checks the lock still holds what it judged stale, then
 * renames its own lock file into place, so the lock path is never empty and two breakers cannot
 * both win.
 *
 * shortcut: a `.break` left by a breaker killed mid-break is removed once stale, and that event
 * counts as missed; removing it while another breaker starts could let two break at once. It needs
 * a hook killed inside a few lines plus three hooks at the same moment; the holder's read-back
 * before saving (guardEvent) is the backstop.
 */
export function takeLock(lock: string, token: string): boolean {
  if (createExclusive(lock, token)) return true;
  let held: string;
  try { held = readFileSync(lock, 'utf8'); } catch { return false; }
  if (!holderGone(held)) return false;
  const brk = `${lock}.break`;
  if (!createExclusive(brk, token)) {
    try { if (holderGone(readFileSync(brk, 'utf8'))) rmSync(brk, { force: true }); } catch { /* gone */ }
    return false;
  }
  const mine = `${lock}.${token.replace(/:/g, '-')}`;
  try {
    if (readFileSync(lock, 'utf8') !== held) return false; // released or replaced meanwhile
    writeFileSync(mine, token, { flag: 'wx', mode: 0o600 });
    renameSync(mine, lock);
    return true;
  } catch { return false; } finally { rmSync(mine, { force: true }); rmSync(brk, { force: true }); }
}

const taintPrefix = (session: string) => `${session}.guard.missed.`;

/** Marks that an event could not be recorded: the next recorded event folds nothing to the person. */
function taint(repoRoot: string, session: string): void {
  ensureHarnessDir(repoRoot);
  writeFileSync(join(harnessDir(repoRoot), `${taintPrefix(session)}${process.pid}.${randomBytes(4).toString('hex')}`), '', { flag: 'wx', mode: 0o600 });
}

const listTaints = (repoRoot: string, session: string): string[] => {
  try { return readdirSync(harnessDir(repoRoot)).filter((n) => n.startsWith(taintPrefix(session))); } catch { return []; }
};
const hasTaints = (repoRoot: string, session: string) => listTaints(repoRoot, session).length > 0;

function takeTaints(repoRoot: string, session: string): boolean {
  const names = listTaints(repoRoot, session);
  for (const n of names) rmSync(join(harnessDir(repoRoot), n), { force: true });
  return names.length > 0;
}

/**
 * Records one hook event (see the module comment). Parallel tool calls run their hooks at the
 * same time; one that cannot take the lock does not wait: it leaves a "missed" marker, so the next
 * recorded event folds nothing to the person (fail toward the agent). Errors are thrown; callers
 * report them and go on, which also leaves changes the agent's.
 */
export function guardEvent(repoRoot: string, session: string, event: GuardEvent, toolId: string | null = null, nowMs = Date.now()): void {
  ensureHarnessDir(repoRoot);
  const lock = `${guardPath(repoRoot, session)}.lock`;
  const token = `${process.pid}:${Date.now()}:${randomBytes(6).toString('hex')}`;
  if (!takeLock(lock, token)) { if (event !== 'start') taint(repoRoot, session); return; }
  try {
    const next = nextGuard(repoRoot, session, event, toolId, nowMs);
    // A lock taken from this process (held past LOCK_STALE_MS) saves nothing and counts as missed.
    // shortcut: a breaker between this read and the save can still lose one write to it.
    if (next && readFileSync(lock, 'utf8') === token) saveGuard(repoRoot, session, next);
    else if (next && event !== 'start') taint(repoRoot, session);
  } finally {
    try { if (readFileSync(lock, 'utf8') === token) rmSync(lock, { force: true }); } catch { /* gone */ }
  }
}

function nextGuard(repoRoot: string, session: string, event: GuardEvent, toolId: string | null, nowMs: number): Guard | null {
  const prev = loadGuard(repoRoot, session);
  if (event === 'start' && prev) return null; // a resumed session keeps its record
  const snap = tamperHashes(repoRoot, prev);
  const missed = takeTaints(repoRoot, session);
  const open = !!prev && (prev.anon.length > 0 || Object.keys(prev.windows).length > 0);
  const { person, agent } = attribute(event === 'start' ? null : prev, snap.hashes, event, open || missed, snap.complete);
  // Windows that never closed stop counting once stale; their changes were already kept the agent's above.
  const fresh = (t: number) => nowMs - t < WINDOW_TTL_MS;
  const windows = Object.fromEntries(Object.entries(prev?.windows ?? {}).filter(([, t]) => fresh(t)));
  const anon = (prev?.anon ?? []).filter(fresh).sort((a, b) => a - b);
  if (toolId) { if (event === 'pre') windows[toolId] = nowMs; else if (event === 'post') delete windows[toolId]; }
  else if (event === 'pre') anon.push(nowMs);
  else if (event === 'post') anon.shift();
  return { version: 3, anon, windows, hashes: snap.hashes, stats: snap.stats, person, agent };
}

/** guardEvent for a hook: never throws; returns a one-line note for stderr when nothing could be recorded. */
export function recordWindow(repoRoot: string, session: string | null, event: GuardEvent, toolId?: unknown): string {
  if (!session) return '';
  const id = typeof toolId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(toolId) ? toolId : null;
  try { guardEvent(repoRoot, session, event, id); return ''; } catch (e: any) { // any: fs error, message only
    try { taint(repoRoot, session); } catch { /* the record stays as it was */ }
    return `PRISM harness: could not record the tool window (${String(e?.message || e).split('\n')[0].slice(0, 200)}); changes to guarded files count as the agent's.\n`;
  }
}

/**
 * The given guarded paths that the person changed and that still hold exactly what they left.
 * With `ownToolId` (Claude Code's push check, whose `pre-tool` hook runs in parallel and may not
 * have folded yet), the gap since the last snapshot is folded here too, in memory only, with that
 * call's own window set aside: the same result the `pre` event gives, without waiting for its lock.
 */
export function personsChanges(repoRoot: string, session: string, paths: string[], ownToolId?: string | null, nowMs = Date.now()): Set<string> {
  const g = paths.length ? loadGuard(repoRoot, session) : null;
  if (!g) return new Set();
  const snap = tamperHashes(repoRoot, g);
  let { person, agent } = g;
  if (ownToolId) {
    const fresh = (t: number) => nowMs - t < WINDOW_TTL_MS;
    const open = g.anon.some(fresh) || Object.entries(g.windows).some(([id, t]) => id !== ownToolId && fresh(t));
    ({ person, agent } = attribute(g, snap.hashes, 'pre', open || hasTaints(repoRoot, session), snap.complete));
  }
  return new Set(paths.filter((p) => p in person && !agent[p] && (snap.hashes[p] ?? null) === person[p]));
}

export function deleteGuard(repoRoot: string, session: string): void {
  rmSync(guardPath(repoRoot, session), { force: true });
  takeTaints(repoRoot, session);
}
