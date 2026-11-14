/**
 * Tamper paths, and who changed them (decision D6, docs/DESIGN-harness-loop.md).
 *
 * A session can last a long time (Kiro IDE keeps one session per opened
 * folder), so the person edits files during it too. Hooks around every agent
 * tool call record a hash of each guarded file in
 * `.prism/harness/<session>.guard.json`:
 *
 * - `pre` (PreToolUse): changes since the last snapshot happened while no
 *   agent tool ran, so they are the person's, unless the previous window never
 *   closed (a PreToolUse with no PostToolUse: crash, timeout), in which case
 *   they stay the agent's. Then a window opens.
 * - `post` (PostToolUse): changes inside the window are the agent's; the
 *   window closes.
 * - `start` (SessionStart): the first snapshot. Nothing is the person's yet.
 *
 * The finish and push checks never fold anything themselves, so a change
 * after the last PostToolUse counts as the agent's. A guarded file is the
 * person's only while it still holds exactly the content they left; any later
 * change, by anyone inside a window, makes it session tamper again. Only tamper
 * attribution uses this: secrets in session lines block whoever wrote them.
 *
 * shortcut: an agent that edits a guarded file from a detached background
 * process between tool calls is taken for the person. Deliberate evasion is a
 * non-goal (section 1); the push-time secret scan and the CI gate still apply.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
    try { names = readdirSync(join(repoRoot, rel)); } catch { return; }
    for (const name of names) {
      const p = rel ? `${rel}/${name}` : name;
      let st;
      try { st = lstatSync(join(repoRoot, p)); } catch { continue; }
      if (st.isDirectory()) { if (deep) walk(p, true); continue; }
      if (!st.isFile() || !isTamperPath(p) || p in out) continue;
      if (n >= MAX_FILES) { complete = false; return; }
      const h = createHash('sha256');
      try {
        if (st.size > MAX_HASH_BYTES) h.update(`size:${st.size}:mtime:${st.mtimeMs}`); else h.update(readFileSync(join(repoRoot, p)));
        out[p] = h.digest('hex');
        n++;
      } catch { /* unreadable: absent */ }
    }
  };
  for (const [dir, deep] of ROOTS) walk(dir, deep);
  return { hashes: out, complete };
}

export interface Guard {
  version: 1;
  /** A tool window is open: PreToolUse seen, PostToolUse not yet. */
  open: boolean;
  /** The guarded files at the last snapshot. */
  hashes: Record<string, string>;
  /** Guarded files the person changed, with the content they left (null: they deleted it). */
  person: Record<string, string | null>;
}

export const guardPath = (repoRoot: string, session: string) => join(harnessDir(repoRoot), `${session}.guard.json`);

const isHashMap = (v: unknown, nullable: boolean): v is Record<string, string | null> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.values(v as object).every((h) => (nullable && h === null) || (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)));

/** The session's guard, or null when absent or not in the expected shape (then nothing is the person's). */
export function loadGuard(repoRoot: string, session: string): Guard | null {
  let v: any; // any: untrusted JSON, checked below
  try { v = JSON.parse(readFileSync(guardPath(repoRoot, session), 'utf8')); } catch { return null; }
  if (!v || v.version !== 1 || typeof v.open !== 'boolean' || !isHashMap(v.hashes, false) || !isHashMap(v.person, true)) return null;
  return { version: 1, open: v.open, hashes: v.hashes as Record<string, string>, person: v.person };
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
 * Records one hook event (see the module comment). Errors are thrown; callers report them and go
 * on, which leaves changes the agent's. Claude Code runs a Bash call's pre-tool and pre-push hooks
 * in parallel, so two `pre` events can race: both fold the same changes into `person`, or the later
 * one sees the window already open and keeps that fold; either way the saved record is the same.
 */
export function guardEvent(repoRoot: string, session: string, event: GuardEvent): void {
  if (event === 'start' && loadGuard(repoRoot, session)) return; // a resumed session keeps its record
  const { hashes: now, complete } = tamperHashes(repoRoot);
  const prev = event === 'start' ? null : loadGuard(repoRoot, session);
  const person = { ...(prev?.person ?? {}) };
  // A cut-off snapshot cannot tell an unhashed file from a deleted one: attribute nothing then.
  if (event === 'pre' && prev && !prev.open && complete) {
    for (const p of new Set([...Object.keys(prev.hashes), ...Object.keys(now)])) {
      if (prev.hashes[p] !== now[p]) person[p] = now[p] ?? null;
    }
  }
  saveGuard(repoRoot, session, { version: 1, open: event === 'pre', hashes: now, person });
}

/** guardEvent for a hook: never throws; returns a one-line note for stderr when nothing could be recorded. */
export function recordWindow(repoRoot: string, session: string | null, event: GuardEvent): string {
  if (!session) return '';
  try { guardEvent(repoRoot, session, event); return ''; } catch (e: any) { // any: fs error, message only
    return `PRISM harness: could not record the tool window (${String(e?.message || e).split('\n')[0].slice(0, 200)}); changes to guarded files count as the agent's.\n`;
  }
}

/** The given guarded paths that the person changed and that still hold exactly what they left. */
export function personsChanges(repoRoot: string, session: string, paths: string[]): Set<string> {
  const g = paths.length ? loadGuard(repoRoot, session) : null;
  if (!g) return new Set();
  const { hashes: now } = tamperHashes(repoRoot);
  return new Set(paths.filter((p) => p in g.person && (now[p] ?? null) === g.person[p]));
}

export const deleteGuard = (repoRoot: string, session: string) => rmSync(guardPath(repoRoot, session), { force: true });
