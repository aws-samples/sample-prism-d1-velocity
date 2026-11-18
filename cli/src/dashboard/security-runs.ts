/**
 * Security runs: every code review, threat model and penetration test saved in
 * each discovered repo's .prism/results/, one row per run, newest first, and
 * one run's full findings for the drill-down (#security/run/<repoId>/<runId>).
 *
 * Local result files only: loading the Dashboard or a drill-down makes no AWS
 * call. A run id is its result file name (ResultEntry.id), which the directory
 * listing supplies; the drill-down resolves the repo id against the server's
 * own repo list and never takes a path from the request. Finding text comes
 * from AWS and from code: it leaves here as plain JSON strings and the page
 * places it with textContent.
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RESULTS_DIR, readResultEntries, type Finding, type PrismResult, type ResultEntry } from '../codewatch/results.js';
import { last4 } from '../aws/connection.js';
import type { CheckState } from './security-autocheck.js';
import { cleanupArgsFor, pentestCleanupOf, shownReason } from './security-pentest.js';
import { DEPLOY_PHASE_LABEL, DEPLOY_PHASES, deployLogName, type DeployPhase } from '../security/pentest-deploy.js';
import { maskHome, redact } from '../utils/redact.js';

export type RunType = 'code-review' | 'threat-model' | 'pentest';
/**
 * complete: a verdict; running: pending and recent, or the dashboard's last check (security-autocheck.ts) found it
 * still running in AWS; noverdict: pending past the stale window with no such check (none could run, or it failed:
 * `check.reason` says why); failed: no verdict; bootstrapping (1.21.7): a pentest still deploying its environment,
 * no job yet.
 */
export type RunStatus = 'complete' | 'running' | 'failed' | 'noverdict' | 'bootstrapping';
/** A pentest run's deploy, as the page shows it: the step (id and words), since when, and whether a log can be shown. */
export interface RunDeploy { phase: string; label: string; step: number; steps: number; phase_at: string; log: boolean; interrupted: boolean }
export interface RunCounts { critical: number; high: number; medium: number; low: number }

export interface SecurityRunRow {
  repo_id: string;
  run_id: string;
  repo: string;
  type: RunType;
  status: RunStatus;
  started_at: string;
  /** Wall time, else the service's job time; null while running or when unknown. */
  duration_s: number | null;
  branch: string | null;
  commit: string | null;
  counts: RunCounts;
  /** Findings (or threats) in the run, all levels. */
  total: number;
  /** The most severe finding's title. */
  top_title: string | null;
  reason: string | null;
  job_id: string;
  /** The dashboard's last read-only check of a pending job; null when none ran. */
  check: CheckState | null;
  /** A pentest run's deploy (1.21.7); null for other runs and for records from before 1.21.7. */
  deploy?: RunDeploy | null;
}

/** The last auto-check of a job (security-autocheck.ts stateOf); absent: none (a snapshot, the CLI's --json). */
export type CheckLookup = (type: RunType, jobId: string) => CheckState | null;

export interface RunRepo { id: string; name: string; path: string }

/** Rows kept in the payload; the page pages through them. */
export const MAX_RUNS = 500;
/** As in security.ts: a pending record older than this most likely finished and was never fetched. */
export const STALE_MS: Record<RunType, number> = { 'code-review': 2 * 3600_000, 'threat-model': 2 * 3600_000, pentest: 6 * 3600_000 };

const TYPE_OF: Partial<Record<PrismResult['kind'], RunType>> = { 'security-review': 'code-review', 'security-threat-model': 'threat-model', 'security-pentest': 'pentest' };
const RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
export const runTypeOf = (r: PrismResult): RunType | null => TYPE_OF[r.kind] ?? null;

