import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AwsResult } from '../src/utils/aws.js';
import {
  CODE_REVIEW_NOTICE, POLL_FIRST_MS, POLL_MAX_MS, resolveRepoRoot, securityCodeReview, securityFindings,
  type CodeReviewOptions, type FindingsOptions, type ReviewDeps,
} from '../src/security/review.js';
import { collectSecurity, latestSecurityReview } from '../src/dashboard/security.js';
import { collectCodewatch } from '../src/dashboard/codewatch.js';
import { MARKER_PATH } from '../src/security/marker.js';
import type { PrismResult } from '../src/codewatch/results.js';

// ---------------------------------------------------------------------------
// A fake AWS account and repo, in the style of the enable security tests.
// ---------------------------------------------------------------------------
const ACCOUNT = '111122223333';
const REGION = 'us-west-2';
const BUCKET = `security-agent-scans-${ACCOUNT}-${REGION}`;
const SLUG = 'github.com-acme-widgets';
const TIP = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PATCH = 'diff --git a/x.ts b/x.ts\n+const x = 1;\n';
const ZIP = 'fake zip';
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

const ok = (json: unknown = {}): AwsResult => ({ ok: true, json, errorCode: '', raw: '' });
const fail = (code: string, raw: string): AwsResult => ({ ok: false, json: null, errorCode: code, raw });
const arg = (a: string[], f: string) => a[a.indexOf(f) + 1];

interface Summary { findingId: string; name: string; riskLevel: string; riskType?: string }
interface State {
  params: Record<string, string>;
  objects: Record<string, string>;
  /** Status returned by each successive batch-get-code-review-jobs call; the last one repeats. */
  statuses: string[];
  findings: Summary[];
  pageSize: number;
  jobs: { codeReviewJobId: string; status: string; createdAt: string }[];
  failReason?: string;
}

function state(o: Partial<State> = {}): State {
  return {
    params: { '/prism/continuum/scan-bucket': BUCKET, '/prism/continuum/agent-space-id': 'as-1', [`/prism/continuum/code-review-id/${SLUG}`]: 'cr-1' },
    objects: {}, statuses: ['COMPLETED'],
    findings: [
      { findingId: 'f1', name: 'SQL injection in lookup', riskLevel: 'HIGH', riskType: 'CWE-89' },
      { findingId: 'f2', name: 'Verbose error', riskLevel: 'LOW' },
      { findingId: 'f3', name: 'Hardcoded key', riskLevel: 'CRITICAL' },
    ],
    pageSize: 100, jobs: [], ...o,
  };
}

interface H {
  deps: ReviewDeps; calls: string[][]; lines: string[]; errs: string[]; outs: string[]; sleeps: number[]; ticks: string[];
  gitCalls: string[][]; repo: string; out: () => string; writes: () => string[]; cleanup: () => void; results: () => any[];
}

