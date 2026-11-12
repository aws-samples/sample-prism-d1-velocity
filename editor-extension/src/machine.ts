/**
 * Machine mode (no repo in the window): the repos with codewatch, sorted by
 * last commit, their findings, and the guard for opening a finding's file.
 * No vscode import.
 */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { headReportArgs, isResultId, lastCommit, mapLimit, reportArgs, type LastCommit } from './cli';
import { plainText } from './text';
import { insideRepo } from './diagnostics';
import type { CodewatchRow, DashboardPayload, Finding, RepoPayload } from './payload';

/** git log runs for at most this many repos (those with results, newest review first), this many at a time. */
export const COMMIT_LOOKUP_MAX = 30;
export const COMMIT_LOOKUP_CONCURRENCY = 4;
/** Findings listed per repo row; the rest are a "N more" line. */
export const ROW_FINDINGS_MAX = 20;

const time = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isNaN(t) ? null : t; };

/** Repos whose last commit is looked up: codewatch results only, newest review first, capped. */
export function commitLookupPaths(p: DashboardPayload, max = COMMIT_LOOKUP_MAX): string[] {
  return p.repos
    .filter((r) => r.codewatch.hasResults)
    .sort((a, b) => (time(b.codewatch.lastRunAt) ?? 0) - (time(a.codewatch.lastRunAt) ?? 0))
    .slice(0, max)
    .map((r) => r.path);
}

export type CommitLookup = (repo: string) => Promise<LastCommit | null>;

/** Last commit per path; null where git failed. */
export async function lastCommits(paths: string[], lookup: CommitLookup = (r) => lastCommit(r), limit = COMMIT_LOOKUP_CONCURRENCY): Promise<Map<string, LastCommit | null>> {
  const found = await mapLimit(paths, limit, lookup);
  return new Map(paths.map((p, i) => [p, found[i]]));
}

export interface MachineRepo {
  row: CodewatchRow;
  repo: RepoPayload | null;
  /** undefined: not looked up (no results or past the cap); null: git failed. Either way the time is unknown. */
  commit: LastCommit | null | undefined;
  /** Newest review first, at most ROW_FINDINGS_MAX. */
  findings: Finding[];
  moreFindings: number;
}

/**
 * The 'Repositories with codewatch' rows, newest last commit first. A repo
 * without a known commit time sorts by its last review time; repos with
 * neither go last.
 */
export function machineRepos(p: DashboardPayload, commits: Map<string, LastCommit | null>): MachineRepo[] {
  const byPath = new Map(p.repos.map((r) => [r.path, r]));
  const rows = (p.overview?.codewatch ?? []).map((row): MachineRepo => {
    const repo = byPath.get(row.path) ?? null;
    const all = [...(repo?.codewatch.findings ?? [])].sort((a, b) => (time(b.started_at) ?? 0) - (time(a.started_at) ?? 0));
    return { row, repo, commit: commits.get(row.path), findings: all.slice(0, ROW_FINDINGS_MAX), moreFindings: Math.max(0, all.length - ROW_FINDINGS_MAX) };
  });
  const key = (m: MachineRepo) => time(m.commit?.at) ?? time(m.row.lastRunAt) ?? -Infinity;
  return rows.sort((a, b) => key(b) - key(a));
}

/** The branch and commit of the repo's latest review (the --id fallback report), for the message shown with it. */
export function latestReviewOf(repo: RepoPayload | null): { id: string; branch: string | null; commit: string | null } | null {
  const id = repo?.codewatch.lastReviewId;
  if (!repo || !id) return null;
  const scan = repo.codewatch.scans.find((s) => s.id === id);
  const lb = repo.codewatch.latestByBranch?.find((b) => scan && b.review.started_at === scan.started_at);
  return { id, branch: scan?.branch ?? lb?.branch ?? null, commit: lb?.review.commit ?? null };
}

export interface FileFs { isFile(p: string): boolean; realpath(p: string): string }

const realFs: FileFs = {
  isFile: (p) => { try { return statSync(p).isFile(); } catch { return false; } },
  realpath: (p) => realpathSync(p),
};

/**
 * The absolute path of a finding's file inside `repoPath`, or null. Refuses an
 * absolute path, any `..` segment, a path resolving outside the repo, a
 * symlink whose target is outside it, and anything that is not a file.
 */
export function repoFile(repoPath: string, file: unknown, fsx: FileFs = realFs): string | null {
  if (typeof file !== 'string' || isAbsolute(file) || file.split(/[\\/]/).includes('..')) return null;
  const rel = insideRepo(repoPath, file);
  if (!rel) return null;
  const abs = resolve(repoPath, rel);
  if (!fsx.isFile(abs)) return null;
  try {
    const root = fsx.realpath(repoPath);
    const real = relative(root, fsx.realpath(abs));
    if (!real || real === '..' || real.startsWith('..' + sep) || isAbsolute(real)) return null;
  } catch { return null; }
  return abs;
}

export interface ReportPlan {
  /** --commit HEAD: the review that covers the repo's last commit. */
  primary: (output: string) => string[];
  /** --id of the latest review, used when no review covers HEAD; null when there is no review id. */
  fallback: { args: (output: string) => string[]; message: string } | null;
}

/** How the panel's Open report button gets a repo's report. */
export function machineReportPlan(repoPath: string, name: string, head: LastCommit | null | undefined, latest: ReturnType<typeof latestReviewOf>): ReportPlan {
  const plain = (s: string | null, max: number) => plainText(s ?? '', { oneLine: true, max });
  return {
    primary: (out) => headReportArgs(repoPath, out),
    fallback: latest && isResultId(latest.id)
      ? {
        args: (out) => reportArgs(repoPath, latest.id, out),
        message: `PRISM: no review in ${plain(name, 120)} covers its last commit${head ? ` ${plain(head.sha, 12)}` : ''}. Showing the latest review instead: branch ${plain(latest.branch ?? '(unknown)', 80)}, commit ${latest.commit ? plain(latest.commit, 40).slice(0, 12) : '(unknown)'}.`,
      }
      : null,
  };
}