/** The job behind a result; a pentest that never started a job keys on its stack. */
function info(r: PrismResult) {
  return r.security ?? r.threat_model ?? r.pentest ?? null;
}
// A pentest with no job keys on its stack, else its slug (a deploy that stopped before cdk deploy keeps only the slug).
const rawJobKey = (r: PrismResult): string | null => (r.kind === 'security-pentest' ? r.pentest?.job_id || r.pentest?.stack || r.pentest?.slug || null : info(r)?.job_id || null);
/**
 * The job id, or null when the file holds none or one outside the shape AWS and prism-cli
 * use: the id goes into a copyable command and a URL, so an edited file cannot inject anything.
 */
export const JOB_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const jobKey = (r: PrismResult): string | null => { const k = rawJobKey(r); return k && JOB_ID.test(k) ? k : null; };

/**
 * One entry per job. Two files can hold the same job (code-review writes it
 * with its scope, `security findings` again without): a verdict beats a
 * pending record, then a known scope, then the newest write.
 */
export function runEntries(entries: ResultEntry[]): ResultEntry[] {
  const best = new Map<string, ResultEntry>();
  for (const e of entries) {
    const t = runTypeOf(e.result), k = jobKey(e.result);
    if (!t || !k) continue;
    const key = `${t}:${k}`, prev = best.get(key);
    if (!prev) { best.set(key, e); continue; }
    const a = prev.result, b = e.result;
    const pend = (x: PrismResult) => x.status === 'pending' || x.status === 'deploying';
    if (pend(a) !== pend(b)) { if (pend(a)) best.set(key, e); continue; }
    const scoped = (x: PrismResult) => (x.security ? x.security.scope !== 'unknown' : true);
    if (scoped(a) !== scoped(b)) { if (!scoped(a)) best.set(key, e); continue; }
    if (b.finished_at > a.finished_at) best.set(key, e);
  }
  return [...best.values()];
}

export function runStatus(r: PrismResult, now: Date, check: CheckState | null = null): RunStatus {
  const t = runTypeOf(r)!;
  if (r.status === 'deploying') return 'bootstrapping';
  if (r.status === 'pending') return check?.state === 'running' || now.getTime() - Date.parse(r.started_at) <= STALE_MS[t] ? 'running' : 'noverdict';
  if (r.status === 'error') return 'failed';
  return 'complete';
}

export function runCounts(r: PrismResult): RunCounts {
  const c = (info(r)?.counts || {}) as Record<string, number>;
  return { critical: c.CRITICAL || 0, high: c.HIGH || 0, medium: c.MEDIUM || 0, low: c.LOW || 0 };
}

function duration(r: PrismResult): number | null {
  if (r.status === 'pending' || r.status === 'deploying') return null;
  const i = info(r) as { wall_s?: number | null; service_duration_s?: number | null; service_created_at?: string | null; service_updated_at?: string | null } | null;
  if (typeof i?.wall_s === 'number') return i.wall_s;
  if (typeof i?.service_duration_s === 'number') return i.service_duration_s;
  const a = Date.parse(i?.service_created_at || ''), b = Date.parse(i?.service_updated_at || '');
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 1000) : null;
}

/** The deploy of a pentest record, for the page; the log only when the record names the run's own log file. */
export function runDeploy(e: ResultEntry): RunDeploy | null {
  const d = e.result.kind === 'security-pentest' ? e.result.pentest?.deploy : null;
  if (!d || typeof d.phase !== 'string') return null;
  const i = DEPLOY_PHASES.indexOf(d.phase as DeployPhase);
  return { phase: d.phase, label: DEPLOY_PHASE_LABEL[d.phase as DeployPhase] ?? 'Bootstrapping', step: i + 1, steps: DEPLOY_PHASES.length,
    phase_at: String(d.phase_at || e.result.started_at), log: d.log === deployLogName(e.id), interrupted: !!d.interrupted };
}

const sorted = (fs: Finding[]) => [...fs].sort((a, b) => (RANK[b.risk_level || ''] ?? 0) - (RANK[a.risk_level || ''] ?? 0));

