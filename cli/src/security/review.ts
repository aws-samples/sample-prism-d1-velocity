/**
 * `prism-cli security code-review` and `prism-cli security findings`: run an
 * AWS Security Agent code review job on demand, and read its findings.
 *
 * Same calls as the CI eval gate's Continuum step:
 *   start-code-review-job (--diff-source s3Uri for a diff scan; without it the
 *     code review's own source asset is reviewed), batch-get-code-review-jobs,
 *   list-findings (--code-review-job-id), plus batch-get-findings for each
 *   finding's description and code location, and
 *   list-code-review-jobs-for-code-review for "the latest job".
 *
 * Account, region, credentials, the identity block and error messages are the
 * ones `enable security` uses. The only AWS writes are the S3 snapshot upload
 * (skipped when identical) and starting the job; `security findings` makes
 * none. Results go to .prism/results/ with kind security-review, so the
 * dashboard can show them without credentials.
 */
import { realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { makeResult, readResultEntries, writeResult, type Finding, type PrismResult, type ResultEntry, type Severity } from '../codewatch/results.js';
import { explainAwsError, redact } from './errors.js';
import { MARKER_PATH, readLocalMarker } from './marker.js';
import { repoZipKey, SSM_PREFIX } from './repo.js';
import {
  Abort, call, getParam, md5, preflight, printIdentity, resolveRegion, resolveRepo, NO_REGION_MESSAGE,
  type Ctx, type Deps, type Identity, type RepoCtx, type Resolved, type SecurityOptions,
} from './setup.js';

export const PARAM_AGENT_SPACE = `${SSM_PREFIX}/agent-space-id`;
export const PARAM_SCAN_BUCKET = `${SSM_PREFIX}/scan-bucket`;

/** Terminal job states (the CI gate breaks on the same three). */
export const TERMINAL = new Set(['COMPLETED', 'FAILED', 'STOPPED']);

/** Poll delays: 10 s, doubling, capped at 60 s. */
export const POLL_FIRST_MS = 10_000;
export const POLL_MAX_MS = 60_000;
export const DEFAULT_TIMEOUT_MIN = 30;
/** A failed job poll is retried this many times, after 2 s, 4 s and 8 s. */
export const POLL_RETRIES = 3;
export const RETRY_FIRST_MS = 2_000;
/** Findings per list-findings page, and ids per batch-get-findings call (assumed limit). */
export const FINDINGS_PAGE = 100;
export const DETAILS_BATCH = 25;
/** Printed description length. */
const DESCRIPTION_CHARS = 200;

/** Security Agent risk levels, most severe first. */
export const RISK_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL', 'UNKNOWN'] as const;
const RISK_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFORMATIONAL: 0, UNKNOWN: 0 };
export const FAIL_ON_LEVELS = ['critical', 'high', 'medium', 'low'] as const;

/** Extra runtime seams on top of enable security's Deps. */
export interface ReviewDeps extends Deps {
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Registers a Ctrl-C handler; returns the function that removes it. */
  onInterrupt(handler: () => void): () => void;
  /** Rewrites the single ticker line (TTY only). */
  ticker(line: string): void;
  /** Human output in --json mode (stderr), so stdout carries only the JSON. */
  err(line?: string): void;
  /** The --json document (stdout). */
  out(text: string): void;
  /** Working directory, for the repo-root check when there is no --path. */
  cwd(): string;
}

export interface CodeReviewOptions extends SecurityOptions {
  /** Repository top level (default: the working directory, which must be the top level). */
  path?: string;
  full?: boolean;
  /** Minutes. */
  timeout?: string | number;
  failOn?: string;
  json?: boolean;
  /** commander turns --no-wait into wait: false. */
  wait?: boolean;
}

export interface FindingsOptions extends SecurityOptions {
  path?: string;
  job?: string;
  latest?: boolean;
  severity?: string;
  json?: boolean;
  wait?: boolean;
  timeout?: string | number;
}

interface Setup { agentSpaceId: string; codeReviewId: string; source: string }

export interface JobInfo {
  codeReviewJobId: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  /** Step currently running, for the ticker. */
  step?: string | null;
  /** ERROR / CLIENT_ERROR context of a failed job. */
  reason?: string | null;
}

export interface ReviewFinding {
  findingId: string;
  /** The path as the service reported it; `file` is the repo-relative form. */
  rawFile: string;
  riskLevel: string;
  title: string;
  file: string;
  line: number | null;
  cwe: string | null;
  description: string;
  riskType: string;
}

// ---------------------------------------------------------------------------
// Setup lookup
// ---------------------------------------------------------------------------

export const NOT_SET_UP = 'run prism-cli enable security first';

/**
 * Agent space and code review for this repo. The SSM parameters (written by
 * `enable security` and the CI gate, in the account itself) are the source of
 * truth: a file in the repo can be committed by anyone, so it must never
 * choose where a developer's code is uploaded and reviewed.
 *
 * - The legacy `security` block in the committable `.prism/config.json` is
 *   never read here.
 * - `.prism/security.local.json` is only a fallback when SSM has no value,
 *   only when git does not track it, and only for this account and region.
 * - When SSM and the marker disagree, SSM wins and the difference is shown.
 */
