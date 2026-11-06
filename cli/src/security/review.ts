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
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { makeResult, writeResult, type Finding, type PrismResult, type Severity } from '../codewatch/results.js';
import { redact } from './errors.js';
import { readSecurityMarker } from './marker.js';
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
}

export interface CodeReviewOptions extends SecurityOptions {
  full?: boolean;
  /** Minutes. */
  timeout?: string | number;
  failOn?: string;
  json?: boolean;
  /** commander turns --no-wait into wait: false. */
  wait?: boolean;
}

export interface FindingsOptions extends SecurityOptions {
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
 * Agent space and code review for this repo: the local marker when it is for
 * this account and region, else the SSM parameters `enable security` and the
 * CI gate write.
 */
function resolveSetup(ctx: Ctx, id: Identity, repo: RepoCtx): Setup {
  const m = readSecurityMarker(repo.root);
  if (m && m.account === id.account && m.region === ctx.opts.region) {
    return { agentSpaceId: m.agentSpaceId, codeReviewId: m.codeReviewId, source: '.prism/security.local.json' };
  }
  const space = getParam(ctx, PARAM_AGENT_SPACE);
  const review = getParam(ctx, repo.param);
  if (space && review) return { agentSpaceId: space, codeReviewId: review, source: `SSM ${repo.param}` };
  throw new Abort(`No Security Agent code review for ${repo.id} in account ${id.account}, region ${ctx.opts.region}: ${NOT_SET_UP}.`);
}

function begin(input: SecurityOptions, deps: Deps, readOnly: boolean, say: (l?: string) => void): Ctx | null {
  const r = resolveRegion(input, deps);
  if (!r) { say(`Error: ${NO_REGION_MESSAGE}`); return null; }
  const opts: Resolved = { ...input, region: r.region, regionSource: r.source };
  return { opts, deps: { ...deps, log: say }, cliVersion: deps.awsVersion(), readOnly };
}

function needRepo(ctx: Ctx): RepoCtx {
  const repo = resolveRepo(ctx.opts, ctx.deps);
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

export function getJob(ctx: Ctx, setup: Setup, jobId: string): JobInfo {
  const r = call(ctx, ['securityagent', 'batch-get-code-review-jobs', '--agent-space-id', setup.agentSpaceId, '--code-review-job-ids', jobId]);
  const j = (r.json?.codeReviewJobs || [])[0];
  if (!j) throw new Abort(`No code review job ${jobId} in agent space ${setup.agentSpaceId}.`);
  return toJob(j);
}

/** Every page of `--max-items` results, following NextToken (the CLI's) or nextToken (the API's). */
function paged(ctx: Ctx, args: string[], key: string): any[] {
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

export function fetchFindings(ctx: Ctx, setup: Setup, jobId: string): ReviewFinding[] {
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
      file: loc?.filePath ? String(loc.filePath) : '',
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

function shortText(s: string): string {
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

export function toResult(o: {
  setup: Setup; job: JobInfo; findings: ReviewFinding[]; region: string; scope: 'diff' | 'full' | 'unknown';
  tip?: string | null; base?: string | null; branch?: string | null; upstream?: string | null; now: Date;
}): PrismResult {
  const counts = countByRisk(o.findings);
  const ok = o.job.status === 'COMPLETED';
  const findings: Finding[] = sortFindings(o.findings).map((f) => ({
    severity: toSeverity(f.riskLevel), category: 'security', rule: f.cwe || f.riskType || f.title,
    file: f.file, line: f.line, message: f.description ? `${f.title}: ${shortText(f.description)}` : f.title,
    risk_level: f.riskLevel, title: f.title, cwe: f.cwe, finding_id: f.findingId,
  }));
  return makeResult({
    kind: 'security-review', hook: 'manual', tool: 'security-agent',
    status: !ok ? 'error' : findings.length ? 'findings' : 'ok',
    commit: o.tip ?? null, base: o.base ?? null, branch: o.branch ?? null, upstream: o.upstream ?? null,
    started_at: o.job.createdAt || o.now.toISOString(),
    finished_at: o.job.updatedAt || o.now.toISOString(),
    findings,
    summary: ok ? totalsLine(counts) : null,
    reason: ok ? null : `job ${o.job.status}${o.job.reason ? `: ${redact(o.job.reason)}` : ''}`,
    security: {
      job_id: o.job.codeReviewJobId, code_review_id: o.setup.codeReviewId, agent_space_id: o.setup.agentSpaceId,
      region: o.region, scope: o.scope, job_status: o.job.status, counts,
    },
  });
}

export function failOnHit(fs: ReviewFinding[], failOn: string | undefined): boolean {
  if (!failOn) return false;
  const min = riskRank(failOn.toUpperCase());
  return fs.some((f) => riskRank(f.riskLevel) >= min && riskRank(f.riskLevel) > 0);
}

function parseLevel(flag: string, v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (!(FAIL_ON_LEVELS as readonly string[]).includes(v.toLowerCase())) throw new Abort(`${flag} must be one of: ${FAIL_ON_LEVELS.join(', ')}`);
  return v.toLowerCase();
}

function parseTimeout(v: string | number | undefined): number {
  if (v === undefined) return DEFAULT_TIMEOUT_MIN;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Abort(`--timeout must be a positive number of minutes, got "${v}"`);
  return n;
}

const fetchLaterHint = (jobId: string) => `The job keeps running in AWS. Fetch its results later with: prism-cli security findings --job ${jobId}`;

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export type PollOutcome = { kind: 'done'; job: JobInfo } | { kind: 'timeout'; job: JobInfo } | { kind: 'interrupted'; job: JobInfo };

const mmss = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/** Polls until a terminal state, the timeout, or Ctrl-C (which never cancels the job). */
export async function pollJob(ctx: Ctx, setup: Setup, first: JobInfo, timeoutMin: number): Promise<PollOutcome> {
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
      job = getJob(ctx, setup, job.codeReviewJobId);
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

interface Scope { scope: 'diff' | 'full'; tip: string; base: string | null; upstream: string | null; branch: string | null; file: string; key: string; empty: boolean }

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
  if (full) {
    const file = join(dir, 'repo.zip');
    if (!ctx.deps.git(['-C', repo.root, 'archive', 'HEAD', '--format=zip', '-o', file]).ok) throw new Abort('git archive HEAD failed.');
    return { scope: 'full', tip, base: null, upstream: null, branch, file, key: repoZipKey(repo.slug), empty: false };
  }
  const { base, upstream } = resolveDiffBase(ctx, repo);
  // The API requires a .patch object. --output writes straight to the file, so a large diff never passes through a buffer.
  const file = join(dir, 'changes.patch');
  if (!ctx.deps.git(['-C', repo.root, 'diff', '--no-color', '--no-ext-diff', `--output=${file}`, `${base}...${tip}`]).ok) throw new Abort(`git diff ${upstream}...HEAD failed.`);
  let size = 0;
  try { size = statSync(file).size; } catch { throw new Abort('git diff wrote no patch file.'); }
  const key = `diffs/${repo.slug}/local/${tip.slice(0, 12)}-${base.slice(0, 12)}.patch`;
  return { scope: 'diff', tip, base, upstream, branch, file, key, empty: size === 0 };
}

/** Uploads the snapshot unless the object already has the same MD5. Returns whether it uploaded. */
function upload(ctx: Ctx, bucket: string, s: Scope): boolean {
  const sum = md5(s.file);
  const head = call(ctx, ['s3api', 'head-object', '--bucket', bucket, '--key', s.key], ['404', 'NotFound', 'NoSuchKey']);
  if (head.ok && String(head.json?.ETag || '').replace(/"/g, '') === sum) return false;
  call(ctx, ['s3api', 'put-object', '--bucket', bucket, '--key', s.key, '--body', s.file]);
  return true;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const CODE_REVIEW_NOTICE = 'prism-cli security code-review uploads a snapshot of your changes (or, with --full, the repo at HEAD) to the Security Agent scan bucket and starts a code review job in the AWS account your credentials point to. Those are its only AWS writes; it may incur cost. The result is saved to .prism/results/.';

function finishFindings(ctx: Ctx, json: boolean, result: PrismResult, findings: ReviewFinding[], repo: RepoCtx, minLevel?: string): void {
  const deps = ctx.deps as ReviewDeps;
  const shown = minLevel ? findings.filter((f) => riskRank(f.riskLevel) >= riskRank(minLevel.toUpperCase()) && riskRank(f.riskLevel) > 0) : findings;
  const path = writeResult(repo.root, result);
  if (json) { deps.out(JSON.stringify(result, null, 2) + '\n'); deps.err(`Saved ${path}`); return; }
  ctx.deps.log('');
  if (shown.length) printFindings(ctx.deps.log, shown); else ctx.deps.log(minLevel ? `No findings at ${minLevel} or above.` : 'No findings.');
  if (minLevel && shown.length !== findings.length) ctx.deps.log(`(${findings.length - shown.length} below ${minLevel} not shown; ${totalsLine(countByRisk(findings))})`);
  ctx.deps.log(`Saved ${path}`);
}

/** `prism-cli security code-review`. Returns the exit code. */
export async function securityCodeReview(input: CodeReviewOptions, deps: ReviewDeps): Promise<number> {
  const say = input.json ? deps.err : deps.log;
  say(CODE_REVIEW_NOTICE);
  say('');
  const ctx = begin(input, deps, false, say);
  if (!ctx) return 1;
  try {
    const failOn = parseLevel('--fail-on', input.failOn);
    const timeout = parseTimeout(input.timeout);
    const id = preflight(ctx);
    printIdentity(ctx, id);
    const repo = needRepo(ctx);
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
    say(upload(ctx, bucket, s) ? `Uploaded s3://${bucket}/${s.key}` : `s3://${bucket}/${s.key} is already up to date; upload skipped`);

    const start = call(ctx, [
      'securityagent', 'start-code-review-job', '--agent-space-id', setup.agentSpaceId, '--code-review-id', setup.codeReviewId,
      // shortcut: --full reviews the code review's own source asset (repo/<slug>/latest.zip, just refreshed); no diff source.
      ...(s.scope === 'diff' ? ['--diff-source', JSON.stringify({ s3Uri: `s3://${bucket}/${s.key}` })] : []),
    ]);
    const job = toJob(start.json);
    if (!job.codeReviewJobId) throw new Abort('start-code-review-job returned no codeReviewJobId.');
    say(`Started job ${job.codeReviewJobId}`);
    if (input.wait === false) {
      say(`Not waiting (--no-wait). ${fetchLaterHint(job.codeReviewJobId)}`);
      return 0;
    }

    say(`Waiting for the job (up to ${timeout} min; Ctrl-C stops waiting, the job keeps running)...`);
    const out = await pollJob(ctx, setup, job.status ? job : { ...job, status: 'IN_PROGRESS' }, timeout);
    if (out.kind === 'interrupted') { say(''); say(`Stopped waiting. ${fetchLaterHint(job.codeReviewJobId)}`); return 130; }
    if (out.kind === 'timeout') { say(`Timed out after ${timeout} min (job ${job.codeReviewJobId} is ${out.job.status}). ${fetchLaterHint(job.codeReviewJobId)}`); return 2; }

    const base = { setup, job: out.job, region: ctx.opts.region, scope: s.scope, tip: s.tip, base: s.base, branch: s.branch, upstream: s.upstream, now: deps.now() };
    if (out.job.status !== 'COMPLETED') {
      const result = toResult({ ...base, findings: [] });
      const path = writeResult(repo.root, result);
      if (input.json) deps.out(JSON.stringify(result, null, 2) + '\n');
      say(`Error: job ${out.job.codeReviewJobId} ended ${out.job.status}${out.job.reason ? `: ${redact(out.job.reason)}` : ''}`);
      say(`Saved ${path}`);
      return 1;
    }
    const findings = fetchFindings(ctx, setup, out.job.codeReviewJobId);
    finishFindings(ctx, !!input.json, toResult({ ...base, findings }), findings, repo);
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
  say('Read-only (security findings): nothing in AWS will be changed; results are cached to .prism/results/.');
  say('');
  const ctx = begin(input, deps, true, say);
  if (!ctx) return 1;
  try {
    const min = parseLevel('--severity', input.severity);
    const timeout = parseTimeout(input.timeout);
    const id = preflight(ctx);
    printIdentity(ctx, id);
    const repo = needRepo(ctx);
    const setup = resolveSetup(ctx, id, repo);
    let job: JobInfo | null;
    if (input.job) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.job)) throw new Abort(`--job must be a job id, got "${input.job}"`);
      job = getJob(ctx, setup, input.job);
    } else {
      job = latestJob(ctx, setup);
      if (!job) { say(`No code review jobs yet for ${repo.id}. Start one with: prism-cli security code-review`); return 0; }
    }
    say(`Job:         ${job.codeReviewJobId} (${job.status}${job.createdAt ? `, started ${job.createdAt}` : ''})`);
    if (!TERMINAL.has(job.status)) {
      if (!input.wait) { say(`The job is still ${job.status}. Re-run with --wait to wait for it, or check back later.`); return 2; }
      const out = await pollJob(ctx, setup, job, timeout);
      if (out.kind === 'interrupted') { say(''); say(`Stopped waiting. ${fetchLaterHint(job.codeReviewJobId)}`); return 130; }
      if (out.kind === 'timeout') { say(`Timed out after ${timeout} min (still ${out.job.status}). ${fetchLaterHint(job.codeReviewJobId)}`); return 2; }
      job = out.job;
    }
    if (job.status !== 'COMPLETED') {
      say(`Error: job ${job.codeReviewJobId} ended ${job.status}${job.reason ? `: ${redact(job.reason)}` : ''}`);
      return 1;
    }
    const findings = fetchFindings(ctx, setup, job.codeReviewJobId);
    finishFindings(ctx, !!input.json, toResult({ setup, job, findings, region: ctx.opts.region, scope: 'unknown', now: deps.now() }), findings, repo, min);
    return 0;
  } catch (e) {
    if (e instanceof Abort) { say(`Error: ${redact(e.message)}`); return 1; }
    throw e;
  }
}