export function runRow(repo: RunRepo, e: ResultEntry, now: Date, lookup?: CheckLookup): SecurityRunRow {
  const r = e.result;
  const top = sorted(r.findings || [])[0];
  const job = jobKey(r) || '';
  const check = r.status === 'pending' && job && lookup ? lookup(runTypeOf(r)!, job) : null;
  return {
    repo_id: repo.id, run_id: e.id, repo: repo.name, type: runTypeOf(r)!, status: runStatus(r, now, check),
    started_at: r.started_at, duration_s: duration(r), branch: r.branch, commit: r.commit ? r.commit.slice(0, 12) : null,
    counts: runCounts(r), total: (r.findings || []).length, top_title: top ? (top.title || top.message) : null,
    // A pentest with no job yet (deploying, or its deploy stopped) shows no job: its key is the stack.
    reason: r.reason ?? null, job_id: r.kind === 'security-pentest' && !r.pentest?.job_id ? '' : job, check, deploy: runDeploy(e),
  };
}

/** Every run in every repo, newest first, at most MAX_RUNS. */
export function collectSecurityRuns(repos: RunRepo[], read: (root: string) => ResultEntry[] = readResultEntries, now: Date = new Date(), check?: CheckLookup): SecurityRunRow[] {
  const rows: SecurityRunRow[] = [];
  for (const repo of repos) for (const e of runEntries(read(repo.path))) rows.push(runRow(repo, e, now, check));
  return rows.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, MAX_RUNS);
}

// ---------------------------------------------------------------- start guards

/** What the Start code review dialog checks first: a review of the repo still running, and a finished review of HEAD. */
export interface StartGuard {
  running: { run_id: string; job_id: string; started_at: string; commit: string | null; branch: string | null } | null;
  reviewed: { run_id: string; finished_at: string; commit: string; counts: RunCounts; total: number } | null;
}

/**
 * The guards for one repo, from its result files: the newest code review that
 * is running (pending inside the stale window), and the newest complete one
 * whose commit is `head`. Local only; `head` null (no commit) skips the second.
 */
export function startGuard(entries: ResultEntry[], head: string | null, now: Date): StartGuard {
  const runs = runEntries(entries).filter((e) => runTypeOf(e.result) === 'code-review')
    .sort((a, b) => b.result.started_at.localeCompare(a.result.started_at));
  const r = runs.find((e) => runStatus(e.result, now) === 'running');
  const done = head ? runs.find((e) => runStatus(e.result, now) === 'complete' && e.result.commit === head) : undefined;
  return {
    running: r ? { run_id: r.id, job_id: jobKey(r.result) || '', started_at: r.result.started_at, commit: r.result.commit ? r.result.commit.slice(0, 12) : null, branch: r.result.branch } : null,
    reviewed: done ? { run_id: done.id, finished_at: done.result.finished_at, commit: head!.slice(0, 12), counts: runCounts(done.result), total: (done.result.findings || []).length } : null,
  };
}

// ---------------------------------------------------------------- the drill-down

export interface RunFinding {
  /** critical / high / medium / low / info / unknown. */
  severity: string;
  title: string;
  /** `file:line`, the file alone, or null (a pentest finding has no location). */
  location: string | null;
  cwe: string | null;
  stride: string[];
  confidence: string | null;
  description: string;
  /** null: this run type gives none (code review and pentest findings carry no remediation text). */
  remediation: string | null;
  evidence: string[];
  /** Threat models: the affected components and assets (saved since 1.20.1). */
  assets: string[];
  finding_id: string | null;
}

export type RunDetail =
  | { found: false; error: string }
  | {
    found: true; run: SecurityRunRow; findings: RunFinding[];
    account4: string | null; region: string | null; scope: string | null; target_host: string | null; overview: string | null;
    result_file: string; cli: string; no_remediation: string | null;
    /**
     * A pentest whose environment may still be up (its teardown failed, or the job finished with the stack
     * recorded): why, the failure reason (redacted, home as ~), and whether Clean up can target this run
     * (`why` when it cannot), and the exact line Clean up runs (also the terminal command). null for every other run.
     */
    cleanup: { kind: 'teardown_failed' | 'still_up' | 'deploy_stopped'; reason: string | null; available: boolean; why: string | null; command: string | null } | null;
  };

