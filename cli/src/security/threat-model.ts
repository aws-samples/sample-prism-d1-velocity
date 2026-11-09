/**
 * `prism-cli security threat-model` and `prism-cli security threats`: run an
 * AWS Security Agent threat model of this repo at HEAD, optionally focused by
 * design docs (scope docs), and read its threats.
 *
 * Calls (see docs/RESEARCH-threat-model-design-review.md):
 *   create-threat-model (assets.sourceCode = the HEAD zip, scopeDocs = the docs,
 *     both in the scan bucket), start-threat-model-job,
 *   batch-get-threat-model-jobs (poll; carries systemOverview),
 *   list-threats + batch-get-threats (details), and for "the latest job"
 *   list-threat-models + list-threat-model-jobs.
 *
 * One threat model per run: a job snapshots its inputs, but updating a shared
 * per-repo threat model before each run would race between two developers.
 *
 * Account, region, credentials, the identity block, polling and the pending
 * record work as in `security code-review`. Results go to .prism/results/
 * with kind security-threat-model.
 */
import { realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { makeResult, readResultEntries, writeResult, type Finding, type PrismResult, type ResultEntry, type Severity } from '../codewatch/results.js';
import { explainAwsError, redact } from './errors.js';
import {
  begin, checkedRoot, DETAILS_BATCH, needRepo, NOT_SET_UP, paged, parseLevel, parseTimeout, PARAM_SCAN_BUCKET, pollUntilDone, repoRelative,
  serviceSeconds, shortText, TERMINAL, upload, type Poller, type ReviewDeps, type Snapshot,
} from './review.js';
import {
  Abort, bucketNotListed, call, getParam, listsBucket, PARAM_AGENT_SPACE, PARAM_SERVICE_ROLE, preflight, printIdentity, SERVICE_ROLE_NAME, spaceBuckets,
  type Ctx, type Identity, type RepoCtx, type SecurityOptions,
} from './setup.js';

// The first live run (a full repo plus one scope doc) took ~51 min, well past
// the 5-30 min AWS's IDE guide gives, so wait up to two hours by default.
export const DEFAULT_TM_TIMEOUT_MIN = 120;

/** Threat severities, most severe first (the API's enum). */
export const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
const SEVERITY_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
const sevRank = (s: string) => SEVERITY_RANK[s] ?? 0;
export const STRIDE_ORDER = ['SPOOFING', 'TAMPERING', 'REPUDIATION', 'INFORMATION_DISCLOSURE', 'DENIAL_OF_SERVICE', 'ELEVATION_OF_PRIVILEGE'] as const;

/** Scope-doc formats the user guide lists. */
export const DOC_EXTENSIONS = ['.md', '.txt', '.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg'];
/** Used when no --doc is given: the Kiro spec files, like the AWS IDE integration. */
export const DEFAULT_DOC = /^\.kiro\/specs\/[^/]+\/(design|requirements)\.md$/;

/**
 * shortcut: the threat-model API documents no scope-doc limits, so these are
 * the web app's design-review limits, used only to warn. Replace them once a
 * live run shows the real ones (research doc, open question Q2).
 */
export const DOC_WARN = { count: 5, bytes: 2 * 1024 * 1024, textBytes: 512 * 1024, total: 6 * 1024 * 1024 };
const TEXT_EXT = new Set(['.md', '.txt']);

/** Overview text printed and shown on the dashboard. */
const OVERVIEW_CHARS = 600;
/** Evidence paths printed per threat. */
const EVIDENCE_SHOWN = 3;

export interface ThreatModelOptions extends SecurityOptions {
  path?: string;
  /** Repeatable --doc. */
  doc?: string[];
  /** commander turns --no-docs into docs: false. */
  docs?: boolean;
  timeout?: string | number;
  failOn?: string;
  json?: boolean;
  wait?: boolean;
}

export interface ThreatsOptions extends SecurityOptions {
  path?: string;
  job?: string;
  latest?: boolean;
  severity?: string;
  json?: boolean;
  wait?: boolean;
  timeout?: string | number;
}

export interface TmJob {
  threatModelJobId: string;
  threatModelId: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  /** errorInformation.code: CLIENT_ERROR | INTERNAL_ERROR | STOPPED_BY_USER. */
  errorCode: string | null;
  reason: string | null;
  systemOverview: string | null;
  step?: string | null;
}

export interface ThreatRow {
  threatId: string;
  severity: string;
  status: string;
  title: string;
  statement: string;
  stride: string[];
  recommendation: string;
  /** Repo-relative evidence paths (sandbox prefix removed). */
  evidence: string[];
  impactedAssets: string[];
}

// ---------------------------------------------------------------------------
// Setup and hints
// ---------------------------------------------------------------------------

/** The agent space, from SSM only: a file in the repo must never choose where code is uploaded. */
function agentSpace(ctx: Ctx, id: Identity): string {
  const space = getParam(ctx, PARAM_AGENT_SPACE);
  if (!space) throw new Abort(`SSM ${PARAM_AGENT_SPACE} is not set in account ${id.account}, region ${ctx.opts.region}: ${NOT_SET_UP}.`);
  return space;
}

/**
 * What a failed threat-model write or job might be about, since the API does
 * not document it yet (research doc, open questions Q1 and Q2).
 */
export function unknownsHint(): string[] {
  return [
    'Hint: the threat-model API documents no scope-doc limits; they may be too large or too many. Try fewer or smaller --doc files, or --no-docs.',
    '  See docs/RESEARCH-threat-model-design-review.md (open question Q2).',
  ];
}

/** The service's refusal of an S3 object in a bucket the agent space does not list. */
const BUCKET_NOT_LISTED = /S3 bucket not found in agent instance S3 buckets/i;

/** A write call; an error that is not about credentials, permissions or the CLI gets the scope-doc hint. */
function writeCall(ctx: Ctx, args: string[], bucket: string) {
  const r = ctx.deps.aws(args, ctx.opts.region);
  if (r.ok) return r;
  // The preflight checks this; the service saying so anyway (the list changed since) gets the same fix.
  if (BUCKET_NOT_LISTED.test(r.raw)) throw new Abort(bucketNotListed(bucket));
  const why = explainAwsError(args, r.raw, ctx.cliVersion);
  throw new Abort(why.kind === 'other' ? [why.message, ...unknownsHint()].join('\n') : why.message);
}

const threatsHint = (jobId: string) => `The job keeps running in AWS. Fetch its threats later with: prism-cli security threats --job ${jobId}`;

/** Threat model titles: one per run, all starting with the repo's prefix (how --latest finds them). */
export function titlePrefix(slug: string): string {
  return `${slug}-tm-`.replace(/[^A-Za-z0-9_-]/g, '-');
}

function runTitle(slug: string, tip: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return `${titlePrefix(slug)}${tip.slice(0, 12)}-${stamp}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100);
}

// ---------------------------------------------------------------------------
// Scope docs (read from HEAD, never the working tree)
// ---------------------------------------------------------------------------

const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };

interface TreeEntry { mode: string; type: string }

/** `git ls-tree HEAD -- <path>` for exactly that path; null when HEAD does not have it. */
function treeEntry(deps: ReviewDeps, root: string, path: string): TreeEntry | null {
  const r = deps.git(['-C', root, 'ls-tree', 'HEAD', '--', path]);
  if (!r.ok) return null;
  for (const line of r.stdout.split('\n')) {
    const m = /^(\d+) (\w+) [0-9a-f]+\t(.*)$/.exec(line);
    if (m && m[3] === path) return { mode: m[1], type: m[2] };
  }
  return null;
}

/** A --doc argument as a repo path, or an error. Relative paths are taken from the working directory, like a shell would. */
export function docRepoPath(root: string, cwd: string, arg: string): string {
  const abs = resolve(real(cwd), arg);
  const rel = relative(real(root), abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Abort(`--doc ${arg} is outside the repository ${root}.`);
  return rel.split(sep).join('/');
}

/**
 * The scope docs for this run, as repo paths in HEAD: --doc (validated),
 * none with --no-docs, else the Kiro spec files HEAD has.
 */
export function selectDocs(deps: ReviewDeps, root: string, input: ThreatModelOptions): string[] {
  const given = input.doc ?? [];
  if (input.docs === false) {
    if (given.length) throw new Abort('--doc and --no-docs cannot be used together.');
    return [];
  }
  if (!given.length) {
    const r = deps.git(['-C', root, 'ls-tree', '-r', '--name-only', 'HEAD', '--', '.kiro/specs']);
    if (!r.ok) return [];
    return r.stdout.split('\n').map((l) => l.trim()).filter((l) => DEFAULT_DOC.test(l) && treeEntry(deps, root, l)?.mode !== '120000').sort();
  }
  const out: string[] = [];
  for (const arg of given) {
    const path = docRepoPath(root, deps.cwd(), arg);
    if (!DOC_EXTENSIONS.includes(extname(path).toLowerCase())) throw new Abort(`--doc ${arg}: unsupported file type; scope docs can be ${DOC_EXTENSIONS.join(', ')}.`);
    const e = treeEntry(deps, root, path);
    if (!e) throw new Abort(`--doc ${arg} is not in HEAD. Commit it first: the threat model reads its docs from the commit it models.`);
    if (e.mode === '120000') throw new Abort(`--doc ${arg} is a symlink in HEAD; pass the file it points to.`);
    if (e.type !== 'blob') throw new Abort(`--doc ${arg} is not a file in HEAD.`);
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

interface DocFile extends Snapshot { path: string; size: number }

/** Writes each doc's blob from HEAD to a temp file (binary-safe: git writes the file itself). */
function materializeDocs(ctx: Ctx, root: string, paths: string[], prefix: string): DocFile[] {
  const dir = ctx.deps.makeTempDir();
  return paths.map((path, i) => {
    const file = join(dir, `${i}-${basename(path)}`);
    if (!ctx.deps.git(['-C', root, 'show', `--output=${file}`, `HEAD:${path}`]).ok) throw new Abort(`git show HEAD:${path} failed.`);
    let size = 0;
    try { size = statSync(file).size; } catch { throw new Abort(`git show wrote no file for ${path}.`); }
    return { path, file, size, key: `${prefix}/docs/${path}` };
  });
}

/** Warnings when the docs exceed the web app's design-review limits (the API's own limits are unknown). */
export function docLimitWarnings(docs: { path: string; size: number }[]): string[] {
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const out: string[] = [];
  if (docs.length > DOC_WARN.count) out.push(`${docs.length} scope docs`);
  for (const d of docs) {
    const cap = TEXT_EXT.has(extname(d.path).toLowerCase()) ? DOC_WARN.textBytes : DOC_WARN.bytes;
    if (d.size > cap) out.push(`${d.path} is ${mb(d.size)}`);
  }
  const total = docs.reduce((a, d) => a + d.size, 0);
  if (total > DOC_WARN.total) out.push(`${mb(total)} in total`);
  if (!out.length) return [];
  return [`Warning: ${out.join('; ')}. The web app's design review allows 5 files, 2 MB each (0.5 MB for .md and .txt), 6 MB in total; the threat-model API documents no limits. If the job fails, trim the docs.`];
}

/** shortcut: "tiny" is a guess (a few lines); tune it once runs show how much a model needs. */
export const TINY_DOCS_BYTES = 1024;

/** A warning when the scope docs are so small the threat model may come back empty; null otherwise. */
export function tinyDocsHint(docs: { path: string; size: number }[]): string | null {
  const total = docs.reduce((a, d) => a + d.size, 0);
  if (!docs.length || total >= TINY_DOCS_BYTES) return null;
  return `Warning: the scope docs are only ${total} bytes in total (${docs.map((d) => d.path).join(', ')}), so the threat model may find no threats. `
    + 'Pass a fuller design doc with --doc, or commit the Kiro spec docs (.kiro/specs/<feature>/design.md and requirements.md), which are used when no --doc is given.';
}

/** Sizes of a recorded run's scope docs at its commit, or null when git cannot tell. */
function recordedDocSizes(deps: ReviewDeps, root: string, commit: string | null, paths: string[]): { path: string; size: number }[] | null {
  if (!commit || !paths.length) return null;
  const out: { path: string; size: number }[] = [];
  for (const path of paths) {
    const r = deps.git(['-C', root, 'cat-file', '-s', `${commit}:${path}`]);
    const size = Number(r.stdout.trim());
    if (!r.ok || !Number.isFinite(size)) return null;
    out.push({ path, size });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Jobs and threats (reads)
// ---------------------------------------------------------------------------

function toTmJob(j: any): TmJob {
  // shortcut: the AWS CLI returns untyped JSON; only these fields are read.
  const e = j?.errorInformation;
  return {
    threatModelJobId: String(j?.threatModelJobId || ''),
    threatModelId: String(j?.threatModelId || ''),
    status: String(j?.status || 'UNKNOWN'),
    createdAt: j?.createdAt ? String(j.createdAt) : undefined,
    updatedAt: j?.updatedAt ? String(j.updatedAt) : undefined,
    errorCode: e?.code ? String(e.code) : null,
    reason: e?.message ? String(e.message) : e?.code ? String(e.code) : null,
    systemOverview: typeof j?.systemOverview === 'string' && j.systemOverview.trim() ? j.systemOverview : null,
    step: null,
  };
}

const tmJobArgs = (space: string, jobId: string) => ['securityagent', 'batch-get-threat-model-jobs', '--agent-space-id', space, '--threat-model-job-ids', jobId];

function parseTmJob(json: any, space: string, jobId: string): TmJob {
  const j = (json?.threatModelJobs || [])[0];
  if (!j) throw new Abort(`No threat model job ${jobId} in agent space ${space}.`);
  return toTmJob(j);
}

export function getTmJob(ctx: Ctx, space: string, jobId: string): TmJob {
  return parseTmJob(call(ctx, tmJobArgs(space, jobId)).json, space, jobId);
}

function tmPoller(space: string, jobId: string): Poller<TmJob> {
  return { args: tmJobArgs(space, jobId), parse: (j) => parseTmJob(j, space, jobId), hint: threatsHint(jobId) };
}

/** The newest job of the newest threat model this repo's runs created, or null. */
export function latestTmJob(ctx: Ctx, space: string, slug: string): TmJob | null {
  const prefix = titlePrefix(slug);
  const models = paged(ctx, ['securityagent', 'list-threat-models', '--agent-space-id', space], 'threatModelSummaries')
    .filter((m) => String(m?.title || '').startsWith(prefix))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  for (const m of models) {
    const jobs = paged(ctx, ['securityagent', 'list-threat-model-jobs', '--agent-space-id', space, '--threat-model-id', String(m.threatModelId)], 'threatModelJobSummaries')
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    // The summary has no systemOverview; read the job itself.
    if (jobs.length) return getTmJob(ctx, space, String(jobs[0].threatModelJobId));
  }
  return null;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);

export function fetchThreats(ctx: Ctx, space: string, jobId: string, repoRoot?: string): ThreatRow[] {
  const summaries = paged(ctx, ['securityagent', 'list-threats', '--agent-space-id', space, '--threat-job-id', jobId], 'threats');
  const details = new Map<string, any>();
  for (let i = 0; i < summaries.length; i += DETAILS_BATCH) {
    const ids = summaries.slice(i, i + DETAILS_BATCH).map((s) => String(s.threatId || '')).filter(Boolean);
    if (!ids.length) continue;
    // Details are best effort: a caller without batch-get-threats still gets the summaries.
    const r = ctx.deps.aws(['securityagent', 'batch-get-threats', '--agent-space-id', space, '--threat-ids', ...ids], ctx.opts.region);
    if (r.ok) for (const t of r.json?.threats || []) details.set(String(t.threatId), t);
  }
  return summaries.map((s) => {
    const d = details.get(String(s.threatId)) || {};
    const evidence = (Array.isArray(d.evidence) ? d.evidence : []).map((e: any) => String(e?.path || '')).filter(Boolean)
      .map((p: string) => repoRelative(p, repoRoot));
    return {
      threatId: String(s.threatId || ''),
      severity: String(d.severity || s.severity || 'INFO').toUpperCase(),
      status: String(d.status || s.status || ''),
      title: String(d.title || s.title || '(untitled threat)'),
      statement: String(d.statement || s.statement || ''),
      stride: strList(d.stride ?? s.stride).map((x) => x.toUpperCase()),
      recommendation: String(d.recommendation || ''),
      evidence: [...new Set<string>(evidence)],
      impactedAssets: strList(d.impactedAssets),
    };
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** "INFORMATION_DISCLOSURE" -> "Information disclosure". */
export function strideLabel(s: string): string {
  const w = s.toLowerCase().replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/**
 * The overview's first paragraph of prose, for the terminal and dashboard:
 * markdown headings skipped, whitespace collapsed, secrets redacted, capped.
 */
export function firstParagraph(text: string | null | undefined): string {
  if (!text) return '';
  for (const block of text.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
    const prose = block.split('\n').filter((l) => !/^\s*#/.test(l)).join(' ').replace(/\s+/g, ' ').trim();
    if (!prose) continue;
    const one = redact(prose);
    return one.length > OVERVIEW_CHARS ? `${one.slice(0, OVERVIEW_CHARS - 3)}...` : one;
  }
  return '';
}

export function countBySeverity(ts: ThreatRow[]): Record<string, number> {
  const c: Record<string, number> = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
  for (const t of ts) c[t.severity in c ? t.severity : 'INFO']++;
  return c;
}

export function countByStride(ts: ThreatRow[]): Record<string, number> {
  const c: Record<string, number> = Object.fromEntries(STRIDE_ORDER.map((s) => [s, 0]));
  for (const t of ts) for (const s of t.stride) if (s in c) c[s]++;
  return c;
}

export function sortThreats(ts: ThreatRow[]): ThreatRow[] {
  return [...ts].sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || a.title.localeCompare(b.title));
}

export function threatTotals(c: Record<string, number>): string {
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return `${total} threat${total === 1 ? '' : 's'}: ` + SEVERITY_ORDER.map((s) => `${c[s] ?? 0} ${s.toLowerCase()}`).join(', ');
}

function strideLine(c: Record<string, number>): string | null {
  const parts = STRIDE_ORDER.filter((s) => (c[s] || 0) > 0).map((s) => `${c[s]} ${strideLabel(s).toLowerCase()}`);
  return parts.length ? `STRIDE: ${parts.join(', ')}` : null;
}

/** Grouped by severity: STRIDE categories and title, then the recommendation and evidence paths. */
export function printThreats(say: (l?: string) => void, ts: ThreatRow[]): void {
  const sorted = sortThreats(ts);
  for (const level of SEVERITY_ORDER) {
    const group = sorted.filter((t) => t.severity === level || (level === 'INFO' && !(SEVERITY_ORDER as readonly string[]).includes(t.severity)));
    if (!group.length) continue;
    say(`${level} (${group.length})`);
    for (const t of group) {
      say(`  ${t.stride.length ? `[${t.stride.map(strideLabel).join(', ')}] ` : ''}${redact(t.title)}`);
      if (t.recommendation) say(`    Recommendation: ${shortText(t.recommendation)}`);
      if (t.evidence.length) {
        const more = t.evidence.length > EVIDENCE_SHOWN ? ` (+${t.evidence.length - EVIDENCE_SHOWN} more)` : '';
        say(`    Evidence: ${t.evidence.slice(0, EVIDENCE_SHOWN).join(', ')}${more}`);
      }
    }
  }
  const sl = strideLine(countByStride(ts));
  if (sl) say(sl);
  say(threatTotals(countBySeverity(ts)));
}

function toSeverity(s: string): Severity {
  return sevRank(s) >= 3 ? 'high' : sevRank(s) === 2 ? 'medium' : 'low';
}

interface TmBase {
  space: string; region: string; account?: string; threatModelId: string;
  tip?: string | null; branch?: string | null; scopeDocs: string[];
  /** When we started the job, or the pending record's start; default: the job's createdAt. */
  startedAt?: string;
}

/** Written right after start-threat-model-job, so a lost wait loses nothing. */
export function pendingThreatModel(o: TmBase & { job: TmJob; startedAt: string }): PrismResult {
  return makeResult({
    kind: 'security-threat-model', hook: 'manual', tool: 'security-agent', status: 'pending',
    commit: o.tip ?? null, branch: o.branch ?? null, started_at: o.startedAt, finished_at: o.startedAt,
    threat_model: {
      job_id: o.job.threatModelJobId, threat_model_id: o.threatModelId, agent_space_id: o.space, region: o.region, account: o.account,
      job_status: o.job.status, counts: {}, stride_counts: {}, scope_docs: o.scopeDocs, system_overview: null,
      service_created_at: o.job.createdAt ?? null, service_updated_at: null,
    },
  });
}

export function toThreatModelResult(o: TmBase & { job: TmJob; threats: ThreatRow[]; now: Date }): PrismResult {
  const ok = o.job.status === 'COMPLETED';
  const counts = countBySeverity(o.threats);
  const findings: Finding[] = sortThreats(o.threats).map((t) => ({
    severity: toSeverity(t.severity), category: 'security', rule: t.stride.join(',') || 'threat',
    file: t.evidence[0] || '', line: null, message: t.statement ? `${t.title}: ${shortText(t.statement)}` : t.title,
    risk_level: t.severity, title: t.title, threat_id: t.threatId, stride: t.stride,
    recommendation: redact(t.recommendation), evidence: t.evidence,
  }));
  return makeResult({
    kind: 'security-threat-model', hook: 'manual', tool: 'security-agent',
    status: !ok ? 'error' : findings.length ? 'findings' : 'ok',
    commit: o.tip ?? null, branch: o.branch ?? null,
    started_at: o.startedAt || o.job.createdAt || o.now.toISOString(),
    finished_at: o.job.updatedAt || o.now.toISOString(),
    findings,
    summary: ok ? threatTotals(counts) : null,
    reason: ok ? null : `job ${o.job.status}${o.job.reason ? `: ${redact(o.job.reason)}` : ''}`,
    threat_model: {
      job_id: o.job.threatModelJobId, threat_model_id: o.threatModelId || o.job.threatModelId, agent_space_id: o.space, region: o.region, account: o.account,
      job_status: o.job.status, counts, stride_counts: countByStride(o.threats), scope_docs: o.scopeDocs,
      system_overview: o.job.systemOverview ? redact(o.job.systemOverview) : null,
      service_created_at: o.job.createdAt ?? null, service_updated_at: o.job.updatedAt ?? null,
    },
  });
}

/** Records (pending, completed or failed) in this repo for this account, region and agent space, newest first. */
export function threatModelRecords(root: string, account: string, region: string, space: string): ResultEntry[] {
  return readResultEntries(root)
    .filter(({ result: r }) => r.kind === 'security-threat-model' && r.threat_model?.job_id
      && r.threat_model.account === account && r.threat_model.region === region && r.threat_model.agent_space_id === space)
    .sort((a, b) => b.result.started_at.localeCompare(a.result.started_at));
}

function fromPending(p: PrismResult): Omit<TmBase, 'space' | 'region' | 'account'> {
  return { threatModelId: p.threat_model!.threat_model_id, tip: p.commit, branch: p.branch, scopeDocs: p.threat_model!.scope_docs || [], startedAt: p.started_at };
}

export function failOnThreat(ts: ThreatRow[], failOn: string | undefined): boolean {
  if (!failOn) return false;
  const min = sevRank(failOn.toUpperCase());
  return ts.some((t) => sevRank(t.severity) >= min && sevRank(t.severity) > 0);
}

/** A FAILED / STOPPED job: saves the error result and prints why, with the unknowns hint for a client error. Exit 1. */
function saveFailed(ctx: Ctx, json: boolean, result: PrismResult, job: TmJob, repo: RepoCtx, space: string, id?: string): number {
  const deps = ctx.deps as ReviewDeps;
  const path = writeResult(repo.root, result, id);
  if (json) deps.out(JSON.stringify(result, null, 2) + '\n');
  ctx.deps.log(`Error: job ${job.threatModelJobId} ended ${job.status}${job.reason ? `: ${redact(job.reason)}` : ''}`);
  if (job.errorCode === 'CLIENT_ERROR') for (const l of unknownsHint()) ctx.deps.log(l);
  ctx.deps.log(`Saved ${path}`);
  return 1;
}

/** `tinyDocs`: the tiny-docs warning, repeated when the job found no threats. */
function finishThreats(ctx: Ctx, json: boolean, result: PrismResult, threats: ThreatRow[], repo: RepoCtx, job: TmJob, minLevel?: string, id?: string, tinyDocs?: string | null): void {
  const deps = ctx.deps as ReviewDeps;
  const shown = minLevel ? threats.filter((t) => sevRank(t.severity) >= sevRank(minLevel.toUpperCase()) && sevRank(t.severity) > 0) : threats;
  const path = writeResult(repo.root, result, id);
  const emptyHint = !threats.length && tinyDocs ? tinyDocs : null;
  if (json) { deps.out(JSON.stringify(result, null, 2) + '\n'); if (emptyHint) deps.err(emptyHint); deps.err(`Saved ${path}`); return; }
  const say = ctx.deps.log;
  const overview = firstParagraph(job.systemOverview);
  say('');
  if (overview) { say('System overview:'); say(`  ${overview}`); say('  (the full overview is in the saved result, field threat_model.system_overview)'); say(''); }
  if (shown.length) printThreats(say, shown); else say(minLevel ? `No threats at ${minLevel} or above.` : 'No threats.');
  if (emptyHint) say(emptyHint);
  if (minLevel && shown.length !== threats.length) say(`(${threats.length - shown.length} below ${minLevel} not shown; ${threatTotals(countBySeverity(threats))})`);
  say(`Saved ${path}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const THREAT_MODEL_NOTICE = 'prism-cli security threat-model uploads the repo at HEAD and its scope docs (read from HEAD) to the Security Agent scan bucket under threat-model/<slug>/<commit>/, creates a threat model and starts a threat model job in the AWS account your credentials point to. Those are its only AWS writes; AWS does not charge for threat modeling while it is in preview. The result is saved to .prism/results/.';

/** `prism-cli security threat-model`. Returns the exit code. */
export async function securityThreatModel(input: ThreatModelOptions, deps: ReviewDeps): Promise<number> {
  const say = input.json ? deps.err : deps.log;
  const root = checkedRoot(deps, input.path, say);
  if (!root) return 1;
  // Local checks before the notice and any AWS call: a bad --doc prints one Error line.
  let docPaths: string[];
  try { docPaths = selectDocs(deps, root, input); } catch (e) {
    if (e instanceof Abort) { say(`Error: ${redact(e.message)}`); return 1; }
    throw e;
  }
  say(THREAT_MODEL_NOTICE);
  say('');
  const ctx = begin(input, deps, false, say);
  if (!ctx) return 1;
  try {
    const failOn = parseLevel('--fail-on', input.failOn);
    const timeout = parseTimeout(input.timeout, DEFAULT_TM_TIMEOUT_MIN);
    const id = preflight(ctx);
    printIdentity(ctx, id);
    const repo = needRepo(ctx, root);
    const space = agentSpace(ctx, id);
    const bucket = getParam(ctx, PARAM_SCAN_BUCKET);
    if (!bucket) throw new Abort(`SSM ${PARAM_SCAN_BUCKET} is not set in this account and region: ${NOT_SET_UP}.`);
    const role = getParam(ctx, PARAM_SERVICE_ROLE) || `arn:aws:iam::${id.account}:role/${SERVICE_ROLE_NAME}`;
    say(`Repo:        ${repo.id}`);
    say(`Agent space: ${space} (from SSM ${PARAM_AGENT_SPACE})`);
    // Before any write: create-threat-model refuses S3 objects in a bucket the agent space does not list.
    const listed = spaceBuckets(ctx, space);
    if (listed === null) throw new Abort(`batch-get-agent-spaces did not return agent space ${space} (from SSM ${PARAM_AGENT_SPACE}); run prism-cli enable security --status.`);
    if (!listsBucket(listed, bucket)) throw new Abort(bucketNotListed(bucket));

    const tipR = deps.git(['-C', root, 'rev-parse', 'HEAD']);
    const tip = tipR.ok ? tipR.stdout.trim() : '';
    if (!tip) throw new Abort('Could not read HEAD; is this a repository with at least one commit?');
    const br = deps.git(['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = br.ok ? br.stdout.trim() : null;
    const prefix = `threat-model/${repo.slug}/${tip.slice(0, 12)}`;

    const dir = deps.makeTempDir();
    const zip = join(dir, 'source.zip');
    if (!deps.git(['-C', root, 'archive', 'HEAD', '--format=zip', '-o', zip]).ok) throw new Abort('git archive HEAD failed.');
    const docs = materializeDocs(ctx, root, docPaths, prefix);
    say(`Source:      the repo at ${tip.slice(0, 12)}`);
    say(docs.length
      ? `Scope docs:  ${docs.map((d) => d.path).join(', ')}`
      : `Scope docs:  none (${input.docs === false ? '--no-docs' : 'no --doc and no .kiro/specs/*/design.md or requirements.md in HEAD'}); the source alone is modeled`);
    for (const w of docLimitWarnings(docs)) say(w);
    const tinyDocs = tinyDocsHint(docs);
    if (tinyDocs) say(tinyDocs);

    const source = { file: zip, key: `${prefix}/source.zip` };
    for (const s of [source, ...docs]) {
      const uri = `s3://${bucket}/${s.key}`;
      say(upload(ctx, bucket, s) ? `Uploaded ${uri}` : `${uri} is already up to date; upload skipped`);
    }

    const title = runTitle(repo.slug, tip, deps.now());
    const created = writeCall(ctx, [
      'securityagent', 'create-threat-model', '--agent-space-id', space, '--title', title, '--service-role', role,
      '--description', `prism-cli threat model of ${repo.id} at ${tip.slice(0, 12)}`,
      '--assets', JSON.stringify({ sourceCode: [{ s3Location: `s3://${bucket}/${source.key}` }] }),
      ...(docs.length ? ['--scope-docs', JSON.stringify(docs.map((d) => ({ s3Location: `s3://${bucket}/${d.key}` })))] : []),
    ], bucket);
    const threatModelId = String(created.json?.threatModelId || '');
    if (!threatModelId) throw new Abort('create-threat-model returned no threatModelId.');
    say(`Threat model: ${threatModelId} ("${title}")`);

    const startedAt = deps.now().getTime();
    const started = toTmJob(writeCall(ctx, ['securityagent', 'start-threat-model-job', '--agent-space-id', space, '--threat-model-id', threatModelId], bucket).json);
    if (!started.threatModelJobId) throw new Abort('start-threat-model-job returned no threatModelJobId.');
    const job: TmJob = { ...started, threatModelId, status: started.status === 'UNKNOWN' ? 'IN_PROGRESS' : started.status };
    say(`Started job ${job.threatModelJobId}`);
    const kept = { space, region: ctx.opts.region, account: id.account, threatModelId, tip, branch, scopeDocs: docPaths, startedAt: new Date(startedAt).toISOString() };
    let pendingId: string | undefined;
    try {
      const p = writeResult(repo.root, pendingThreatModel({ ...kept, job }));
      pendingId = basename(p, '.json');
      say(`Saved ${p} (pending)`);
    } catch (e) {
      say(`Warning: could not save the pending record (${redact(e instanceof Error ? e.message : String(e))}).`);
    }
    if (input.wait === false) { say(`Not waiting (--no-wait). ${threatsHint(job.threatModelJobId)}`); return 0; }

    say(`Waiting for the job (up to ${timeout} min; Ctrl-C stops waiting, the job keeps running)...`);
    const out = await pollUntilDone(ctx, tmPoller(space, job.threatModelJobId), job, timeout);
    if (out.kind === 'interrupted') { say(''); say(`Stopped waiting. ${threatsHint(job.threatModelJobId)}`); return 130; }
    if (out.kind === 'timeout') { say(`Timed out after ${timeout} min (job ${job.threatModelJobId} is ${out.job.status}). ${threatsHint(job.threatModelJobId)}`); return 2; }

    const wallS = Math.round((deps.now().getTime() - startedAt) / 1000);
    const svc = serviceSeconds(out.job);
    say(`Finished in ${wallS}s here${svc !== null ? `; the service reports ${svc}s from job creation to its last update` : ''}.`);
    const base = { ...kept, job: out.job, now: deps.now() };
    if (out.job.status !== 'COMPLETED') return saveFailed(ctx, !!input.json, toThreatModelResult({ ...base, threats: [] }), out.job, repo, space, pendingId);
    const threats = fetchThreats(ctx, space, out.job.threatModelJobId, repo.root);
    finishThreats(ctx, !!input.json, toThreatModelResult({ ...base, threats }), threats, repo, out.job, undefined, pendingId, tinyDocs);
    if (failOnThreat(threats, failOn)) { say(`--fail-on ${failOn}: threats at or above ${failOn}.`); return 1; }
    return 0;
  } catch (e) {
    if (e instanceof Abort) { say(`Error: ${redact(e.message)}`); return 1; }
    throw e;
  }
}

/** `prism-cli security threats`. Read-only: no AWS writes. Returns the exit code. */
export async function securityThreats(input: ThreatsOptions, deps: ReviewDeps): Promise<number> {
  const say = input.json ? deps.err : deps.log;
  const root = checkedRoot(deps, input.path, say);
  if (!root) return 1;
  say('Read-only (security threats): nothing in AWS will be changed; results are cached to .prism/results/.');
  say('');
  const ctx = begin(input, deps, true, say);
  if (!ctx) return 1;
  try {
    const min = parseLevel('--severity', input.severity);
    const timeout = parseTimeout(input.timeout, DEFAULT_TM_TIMEOUT_MIN);
    const id = preflight(ctx);
    printIdentity(ctx, id);
    const repo = needRepo(ctx, root);
    const space = agentSpace(ctx, id);
    const records = threatModelRecords(repo.root, id.account, ctx.opts.region, space);
    const pendings = records.filter((e) => e.result.status === 'pending');
    // A job already on record (pending or completed) is updated in place, keeping its scope docs and commit.
    const recordOf = (jobId: string) => records.find((e) => e.result.threat_model!.job_id === jobId) ?? null;
    let pending: ResultEntry | null = null;
    let job: TmJob | null;
    if (input.job) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.job)) throw new Abort(`--job must be a job id, got "${input.job}"`);
      pending = recordOf(input.job);
      job = getTmJob(ctx, space, input.job);
    } else if (pendings.length) {
      pending = pendings[0];
      if (pendings.length > 1) {
        say(`Also pending: ${pendings.slice(1).map((e) => `${e.result.threat_model!.job_id} (started ${e.result.started_at})`).join(', ')}. Fetch one with --job <id>.`);
      }
      job = getTmJob(ctx, space, pending.result.threat_model!.job_id);
    } else {
      job = latestTmJob(ctx, space, repo.slug);
      if (!job) { say(`No threat models yet for ${repo.id}. Start one with: prism-cli security threat-model`); return 0; }
      pending = recordOf(job.threatModelJobId);
    }
    if (pending) say(`${pending.result.status === 'pending' ? 'Pending: ' : 'Recorded:'}    recorded by threat-model at ${pending.result.started_at} (commit ${(pending.result.commit || '').slice(0, 12)})`);
    say(`Job:         ${job.threatModelJobId} (${job.status}${job.createdAt ? `, started ${job.createdAt}` : ''})`);
    if (!TERMINAL.has(job.status)) {
      if (!input.wait) { say(`The job is still ${job.status}. Re-run with --wait to wait for it, or check back later.`); return 2; }
      const out = await pollUntilDone(ctx, tmPoller(space, job.threatModelJobId), job, timeout);
      if (out.kind === 'interrupted') { say(''); say(`Stopped waiting. ${threatsHint(job.threatModelJobId)}`); return 130; }
      if (out.kind === 'timeout') { say(`Timed out after ${timeout} min (still ${out.job.status}). ${threatsHint(job.threatModelJobId)}`); return 2; }
      job = out.job;
    }
    const base = {
      space, job, region: ctx.opts.region, account: id.account, now: deps.now(),
      ...(pending ? fromPending(pending.result) : { threatModelId: job.threatModelId, scopeDocs: [] as string[] }),
    };
    if (job.status !== 'COMPLETED') {
      if (pending) return saveFailed(ctx, !!input.json, toThreatModelResult({ ...base, threats: [] }), job, repo, space, pending.id);
      say(`Error: job ${job.threatModelJobId} ended ${job.status}${job.reason ? `: ${redact(job.reason)}` : ''}`);
      if (job.errorCode === 'CLIENT_ERROR') for (const l of unknownsHint()) say(l);
      return 1;
    }
    const threats = fetchThreats(ctx, space, job.threatModelJobId, repo.root);
    const sizes = pending ? recordedDocSizes(deps, root, pending.result.commit, base.scopeDocs) : null;
    finishThreats(ctx, !!input.json, toThreatModelResult({ ...base, threats }), threats, repo, job, min, pending?.id, sizes && tinyDocsHint(sizes));
    return 0;
  } catch (e) {
    if (e instanceof Abort) { say(`Error: ${redact(e.message)}`); return 1; }
    throw e;
  }
}