function harness(s: State, o: { cwd?: (repo: string) => string; tty?: boolean; marker?: boolean; upstream?: boolean; patch?: string; interruptOnSleep?: number } = {}): H {
  const repo = mkdtempSync(join(tmpdir(), 'prism-scr-repo-'));
  if (o.marker !== false) {
    mkdirSync(join(repo, '.prism'), { recursive: true });
    writeFileSync(join(repo, MARKER_PATH), JSON.stringify({ agentSpaceId: 'as-1', applicationId: 'app-1', codeReviewId: 'cr-1', region: REGION, account: ACCOUNT, setupAt: '2026-11-06T00:00:00Z' }));
  }
  const calls: string[][] = []; const lines: string[] = []; const errs: string[] = []; const outs: string[] = [];
  const sleeps: number[] = []; const ticks: string[] = []; const gitCalls: string[][] = [];
  let clock = Date.parse('2026-11-07T10:00:00Z');
  let polls = 0; let interrupt: (() => void) | null = null;
  const deps: ReviewDeps = {
    aws(a) {
      calls.push(a);
      switch (`${a[0]} ${a[1]}`) {
        case 'sts get-caller-identity': return ok({ Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Dev/me` });
        case 'iam list-account-aliases': return ok({ AccountAliases: ['acme-dev'] });
        case 'ssm get-parameter': { const v = s.params[arg(a, '--name')]; return v ? ok({ Parameter: { Value: v } }) : fail('ParameterNotFound', 'ParameterNotFound'); }
        case 's3api head-object': { const e = s.objects[arg(a, '--key')]; return e ? ok({ ETag: `"${e}"` }) : fail('404', 'An error occurred (404) when calling the HeadObject operation: Not Found'); }
        case 's3api put-object': s.objects[arg(a, '--key')] = createHash('md5').update(readFileSync(arg(a, '--body'))).digest('hex'); return ok({});
        case 'securityagent start-code-review-job': return ok({ codeReviewJobId: 'job-1', status: 'IN_PROGRESS', createdAt: '2026-11-07T10:00:00Z' });
        case 'securityagent batch-get-code-review-jobs': {
          const st = s.statuses[Math.min(polls++, s.statuses.length - 1)];
          return ok({ codeReviewJobs: [{
            codeReviewJobId: arg(a, '--code-review-job-ids'), status: st, createdAt: '2026-11-07T10:00:00Z', updatedAt: '2026-11-07T10:05:00Z',
            steps: [{ name: 'STATIC_ANALYSIS', status: st === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'COMPLETED' }],
            executionContext: s.failReason ? [{ contextType: 'ERROR', context: s.failReason }] : [],
          }] });
        }
        case 'securityagent list-findings': {
          const start = a.includes('--starting-token') ? Number(arg(a, '--starting-token')) : 0;
          const page = s.findings.slice(start, start + s.pageSize);
          return ok({ findingsSummaries: page, ...(start + s.pageSize < s.findings.length ? { NextToken: String(start + s.pageSize) } : {}) });
        }
        case 'securityagent batch-get-findings': {
          const ids = a.slice(a.indexOf('--finding-ids') + 1);
          return ok({ findings: ids.map((id) => ({ findingId: id, description: `Details of ${id}. More text.`, codeLocations: [{ filePath: `src/${id}.ts`, lineStart: 7 }] })) });
        }
        case 'securityagent list-code-review-jobs-for-code-review': return ok({ codeReviewJobSummaries: s.jobs });
        default: return fail('', `fake aws: unexpected ${a.join(' ')}`);
      }
    },
    configRegion: () => null,
    env: {},
    awsVersion: () => 'aws-cli/2.36.19 Python/3.14',
    cdk: { synth: () => { throw new Error('no cdk here'); }, diff: () => { throw new Error('no cdk'); }, deploy: () => { throw new Error('no cdk'); } },
    git(a) {
      gitCalls.push(a);
      const has = (x: string) => a.includes(x);
      if (has('--show-toplevel')) {
        // Like git: the real path of the enclosing repo, or a failure outside one.
        const dir = realpathSync(a[a.indexOf('-C') + 1]); const top = realpathSync(repo);
        return dir === top || dir.startsWith(top + '/') ? { ok: true, stdout: top, stderr: '' } : { ok: false, stdout: '', stderr: 'fatal: not a git repository' };
      }
      if (has('remote')) return { ok: true, stdout: 'https://github.com/acme/widgets.git', stderr: '' };
      if (has('@{upstream}')) return o.upstream === false ? { ok: false, stdout: '', stderr: 'no upstream' } : { ok: true, stdout: 'origin/main', stderr: '' };
      if (has('symbolic-ref')) return { ok: false, stdout: '', stderr: '' };
      if (has('--verify')) return { ok: true, stdout: BASE, stderr: '' };
      if (has('--abbrev-ref') && has('HEAD')) return { ok: true, stdout: 'work', stderr: '' };
      if (has('rev-parse') && has('HEAD')) return { ok: true, stdout: TIP, stderr: '' };
      if (has('archive')) { writeFileSync(arg(a, '-o'), ZIP); return { ok: true, stdout: '', stderr: '' }; }
      if (has('diff')) { const f = a.find((x) => x.startsWith('--output='))!.slice('--output='.length); writeFileSync(f, o.patch ?? PATCH); return { ok: true, stdout: '', stderr: '' }; }
      return { ok: false, stdout: '', stderr: `fake git: ${a.join(' ')}` };
    },
    makeTempDir: () => mkdtempSync(join(tmpdir(), 'prism-scr-tmp-')),
    isTTY: o.tty ?? false,
    ask: async () => '',
    log: (l = '') => { lines.push(l); },
    now: () => new Date(clock),
    sleep: async (ms) => {
      sleeps.push(ms);
      if (o.interruptOnSleep === sleeps.length && interrupt) { interrupt(); return; }
      clock += ms;
    },
    onInterrupt: (h) => { interrupt = h; return () => { interrupt = null; }; },
    ticker: (l) => { ticks.push(l); },
    err: (l = '') => { errs.push(l); },
    out: (t) => { outs.push(t); },
    cwd: () => (o.cwd ? o.cwd(repo) : repo),
  };
  const writeVerbs = /^(create|update|put|delete|start|stop)-/;
  return {
    deps, calls, lines, errs, outs, sleeps, ticks, gitCalls, repo,
    out: () => lines.join('\n'),
    writes: () => calls.filter((c) => writeVerbs.test(c[1] || '')).map((c) => `${c[0]} ${c[1]}`),
    results: () => {
      const dir = join(repo, '.prism', 'results');
      try { return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))); } catch { return []; }
    },
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
}

const cr = (o: Partial<CodeReviewOptions> = {}): CodeReviewOptions => ({ region: REGION, ...o });
const fo = (o: Partial<FindingsOptions> = {}): FindingsOptions => ({ region: REGION, ...o });

// ---------------------------------------------------------------------------

test('code-review: notice first, diff scope, upload, start, poll with backoff, findings grouped, result saved', async () => {
  const s = state({ statuses: ['IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS', 'COMPLETED'] });
  const h = harness(s);
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 0);
    assert.equal(h.lines[0], CODE_REVIEW_NOTICE);
    assert.match(CODE_REVIEW_NOTICE, /only AWS writes/);
    assert.deepEqual(h.sleeps, [POLL_FIRST_MS, 20_000, 40_000, POLL_MAX_MS, POLL_MAX_MS, POLL_MAX_MS]);
    assert.deepEqual(h.writes(), ['s3api put-object', 'securityagent start-code-review-job']);
    const start = h.calls.find((c) => c[1] === 'start-code-review-job')!;
    assert.deepEqual(JSON.parse(arg(start, '--diff-source')), { s3Uri: `s3://${BUCKET}/diffs/${SLUG}/local/${TIP.slice(0, 12)}-${BASE.slice(0, 12)}.patch` });
    assert.ok(h.gitCalls.some((g) => g.includes(`${BASE}...${TIP}`)), 'diff of base...tip');
    const out = h.out();
    assert.match(out, /Account: {5}111122223333 \(acme-dev\)/);
    assert.match(out, /Scope: {7}origin\/main\.\.\.aaaaaaaaaaaa/);
    assert.match(out, /CRITICAL \(1\)\n {2}Hardcoded key {2}src\/f3\.ts:7\n {4}Details of f3\. More text\.\nHIGH \(1\)\n {2}SQL injection in lookup {2}src\/f1\.ts:7 {2}CWE-89/);
    assert.match(out, /3 findings: 1 critical, 1 high, 0 medium, 1 low, 0 informational, 0 unknown/);
    assert.match(out, /\[00:10\] IN_PROGRESS \(STATIC_ANALYSIS\)/, 'plain periodic lines without a TTY');
  } finally { h.cleanup(); }
});

test('code-review: the result file uses the codewatch schema with kind security-review', async () => {
  const h = harness(state());
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 0);
    const [r] = h.results();
    assert.equal(r.schema_version, 1);
    assert.equal(r.kind, 'security-review');
    assert.equal(r.tool, 'security-agent');
    assert.equal(r.hook, 'manual');
    assert.equal(r.status, 'findings');
    assert.equal(r.commit, TIP);
    assert.equal(r.base, BASE);
    assert.equal(r.upstream, 'origin/main');
    assert.deepEqual({ ...r.security, counts: undefined }, { job_id: 'job-1', code_review_id: 'cr-1', agent_space_id: 'as-1', region: REGION, scope: 'diff', job_status: 'COMPLETED', counts: undefined });
    assert.deepEqual(r.security.counts, { CRITICAL: 1, HIGH: 1, MEDIUM: 0, LOW: 1, INFORMATIONAL: 0, UNKNOWN: 0 });
    assert.deepEqual(r.findings.map((f: any) => [f.risk_level, f.severity, f.file, f.line, f.cwe]), [
      ['CRITICAL', 'high', 'src/f3.ts', 7, null], ['HIGH', 'high', 'src/f1.ts', 7, 'CWE-89'], ['LOW', 'low', 'src/f2.ts', 7, null]]);
  } finally { h.cleanup(); }
});

test('code-review: a TTY gets a one-line ticker instead of periodic lines', async () => {
  const h = harness(state({ statuses: ['IN_PROGRESS', 'COMPLETED'] }), { tty: true });
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 0);
    assert.deepEqual(h.ticks, ['[00:10] IN_PROGRESS (STATIC_ANALYSIS)', '[00:30] COMPLETED', '']);
    assert.doesNotMatch(h.out(), /\[00:10\]/);
  } finally { h.cleanup(); }
});

