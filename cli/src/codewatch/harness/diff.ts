/**
 * Git plumbing for the harness loop: working-tree snapshots, tree-to-tree
 * diffs, and a small unified-diff parser.
 *
 * A snapshot is `git add -A` into a COPY of the index followed by
 * `git write-tree`, so the user's index, stash and working tree are never
 * touched (docs/DESIGN-harness-loop.md section 4.1). It writes blob and tree
 * objects only; nothing references them, so `git gc` prunes them later.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIFF_EXCLUDES } from '../prepush.js';
import { RESULTS_DIR } from '../results.js';

export const HARNESS_DIR = '.prism/harness';
/** PRISM's own local output never counts as a change. */
const OWN_OUTPUT = [`:(exclude,glob)${RESULTS_DIR}/**`, `:(exclude,glob)${HARNESS_DIR}/**`];
const GIT_HOOK_ENV = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];
const MAX_BUFFER = 256 * 1024 * 1024;

export interface GitOut { ok: boolean; stdout: string; stderr: string }

export function gitIn(repoRoot: string, args: string[], extraEnv: Record<string, string> = {}, input?: string): GitOut {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of GIT_HOOK_ENV) delete env[k];
  Object.assign(env, extraEnv);
  const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', env, input, maxBuffer: MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] });
  return { ok: r.status === 0 && !r.error, stdout: (r.stdout || '').replace(/\n$/, ''), stderr: r.stderr || '' };
}

/**
 * Tree object of the whole working tree (tracked plus untracked, honoring
 * .gitignore), or null. A partial snapshot (a file git could not read) still
 * returns a tree and says what was left out in `warnings`.
 */
