/**
 * The Security findings panel: the cached `security-review` results that
 * `prism-cli security code-review` and `security findings` write to
 * .prism/results/. Local files only; no AWS calls.
 */
import { readResults, type PrismResult } from '../codewatch/results.js';
import { firstParagraph } from '../security/threat-model.js';
import { PENDING_STALE_MS } from '../security/review.js';
import type { CheckLookup } from './security-runs.js';
import type { CheckState } from './security-autocheck.js';

export const MAX_PANEL_FINDINGS = 50;
/**
 * A pending record older than PENDING_STALE_MS (security/review.ts) is marked `stale?`, unless the live dashboard's
 * last read-only check (security-autocheck.ts) found the job still running. `check` carries that check, and its
 * reason when it could not run or failed.
 */
export { PENDING_STALE_MS };
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
  /** Pending for longer than PENDING_STALE_MS, and no check found it still running. */
  stale: boolean;
  /** The last auto-check of this pending job; null when none ran. */
  check: CheckState | null;
  /**
   * A newer job that is still pending while this row shows the last completed
   * one, so its findings stay on the page; null when there is none.
   */
  running: RunningJob | null;
}

export interface RunningJob { job_id: string; scope: string; started_at: string; stale: boolean; check: CheckState | null }

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
  /** The last teardown left the stack up; --cleanup retries it. */
  teardown_failed: { at: string; reason: string } | null;
  pending: boolean;
  stale: boolean;
  check: CheckState | null;
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
  check: CheckState | null;
}

/** Past `windowMs` and not reported running by the last check. */
const staleAfter = (r: PrismResult, now: Date, windowMs: number, check: CheckState | null) =>
  r.status === 'pending' && now.getTime() - Date.parse(r.started_at) > windowMs && check?.state !== 'running';

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
    // A run that never started a job (the app never became healthy) has no job id but may still have a stack up.
    const key = r.kind === 'security-pentest' ? (r.pentest?.job_id || r.pentest?.stack) : null;
    if (!key) continue;
    const prev = byJob.get(key);
    if (prev && (prev.status === 'pending') !== (r.status === 'pending')) {
      if (prev.status === 'pending') byJob.set(key, r);
      continue;
    }
    if (!prev || r.finished_at > prev.finished_at) byJob.set(key, r);
  }
  const all = [...byJob.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  return all[0] ?? null;
}

export function collectSecurity(repos: { name: string; path: string; current: boolean }[], read: (root: string) => PrismResult[] = readResults, now: Date = new Date(), lookup?: CheckLookup): SecurityPanel {
  const checkOf = (r: PrismResult | null | undefined, type: Parameters<CheckLookup>[0], job: string | undefined) => (r && r.status === 'pending' && job && lookup ? lookup(type, job) : null);
  const rows: SecurityRepoRow[] = [];
  const pentests: SecurityPentestRow[] = [];
  for (const repo of repos) {
    const all = read(repo.path);
    const latest = latestSecurityReview(all);
    // A pending newest job does not hide the last completed review: show that one, and the running job beside it.
    const done = latest?.status === 'pending' ? latestSecurityReview(all.filter((x) => x.status !== 'pending' && x.security?.job_id !== latest.security!.job_id)) : null;
    const r = done ?? latest;
    const runCheck = done && latest ? checkOf(latest, 'code-review', latest.security!.job_id) : null;
    const running: RunningJob | null = done && latest ? {
      job_id: latest.security!.job_id, scope: latest.security!.scope, started_at: latest.started_at,
      stale: staleAfter(latest, now, PENDING_STALE_MS, runCheck), check: runCheck,
    } : null;
    if (r && r.security) {
      const check = checkOf(r, 'code-review', r.security.job_id);
      const findings = [...(r.findings || [])]
        .sort((a, b) => (RANK[b.risk_level || ''] ?? 0) - (RANK[a.risk_level || ''] ?? 0) || a.file.localeCompare(b.file))
        .map((f) => ({ risk_level: f.risk_level || f.severity.toUpperCase(), title: f.title || f.message, file: f.file, line: f.line, cwe: f.cwe ?? null }));
      rows.push({
        name: repo.name, path: repo.path, current: repo.current,
        job_id: r.security.job_id, job_status: r.security.job_status, status: r.status, scope: r.security.scope,
        started_at: r.started_at, finished_at: r.finished_at, counts: r.security.counts || {},
        findings: findings.slice(0, MAX_PANEL_FINDINGS), truncated: findings.length > MAX_PANEL_FINDINGS, reason: r.reason ?? null,
        pending: r.status === 'pending',
        stale: staleAfter(r, now, PENDING_STALE_MS, check), check,
        running,
      });
    }
    const p = latestPentest(all);
    if (p && p.pentest) {
      const pcheck = checkOf(p, 'pentest', p.pentest.job_id);
      const pf = [...(p.findings || [])]
        .sort((a, b) => (RANK[b.risk_level || ''] ?? 0) - (RANK[a.risk_level || ''] ?? 0) || (a.title || '').localeCompare(b.title || ''))
        .map((f) => ({ risk_level: f.risk_level || f.severity.toUpperCase(), title: f.title || f.message, confidence: f.confidence ?? null }));
      pentests.push({
        name: repo.name, path: repo.path, current: repo.current,
        job_id: p.pentest.job_id, job_status: p.pentest.job_status, status: p.status,
        target_host: p.pentest.target_host, started_at: p.started_at, finished_at: p.finished_at,
        counts: p.pentest.counts || {}, findings: pf.slice(0, MAX_PANEL_FINDINGS), truncated: pf.length > MAX_PANEL_FINDINGS,
        reason: p.reason ?? null, overview: p.pentest.overview ?? null,
        teardown_failed: p.pentest.teardown_failed ?? null,
        pending: p.status === 'pending',
        stale: staleAfter(p, now, PENTEST_PENDING_STALE_MS, pcheck), check: pcheck,
      });
    }
  }
  rows.sort((a, b) => Number(b.current) - Number(a.current) || (b.running?.started_at ?? b.started_at).localeCompare(a.running?.started_at ?? a.started_at));
  const tms: ThreatModelRow[] = [];
  for (const repo of repos) {
    const r = latestThreatModel(read(repo.path));
    if (r) tms.push(threatModelRow(repo, r, now, checkOf(r, 'threat-model', r.threat_model?.job_id)));
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

function threatModelRow(repo: { name: string; path: string; current: boolean }, r: PrismResult, now: Date, check: CheckState | null = null): ThreatModelRow {
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
    stale: staleAfter(r, now, PENDING_STALE_MS, check), check,
  };
}