test('code-review: FAILED and STOPPED exit 1 with the reason; the result records the error', async () => {
  for (const st of ['FAILED', 'STOPPED']) {
    const h = harness(state({ statuses: [st], failReason: 'Source asset not readable' }));
    try {
      assert.equal(await securityCodeReview(cr(), h.deps), 1);
      assert.match(h.out(), new RegExp(`Error: job job-1 ended ${st}: Source asset not readable`));
      const [r] = h.results();
      assert.equal(r.status, 'error');
      assert.equal(r.security.job_status, st);
      assert.ok(!h.calls.some((c) => c[1] === 'list-findings'));
    } finally { h.cleanup(); }
  }
});

test('code-review: timeout exits 2 with the job id and how to fetch it later', async () => {
  const h = harness(state({ statuses: ['IN_PROGRESS'] }));
  try {
    assert.equal(await securityCodeReview(cr({ timeout: '1' }), h.deps), 2);
    assert.deepEqual(h.sleeps, [10_000, 20_000, 30_000], 'last sleep cut to the time left');
    assert.match(h.out(), /Timed out after 1 min \(job job-1 is IN_PROGRESS\)\. The job keeps running in AWS\. Fetch its results later with: prism-cli security findings --job job-1/);
    assert.equal(h.results().length, 0);
  } finally { h.cleanup(); }
});