export function snapshotTree(repoRoot: string, warnings: string[] = []): string | null {
  const idx = gitIn(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const dir = mkdtempSync(join(tmpdir(), 'prism-harness-idx-'));
  const firstLine = (s: string) => s.trim().split('\n')[0].slice(0, 200);
  try {
    const tmpIndex = join(dir, 'index');
    if (idx.ok && idx.stdout && existsSync(idx.stdout)) copyFileSync(idx.stdout, tmpIndex);
    const env = { GIT_INDEX_FILE: tmpIndex };
    // --ignore-errors: an unreadable file is left out rather than failing the snapshot.
    const add = gitIn(repoRoot, ['add', '-A', '--ignore-errors', '--', '.'], env);
    if (!add.ok) warnings.push(`the working-tree snapshot left out files git could not add (${firstLine(add.stderr)}); changes in them are not reviewed`);
    // PRISM's own output never counts, even where git does not ignore it. (An exclude
    // pathspec on `git add` errors when the path is also ignored, so remove it after.)
    // The diff excludes these paths too, so a failure here only costs a warning.
    const rm = gitIn(repoRoot, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', RESULTS_DIR, HARNESS_DIR], env);
    if (!rm.ok) warnings.push(`could not drop PRISM's own output from the snapshot (${firstLine(rm.stderr)})`);
    const t = gitIn(repoRoot, ['write-tree'], env);
    return t.ok && /^[0-9a-f]{40,64}$/.test(t.stdout) ? t.stdout : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function objectExists(repoRoot: string, rev: string): boolean {
  return gitIn(repoRoot, ['cat-file', '-e', rev]).ok;
}

export function revParse(repoRoot: string, rev: string): string | null {
  const r = gitIn(repoRoot, ['rev-parse', '--verify', '--quiet', rev]);
  return r.ok && r.stdout ? r.stdout : null;
}

/** Unified diff between two trees (or commits), lock files and PRISM's own output excluded. */
export function diffTrees(repoRoot: string, from: string, to: string): string | null {
  const r = gitIn(repoRoot, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--unified=3', '-M',
    '--src-prefix=a/', '--dst-prefix=b/', from, to, '--', '.', ...DIFF_EXCLUDES, ...OWN_OUTPUT]);
  return r.ok ? r.stdout : null;
}

export interface DiffFile {
  /** Path after the change; for a deleted file, its old path. */
  path: string;
  /** Path before the change, when it differs (rename) or the file was deleted. */
  oldPath: string | null;
  deleted: boolean;
  /** New-side line numbers of added or changed lines. */
  added: Set<number>;
}

export interface ParsedDiff {
  files: DiffFile[];
  addedLines: number;
  /** Added lines that carry an inline `gitleaks:allow`, as file:line. */
  allowMarkers: { file: string; line: number }[];
}

function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  try { return JSON.parse(p); } catch { return p.slice(1, -1); }
}

const stripPrefix = (p: string, pre: string) => (p.startsWith(pre) ? p.slice(pre.length) : p);

/** Parses `git diff` output (a/ b/ prefixes). Tolerant: unknown lines are skipped. */
export function parseDiff(text: string): ParsedDiff {
  const files: DiffFile[] = [];
  const allowMarkers: ParsedDiff['allowMarkers'] = [];
  let cur: DiffFile | null = null;
  let inHunk = false;
  let newLine = 0;
  let addedLines = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (.+?) (b\/.+|"b\/.+")$/.exec(line);
      const b = m ? stripPrefix(unquote(m[2]), 'b/') : '';
      const a = m ? stripPrefix(unquote(m[1]), 'a/') : '';
      cur = { path: b, oldPath: a && a !== b ? a : null, deleted: false, added: new Set() };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (line.startsWith('+++ ')) {
        const p = line.slice(4);
        if (p === '/dev/null') { cur.deleted = true; cur.oldPath = cur.oldPath ?? cur.path; } else cur.path = stripPrefix(unquote(p), 'b/');
      } else if (line.startsWith('--- ')) {
        const p = line.slice(4);
        if (p !== '/dev/null') { const old = stripPrefix(unquote(p), 'a/'); if (old !== cur.path) cur.oldPath = old; }
      } else if (line.startsWith('rename from ')) cur.oldPath = unquote(line.slice(12));
      else if (line.startsWith('rename to ')) cur.path = unquote(line.slice(10));
      else if (line.startsWith('deleted file mode')) cur.deleted = true;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { inHunk = true; newLine = Number(h[1]); continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      cur.added.add(newLine);
      addedLines++;
      if (line.includes('gitleaks:allow')) allowMarkers.push({ file: cur.path, line: newLine });
      newLine++;
    } else if (line.startsWith(' ')) newLine++;
  }
  return { files, addedLines, allowMarkers };
}

/** Every path a diff touches, old and new. */
export function touchedPaths(d: ParsedDiff): string[] {
  const out = new Set<string>();
  for (const f of d.files) { out.add(f.path); if (f.oldPath) out.add(f.oldPath); }
  return [...out].filter(Boolean);
}

/**
 * Contents of `<rev>:<path>` for each path, through one `git cat-file --batch`.
 * Missing paths are absent from the map. A path holding a newline cannot be
 * sent on the batch protocol's one-line-per-object input (it would desync
 * every object after it; `-z` needs git 2.43), so it is left out and pushed
 * onto `unreadable` for the caller to report.
 */
export function readBlobs(repoRoot: string, rev: string, paths: string[], unreadable: string[] = []): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const ok = paths.filter((p) => !/[\n\r]/.test(p));
  unreadable.push(...paths.filter((p) => /[\n\r]/.test(p)));
  paths = ok;
  if (!paths.length) return out;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of GIT_HOOK_ENV) delete env[k];
  const r = spawnSync('git', ['-C', repoRoot, 'cat-file', '--batch'], {
    input: paths.map((p) => `${rev}:${p}`).join('\n') + '\n', env, maxBuffer: MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.status !== 0 || !r.stdout) return out;
  const buf = r.stdout as Buffer;
  let pos = 0;
  for (const p of paths) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) continue; // "<obj> missing"
    const size = Number(m[2]);
    if (m[1] === 'blob') out.set(p, buf.subarray(pos, pos + size));
    pos += size + 1;
  }
  return out;
}

/** Converts a glob (`*`, `**`, `?`) to a regex. A pattern without `/` matches the base name. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { re += '(.*/)?'; i++; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(glob.includes('/') ? `^${re}$` : `(^|/)${re}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
