/**
 * Codewatch panel data, from `.prism/results/` (see codewatch/results.ts).
 */
import { readResultEntries, REASON_GITLEAKS_MISSING, type Finding, type PrismResult, type ResultStatus, countBySeverity } from '../codewatch/results.js';
import { gitleaksInstallHint } from './setup.js';
import { localDate } from './usage.js';
import { collectCommits, type CommitsPanel } from './commits.js';

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

export interface SecretScanning {
  /** gitleaks on PATH on this machine right now. */
  gitleaksAvailable: boolean;
  /**
   * Commits allowed without a secret scan because gitleaks was missing, in the
   * current run of such commits: since the last pre-commit that did run
   * gitleaks, or since the first record if it never ran.
   */
  unscannedCommits: number;
  /** started_at of the first commit in that run; null when there is none. */
  unscannedSince: string | null;
  installHint: string;
  /** Banner text when gitleaks is unavailable, else null. Same words in the page and --json. */
  banner: string | null;
}

export interface CodewatchPanel {
  /** False when there are no results at all: the empty state. */
  hasResults: boolean;
  /** started_at of the newest result of any kind, or null. */
  lastRunAt: string | null;
  /** Tool of the newest pre-push review that had one, or null. */
  lastReviewer: string | null;
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
  /** Last N runs that were not skipped, oldest first. A skipped run (nothing to review, no gitleaks) has no findings to chart. */
  trend: RunSummary[];
  /** Runs left out of the trend because they were skipped. */
  skippedRuns: number;
  secretScanning: SecretScanning;
  /** Results mapped onto commits, newest first. */
  commits: CommitsPanel;
  /** Result id of the newest pre-push review, for the report link. */
  lastReviewId: string | null;
  /** Newest pre-push reviews (at most MAX_SCANS), each linking to its report. */
  scans: ScanRow[];
}

export const MAX_SCANS = 20;

export interface ScanRow {
  id: string;
  started_at: string;
  branch: string | null;
  tool: string;
  model: string | null;
  status: ResultStatus;
  high: number;
  medium: number;
  low: number;
  reason: string | null;
}

const isMissingSkip = (r: PrismResult) =>
  r.kind === 'secrets' && r.hook === 'pre-commit' && r.status === 'skipped' && r.reason === REASON_GITLEAKS_MISSING;

/** A pre-commit that actually ran gitleaks (any verdict). */
const ranGitleaks = (r: PrismResult) =>
  r.kind === 'secrets' && r.hook === 'pre-commit' && (r.status === 'ok' || r.status === 'findings' || (r.status === 'error' && !/not on PATH/.test(r.reason || '')));

/** Local calendar day, so the banner reads "since 2026-11-03". */
function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : localDate(d);
}

function bannerText(gitleaksAvailable: boolean, count: number, since: string | null): string | null {
  if (gitleaksAvailable) return null;
  return count
    ? `Secret scanning is off: gitleaks is not installed. ${count} commit${count === 1 ? '' : 's'} since ${day(since!)} ${count === 1 ? 'was' : 'were'} not scanned.`
    : 'Secret scanning is off: gitleaks is not installed. No unscanned commits recorded yet.';
}

export function secretScanning(sorted: PrismResult[], gitleaksAvailable: boolean, hint = gitleaksInstallHint()): SecretScanning {
  let lastRan = -1;
  sorted.forEach((r, i) => { if (ranGitleaks(r)) lastRan = i; });
  const streak = sorted.slice(lastRan + 1).filter(isMissingSkip);
  const since = streak.length ? streak[0].started_at : null;
  return { gitleaksAvailable, unscannedCommits: streak.length, unscannedSince: since, installHint: hint, banner: bannerText(gitleaksAvailable, streak.length, since) };
}

/**
 * gitleaks is a machine tool, so the banner is machine-level: it sums each
 * repo's unscanned commits and dates them from the earliest.
 */
export function combineSecretScanning(perRepo: SecretScanning[], gitleaksAvailable: boolean, hint = gitleaksInstallHint()): SecretScanning {
  const count = perRepo.reduce((n, s) => n + s.unscannedCommits, 0);
  const since = perRepo.map((s) => s.unscannedSince).filter((x): x is string => !!x).sort()[0] ?? null;
  return { gitleaksAvailable, unscannedCommits: count, unscannedSince: since, installHint: hint, banner: bannerText(gitleaksAvailable, count, since) };
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

export function collectCodewatch(repoRoot: string, trendRuns = DEFAULT_TREND_RUNS, gitleaksAvailable = true): CodewatchPanel {
  // Security Agent reviews have their own panel; the codewatch panel is the git-hook gate only.
  const entries = readResultEntries(repoRoot).filter((e) => e.result && typeof e.result.started_at === 'string' && e.result.kind !== 'security-review' && e.result.kind !== 'security-threat-model' && e.result.kind !== 'aws-check');
  const idOf = new Map(entries.map((e) => [e.result, e.id]));
  const all = entries.map((e) => e.result).sort(byTime);
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

  const reviews = all.filter((r) => r.kind === 'review' && r.tool && r.tool !== 'none');
  const allReviews = all.filter((r) => r.kind === 'review' && r.hook === 'pre-push');
  const lastReview = allReviews.length ? allReviews[allReviews.length - 1] : null;
  return {
    hasResults: all.length > 0,
    lastRunAt: all.length ? all[all.length - 1].started_at : null,
    lastReviewer: reviews.length ? reviews[reviews.length - 1].tool : null,
    lastReviewId: lastReview ? idOf.get(lastReview) ?? null : null,
    scans: allReviews.slice(-MAX_SCANS).reverse().map((r) => {
      const c = countBySeverity(r.findings || []);
      return { id: idOf.get(r) as string, started_at: r.started_at, branch: r.branch ?? null, tool: r.tool, model: r.model ?? null, status: r.status, high: c.high, medium: c.medium, low: c.low, reason: r.reason ?? null };
    }),
    totalRuns: all.length,
    latestByBranch: [...latest.values()].sort((a, b) => a.branch.localeCompare(b.branch)),
    findings: findings.slice(0, MAX_FINDINGS),
    findingsTruncated: findings.length > MAX_FINDINGS,
    bySeverity,
    byCategory,
    gitleaksBlocks: all.filter(isBlock).map(summarize).reverse(),
    // --no-verify and other unhooked commits; gitleaks-missing ones are counted in secretScanning.
    skipped: all.filter((r) => r.kind === 'secrets' && r.status === 'skipped' && !isMissingSkip(r)).map(summarize).reverse(),
    trend: all.filter((r) => r.status !== 'skipped').slice(-trendRuns).map(summarize),
    skippedRuns: all.filter((r) => r.status === 'skipped').length,
    secretScanning: secretScanning(all, gitleaksAvailable),
    commits: all.length ? collectCommits(repoRoot, all, { idOf: (r) => idOf.get(r) ?? null }) : { rows: [], total: 0, truncated: false, timing: { logMs: 0, blameMs: 0, blameCalls: 0 } },
  };
}
