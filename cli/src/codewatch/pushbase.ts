/**
 * What a push carries: the base to review a branch's commits against when
 * there is no upstream. Shared by the agent harness (`codewatch review`,
 * branch scope) and the git pre-push hook, so neither ever falls back to
 * reviewing only uncommitted changes while commits leave the machine.
 *
 * Order, after the caller's own upstream / remote-sha checks:
 *  1. refs/remotes/<remote>/<dst>        the branch the push writes to
 *  2. refs/remotes/<remote>/<branch>     the current branch on that remote
 *  3. <remote>/HEAD, <remote>/main, <remote>/master (and the same for origin)
 *  4. the commits on no remote at all (`<tip> --not --remotes`): their boundary
 *  5. nothing of the history is on a remote: the empty tree (the whole tree is reviewed)
 * A found ref is turned into its merge-base with the tip.
 */
import { spawnSync } from 'node:child_process';

const GIT_HOOK_ENV = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];

function g(repoRoot: string, args: string[], input?: string): string | null {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of GIT_HOOK_ENV) delete env[k];
  const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', env, input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  return r.status === 0 && !r.error ? (r.stdout || '').trim() : null;
}

export interface PushBase {
  /** A commit, or the empty tree when nothing of the history is on a remote. */
  base: string;
  /** What the base is, for logs and the result file (`origin/main`, `commits on no remote`). */
  label: string;
  emptyTree: boolean;
  /** A warning to show, or null. */
  note: string | null;
}

/** The empty tree object of this repository's hash format. */
export function emptyTree(repoRoot: string): string | null {
  return g(repoRoot, ['hash-object', '-t', 'tree', '--stdin'], '');
}

const shortRef = (ref: string) => ref.replace(/^refs\/remotes\//, '');

/** A remote or branch name as given on a command line; anything else is not looked up. */
const SAFE_NAME = /^[A-Za-z0-9._/-]{1,200}$/;
const safe = (s: string | null | undefined): s is string => !!s && SAFE_NAME.test(s) && !s.startsWith('-') && !s.includes('..');

/** The base for `tip` when no upstream is set. Null only when git itself fails. */
export function fallbackPushBase(repoRoot: string, opts: { remote?: string | null; dst?: string | null; branch?: string | null; tip: string }): PushBase | null {
  const { tip } = opts;
  const remotes = [...new Set([opts.remote, 'origin'].filter(safe))];
  const candidates: string[] = [];
  const first = remotes[0];
  if (first && safe(opts.dst)) candidates.push(`refs/remotes/${first}/${opts.dst}`);
  if (first && safe(opts.branch)) candidates.push(`refs/remotes/${first}/${opts.branch}`);
  for (const r of remotes) {
    const head = g(repoRoot, ['symbolic-ref', '--quiet', `refs/remotes/${r}/HEAD`]);
    if (head) candidates.push(head);
    candidates.push(`refs/remotes/${r}/main`, `refs/remotes/${r}/master`);
  }
  for (const c of candidates) {
    const sha = g(repoRoot, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`]);
    if (!sha) continue;
    const mb = g(repoRoot, ['merge-base', sha, tip]);
    if (mb) return { base: mb, label: shortRef(c), emptyTree: false, note: null };
  }

  const empty = emptyTree(repoRoot);
  const anyRemote = g(repoRoot, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes']);
  if (anyRemote === null || empty === null) return null;
  if (anyRemote) {
    // --boundary marks with '-' the remote-reachable parents of the commits on no remote.
    const list = g(repoRoot, ['rev-list', '--boundary', tip, '--not', '--remotes']);
    if (list === null) return null;
    const lines = list.split('\n').filter(Boolean);
    if (!lines.length) return { base: tip, label: 'already on a remote', emptyTree: false, note: null };
    const boundary = lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1));
    if (boundary.length) {
      const base = boundary.length > 1 ? g(repoRoot, ['merge-base', '--octopus', ...boundary]) ?? boundary[0] : boundary[0];
      return {
        base, label: 'commits on no remote', emptyTree: false,
        note: `no upstream or remote branch to compare with; reviewing the ${lines.length - boundary.length} commit(s) that are on no remote`,
      };
    }
  }
  return {
    base: empty, label: 'empty tree', emptyTree: true,
    note: 'none of this history is on a remote (first push); reviewing the whole tree',
  };
}