export function resolveSetup(ctx: Ctx, id: Identity, repo: RepoCtx): Setup {
  const space = getParam(ctx, PARAM_AGENT_SPACE);
  const review = getParam(ctx, repo.param);
  let local = readLocalMarker(repo.root);
  if (local && ctx.deps.git(['-C', repo.root, 'ls-files', '--error-unmatch', MARKER_PATH]).ok) {
    ctx.deps.log(`Warning: ignoring ${MARKER_PATH} because git tracks it; a committed file cannot choose the code review.`);
    local = null;
  }
  if (local && (local.account !== id.account || local.region !== ctx.opts.region)) local = null;
  if (space && review) {
    if (local && (local.agentSpaceId !== space || local.codeReviewId !== review)) {
      ctx.deps.log(`Warning: ${MARKER_PATH} names agent space ${local.agentSpaceId} and code review ${local.codeReviewId}, but SSM says ${space} and ${review}; using SSM. Re-run prism-cli enable security to refresh the marker.`);
    }
    return { agentSpaceId: space, codeReviewId: review, source: `SSM ${repo.param}` };
  }
  if (local) {
    ctx.deps.log(`Note: SSM has no ${space ? repo.param : PARAM_AGENT_SPACE}; using the IDs from the local marker ${MARKER_PATH}.`);
    return { agentSpaceId: local.agentSpaceId, codeReviewId: local.codeReviewId, source: `local marker ${MARKER_PATH}` };
  }
  throw new Abort(`No Security Agent code review for ${repo.id} in account ${id.account}, region ${ctx.opts.region}: ${NOT_SET_UP}.`);
}

export function begin(input: SecurityOptions, deps: Deps, readOnly: boolean, say: (l?: string) => void): Ctx | null {
  const r = resolveRegion(input, deps);
  if (!r) { say(`Error: ${NO_REGION_MESSAGE}`); return null; }
  const opts: Resolved = { ...input, region: r.region, regionSource: r.source };
  return { opts, deps: { ...deps, log: say }, cliVersion: deps.awsVersion(), readOnly };
}

const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * The repo these commands work on, strictly: `--path <dir>`, or the working
 * directory, must be the top level of a git repository (compared by realpath,
 * so a symlinked root is fine). A subdirectory or a non-repo is an error, never
 * a walk up to some enclosing repo. Every later git call runs with -C <root>,
 * and results are written under it.
 */
export function resolveRepoRoot(deps: Pick<Deps, 'git'> & { cwd(): string }, path?: string): string {
  const dir = path !== undefined ? resolve(deps.cwd(), path) : deps.cwd();
  const top = deps.git(['-C', dir, 'rev-parse', '--show-toplevel']);
  const root = top.ok ? top.stdout.trim() : '';
  if (path !== undefined) {
    if (!root) throw new Abort(`--path ${dir} is not a git repository.`);
    if (real(dir) !== real(root)) throw new Abort(`--path ${dir} is not the top level of its repository; the top level is ${root}.`);
    return root;
  }
  if (!root) throw new Abort('not a git repository; cd into one or pass --path <repo>');
  if (real(dir) !== real(root)) throw new Abort(`run from the repository root (${root}) or pass --path <repo>`);
  return root;
}

/**
 * The repo root, checked before anything else runs: a wrong directory prints
 * one Error line and makes no AWS call (no notice, no region lookup, no STS).
 */
export function checkedRoot(deps: ReviewDeps, path: string | undefined, say: (l?: string) => void): string | null {
  try { return resolveRepoRoot(deps, path); } catch (e) {
    if (e instanceof Abort) { say(`Error: ${redact(e.message)}`); return null; }
    throw e;
  }
}

export function needRepo(ctx: Ctx, root: string): RepoCtx {
  const repo = resolveRepo(ctx.opts, ctx.deps, root);
  if ('error' in repo) throw new Abort(repo.error);
  return repo;
}

// ---------------------------------------------------------------------------
// Jobs and findings (reads)
// ---------------------------------------------------------------------------

function toJob(j: any): JobInfo {
  // shortcut: the AWS CLI returns untyped JSON; only these fields are read.
  const steps: any[] = Array.isArray(j?.steps) ? j.steps : [];
  const ctxs: any[] = Array.isArray(j?.executionContext) ? j.executionContext : [];
  const running = steps.find((s) => s?.status === 'IN_PROGRESS');
  const err = ctxs.filter((c) => c?.contextType === 'ERROR' || c?.contextType === 'CLIENT_ERROR').map((c) => String(c.context || '')).filter(Boolean);
  return {
    codeReviewJobId: String(j?.codeReviewJobId || ''),
    status: String(j?.status || 'UNKNOWN'),
    createdAt: j?.createdAt ? String(j.createdAt) : undefined,
    updatedAt: j?.updatedAt ? String(j.updatedAt) : undefined,
    step: running?.name ? String(running.name) : null,
    reason: err.length ? err.join('; ') : null,
  };
}

const jobArgs = (setup: Setup, jobId: string) => ['securityagent', 'batch-get-code-review-jobs', '--agent-space-id', setup.agentSpaceId, '--code-review-job-ids', jobId];

