/**
 * Tamper paths, and who changed them (decision D6, docs/DESIGN-harness-loop.md).
 *
 * A session can last a long time (Kiro IDE keeps one session per opened
 * folder), so the person edits files during it too. Hooks around every agent
 * tool call record a hash of each guarded file in
 * `.prism/harness/<session>.guard.json`:
 *
 * - `pre` (PreToolUse): changes since the last snapshot happened while no
 *   agent tool ran, so they are the person's, unless a window is still open (a
 *   parallel call, or a PreToolUse with no PostToolUse: crash, timeout), in
 *   which case they stay the agent's. Then a window opens. An open window that
 *   never closes stops counting after WINDOW_TTL_MS.
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
 * process between tool calls is taken for the person, and the guard record
 * itself, like the session state (section 6.2), is not signed, so an agent
 * that writes it directly can claim a change. Deliberate evasion is a non-goal
 * (section 1); the push-time secret scan and the CI gate still apply.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHarnessDir, harnessDir } from './state.js';

/** Paths whose change during a session ends the loop (section 6.2). `.prism/results/**` and
 * `.prism/harness/**` are on the design's list but never appear here: every diff and snapshot
 * excludes PRISM's own output, so an edit to them is never seen (the section 6.2 non-goal). */
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
/** Files larger than this are fingerprinted by size and mtime instead of read, to keep every tool call fast. */
const MAX_HASH_BYTES = 1024 * 1024;

/** The directories that can hold a guarded file, and whether to walk them recursively. */
const ROOTS: [string, boolean][] = [...new Map(TAMPER_GLOBS.map((g) => {
  const parts = g.split('/');
  const k = parts.findIndex((s) => s.includes('*'));
  return [(k < 0 ? parts.slice(0, -1) : parts.slice(0, k)).join('/'), g.includes('**')] as [string, boolean];
}).sort((a, b) => Number(a[1]) - Number(b[1]))).entries()];

/**
 * sha256 of every guarded file that exists, by repo-relative path, and whether the snapshot is
 * complete (under MAX_FILES). No git call: this runs around every tool.
 */
export function tamperHashes(repoRoot: string): { hashes: Record<string, string>; complete: boolean } {
  const out: Record<string, string> = {};
  let n = 0;
  let complete = true;
  const walk = (rel: string, deep: boolean) => {
    let names: string[];
    try { names = readdirSync(join(repoRoot, rel)); } catch { return; } // no such directory: nothing guarded there
    for (const name of names) {
      const p = rel ? `${rel}/${name}` : name;
      let st;
      try { st = lstatSync(join(repoRoot, p)); } catch { continue; } // removed while walking: absent
      if (st.isDirectory()) { if (deep) walk(p, true); continue; }
      if (!(st.isFile() || st.isSymbolicLink()) || !isTamperPath(p) || p in out) continue;
      if (n >= MAX_FILES) { complete = false; return; }
      const h = createHash('sha256');
      try {
        // A symlink is fingerprinted by its target, so replacing a guarded file with a link is a change.
        if (st.isSymbolicLink()) h.update(`symlink:${readlinkSync(join(repoRoot, p))}`);
        else if (st.size > MAX_HASH_BYTES) h.update(`size:${st.size}:mtime:${st.mtimeMs}`); else h.update(readFileSync(join(repoRoot, p)));
        out[p] = h.digest('hex');
      } catch {
        // Present but unreadable: a fixed fingerprint, so it is never mistaken for a deletion.
        out[p] = createHash('sha256').update(`unreadable:${p}`).digest('hex');
      }
      n++;
    }
  };
  for (const [dir, deep] of ROOTS) walk(dir, deep);
  return { hashes: out, complete };
}

/** A window with an id that never closes (no PostToolUse) stops counting as open after this long. */
export const WINDOW_TTL_MS = 30 * 60 * 1000;

export interface Guard {
  version: 2;
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
  /** The guarded files at the last snapshot. */
  hashes: Record<string, string>;
  /** Guarded files the person changed, with the content they left (null: they deleted it). */
  person: Record<string, string | null>;
  /** Guarded files that changed while a window was open: never the person's for the rest of the session. */
  agent: Record<string, true>;
}

export const guardPath = (repoRoot: string, session: string) => join(harnessDir(repoRoot), `${session}.guard.json`);

const isHashMap = (v: unknown, nullable: boolean): v is Record<string, string | null> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.values(v as object).every((h) => (nullable && h === null) || (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)));