test('code-review: Ctrl-C stops waiting, leaves the job running, exits 130', async () => {
  const h = harness(state({ statuses: ['IN_PROGRESS'] }), { interruptOnSleep: 2 });
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 130);
    assert.match(h.out(), /Stopped waiting\. The job keeps running in AWS\. Fetch its results later with: prism-cli security findings --job job-1/);
    assert.equal(h.calls.filter((c) => c[1] === 'batch-get-code-review-jobs').length, 1, 'no poll after Ctrl-C');
    assert.deepEqual(h.writes(), ['s3api put-object', 'securityagent start-code-review-job'], 'nothing stops or cancels the job');
  } finally { h.cleanup(); }
});

test('findings are fetched across pages and detailed in batches of 25', async () => {
  const many = Array.from({ length: 230 }, (_, i) => ({ findingId: `f${i}`, name: `Finding ${i}`, riskLevel: 'MEDIUM' }));
  const h = harness(state({ findings: many, pageSize: 100 }));
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 0);
    const pages = h.calls.filter((c) => c[1] === 'list-findings');
    assert.deepEqual(pages.map((c) => (c.includes('--starting-token') ? arg(c, '--starting-token') : null)), [null, '100', '200']);
    assert.ok(pages.every((c) => arg(c, '--max-items') === '100'));
    assert.equal(h.calls.filter((c) => c[1] === 'batch-get-findings').length, 10);
    assert.equal(h.results()[0].findings.length, 230);
  } finally { h.cleanup(); }
});