function parseJob(json: any, setup: Setup, jobId: string): JobInfo {
  const j = (json?.codeReviewJobs || [])[0];
  if (!j) throw new Abort(`No code review job ${jobId} in agent space ${setup.agentSpaceId}.`);
  return toJob(j);
}

export function getJob(ctx: Ctx, setup: Setup, jobId: string): JobInfo {
  return parseJob(call(ctx, jobArgs(setup, jobId)).json, setup, jobId);
}

/** Every page of `--max-items` results, following NextToken (the CLI's) or nextToken (the API's). */
export function paged(ctx: Ctx, args: string[], key: string): any[] {
  const out: any[] = [];
  let token: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r = call(ctx, [...args, '--max-items', String(FINDINGS_PAGE), ...(token ? ['--starting-token', token] : [])]);
    out.push(...(r.json?.[key] || []));
    token = r.json?.NextToken || r.json?.nextToken || undefined;
    if (!token) return out;
  }
  throw new Abort(`${args[1]} returned more than 1000 pages; stopping.`);
}

export function latestJob(ctx: Ctx, setup: Setup): JobInfo | null {
  const jobs = paged(ctx, ['securityagent', 'list-code-review-jobs-for-code-review', '--agent-space-id', setup.agentSpaceId, '--code-review-id', setup.codeReviewId], 'codeReviewJobSummaries');
  if (!jobs.length) return null;
  jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return toJob(jobs[0]);
}

const CWE = /\bCWE-\d+\b/i;

/** The service reports paths inside its own sandbox: `/tmp/opt/source_code/code_sc-<id>/<repo path>`. */
const SANDBOX_PREFIX = /^.*?\/source_code\/code_sc-[^/]+\//;

