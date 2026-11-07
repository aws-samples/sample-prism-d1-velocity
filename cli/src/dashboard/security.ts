/**
 * The Security findings panel: the cached `security-review` results that
 * `prism-cli security code-review` and `security findings` write to
 * .prism/results/. Local files only; no AWS calls.
 */
import { readResults, type PrismResult } from '../codewatch/results.js';
import { firstParagraph } from '../security/threat-model.js';

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

/** A pentest runs for hours, so its pending record goes stale later than a review's. */
export const PENTEST_PENDING_STALE_MS = 6 * 60 * 60 * 1000;
export const PENTEST_HINT = 'prism-cli security pentest --status';

export interface SecurityPentestFindingRow { risk_level: string; title: string; confidence: string | null }

export interface SecurityPentestRow {
  name: string;
  path: string;
  current: boolean;
  job_id: string;
  job_status: string;
  status: PrismResult['status'];
  target_host: string;
  started_at: string;
  finished_at: string;
  counts: Record<string, number>;
  findings: SecurityPentestFindingRow[];
  truncated: boolean;
  reason: string | null;
  overview: string | null;
  pending: boolean;
  stale: boolean;
}

export interface SecurityPanel {
  /** One row per repo with a cached code-review result, newest job first. */
  repos: SecurityRepoRow[];
  /** One row per repo with a cached penetration-test result, newest job first. */
  pentests: SecurityPentestRow[];
  hint: string;
  /** Shown on a pending repo: how to fetch the job's results. */
  pending_hint: string;
  /** Shown on a pending pentest: how to refresh it. */
  pentest_hint: string;
  /** One row per repo with a cached threat model, current repo first. */
  threat_models: ThreatModelRow[];
  /** Shown on a pending threat model: how to fetch its threats. */
  threats_hint: string;
}

/** Threats shown per repo; the rest are in the result file and `prism-cli security threats`. */
export const MAX_PANEL_THREATS = 5;
export const THREATS_HINT = 'prism-cli security threats';

export interface ThreatModelRow {
  name: string;
  path: string;
  current: boolean;
  job_id: string;
  job_status: string;
  status: PrismResult['status'];
  commit: string | null;
  started_at: string;
  finished_at: string;
  counts: Record<string, number>;
  scope_docs: string[];
  /** The system overview's first paragraph. */
  overview: string;
  threats: { severity: string; title: string; stride: string[] }[];
  /** Threats beyond MAX_PANEL_THREATS. */
  more: number;
  reason: string | null;
  pending: boolean;
  stale: boolean;
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

/**
 * The latest pentest job of a repo. Like latestSecurityReview: newest write per
 * job, but a completed record for a job wins over its pending record.
 */
export function latestPentest(results: PrismResult[]): PrismResult | null {
  const byJob = new Map<string, PrismResult>();
  for (const r of results) {
    if (r.kind !== 'security-pentest' || !r.pentest?.job_id) continue;
    const prev = byJob.get(r.pentest.job_id);
    if (prev && (prev.status === 'pending') !== (r.status === 'pending')) {
      if (prev.status === 'pending') byJob.set(r.pentest.job_id, r);
      continue;
    }
    if (!prev || r.finished_at > prev.finished_at) byJob.set(r.pentest.job_id, r);
  }
  const all = [...byJob.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  return all[0] ?? null;
}

export function collectSecurity(repos: { name: string; path: string; current: boolean }[], read: (root: string) => PrismResult[] = readResults, now: Date = new Date()): SecurityPanel {
  const rows: SecurityRepoRow[] = [];
  const pentests: SecurityPentestRow[] = [];
  for (const repo of repos) {
    const all = read(repo.path);
    const r = latestSecurityReview(all);
    if (r && r.security) {
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
    const p = latestPentest(all);
    if (p && p.pentest) {
      const pf = [...(p.findings || [])]
        .sort((a, b) => (RANK[b.risk_level || ''] ?? 0) - (RANK[a.risk_level || ''] ?? 0) || (a.title || '').localeCompare(b.title || ''))
        .map((f) => ({ risk_level: f.risk_level || f.severity.toUpperCase(), title: f.title || f.message, confidence: f.confidence ?? null }));
      pentests.push({
        name: repo.name, path: repo.path, current: repo.current,
        job_id: p.pentest.job_id, job_status: p.pentest.job_status, status: p.status,
        target_host: p.pentest.target_host, started_at: p.started_at, finished_at: p.finished_at,
        counts: p.pentest.counts || {}, findings: pf.slice(0, MAX_PANEL_FINDINGS), truncated: pf.length > MAX_PANEL_FINDINGS,
        reason: p.reason ?? null, overview: p.pentest.overview ?? null,
        pending: p.status === 'pending',
        stale: p.status === 'pending' && now.getTime() - Date.parse(p.started_at) > PENTEST_PENDING_STALE_MS,
      });
    }
  }
  rows.sort((a, b) => Number(b.current) - Number(a.current) || b.started_at.localeCompare(a.started_at));
  const tms: ThreatModelRow[] = [];
  for (const repo of repos) {
    const r = latestThreatModel(read(repo.path));
    if (r) tms.push(threatModelRow(repo, r, now));
  }
  tms.sort((a, b) => Number(b.current) - Number(a.current) || b.started_at.localeCompare(a.started_at));
  pentests.sort((a, b) => Number(b.current) - Number(a.current) || b.started_at.localeCompare(a.started_at));
  return { repos: rows, pentests, hint: 'prism-cli security code-review', pending_hint: PENDING_HINT, pentest_hint: PENTEST_HINT, threat_models: tms, threats_hint: THREATS_HINT };
}

/** The newest threat model job of a repo; for one job, a verdict wins over a pending record. */
export function latestThreatModel(results: PrismResult[]): PrismResult | null {
  const byJob = new Map<string, PrismResult>();
  for (const r of results) {
    if (r.kind !== 'security-threat-model' || !r.threat_model?.job_id) continue;
    const prev = byJob.get(r.threat_model.job_id);
    const better = !prev || (prev.status === 'pending' && r.status !== 'pending')
      || ((prev.status === 'pending') === (r.status === 'pending') && r.finished_at > prev.finished_at);
    if (better) byJob.set(r.threat_model.job_id, r);
  }
  return [...byJob.values()].sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
}

function threatModelRow(repo: { name: string; path: string; current: boolean }, r: PrismResult, now: Date): ThreatModelRow {
  const t = r.threat_model!;
  const threats = [...(r.findings || [])]
    .sort((a, b) => (RANK[b.risk_level || ''] ?? 0) - (RANK[a.risk_level || ''] ?? 0))
    .map((f) => ({ severity: f.risk_level || f.severity.toUpperCase(), title: f.title || f.message, stride: f.stride || [] }));
  return {
    name: repo.name, path: repo.path, current: repo.current,
    job_id: t.job_id, job_status: t.job_status, status: r.status, commit: r.commit,
    started_at: r.started_at, finished_at: r.finished_at, counts: t.counts || {}, scope_docs: t.scope_docs || [],
    overview: firstParagraph(t.system_overview),
    threats: threats.slice(0, MAX_PANEL_THREATS), more: Math.max(0, threats.length - MAX_PANEL_THREATS), reason: r.reason ?? null,
    pending: r.status === 'pending',
    stale: r.status === 'pending' && now.getTime() - Date.parse(r.started_at) > PENDING_STALE_MS,
  };
}