/** The session's guard, or null when absent or not in the expected shape (then nothing is the person's). */
export function loadGuard(repoRoot: string, session: string): Guard | null {
  let v: any; // any: untrusted JSON, checked below
  try { v = JSON.parse(readFileSync(guardPath(repoRoot, session), 'utf8')); } catch { return null; }
  if (!v || v.version !== 2 || !Array.isArray(v.anon) || !isHashMap(v.hashes, false) || !isHashMap(v.person, true)) return null;
  const windows: Record<string, number> = {};
  if (v.windows && typeof v.windows === 'object') for (const [id, t] of Object.entries(v.windows)) if (Number.isFinite(t)) windows[id] = t as number;
  const agent: Record<string, true> = {};
  if (v.agent && typeof v.agent === 'object') for (const k of Object.keys(v.agent)) agent[k] = true;
  return { version: 2, anon: v.anon.filter(Number.isFinite), windows, hashes: v.hashes as Record<string, string>, person: v.person, agent };
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

/** Lock wait, poll and stale age: hook processes for parallel tool calls write the same guard file. */
const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 10;
const LOCK_STALE_MS = 10_000;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** Runs `fn` holding `<guard>.lock` (an exclusive create). Throws when the lock cannot be had, which leaves changes the agent's. */
function withLock<T>(repoRoot: string, session: string, fn: () => T): T {
  ensureHarnessDir(repoRoot);
  const lock = `${guardPath(repoRoot, session)}.lock`;
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); break; } catch (e: any) { // any: fs error, code only
      if (e?.code !== 'EEXIST') throw e;
      // shortcut: two waiters that both find the same stale lock (a hook killed while holding it)
      // can both remove it and race once; a lock with a pid check would close that, if it shows up.
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true }); } catch { /* gone already */ }
      if (Date.now() > until) throw new Error('the tool window record is locked by another hook');
      Atomics.wait(SLEEP_CELL, 0, 0, LOCK_POLL_MS); // a synchronous sleep: the hook is a short-lived process
    }
  }
  try { return fn(); } finally { rmSync(lock, { force: true }); }
}

/**
 * Records one hook event (see the module comment) under a lock, since parallel tool calls run
 * their hooks at the same time. Errors are thrown; callers report them and go on, which leaves
 * changes the agent's.
 */
export function guardEvent(repoRoot: string, session: string, event: GuardEvent, toolId: string | null = null, nowMs = Date.now()): void {
  withLock(repoRoot, session, () => guardEventLocked(repoRoot, session, event, toolId, nowMs));
}

function guardEventLocked(repoRoot: string, session: string, event: GuardEvent, toolId: string | null, nowMs: number): void {
  if (event === 'start' && loadGuard(repoRoot, session)) return; // a resumed session keeps its record
  const { hashes: now, complete } = tamperHashes(repoRoot);
  const prev = event === 'start' ? null : loadGuard(repoRoot, session);
  const person = { ...(prev?.person ?? {}) };
  const agent = { ...(prev?.agent ?? {}) };
  const anyOpen = !!prev && (prev.anon.length > 0 || Object.keys(prev.windows).length > 0);
  const changed = prev ? [...new Set([...Object.keys(prev.hashes), ...Object.keys(now)])].filter((p) => prev.hashes[p] !== now[p]) : [];
  // A cut-off snapshot cannot tell an unhashed file from a deleted one: attribute nothing then.
  if (event === 'pre' && prev && !anyOpen && complete) {
    for (const p of changed) if (!agent[p]) person[p] = now[p] ?? null;
  } else if (event === 'post' || anyOpen) {
    // Changed inside a window: the agent's, and a later edit by the person does not hide it.
    for (const p of changed) { agent[p] = true; delete person[p]; }
  }
  // Windows that never closed stop counting once stale; their changes were already kept the agent's above.
  const fresh = (t: number) => nowMs - t < WINDOW_TTL_MS;
  const windows = Object.fromEntries(Object.entries(prev?.windows ?? {}).filter(([, t]) => fresh(t)));
  const anon = (prev?.anon ?? []).filter(fresh).sort((a, b) => a - b);
  if (toolId) { if (event === 'pre') windows[toolId] = nowMs; else if (event === 'post') delete windows[toolId]; }
  else if (event === 'pre') anon.push(nowMs);
  else if (event === 'post') anon.shift();
  saveGuard(repoRoot, session, { version: 2, anon, windows, hashes: now, person, agent });
}

/** guardEvent for a hook: never throws; returns a one-line note for stderr when nothing could be recorded. */
export function recordWindow(repoRoot: string, session: string | null, event: GuardEvent, toolId?: unknown): string {
  if (!session) return '';
  const id = typeof toolId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(toolId) ? toolId : null;
  try { guardEvent(repoRoot, session, event, id); return ''; } catch (e: any) { // any: fs error, message only
    return `PRISM harness: could not record the tool window (${String(e?.message || e).split('\n')[0].slice(0, 200)}); changes to guarded files count as the agent's.\n`;
  }
}

/** The given guarded paths that the person changed and that still hold exactly what they left. */
export function personsChanges(repoRoot: string, session: string, paths: string[]): Set<string> {
  const g = paths.length ? loadGuard(repoRoot, session) : null;
  if (!g) return new Set();
  const { hashes: now } = tamperHashes(repoRoot);
  return new Set(paths.filter((p) => p in g.person && !g.agent[p] && (now[p] ?? null) === g.person[p]));
}

export const deleteGuard = (repoRoot: string, session: string) => rmSync(guardPath(repoRoot, session), { force: true });
