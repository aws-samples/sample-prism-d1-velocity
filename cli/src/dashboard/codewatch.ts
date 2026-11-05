/**
 * Codewatch panel data, from `.prism/results/` (see codewatch/results.ts).
 */
import { readResults, type Finding, type PrismResult, type ResultStatus, countBySeverity } from '../codewatch/results.js';

export const DEFAULT_TREND_RUNS = 20;
/** Cap on findings listed per repo, so one noisy branch cannot flood the page. */
export const MAX_FINDINGS = 200;

export interface RunSummary {
  started_at: string;
  kind: PrismResult['kind'];
  hook: PrismResult['hook'];
  status: ResultStatus;
  tool: string;
  model: string | null;
  commit: string | null;
  branch: string | null;
  high: number;
  medium: number;
  low: number;
  reason: string | null;
}

export interface BranchLatest {
  branch: string;
  /** Latest pre-push review on this branch, if any. */
  review: RunSummary | null;
  /** Latest pre-commit secret scan on this branch, if any. */
  secrets: RunSummary | null;
}

export interface FindingRow extends Finding {
  branch: string | null;
  commit: string | null;
  tool: string;
  started_at: string;
}

export interface CodewatchPanel {
  /** False when there are no results at all: the empty state. */
  hasResults: boolean;
  totalRuns: number;
  latestByBranch: BranchLatest[];
  /** Findings from the latest review of each branch. */
  findings: FindingRow[];
  findingsTruncated: boolean;
  bySeverity: { high: number; medium: number; low: number };
  byCategory: { quality: number; security: number };
  /** Pre-commit scans that blocked a commit (status findings, or a blocking error). */
  gitleaksBlocks: RunSummary[];
  /** Commits pushed without a pre-commit scan (`--no-verify`, rebase, ...). */
  skipped: RunSummary[];
  /** Last N runs, oldest first. */
  trend: RunSummary[];
}

function summarize(r: PrismResult): RunSummary {
  const c = countBySeverity(r.findings || []);
  return {
    started_at: r.started_at, kind: r.kind, hook: r.hook, status: r.status, tool: r.tool, model: r.model ?? null,
    commit: r.commit ?? null, branch: r.branch ?? null, high: c.high, medium: c.medium, low: c.low, reason: r.reason ?? null,
  };
}

/**
 * A pre-commit run that stopped a commit: a finding, or a scan that ran but
 * gave no verdict. A missing gitleaks is an error that did NOT block.
 */
function isBlock(r: PrismResult): boolean {
  if (r.kind !== 'secrets' || r.hook !== 'pre-commit') return false;
  if (r.status === 'findings') return true;
  return r.status === 'error' && !/not on PATH/.test(r.reason || '');
}

const byTime = (a: PrismResult, b: PrismResult) => String(a.started_at).localeCompare(String(b.started_at));

export function collectCodewatch(repoRoot: string, trendRuns = DEFAULT_TREND_RUNS): CodewatchPanel {
  const all = readResults(repoRoot).filter((r) => r && typeof r.started_at === 'string').sort(byTime);
  const latest = new Map<string, BranchLatest>();
  const latestReview = new Map<string, PrismResult>();
  for (const r of all) {
    const branch = r.branch || '(detached)';
    const entry = latest.get(branch) || { branch, review: null, secrets: null };
    if (r.kind === 'review' && r.hook === 'pre-push') { entry.review = summarize(r); latestReview.set(branch, r); }
    if (r.kind === 'secrets' && r.hook === 'pre-commit') entry.secrets = summarize(r);
    latest.set(branch, entry);
  }

  const findings: FindingRow[] = [];
  for (const r of latestReview.values()) {
    for (const f of r.findings || []) findings.push({ ...f, branch: r.branch, commit: r.commit, tool: r.tool, started_at: r.started_at });
  }
  const order = { high: 0, medium: 1, low: 2 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));

  const bySeverity = { high: 0, medium: 0, low: 0 };
  const byCategory = { quality: 0, security: 0 };
  for (const f of findings) { bySeverity[f.severity]++; byCategory[f.category]++; }

  return {
    hasResults: all.length > 0,
    totalRuns: all.length,
    latestByBranch: [...latest.values()].sort((a, b) => a.branch.localeCompare(b.branch)),
    findings: findings.slice(0, MAX_FINDINGS),
    findingsTruncated: findings.length > MAX_FINDINGS,
    bySeverity,
    byCategory,
    gitleaksBlocks: all.filter(isBlock).map(summarize).reverse(),
    skipped: all.filter((r) => r.kind === 'secrets' && r.status === 'skipped').map(summarize).reverse(),
    trend: all.filter((r) => r.status !== 'skipped').slice(-trendRuns).map(summarize),
  };
}