test('--full reviews the repo at HEAD: zip to the code review asset, no diff source', async () => {
  const h = harness(state());
  try {
    assert.equal(await securityCodeReview(cr({ full: true }), h.deps), 0);
    const put = h.calls.find((c) => c[1] === 'put-object')!;
    assert.equal(arg(put, '--key'), `repo/${SLUG}/latest.zip`);
    assert.ok(!h.calls.find((c) => c[1] === 'start-code-review-job')!.includes('--diff-source'));
    assert.equal(h.results()[0].security.scope, 'full');
    assert.ok(!h.gitCalls.some((g) => g.includes('diff')), 'no diff for --full');
  } finally { h.cleanup(); }
});

test('an identical snapshot skips the upload', async () => {
  const s = state(); s.objects[`diffs/${SLUG}/local/${TIP.slice(0, 12)}-${BASE.slice(0, 12)}.patch`] = md5(PATCH);
  const h = harness(s);
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 0);
    assert.deepEqual(h.writes(), ['securityagent start-code-review-job']);
    assert.match(h.out(), /is already up to date; upload skipped/);
  } finally { h.cleanup(); }
});

test('an empty diff starts nothing', async () => {
  const h = harness(state(), { patch: '' });
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 0);
    assert.match(h.out(), /No changes against origin\/main; nothing to review\./);
    assert.deepEqual(h.writes(), []);
  } finally { h.cleanup(); }
});

test('no upstream and no default branch: suggests --full', async () => {
  const h = harness(state(), { upstream: false });
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 1);
    assert.match(h.out(), /review the whole repo with --full/);
  } finally { h.cleanup(); }
});

test('--fail-on: exits 1 at or above the level, 0 below it; a bad level is refused', async () => {
  for (const [level, code] of [['critical', 1], ['high', 1], ['low', 1]] as const) {
    const h = harness(state());
    try { assert.equal(await securityCodeReview(cr({ failOn: level }), h.deps), code, level); } finally { h.cleanup(); }
  }
  const only = state({ findings: [{ findingId: 'f2', name: 'Verbose error', riskLevel: 'LOW' }] });
  const h = harness(only);
  try { assert.equal(await securityCodeReview(cr({ failOn: 'medium' }), h.deps), 0); } finally { h.cleanup(); }
  const h2 = harness(state());
  try {
    assert.equal(await securityCodeReview(cr({ failOn: 'severe' }), h2.deps), 1);
    assert.match(h2.out(), /--fail-on must be one of: critical, high, medium, low/);
    assert.equal(h2.calls.length, 0);
  } finally { h2.cleanup(); }
});

test('--no-wait starts the job, prints its id and exits 0 without polling', async () => {
  const h = harness(state());
  try {
    assert.equal(await securityCodeReview(cr({ wait: false }), h.deps), 0);
    assert.match(h.out(), /Started job job-1/);
    assert.match(h.out(), /prism-cli security findings --job job-1/);
    assert.equal(h.sleeps.length, 0);
    assert.ok(!h.calls.some((c) => c[1] === 'batch-get-code-review-jobs'));
  } finally { h.cleanup(); }
});