export const NO_REMEDIATION = 'No remediation provided by this run type.';
const REPO_ID = /^[a-f0-9]{16}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,200}$/;
const SCOPE: Record<string, string> = { diff: 'branch diff against its upstream', full: 'the whole repo at HEAD', unknown: 'fetched later (scope not recorded)' };

/** The full text: the saved description, else (results before 1.18.0) the message without its "title: " prefix. */
function fullText(f: Finding): string {
  if (f.description) return f.description;
  const t = f.title || '';
  return t && f.message.startsWith(t + ': ') ? f.message.slice(t.length + 2) : f.message === t ? '' : f.message;
}

const sev = (f: Finding) => {
  const r = (f.risk_level || f.severity || '').toUpperCase();
  return r === 'INFORMATIONAL' ? 'info' : ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].includes(r) ? r.toLowerCase() : 'unknown';
};

/** `~/…` for a path under home (either spelling of a symlinked home), else the path. */
function tilde(p: string, home: string): string {
  if (!home) return p;
  let real = home;
  try { real = realpathSync(home); } catch { /* keep home */ }
  for (const h of [home, real]) if (p === h || p.startsWith(h + '/')) return '~' + p.slice(h.length);
  return p;
}
const shellWord = (p: string) => (/^[~A-Za-z0-9_./@%+,:=-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

/** GET /api/security-run?repo=<id>&run=<id>: one run's header and every finding. Local files only. */
export function securityRunDetail(repos: RunRepo[], repoArg: string | null, runArg: string | null, home: string, now: Date = new Date(),
  read: (root: string) => ResultEntry[] = readResultEntries, check?: CheckLookup, cleanupLine?: (repoPath: string, args: string[]) => string): RunDetail {
  if (!repoArg || !REPO_ID.test(repoArg) || !runArg || !RUN_ID.test(runArg)) return { found: false, error: 'not a run id' };
  const repo = repos.find((r) => r.id === repoArg);
  if (!repo) return { found: false, error: 'that repo is not in the scan list' };
  const e = read(repo.path).find((x) => x.id === runArg);
  if (!e || !runTypeOf(e.result)) return { found: false, error: 'no such run in this repo (it may have been deleted)' };
  if (!jobKey(e.result)) return { found: false, error: 'this result file has no valid job id' };
  const r = e.result, type = runTypeOf(r)!, i = info(r) as { account?: string; region?: string } | null;
  const findings: RunFinding[] = sorted(r.findings || []).map((f) => ({
    severity: sev(f), title: f.title || f.message,
    location: f.file ? f.file + (f.line ? ':' + f.line : '') : null,
    cwe: f.cwe ?? null, stride: f.stride || [], confidence: f.confidence ?? null,
    description: fullText(f),
    remediation: type === 'threat-model' && f.recommendation ? f.recommendation : null,
    evidence: f.evidence || [], assets: f.assets || [], finding_id: f.finding_id || f.threat_id || null,
  }));
  const left = pentestCleanupOf(e);
  const target = left ? cleanupArgsFor(repo.path, e) : null;
  const cleanup = left ? {
    kind: left.kind, reason: shownReason(left.reason, home), available: !!target && !('error' in target), why: target && 'error' in target ? target.error : null,
    command: target && 'args' in target && cleanupLine ? cleanupLine(repo.path, target.args) : null,
  } : null;
  const where = shellWord(tilde(repo.path, home));
  const job = shellWord(jobKey(r)!);
  const cli = type === 'code-review' ? `prism-cli security findings --job ${job} --path ${where}`
    : type === 'threat-model' ? `prism-cli security threats --job ${job} --path ${where}`
      // A pentest with no job yet (deploying, or its deploy stopped): its status, which also marks an interrupted deploy.
      : r.pentest?.job_id ? `prism-cli security findings --pentest ${job} --path ${where}` : `prism-cli security pentest --status --path ${where}`;
  return {
    found: true, run: runRow(repo, e, now, check), findings,
    account4: i?.account ? last4(i.account) : null, region: i?.region ?? null,
    scope: r.security ? SCOPE[r.security.scope] ?? null : null,
    target_host: r.pentest?.target_host ?? null,
    overview: r.threat_model?.system_overview ?? r.pentest?.overview ?? null,
    result_file: tilde(join(resolve(repo.path, RESULTS_DIR), `${e.id}.json`), home),
    cli, no_remediation: type === 'threat-model' ? null : NO_REMEDIATION,
    cleanup,
  };
}

/**
 * The run a finished dashboard action wrote: the newest security result in
 * `repoPath` whose file changed at or after `sinceMs` (a pending record is
 * completed in place, so its mtime moves). null when the command wrote none.
 */
export function runWrittenSince(repoPath: string, sinceMs: number, now: Date = new Date()): { run: string; status: RunStatus } | null {
  const dir = resolve(repoPath, RESULTS_DIR);
  let best: { e: ResultEntry; m: number } | null = null;
  for (const e of readResultEntries(repoPath)) {
    if (!runTypeOf(e.result)) continue;
    let m: number;
    try { m = statSync(join(dir, `${e.id}.json`)).mtimeMs; } catch { continue; }
    // A second of slack: some filesystems store mtimes at whole seconds.
    if (m + 1000 < sinceMs) continue;
    if (!best || m > best.m) best = { e, m };
  }
  return best ? { run: best.e.id, status: runStatus(best.e.result, now) } : null;
}

// ---------------------------------------------------------------- a pentest deploy's log (1.21.7)

/** How much of a deploy log the page gets: its end. */
export const LOG_TAIL_BYTES = 64 * 1024;
export const LOG_TAIL_LINES = 200;

export type RunLog = { found: false; error: string } | { found: true; text: string; truncated: boolean; updated_at: string | null };

/**
 * GET /api/security-run/log?repo=<id>&run=<id>: the end of a pentest deploy's log, redacted (account ids, ARNs,
 * keys) and with home as ~. Only the run's own log file (<run id>.log in .prism/results/, named by its record);
 * ids only, never a path from the request. Local files only.
 */
export function securityRunLog(repos: RunRepo[], repoArg: string | null, runArg: string | null, home: string, read: (root: string) => ResultEntry[] = readResultEntries): RunLog {
  if (!repoArg || !REPO_ID.test(repoArg) || !runArg || !RUN_ID.test(runArg)) return { found: false, error: 'not a run id' };
  const repo = repos.find((r) => r.id === repoArg);
  if (!repo) return { found: false, error: 'that repo is not in the scan list' };
  const e = read(repo.path).find((x) => x.id === runArg);
  if (!e || !runDeploy(e)?.log) return { found: false, error: 'this run has no deploy log (it was started from a terminal, or before 1.21.7)' };
  const file = join(resolve(repo.path, RESULTS_DIR), deployLogName(e.id));
  let size: number, mtime: string;
  try { const st = statSync(file); size = st.size; mtime = st.mtime.toISOString(); } catch { return { found: true, text: '', truncated: false, updated_at: null }; }
  const n = Math.min(size, LOG_TAIL_BYTES), buf = Buffer.alloc(n);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, n, size - n); } finally { closeSync(fd); }
  let lines = buf.toString('utf8').split('\n');
  if (size > n) lines = lines.slice(1);
  const truncated = size > n || lines.length > LOG_TAIL_LINES;
  let real = home;
  try { real = realpathSync(home); } catch { /* keep home */ }
  const text = [home, real].reduce((t, h) => (h ? maskHome(t, h) : t), redact(lines.slice(-LOG_TAIL_LINES).join('\n')));
  return { found: true, text, truncated, updated_at: mtime };
}