/** A finding path as a repo-relative path: the sandbox prefix, the repo root and a leading ./ or / removed. */
export function repoRelative(raw: string, repoRoot?: string): string {
  let p = raw.replace(/\\/g, '/');
  p = p.replace(SANDBOX_PREFIX, '');
  if (repoRoot) {
    const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    if (p.startsWith(root)) p = p.slice(root.length);
  }
  return p.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

export function fetchFindings(ctx: Ctx, setup: Setup, jobId: string, repoRoot?: string): ReviewFinding[] {
  const summaries = paged(ctx, ['securityagent', 'list-findings', '--agent-space-id', setup.agentSpaceId, '--code-review-job-id', jobId], 'findingsSummaries');
  const details = new Map<string, any>();
  for (let i = 0; i < summaries.length; i += DETAILS_BATCH) {
    const ids = summaries.slice(i, i + DETAILS_BATCH).map((s) => String(s.findingId)).filter(Boolean);
    if (!ids.length) continue;
    // Details are best effort: a caller without batch-get-findings still gets the summaries.
    const r = ctx.deps.aws(['securityagent', 'batch-get-findings', '--agent-space-id', setup.agentSpaceId, '--finding-ids', ...ids], ctx.opts.region);
    if (r.ok) for (const f of r.json?.findings || []) details.set(String(f.findingId), f);
  }
  return summaries.map((s) => {
    const d = details.get(String(s.findingId)) || {};
    const loc = Array.isArray(d.codeLocations) && d.codeLocations[0] ? d.codeLocations[0] : null;
    const title = String(d.name || s.name || '(untitled finding)');
    const riskType = String(d.riskType || s.riskType || '');
    const description = String(d.description || '');
    const cwe = (CWE.exec(riskType) || CWE.exec(title) || CWE.exec(description))?.[0]?.toUpperCase() ?? null;
    return {
      findingId: String(s.findingId || ''),
      riskLevel: String(d.riskLevel || s.riskLevel || 'UNKNOWN').toUpperCase(),
      title, riskType, cwe,
      rawFile: loc?.filePath ? String(loc.filePath) : '',
      file: loc?.filePath ? repoRelative(String(loc.filePath), repoRoot) : '',
      line: typeof loc?.lineStart === 'number' ? loc.lineStart : null,
      description,
    };
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function countByRisk(fs: ReviewFinding[]): Record<string, number> {
  const c: Record<string, number> = Object.fromEntries(RISK_ORDER.map((r) => [r, 0]));
  for (const f of fs) c[RISK_ORDER.includes(f.riskLevel as typeof RISK_ORDER[number]) ? f.riskLevel : 'UNKNOWN']++;
  return c;
}

const riskRank = (r: string) => RISK_RANK[r] ?? 0;

export function sortFindings(fs: ReviewFinding[]): ReviewFinding[] {
  return [...fs].sort((a, b) => riskRank(b.riskLevel) - riskRank(a.riskLevel) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
}

export function shortText(s: string): string {
  const one = redact(s).replace(/\s+/g, ' ').trim();
  return one.length > DESCRIPTION_CHARS ? `${one.slice(0, DESCRIPTION_CHARS - 1)}...` : one;
}

export function totalsLine(c: Record<string, number>): string {
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return `${total} finding${total === 1 ? '' : 's'}: ` + RISK_ORDER.map((r) => `${c[r]} ${r.toLowerCase()}`).join(', ');
}

/** Grouped by risk level, then file. */
export function printFindings(say: (l?: string) => void, fs: ReviewFinding[]): void {
  const sorted = sortFindings(fs);
  for (const level of RISK_ORDER) {
    const group = sorted.filter((f) => f.riskLevel === level || (level === 'UNKNOWN' && !RISK_ORDER.includes(f.riskLevel as typeof RISK_ORDER[number])));
    if (!group.length) continue;
    say(`${level} (${group.length})`);
    for (const f of group) {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '(no location)';
      say(`  ${f.title}  ${where}${f.cwe ? `  ${f.cwe}` : ''}`);
      if (f.description) say(`    ${shortText(f.description)}`);
    }
  }
  say(totalsLine(countByRisk(fs)));
}

/** Security Agent risk -> the codewatch schema's three severities. */
function toSeverity(risk: string): Severity {
  return riskRank(risk) >= 3 ? 'high' : riskRank(risk) === 2 ? 'medium' : 'low';
}

interface ResultBase {
  setup: Setup; region: string; account?: string; scope: 'diff' | 'full' | 'unknown';
  tip?: string | null; base?: string | null; branch?: string | null; upstream?: string | null;
  /** The commit the code review's source asset held for this job; null when not known (a job fetched with no pending record). */
  contextCommit?: string | null;
  /** When we started the job (code-review) or the pending record's start; default: the job's createdAt. */
  startedAt?: string;
}

/** The record code-review writes right after start-code-review-job, so a lost wait loses nothing. */
export function pendingResult(o: ResultBase & { job: JobInfo; startedAt: string }): PrismResult {
  return makeResult({
    kind: 'security-review', hook: 'manual', tool: 'security-agent', status: 'pending',
    commit: o.tip ?? null, base: o.base ?? null, branch: o.branch ?? null, upstream: o.upstream ?? null,
    started_at: o.startedAt, finished_at: o.startedAt,
    security: {
      job_id: o.job.codeReviewJobId, code_review_id: o.setup.codeReviewId, agent_space_id: o.setup.agentSpaceId,
      region: o.region, account: o.account, scope: o.scope, job_status: o.job.status, counts: {}, context_commit: o.contextCommit ?? null,
      service_created_at: o.job.createdAt ?? null, service_updated_at: null, service_duration_s: null, wall_s: null,
    },
  });
}

function scopeText(r: PrismResult): string {
  const tip = (r.commit || '').slice(0, 12);
  const s = r.security?.scope;
  return s === 'full' ? `the whole repo at ${tip}` : s === 'diff' ? `${r.upstream || 'base'}...${tip}` : 'scope unknown';
}

/** The fields of a pending record that its completion keeps. */
function fromPending(p: PrismResult): Omit<ResultBase, 'setup' | 'region' | 'account'> {
  return { scope: p.security!.scope, tip: p.commit, base: p.base, branch: p.branch, upstream: p.upstream, contextCommit: p.security!.context_commit ?? null, startedAt: p.started_at };
}

/**
 * Pending records in this repo for this account, region and code review,
 * newest first. Records from another account or code review are never
 * completed with this one's findings.
 */
export function pendingReviews(root: string, account: string, region: string, codeReviewId: string): ResultEntry[] {
  return readResultEntries(root)
    .filter(({ result: r }) => r.kind === 'security-review' && r.status === 'pending' && r.security?.job_id
      && r.security.account === account && r.security.region === region && r.security.code_review_id === codeReviewId)
    .sort((a, b) => b.result.started_at.localeCompare(a.result.started_at));
}

export function toResult(o: ResultBase & {
  job: JobInfo; findings: ReviewFinding[]; now: Date;
  /** Our wall time from start-code-review-job to the terminal state, in seconds. */
  wallS?: number | null;
}): PrismResult {
  const counts = countByRisk(o.findings);
  const ok = o.job.status === 'COMPLETED';
  const findings: Finding[] = sortFindings(o.findings).map((f) => ({
    severity: toSeverity(f.riskLevel), category: 'security', rule: f.cwe || f.riskType || f.title,
    file: f.file, line: f.line, message: f.description ? `${f.title}: ${shortText(f.description)}` : f.title,
    risk_level: f.riskLevel, title: f.title, cwe: f.cwe, finding_id: f.findingId, raw_file: f.rawFile,
  }));
  return makeResult({
    kind: 'security-review', hook: 'manual', tool: 'security-agent',
    status: !ok ? 'error' : findings.length ? 'findings' : 'ok',
    commit: o.tip ?? null, base: o.base ?? null, branch: o.branch ?? null, upstream: o.upstream ?? null,
    started_at: o.startedAt || o.job.createdAt || o.now.toISOString(),
    finished_at: o.job.updatedAt || o.now.toISOString(),
    findings,
    summary: ok ? totalsLine(counts) : null,
    reason: ok ? null : `job ${o.job.status}${o.job.reason ? `: ${redact(o.job.reason)}` : ''}`,
    security: {
      job_id: o.job.codeReviewJobId, code_review_id: o.setup.codeReviewId, agent_space_id: o.setup.agentSpaceId,
      region: o.region, account: o.account, scope: o.scope, job_status: o.job.status, counts, context_commit: o.contextCommit ?? null,
      service_created_at: o.job.createdAt ?? null, service_updated_at: o.job.updatedAt ?? null,
      service_duration_s: serviceSeconds(o.job), wall_s: o.wallS ?? null,
    },
  });
}

/** updatedAt - createdAt of a finished job: the service's queue plus run time. null when not reported. */
export function serviceSeconds(job: JobInfo): number | null {
  if (!TERMINAL.has(job.status) || !job.createdAt || !job.updatedAt) return null;
  const a = Date.parse(job.createdAt), b = Date.parse(job.updatedAt);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 1000) : null;
}

export function failOnHit(fs: ReviewFinding[], failOn: string | undefined): boolean {
  if (!failOn) return false;
  const min = riskRank(failOn.toUpperCase());
  return fs.some((f) => riskRank(f.riskLevel) >= min && riskRank(f.riskLevel) > 0);
}

export function parseLevel(flag: string, v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (!(FAIL_ON_LEVELS as readonly string[]).includes(v.toLowerCase())) throw new Abort(`${flag} must be one of: ${FAIL_ON_LEVELS.join(', ')}`);
  return v.toLowerCase();
}

export function parseTimeout(v: string | number | undefined, fallback: number = DEFAULT_TIMEOUT_MIN): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Abort(`--timeout must be a positive number of minutes, got "${v}"`);
  return n;
}

const fetchLaterHint = (jobId: string) => `The job keeps running in AWS. Fetch its results later with: prism-cli security findings --job ${jobId}`;

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export type PollOutcome<J = JobInfo> = { kind: 'done'; job: J } | { kind: 'timeout'; job: J } | { kind: 'interrupted'; job: J };

/** What a poll loop needs to know about one job: how to read it, and what to tell the user when it cannot. */
export interface Poller<J> {
  /** The read call (`batch-get-...-jobs`). */
  args: string[];
  parse(json: any): J;
  /** Printed after a final poll failure: how to fetch the results later. */
  hint: string;
}

/** The status fields every polled job has. */
export interface PolledJob { status: string; step?: string | null }

const mmss = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/** Errors a retry cannot fix: a missing or malformed job. Credential, AccessDenied and old-CLI errors are excluded by kind. */
const NOT_TRANSIENT = /ResourceNotFound|ValidationException|NotFound/;

/**
 * One poll, retried up to POLL_RETRIES times (2 s, 4 s, 8 s) when the AWS CLI
 * fails in a way a retry can fix (throttling, a network error, any other
 * non-zero exit that is not about credentials, permissions or the request).
 * A final failure aborts with the fetch-later hint. null: Ctrl-C during a backoff.
 */
async function getJobRetrying<J>(ctx: Ctx, p: Poller<J>, signal: AbortSignal): Promise<J | null> {
  const deps = ctx.deps as ReviewDeps;
  const args = p.args;
  for (let attempt = 0; ; attempt++) {
    const r = ctx.deps.aws(args, ctx.opts.region);
    if (r.ok) return p.parse(r.json);
    const why = explainAwsError(args, r.raw, ctx.cliVersion);
    if (why.kind !== 'other' || NOT_TRANSIENT.test(r.raw) || attempt >= POLL_RETRIES) {
      const tries = attempt ? ` (after ${attempt} ${attempt === 1 ? 'retry' : 'retries'})` : '';
      throw new Abort(`${why.message}${tries}\n${p.hint}`);
    }
    const wait = RETRY_FIRST_MS * 2 ** attempt;
    if (deps.isTTY) deps.ticker('');
    ctx.deps.log(`  Poll failed: ${why.message.split('\n')[0]}; retrying in ${wait / 1000}s (${attempt + 1}/${POLL_RETRIES})`);
    await deps.sleep(wait, signal);
    if (signal.aborted) return null;
  }
}

/** Polls a code review job until a terminal state, the timeout, or Ctrl-C (which never cancels the job). */
export function pollJob(ctx: Ctx, setup: Setup, first: JobInfo, timeoutMin: number): Promise<PollOutcome> {
  const jobId = first.codeReviewJobId;
  return pollUntilDone(ctx, { args: jobArgs(setup, jobId), parse: (j) => parseJob(j, setup, jobId), hint: fetchLaterHint(jobId) }, first, timeoutMin);
}

/** Polls any job until a terminal state, the timeout, or Ctrl-C (which never cancels the job). */
export async function pollUntilDone<J extends PolledJob>(ctx: Ctx, p: Poller<J>, first: J, timeoutMin: number): Promise<PollOutcome<J>> {
  const deps = ctx.deps as ReviewDeps;
  const start = deps.now().getTime();
  const limit = timeoutMin * 60_000;
  const ac = new AbortController();
  let interrupted = false;
  const off = deps.onInterrupt(() => { interrupted = true; ac.abort(); });
  let job = first;
  let delay = POLL_FIRST_MS;
  try {
    while (!TERMINAL.has(job.status)) {
      const elapsed = deps.now().getTime() - start;
      if (elapsed >= limit) return { kind: 'timeout', job };
      await deps.sleep(Math.min(delay, limit - elapsed), ac.signal);
      if (interrupted) return { kind: 'interrupted', job };
      delay = Math.min(delay * 2, POLL_MAX_MS);
      const next = await getJobRetrying(ctx, p, ac.signal);
      if (!next) return { kind: 'interrupted', job };
      job = next;
      const line = `[${mmss(deps.now().getTime() - start)}] ${job.status}${job.step ? ` (${job.step})` : ''}`;
      if (deps.isTTY) deps.ticker(line); else ctx.deps.log(`  ${line}`);
    }
    return { kind: 'done', job };
  } finally {
    off();
    if (deps.isTTY) deps.ticker('');
  }
}

// ---------------------------------------------------------------------------
// Scope and upload
// ---------------------------------------------------------------------------

export interface Snapshot { file: string; key: string }
/**
 * `context` is `git archive HEAD` for the code review's own source asset
 * (repo/<slug>/latest.zip). A diff job reads it as the code around the patch,
 * and start-code-review-job has no per-job source override (AWS CLI 2.36), so
 * both scopes refresh it: otherwise a diff job reviews against whatever HEAD
 * last ran --full or CI's first setup, and reports code that no longer exists.
 * `diff` is the patch for a diff job.
 */
interface Scope { scope: 'diff' | 'full'; tip: string; base: string | null; upstream: string | null; branch: string | null; context: Snapshot; diff: Snapshot | null; empty: boolean }

function git(ctx: Ctx, repo: RepoCtx, args: string[]): string | null {
  const r = ctx.deps.git(['-C', repo.root, ...args]);
  return r.ok ? r.stdout.trim() : null;
}

/** The pre-push base: the branch's upstream, else the remote's default branch. */
function resolveDiffBase(ctx: Ctx, repo: RepoCtx): { base: string; upstream: string } {
  const up = git(ctx, repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (up) {
    const sha = git(ctx, repo, ['rev-parse', '--verify', '--quiet', `${up}^{commit}`]);
    if (sha) return { base: sha, upstream: up };
  }
  const head = git(ctx, repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head) {
    const sha = git(ctx, repo, ['rev-parse', '--verify', '--quiet', head]);
    if (sha) return { base: sha, upstream: head.replace(/^refs\/remotes\//, '') };
  }
  throw new Abort('This branch has no upstream and the remote has no default branch to diff against. Push the branch, or review the whole repo with --full.');
}

function buildScope(ctx: Ctx, repo: RepoCtx, full: boolean): Scope {
  const tip = git(ctx, repo, ['rev-parse', 'HEAD']);
  if (!tip) throw new Abort('Could not read HEAD; is this a repository with at least one commit?');
  const branch = git(ctx, repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const dir = ctx.deps.makeTempDir();
  const zip = join(dir, 'repo.zip');
  const archive = () => {
    // A zip of one commit is byte-identical run to run (file times are the commit time), so the MD5 skip works.
    if (!ctx.deps.git(['-C', repo.root, 'archive', 'HEAD', '--format=zip', '-o', zip]).ok) throw new Abort('git archive HEAD failed.');
    return { file: zip, key: repoZipKey(repo.slug) };
  };
  if (full) return { scope: 'full', tip, base: null, upstream: null, branch, context: archive(), diff: null, empty: false };
  const { base, upstream } = resolveDiffBase(ctx, repo);
  // The API requires a .patch object. --output writes straight to the file, so a large diff never passes through a buffer.
  const file = join(dir, 'changes.patch');
  if (!ctx.deps.git(['-C', repo.root, 'diff', '--no-color', '--no-ext-diff', `--output=${file}`, `${base}...${tip}`]).ok) throw new Abort(`git diff ${upstream}...HEAD failed.`);
  let size = 0;
  try { size = statSync(file).size; } catch { throw new Abort('git diff wrote no patch file.'); }
  const diff = { file, key: `diffs/${repo.slug}/local/${tip.slice(0, 12)}-${base.slice(0, 12)}.patch` };
  if (size === 0) return { scope: 'diff', tip, base, upstream, branch, context: { file: '', key: repoZipKey(repo.slug) }, diff, empty: true };
  return { scope: 'diff', tip, base, upstream, branch, context: archive(), diff, empty: false };
}

/** Uploads a snapshot unless the object already has the same MD5. Returns whether it uploaded. */
export function upload(ctx: Ctx, bucket: string, s: Snapshot): boolean {
  const sum = md5(s.file);
  const head = call(ctx, ['s3api', 'head-object', '--bucket', bucket, '--key', s.key], ['404', 'NotFound', 'NoSuchKey']);
  if (head.ok && String(head.json?.ETag || '').replace(/"/g, '') === sum) return false;
  call(ctx, ['s3api', 'put-object', '--bucket', bucket, '--key', s.key, '--body', s.file]);
  return true;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const CODE_REVIEW_NOTICE = 'prism-cli security code-review uploads the repo at HEAD as the code review\'s source (repo/<slug>/latest.zip, which CI reviews also read) and, for a branch diff, a patch of your changes to the Security Agent scan bucket, and starts a code review job in the AWS account your credentials point to. Those are its only AWS writes; it may incur cost. The result is saved to .prism/results/.';

/** A FAILED / STOPPED job: saves the error result (in place over `id` when given) and prints why. Exit 1. */
function saveFailed(ctx: Ctx, json: boolean, result: PrismResult, job: JobInfo, repo: RepoCtx, id?: string): number {
  const deps = ctx.deps as ReviewDeps;
  const path = writeResult(repo.root, result, id);
  if (json) deps.out(JSON.stringify(result, null, 2) + '\n');
  ctx.deps.log(`Error: job ${job.codeReviewJobId} ended ${job.status}${job.reason ? `: ${redact(job.reason)}` : ''}`);
  ctx.deps.log(`Saved ${path}`);
  return 1;
}

function finishFindings(ctx: Ctx, json: boolean, result: PrismResult, findings: ReviewFinding[], repo: RepoCtx, minLevel?: string, id?: string): void {
  const deps = ctx.deps as ReviewDeps;
  const shown = minLevel ? findings.filter((f) => riskRank(f.riskLevel) >= riskRank(minLevel.toUpperCase()) && riskRank(f.riskLevel) > 0) : findings;
  const path = writeResult(repo.root, result, id);
  if (json) { deps.out(JSON.stringify(result, null, 2) + '\n'); deps.err(`Saved ${path}`); return; }
  ctx.deps.log('');
  if (shown.length) printFindings(ctx.deps.log, shown); else ctx.deps.log(minLevel ? `No findings at ${minLevel} or above.` : 'No findings.');
  if (minLevel && shown.length !== findings.length) ctx.deps.log(`(${findings.length - shown.length} below ${minLevel} not shown; ${totalsLine(countByRisk(findings))})`);
  ctx.deps.log(`Saved ${path}`);
}

/** `prism-cli security code-review`. Returns the exit code. */
export async function securityCodeReview(input: CodeReviewOptions, deps: ReviewDeps): Promise<number> {
  const say = input.json ? deps.err : deps.log;
  const root = checkedRoot(deps, input.path, say);
  if (!root) return 1;
  say(CODE_REVIEW_NOTICE);
  say('');
  const ctx = begin(input, deps, false, say);
  if (!ctx) return 1;
  try {
    const failOn = parseLevel('--fail-on', input.failOn);
    const timeout = parseTimeout(input.timeout);
    const id = preflight(ctx);
    printIdentity(ctx, id);
    const repo = needRepo(ctx, root);
    const setup = resolveSetup(ctx, id, repo);
    say(`Repo:        ${repo.id}`);
    say(`Code review: ${setup.codeReviewId} (from ${setup.source})`);
    const bucket = getParam(ctx, PARAM_SCAN_BUCKET);
    if (!bucket) throw new Abort(`SSM ${PARAM_SCAN_BUCKET} is not set in this account and region: ${NOT_SET_UP}.`);

    const s = buildScope(ctx, repo, !!input.full);
    say(`Scope:       ${s.scope === 'full' ? `the whole repo at ${s.tip.slice(0, 12)}` : `${s.upstream}...${s.tip.slice(0, 12)}`}`);
    if (s.empty) {
      say(`No changes against ${s.upstream}; nothing to review.`);
      return 0;
    }
    const ctxUri = `s3://${bucket}/${s.context.key}`;
    say(upload(ctx, bucket, s.context)
      ? `Review context: updated ${ctxUri} to HEAD ${s.tip.slice(0, 12)}`
      : `Review context: ${ctxUri} is already HEAD ${s.tip.slice(0, 12)}; upload skipped`);
    if (s.diff) say(upload(ctx, bucket, s.diff) ? `Uploaded s3://${bucket}/${s.diff.key}` : `s3://${bucket}/${s.diff.key} is already up to date; upload skipped`);

    const startedAt = deps.now().getTime();
    const start = call(ctx, [
      'securityagent', 'start-code-review-job', '--agent-space-id', setup.agentSpaceId, '--code-review-id', setup.codeReviewId,
      // --full reviews the code review's own source asset (just refreshed); a diff job reviews the patch with that asset as context.
      ...(s.diff ? ['--diff-source', JSON.stringify({ s3Uri: `s3://${bucket}/${s.diff.key}` })] : []),
    ]);
    const started = toJob(start.json);
    if (!started.codeReviewJobId) throw new Abort('start-code-review-job returned no codeReviewJobId.');
    const job = started.status === 'UNKNOWN' ? { ...started, status: 'IN_PROGRESS' } : started;
    say(`Started job ${job.codeReviewJobId}`);
    const kept = { setup, region: ctx.opts.region, account: id.account, scope: s.scope, tip: s.tip, base: s.base, branch: s.branch, upstream: s.upstream, contextCommit: s.tip, startedAt: new Date(startedAt).toISOString() };
    // Written before any wait, and completed in place below, so a lost wait (timeout, Ctrl-C, a poll error, a closed terminal) loses nothing.
    let pendingId: string | undefined;
    try {
      const p = writeResult(repo.root, pendingResult({ ...kept, job }));
      pendingId = basename(p, '.json');
      say(`Saved ${p} (pending)`);
    } catch (e) {
      say(`Warning: could not save the pending record (${redact(e instanceof Error ? e.message : String(e))}).`);
    }
    if (input.wait === false) {
      say(`Not waiting (--no-wait). ${fetchLaterHint(job.codeReviewJobId)}`);
      return 0;
    }

    say(`Waiting for the job (up to ${timeout} min; Ctrl-C stops waiting, the job keeps running)...`);
    const out = await pollJob(ctx, setup, job, timeout);
    if (out.kind === 'interrupted') { say(''); say(`Stopped waiting. ${fetchLaterHint(job.codeReviewJobId)}`); return 130; }
    if (out.kind === 'timeout') { say(`Timed out after ${timeout} min (job ${job.codeReviewJobId} is ${out.job.status}). ${fetchLaterHint(job.codeReviewJobId)}`); return 2; }

    const wallS = Math.round((deps.now().getTime() - startedAt) / 1000);
    const svc = serviceSeconds(out.job);
    say(`Finished in ${wallS}s here${svc !== null ? `; the service reports ${svc}s from job creation to its last update` : ''}.`);
    const base = { ...kept, job: out.job, now: deps.now(), wallS };
    if (out.job.status !== 'COMPLETED') return saveFailed(ctx, !!input.json, toResult({ ...base, findings: [] }), out.job, repo, pendingId);
    const findings = fetchFindings(ctx, setup, out.job.codeReviewJobId, repo.root);
    finishFindings(ctx, !!input.json, toResult({ ...base, findings }), findings, repo, undefined, pendingId);
    if (failOnHit(findings, failOn)) { say(`--fail-on ${failOn}: findings at or above ${failOn}.`); return 1; }
    return 0;
  } catch (e) {
    if (e instanceof Abort) { say(`Error: ${redact(e.message)}`); return 1; }
    throw e;
  }
}

/** `prism-cli security findings`. Read-only: no AWS writes. Returns the exit code. */
export async function securityFindings(input: FindingsOptions, deps: ReviewDeps): Promise<number> {
  const say = input.json ? deps.err : deps.log;
  const root = checkedRoot(deps, input.path, say);
  if (!root) return 1;
  say('Read-only (security findings): nothing in AWS will be changed; results are cached to .prism/results/.');
  say('');
  const ctx = begin(input, deps, true, say);
  if (!ctx) return 1;
  try {
    const min = parseLevel('--severity', input.severity);
    const timeout = parseTimeout(input.timeout);
    const id = preflight(ctx);
    printIdentity(ctx, id);
    const repo = needRepo(ctx, root);
    const setup = resolveSetup(ctx, id, repo);
    const pendings = pendingReviews(repo.root, id.account, ctx.opts.region, setup.codeReviewId);
    let pending: ResultEntry | null = null;
    let job: JobInfo | null;
    if (input.job) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.job)) throw new Abort(`--job must be a job id, got "${input.job}"`);
      pending = pendings.find((e) => e.result.security!.job_id === input.job) ?? null;
      job = getJob(ctx, setup, input.job);
    } else if (pendings.length) {
      // A job code-review started and did not see finish: the newest one, completed in place with its scope and commits.
      pending = pendings[0];
      if (pendings.length > 1) {
        say(`Also pending: ${pendings.slice(1).map((e) => `${e.result.security!.job_id} (started ${e.result.started_at})`).join(', ')}. Fetch one with --job <id>.`);
      }
      job = getJob(ctx, setup, pending.result.security!.job_id);
    } else {
      job = latestJob(ctx, setup);
      if (!job) { say(`No code review jobs yet for ${repo.id}. Start one with: prism-cli security code-review`); return 0; }
    }
    if (pending) say(`Pending:     recorded by code-review at ${pending.result.started_at} (${scopeText(pending.result)})`);
    say(`Job:         ${job.codeReviewJobId} (${job.status}${job.createdAt ? `, started ${job.createdAt}` : ''})`);
    if (!TERMINAL.has(job.status)) {
      if (!input.wait) { say(`The job is still ${job.status}. Re-run with --wait to wait for it, or check back later.`); return 2; }
      const out = await pollJob(ctx, setup, job, timeout);
      if (out.kind === 'interrupted') { say(''); say(`Stopped waiting. ${fetchLaterHint(job.codeReviewJobId)}`); return 130; }
      if (out.kind === 'timeout') { say(`Timed out after ${timeout} min (still ${out.job.status}). ${fetchLaterHint(job.codeReviewJobId)}`); return 2; }
      job = out.job;
    }
    const base = { setup, job, region: ctx.opts.region, account: id.account, now: deps.now(), ...(pending ? fromPending(pending.result) : { scope: 'unknown' as const }) };
    if (job.status !== 'COMPLETED') {
      if (pending) return saveFailed(ctx, !!input.json, toResult({ ...base, findings: [] }), job, repo, pending.id);
      say(`Error: job ${job.codeReviewJobId} ended ${job.status}${job.reason ? `: ${redact(job.reason)}` : ''}`);
      return 1;
    }
    const findings = fetchFindings(ctx, setup, job.codeReviewJobId, repo.root);
    finishFindings(ctx, !!input.json, toResult({ ...base, findings }), findings, repo, min, pending?.id);
    return 0;
  } catch (e) {
    if (e instanceof Abort) { say(`Error: ${redact(e.message)}`); return 1; }
    throw e;
  }
}