test('--json prints only the result JSON on stdout; progress goes to stderr', async () => {
  const h = harness(state());
  try {
    assert.equal(await securityCodeReview(cr({ json: true }), h.deps), 0);
    assert.deepEqual(h.lines, []);
    assert.equal(h.outs.length, 1);
    const r = JSON.parse(h.outs[0]);
    assert.equal(r.kind, 'security-review');
    assert.equal(r.findings.length, 3);
    assert.equal(h.errs[0], CODE_REVIEW_NOTICE);
  } finally { h.cleanup(); }
});

test('missing setup: no marker and no SSM says to run enable security first', async () => {
  const s = state(); s.params = { '/prism/continuum/scan-bucket': BUCKET };
  const h = harness(s, { marker: false });
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 1);
    assert.match(h.out(), /Error: No Security Agent code review for github\.com\/acme\/widgets in account 111122223333, region us-west-2: run prism-cli enable security first\./);
    assert.deepEqual(h.writes(), []);
  } finally { h.cleanup(); }
});

test('without a marker the SSM parameters are used', async () => {
  const h = harness(state(), { marker: false });
  try {
    assert.equal(await securityCodeReview(cr({ wait: false }), h.deps), 0);
    assert.match(h.out(), /Code review: cr-1 \(from SSM \/prism\/continuum\/code-review-id\/github\.com-acme-widgets\)/);
  } finally { h.cleanup(); }
});

// --------------------------------------------------------------- findings

test('findings: the latest job by default, read-only, cached for the dashboard', async () => {
  const s = state({ jobs: [
    { codeReviewJobId: 'job-old', status: 'COMPLETED', createdAt: '2026-11-01T00:00:00Z' },
    { codeReviewJobId: 'job-new', status: 'COMPLETED', createdAt: '2026-11-07T00:00:00Z' },
  ] });
  const h = harness(s);
  try {
    assert.equal(await securityFindings(fo(), h.deps), 0);
    assert.match(h.lines[0], /^Read-only \(security findings\)/);
    assert.match(h.out(), /Job: {9}job-new/);
    assert.deepEqual(h.writes(), []);
    const [r] = h.results();
    assert.equal(r.security.job_id, 'job-new');
    assert.equal(r.security.scope, 'unknown');
  } finally { h.cleanup(); }
});

