/**
 * The Security findings panel: the cached `security-review` results that
 * `prism-cli security code-review` and `security findings` write to
 * .prism/results/. Local files only; no AWS calls.
 */
import { readResults, type PrismResult } from '../codewatch/results.js';

export const MAX_PANEL_FINDINGS = 50;
/** A pending record older than this is marked `stale?`: results are local, so the dashboard cannot know the job's real state. */
export const PENDING_STALE_MS = 2 * 60 * 60 * 1000;
export const PENDING_HINT = 'prism-cli security findings';

export interface SecurityFindingRow { risk_level: string; title: string; file: string; line: number | null; cwe: string | null }

export interface SecurityRepoRow {
  name: string;
  path: string;
  current: boolean;
  job_id: string;
  job_status: string;
  status: PrismResult['status'];
  scope: string;
  started_at: string;
  finished_at: string;
  counts: Record<string, number>;
  findings: SecurityFindingRow[];
  truncated: boolean;
  reason: string | null;
  /** Started by code-review, no verdict recorded yet. */
  pending: boolean;
  /** Pending for longer than PENDING_STALE_MS: the job most likely finished and nobody fetched it. */
  stale: boolean;
}

export interface SecurityPanel {
  /** One row per repo with a cached result, newest job first. */
  repos: SecurityRepoRow[];
  hint: string;
  /** Shown on a pending repo: how to fetch the job's results. */
  pending_hint: string;
}

const RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

/**
 * The latest job of a repo. Two files can hold the same job (code-review
 * writes it with its scope, `security findings` again without); the one that
 * knows its scope wins, then the newest write. A pending record is completed
 * in place, but should a verdict for the same job exist elsewhere, it wins.
 */
export function latestSecurityReview(results: PrismResult[]): PrismResult | null {
  const byJob = new Map<string, PrismResult>();
  for (const r of results) {
    if (r.kind !== 'security-review' || !r.security?.job_id) continue;
    const prev = byJob.get(r.security.job_id);
    if (prev && (prev.status === 'pending') !== (r.status === 'pending')) {
      if (prev.status === 'pending') byJob.set(r.security.job_id, r);
      continue;
    }
    const better = !prev || (prev.security!.scope === 'unknown' && r.security.scope !== 'unknown')
      || (prev.security!.scope === r.security.scope && r.finished_at > prev.finished_at)
      || (r.security.scope !== 'unknown' && r.finished_at > prev.finished_at);
    if (better) byJob.set(r.security.job_id, r);
  }
  const all = [...byJob.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  return all[0] ?? null;
}

export function collectSecurity(repos: { name: string; path: string; current: boolean }[], read: (root: string) => PrismResult[] = readResults, now: Date = new Date()): SecurityPanel {
  const rows: SecurityRepoRow[] = [];
  for (const repo of repos) {
    const r = latestSecurityReview(read(repo.path));
    if (!r || !r.security) continue;
    const findings = [...(r.findings || [])]
      .sort((a, b) => (RANK[b.risk_level || ''] ?? 0) - (RANK[a.risk_level || ''] ?? 0) || a.file.localeCompare(b.file))
      .map((f) => ({ risk_level: f.risk_level || f.severity.toUpperCase(), title: f.title || f.message, file: f.file, line: f.line, cwe: f.cwe ?? null }));
    rows.push({
      name: repo.name, path: repo.path, current: repo.current,
      job_id: r.security.job_id, job_status: r.security.job_status, status: r.status, scope: r.security.scope,
      started_at: r.started_at, finished_at: r.finished_at, counts: r.security.counts || {},
      findings: findings.slice(0, MAX_PANEL_FINDINGS), truncated: findings.length > MAX_PANEL_FINDINGS, reason: r.reason ?? null,
      pending: r.status === 'pending',
      stale: r.status === 'pending' && now.getTime() - Date.parse(r.started_at) > PENDING_STALE_MS,
    });
  }
  rows.sort((a, b) => Number(b.current) - Number(a.current) || b.started_at.localeCompare(a.started_at));
  return { repos: rows, hint: 'prism-cli security code-review', pending_hint: PENDING_HINT };
}
