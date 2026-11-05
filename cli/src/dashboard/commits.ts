/**
 * Codewatch results per commit, for the dashboard's Commits table.
 *
 * Results are recorded per hook run, not per commit: a pre-commit scan knows
 * only the staged tree, and a pre-push review covers a range. This module maps
 * both back onto commits:
 *
 * - one `git log --all` per repo gives every commit's parents, tree, author
 *   date and subject; review ranges (`base..tip`, the commits the push
 *   introduced) are expanded from it in memory, so no per-review rev-list;
 * - pre-commit scans match commits by tree id (a commit's tree is the staged
 *   tree it was scanned as);
 * - each review finding is attributed to the commit that introduced its line
 *   with `git blame` at the review's tip, once per distinct location; when
 *   blame fails or names a commit outside the range, the finding stays on the
 *   tip, marked "in push of <tip>".
 */
import { spawnSync } from 'node:child_process';
import { REASON_GITLEAKS_MISSING, type Finding, type PrismResult } from '../codewatch/results.js';

export const MAX_COMMIT_ROWS = 50;
/** History read per repo; ranges reaching further are cut there. */
export const LOG_LIMIT = 5000;

export interface LogEntry {
  sha: string;
  parents: string[];
  tree: string;
  authorDate: string;
  subject: string;
}

export interface CommitFinding extends Finding {
  /** blame: the commit introduced this line. tip: blame could not say; shown on the push's tip. */
  attributed: 'blame' | 'tip';
  /** Tip of the push the finding was reported in, when attributed to the tip. */
  inPushOf: string | null;
}

export type SecretScanState = 'ok' | 'not-scanned' | 'no-verify' | 'flagged' | 'none';
export type ReviewState = 'clean' | 'findings' | 'failed' | 'not-reviewed';

export interface CommitRow {
  sha: string;
  short: string;
  /** null when the commit is no longer reachable from any ref (amended, rebased away). */
  subject: string | null;
  inHistory: boolean;
  branch: string | null;
  authorDate: string | null;
  secretScan: { state: SecretScanState; reason: string | null };
  review: {
    state: ReviewState;
    tool: string | null;
    model: string | null;
    /** Reviews whose range included this commit; the newest one is shown. */
    reviewCount: number;
    reviewedAt: string | null;
    tip: string | null;
    /** Result id of the review shown, for the report link. */
    reportId: string | null;
    high: number;
    medium: number;
    low: number;
    reason: string | null;
  };
  findings: CommitFinding[];
}

export interface CommitsPanel {
  rows: CommitRow[];
  total: number;
  truncated: boolean;
  /** Measured cost of building the table. */
  timing: { logMs: number; blameMs: number; blameCalls: number };
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return { ok: r.status === 0, out: r.stdout || '' };
}

const SEP = '\x1f';

/** One `git log --all` for the repo, newest first. */
export function readLog(repo: string, limit = LOG_LIMIT): Map<string, LogEntry> {
  const r = git(repo, ['log', '--all', `--max-count=${limit}`, `--format=%H${SEP}%P${SEP}%T${SEP}%aI${SEP}%s`]);
  const m = new Map<string, LogEntry>();
  if (!r.ok) return m;
  for (const line of r.out.split('\n')) {
    if (!line) continue;
    const [sha, parents, tree, authorDate, subject] = line.split(SEP);
    m.set(sha, { sha, parents: parents ? parents.split(' ') : [], tree, authorDate, subject: subject ?? '' });
  }
  return m;
}

/** Commits reachable from `sha` within the log (inclusive). */
function ancestors(log: Map<string, LogEntry>, sha: string): Set<string> {
  const seen = new Set<string>();
  const stack = [sha];
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c) || !log.has(c)) continue;
    seen.add(c);
    for (const p of log.get(c)!.parents) stack.push(p);
  }
  return seen;
}

/**
 * Commits a push of `tip` over `base` introduced: `git rev-list base..tip`,
 * computed from the log. With no base, just the tip.
 */
export function expandRange(log: Map<string, LogEntry>, base: string | null, tip: string): string[] {
  if (!log.has(tip)) return [tip];
  if (!base) return [tip];
  const exclude = ancestors(log, base);
  return [...ancestors(log, tip)].filter((c) => !exclude.has(c));
}

const byTime = (a: PrismResult, b: PrismResult) => String(a.started_at).localeCompare(String(b.started_at));