test('findings --severity hides lower levels and says how many', async () => {
  const h = harness(state({ jobs: [{ codeReviewJobId: 'job-1', status: 'COMPLETED', createdAt: '2026-11-07T00:00:00Z' }] }));
  try {
    assert.equal(await securityFindings(fo({ severity: 'high' }), h.deps), 0);
    assert.match(h.out(), /CRITICAL \(1\)/);
    assert.doesNotMatch(h.out(), /^LOW \(1\)/m);
    assert.match(h.out(), /\(1 below high not shown; 3 findings/);
  } finally { h.cleanup(); }
});

test('findings --job while still running: says so (exit 2); --wait polls to the end', async () => {
  const h = harness(state({ statuses: ['IN_PROGRESS'] }));
  try {
    assert.equal(await securityFindings(fo({ job: 'job-9' }), h.deps), 2);
    assert.match(h.out(), /The job is still IN_PROGRESS\. Re-run with --wait/);
    assert.equal(h.results().length, 0);
  } finally { h.cleanup(); }
  const h2 = harness(state({ statuses: ['IN_PROGRESS', 'IN_PROGRESS', 'COMPLETED'] }));
  try {
    assert.equal(await securityFindings(fo({ job: 'job-9', wait: true }), h2.deps), 0);
    assert.deepEqual(h2.sleeps, [10_000, 20_000]);
    assert.equal(h2.results()[0].security.job_id, 'job-9');
    assert.deepEqual(h2.writes(), []);
  } finally { h2.cleanup(); }
});

test('findings with no jobs points to code-review', async () => {
  const h = harness(state());
  try {
    assert.equal(await securityFindings(fo(), h.deps), 0);
    assert.match(h.out(), /No code review jobs yet for github\.com\/acme\/widgets\. Start one with: prism-cli security code-review/);
  } finally { h.cleanup(); }
});

// --------------------------------------------------------------- dashboard

function result(job: string, scope: 'diff' | 'full' | 'unknown', at: string, findings: any[] = []): PrismResult {
  return {
    schema_version: 1, kind: 'security-review', hook: 'manual', status: findings.length ? 'findings' : 'ok', tool: 'security-agent',
    tool_version: null, model: null, commit: TIP, tree: null, branch: 'work', upstream: 'origin/main', base: BASE,
    started_at: at, finished_at: at, findings, summary: null, score: null, reason: null,
    security: { job_id: job, code_review_id: 'cr-1', agent_space_id: 'as-1', region: REGION, scope, job_status: 'COMPLETED', counts: { CRITICAL: 0, HIGH: findings.length, MEDIUM: 0, LOW: 0 } },
  };
}

test('dashboard: the latest job per repo with counts and findings; a scoped copy beats the fetched one', () => {
  const f = { severity: 'high', category: 'security', rule: 'CWE-89', file: 'src/a.ts', line: 3, message: 'm', risk_level: 'HIGH', title: 'SQL injection', cwe: 'CWE-89' };
  const rs = [result('job-1', 'diff', '2026-11-01T00:00:00Z'), result('job-2', 'unknown', '2026-11-07T00:00:00Z', [f]), result('job-2', 'diff', '2026-11-07T00:00:00Z', [f])];
  assert.equal(latestSecurityReview(rs)!.security!.scope, 'diff');
  const panel = collectSecurity([{ name: 'widgets', path: '/r/w', current: true }, { name: 'empty', path: '/r/e', current: false }], (p) => (p === '/r/w' ? rs : []));
  assert.equal(panel.repos.length, 1);
  assert.deepEqual({ job: panel.repos[0].job_id, scope: panel.repos[0].scope, high: panel.repos[0].counts.HIGH }, { job: 'job-2', scope: 'diff', high: 1 });
  assert.deepEqual(panel.repos[0].findings, [{ risk_level: 'HIGH', title: 'SQL injection', file: 'src/a.ts', line: 3, cwe: 'CWE-89' }]);
  assert.equal(collectSecurity([{ name: 'x', path: '/x', current: false }], () => []).hint, 'prism-cli security code-review');
});

test('the codewatch panel ignores security-review results', () => {
  const repo = mkdtempSync(join(tmpdir(), 'prism-scr-cw-'));
  try {
    mkdirSync(join(repo, '.prism', 'results'), { recursive: true });
    writeFileSync(join(repo, '.prism', 'results', 'x-security-review.json'), JSON.stringify(result('job-1', 'diff', '2026-11-01T00:00:00Z')));
    const cw = collectCodewatch(repo);
    assert.equal(cw.hasResults, false);
    assert.equal(cw.trend.length, 0);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// --------------------------------------------------------------- repo selection (--path)

test('repo root: the working directory must be the top level; --path must be a top level', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'prism-scr-out-'));
  const links = mkdtempSync(join(tmpdir(), 'prism-scr-link-'));
  const h = harness(state());
  const sub = join(h.repo, 'src'); mkdirSync(sub);
  const link = join(links, 'repo-link'); symlinkSync(h.repo, link);
  const top = realpathSync(h.repo);
  const git = h.deps.git;
  const at = (cwd: string) => ({ git, cwd: () => cwd });
  try {
    // root OK
    assert.equal(resolveRepoRoot(at(h.repo)), top);
    // subdirectory
    assert.throws(() => resolveRepoRoot(at(sub)), (e: any) => e.message === `run from the repository root (${top}) or pass --path <repo>`);
    // not a repo
    assert.throws(() => resolveRepoRoot(at(outside)), (e: any) => e.message === 'not a git repository; cd into one or pass --path <repo>');
    // --path to the root, from anywhere
    assert.equal(resolveRepoRoot(at(outside), h.repo), top);
    // --path to a subdirectory names the real top level
    assert.throws(() => resolveRepoRoot(at(outside), sub), new RegExp(`--path ${sub} is not the top level of its repository; the top level is ${top}\\.`));
    // --path to a non-repo
    assert.throws(() => resolveRepoRoot(at(h.repo), outside), new RegExp(`--path ${outside} is not a git repository\\.`));
    // a symlinked root is fine, as cwd and as --path
    assert.equal(resolveRepoRoot(at(link)), top);
    assert.equal(resolveRepoRoot(at(outside), link), top);
  } finally { h.cleanup(); rmSync(outside, { recursive: true, force: true }); rmSync(links, { recursive: true, force: true }); }
});

test('the commands refuse a subdirectory with an Error line and make no AWS write', async () => {
  const h = harness(state(), { cwd: (repo) => { const d = join(repo, 'src'); mkdirSync(d, { recursive: true }); return d; } });
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 1);
    assert.match(h.out(), /Error: run from the repository root \(.*\) or pass --path <repo>/);
    assert.deepEqual(h.writes(), []);
    assert.equal(await securityFindings(fo(), h.deps), 1);
  } finally { h.cleanup(); }
});

test('--path from outside the repo works, uses -C <root> for git and writes results under the root', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'prism-scr-out-'));
  const h = harness(state(), { cwd: () => outside });
  try {
    assert.equal(await securityCodeReview(cr({ path: h.repo }), h.deps), 0);
    const top = realpathSync(h.repo);
    assert.ok(h.gitCalls.every((g) => g[0] === '-C'), 'every git call is -C');
    assert.ok(h.gitCalls.filter((g) => !g.includes('--show-toplevel')).every((g) => g[1] === top), 'all later calls at the root');
    assert.equal(h.results().length, 1);
    assert.deepEqual(readdirSync(outside), [], 'nothing written in the working directory');
  } finally { h.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test('a wrong directory is refused before the notice, the region lookup and any AWS call', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'prism-scr-out-'));
  try {
    for (const where of ['subdir', 'not-a-repo', 'path-subdir', 'path-not-a-repo'] as const) {
      for (const run of ['code-review', 'findings'] as const) {
        const h = harness(state(), { cwd: (repo) => {
          if (where === 'subdir') { const d = join(repo, 'src'); mkdirSync(d, { recursive: true }); return d; }
          return where === 'not-a-repo' ? outside : repo;
        } });
        let regionLookups = 0; let versionChecks = 0;
        h.deps.configRegion = () => { regionLookups++; return null; };
        h.deps.awsVersion = () => { versionChecks++; return 'aws-cli/2.36.19'; };
        const path = where === 'path-subdir' ? (() => { const d = join(h.repo, 'lib'); mkdirSync(d, { recursive: true }); return d; })()
          : where === 'path-not-a-repo' ? outside : undefined;
        try {
          const code = run === 'code-review' ? await securityCodeReview(cr({ path }), h.deps) : await securityFindings(fo({ path }), h.deps);
          assert.equal(code, 1, `${where} ${run}`);
          assert.equal(h.calls.length, 0, `${where} ${run}: no AWS call`);
          assert.equal(regionLookups + versionChecks, 0, `${where} ${run}: no region or CLI lookup`);
          assert.equal(h.lines.length, 1, `${where} ${run}: only the Error line, got ${JSON.stringify(h.lines)}`);
          assert.match(h.lines[0], /^Error: /);
        } finally { h.cleanup(); }
      }
    }
  } finally { rmSync(outside, { recursive: true, force: true }); }
});