/** Per-request blame cache: `${tip}\0${file}\0${line}` -> introducing commit or null. */
export class Blamer {
  private cache = new Map<string, string | null>();
  calls = 0;
  ms = 0;
  constructor(private repo: string) {}
  blame(tip: string, file: string, line: number | null): string | null {
    if (!file || !line || line < 1) return null;
    const key = `${tip}\0${file}\0${line}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const t0 = Date.now();
    this.calls++;
    const r = git(this.repo, ['blame', '-l', '-s', '-L', `${line},${line}`, tip, '--', file]);
    this.ms += Date.now() - t0;
    const m = r.ok ? /^\^?([0-9a-f]{40})/.exec(r.out) : null;
    const sha = m ? m[1] : null;
    this.cache.set(key, sha);
    return sha;
  }
}

function emptyRow(sha: string, log: Map<string, LogEntry>): CommitRow {
  const e = log.get(sha);
  return {
    sha, short: sha.slice(0, 8), subject: e ? e.subject : null, inHistory: !!e, branch: null, authorDate: e ? e.authorDate : null,
    secretScan: { state: 'none', reason: null },
    review: { state: 'not-reviewed', tool: null, model: null, reviewCount: 0, reviewedAt: null, tip: null, reportId: null, high: 0, medium: 0, low: 0, reason: null },
    findings: [],
  };
}

export interface CollectCommitsOptions {
  log?: Map<string, LogEntry>;
  blamer?: Blamer;
  maxRows?: number;
  /** Result id lookup, for report links. */
  idOf?: (r: PrismResult) => string | null;
}

export interface Attribution {
  /** All commits the push introduced. */
  range: string[];
  /** Findings per commit they were attributed to. */
  byCommit: Map<string, CommitFinding[]>;
}

/**
 * Attributes one review's findings to commits: the commit `git blame` names at
 * the review's tip, when it is inside the pushed range; otherwise the tip,
 * marked "in push of <tip>". Shared by the Commits table and the scan report.
 */
export function attributeFindings(rev: PrismResult, log: Map<string, LogEntry>, blamer: Blamer): Attribution {
  const tip = rev.commit as string;
  const range = expandRange(log, rev.base, tip);
  const inRange = new Set(range);
  const byCommit = new Map<string, CommitFinding[]>();
  for (const f of rev.findings || []) {
    const who = blamer.blame(tip, f.file, f.line);
    const target = who && inRange.has(who) ? who : tip;
    const cf: CommitFinding = { ...f, attributed: target === who ? 'blame' : 'tip', inPushOf: target === who ? null : tip };
    if (!byCommit.has(target)) byCommit.set(target, []);
    byCommit.get(target)!.push(cf);
  }
  return { range, byCommit };
}

export function collectCommits(repo: string, results: PrismResult[], opts: CollectCommitsOptions = {}): CommitsPanel {
  const t0 = Date.now();
  const log = opts.log ?? readLog(repo);
  const logMs = Date.now() - t0;
  const blamer = opts.blamer ?? new Blamer(repo);
  const sorted = results.filter((r) => r && typeof r.started_at === 'string').sort(byTime);
  const rows = new Map<string, CommitRow>();
  const row = (sha: string) => {
    let r = rows.get(sha);
    if (!r) { r = emptyRow(sha, log); rows.set(sha, r); }
    return r;
  };

  // Pre-push reviews: every commit in each range, newest review wins.
  for (const rev of sorted.filter((r) => r.kind === 'review' && r.hook === 'pre-push' && r.commit)) {
    if (rev.status === 'skipped') continue; // nothing was pushed to review
    const tip = rev.commit as string;
    const { range, byCommit } = attributeFindings(rev, log, blamer);
    for (const sha of range) {
      const r = row(sha);
      const fs = byCommit.get(sha) || [];
      const count = (s: string) => fs.filter((f) => f.severity === s).length;
      r.branch = rev.branch ?? r.branch;
      r.review = {
        state: rev.status === 'error' ? 'failed' : fs.length ? 'findings' : 'clean',
        tool: rev.tool && rev.tool !== 'none' ? rev.tool : null,
        model: rev.model ?? null,
        reviewCount: r.review.reviewCount + 1,
        reviewedAt: rev.started_at,
        tip,
        high: count('high'), medium: count('medium'), low: count('low'),
        reason: rev.status === 'error' ? rev.reason : null,
        reportId: opts.idOf ? opts.idOf(rev) : null,
      };
      r.findings = fs;
    }
  }

  // Pre-commit scans, matched by tree. Newest scan of a tree wins.
  const scanByTree = new Map<string, PrismResult>();
  for (const s of sorted.filter((r) => r.kind === 'secrets' && r.hook === 'pre-commit' && r.tree)) scanByTree.set(s.tree as string, s);
  if (scanByTree.size) {
    for (const e of log.values()) {
      const s = scanByTree.get(e.tree);
      if (!s) continue;
      const r = row(e.sha);
      r.branch = r.branch ?? s.branch ?? null;
      if (s.status === 'ok') r.secretScan = { state: 'ok', reason: null };
      else if (s.status === 'skipped' && s.reason === REASON_GITLEAKS_MISSING) r.secretScan = { state: 'not-scanned', reason: 'gitleaks was not installed' };
      else if (s.status === 'findings') r.secretScan = { state: 'flagged', reason: 'committed although the scan found secrets (--no-verify)' };
      else r.secretScan = { state: 'not-scanned', reason: s.reason };
    }
  }

  // Commits pre-push found with no pre-commit scan.
  for (const s of sorted.filter((r) => r.kind === 'secrets' && r.hook === 'pre-push' && r.status === 'skipped' && r.commit)) {
    const r = row(s.commit as string);
    r.branch = r.branch ?? s.branch ?? null;
    if (r.secretScan.state === 'none') r.secretScan = { state: 'no-verify', reason: 'pushed with no matching pre-commit scan (--no-verify, rebase or cherry-pick)' };
  }

  // Newest first. Commits made in the same second keep git log order (children
  // before parents); commits no longer in history sort after those that are.
  const order = new Map<string, number>();
  let i = 0;
  for (const sha of log.keys()) order.set(sha, i++);
  const pos = (r: CommitRow) => order.get(r.sha) ?? Number.MAX_SAFE_INTEGER;
  const all = [...rows.values()].sort((a, b) =>
    String(b.authorDate ?? b.review.reviewedAt ?? '').localeCompare(String(a.authorDate ?? a.review.reviewedAt ?? '')) || pos(a) - pos(b) || a.sha.localeCompare(b.sha));
  const max = opts.maxRows ?? MAX_COMMIT_ROWS;
  return {
    rows: all.slice(0, max),
    total: all.length,
    truncated: all.length > max,
    timing: { logMs, blameMs: blamer.ms, blameCalls: blamer.calls },
  };
}
