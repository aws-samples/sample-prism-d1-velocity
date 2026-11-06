import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AwsResult } from '../src/utils/aws.js';
import {
  CODE_REVIEW_NOTICE, pendingResult, POLL_FIRST_MS, POLL_MAX_MS, POLL_RETRIES, repoRelative, resolveRepoRoot, RETRY_FIRST_MS, securityCodeReview, securityFindings,
  type CodeReviewOptions, type FindingsOptions, type ReviewDeps,
} from '../src/security/review.js';
import { collectSecurity, latestSecurityReview } from '../src/dashboard/security.js';
import { collectCodewatch } from '../src/dashboard/codewatch.js';
import { MARKER_PATH } from '../src/security/marker.js';
import { writeResult, type PrismResult } from '../src/codewatch/results.js';
import { renderPage } from '../src/dashboard/page.js';

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
  /** Raw CLI errors returned by the next batch-get-code-review-jobs calls, before any status. */
  pollErrors?: string[];
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

function harness(s: State, o: { tracked?: boolean; sandbox?: boolean; cwd?: (repo: string) => string; tty?: boolean; marker?: boolean; upstream?: boolean; patch?: string; interruptOnSleep?: number } = {}): H {
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
          if (s.pollErrors?.length) return fail('', s.pollErrors.shift()!);
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
          return ok({ findings: ids.map((id) => ({ findingId: id, description: `Details of ${id}. More text.`, codeLocations: [{ filePath: `${o.sandbox ? '/tmp/opt/source_code/code_sc-ab12cd/' : ''}src/${id}.ts`, lineStart: 7 }] })) });
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
      if (has('ls-files')) return { ok: !!o.tracked, stdout: '', stderr: o.tracked ? '' : 'error: pathspec did not match' };
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
    assert.deepEqual(h.writes(), ['s3api put-object', 's3api put-object', 'securityagent start-code-review-job']);
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
    assert.deepEqual({ ...r.security, counts: undefined }, {
      job_id: 'job-1', code_review_id: 'cr-1', agent_space_id: 'as-1', region: REGION, account: ACCOUNT, scope: 'diff', context_commit: TIP, job_status: 'COMPLETED', counts: undefined,
      service_created_at: '2026-11-07T10:00:00Z', service_updated_at: '2026-11-07T10:05:00Z', service_duration_s: 300, wall_s: 10,
    });
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
    const rs = h.results();
    assert.equal(rs.length, 1, 'only the pending record');
    assert.equal(rs[0].status, 'pending');
    assert.equal(rs[0].security.job_id, 'job-1');
  } finally { h.cleanup(); }
});

test('code-review: Ctrl-C stops waiting, leaves the job running, exits 130', async () => {
  const h = harness(state({ statuses: ['IN_PROGRESS'] }), { interruptOnSleep: 2 });
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 130);
    assert.match(h.out(), /Stopped waiting\. The job keeps running in AWS\. Fetch its results later with: prism-cli security findings --job job-1/);
    assert.equal(h.calls.filter((c) => c[1] === 'batch-get-code-review-jobs').length, 1, 'no poll after Ctrl-C');
    assert.deepEqual(h.writes(), ['s3api put-object', 's3api put-object', 'securityagent start-code-review-job'], 'nothing stops or cancels the job');
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

test('an identical snapshot skips the upload (patch and review context)', async () => {
  const s = state();
  s.objects[`diffs/${SLUG}/local/${TIP.slice(0, 12)}-${BASE.slice(0, 12)}.patch`] = md5(PATCH);
  s.objects[`repo/${SLUG}/latest.zip`] = md5(ZIP);
  const h = harness(s);
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 0);
    assert.deepEqual(h.writes(), ['securityagent start-code-review-job']);
    assert.match(h.out(), /patch is already up to date; upload skipped/);
    assert.match(h.out(), /Review context: s3:\/\/.*\/latest\.zip is already HEAD aaaaaaaaaaaa; upload skipped/);
  } finally { h.cleanup(); }
});

test('a diff job refreshes the review context (latest.zip) to HEAD first and records context_commit', async () => {
  const s = state(); s.objects[`repo/${SLUG}/latest.zip`] = md5('stale zip of an older commit');
  const h = harness(s);
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 0);
    const puts = h.calls.filter((c) => c[1] === 'put-object').map((c) => arg(c, '--key'));
    assert.deepEqual(puts, [`repo/${SLUG}/latest.zip`, `diffs/${SLUG}/local/${TIP.slice(0, 12)}-${BASE.slice(0, 12)}.patch`]);
    assert.equal(s.objects[`repo/${SLUG}/latest.zip`], md5(ZIP), 'context is HEAD now');
    const putAt = h.calls.findIndex((c) => c[1] === 'put-object');
    assert.ok(putAt < h.calls.findIndex((c) => c[1] === 'start-code-review-job'), 'refreshed before the job starts');
    assert.ok(h.gitCalls.some((g) => g.includes('archive') && g.includes('HEAD')));
    assert.match(h.out(), /Review context: updated s3:\/\/.*\/repo\/github\.com-acme-widgets\/latest\.zip to HEAD aaaaaaaaaaaa/);
    const [r] = h.results();
    assert.equal(r.security.scope, 'diff');
    assert.equal(r.security.context_commit, TIP);
  } finally { h.cleanup(); }
});

test('context_commit: kept when findings completes a pending record, null for a job fetched without one', async () => {
  const h = harness(state({ jobs: [{ codeReviewJobId: 'job-api', status: 'COMPLETED', createdAt: '2026-11-08T00:00:00Z' }] }));
  try {
    assert.equal(await securityCodeReview(cr({ wait: false }), h.deps), 0);
    assert.equal(h.results()[0].security.context_commit, TIP, 'pending records it');
    assert.equal(await securityFindings(fo(), h.deps), 0);
    assert.equal(h.results()[0].security.context_commit, TIP);
  } finally { h.cleanup(); }
  const h2 = harness(state({ jobs: [{ codeReviewJobId: 'job-api', status: 'COMPLETED', createdAt: '2026-11-08T00:00:00Z' }] }));
  try {
    assert.equal(await securityFindings(fo(), h2.deps), 0);
    assert.equal(h2.results()[0].security.context_commit, null);
  } finally { h2.cleanup(); }
});

test('an empty diff starts nothing', async () => {
  const h = harness(state(), { patch: '' });
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 0);
    assert.match(h.out(), /No changes against origin\/main; nothing to review\./);
    assert.deepEqual(h.writes(), []);
    assert.ok(!h.gitCalls.some((g) => g.includes('archive')), 'no context zip for an empty diff');
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

// --------------------------------------------------------------- which code review (SSM is the source of truth)

const REVIEW_PARAM = `/prism/continuum/code-review-id/${SLUG}`;
function marker(repo: string, over: Record<string, string> = {}) {
  mkdirSync(join(repo, '.prism'), { recursive: true });
  writeFileSync(join(repo, MARKER_PATH), JSON.stringify({ agentSpaceId: 'as-1', applicationId: 'app-1', codeReviewId: 'cr-1', region: REGION, account: ACCOUNT, setupAt: '2026-11-06T00:00:00Z', ...over }));
}

test('the legacy security block in .prism/config.json is never used', async () => {
  const s = state(); delete s.params[REVIEW_PARAM];
  const h = harness(s, { marker: false });
  mkdirSync(join(h.repo, '.prism'), { recursive: true });
  writeFileSync(join(h.repo, '.prism/config.json'), JSON.stringify({ security: { agentSpaceId: 'as-evil', applicationId: 'a', codeReviewId: 'cr-evil', region: REGION, account: ACCOUNT, setupAt: 'x' } }));
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 1);
    assert.match(h.out(), /run prism-cli enable security first/);
    assert.ok(!h.calls.flat().some((a) => /evil/.test(a)));
    assert.deepEqual(h.writes(), []);
  } finally { h.cleanup(); }
});

test('a marker git tracks is ignored, even with SSM empty', async () => {
  const s = state(); delete s.params[REVIEW_PARAM];
  const h = harness(s, { tracked: true });
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 1);
    assert.match(h.out(), /Warning: ignoring \.prism\/security\.local\.json because git tracks it/);
    assert.match(h.out(), /run prism-cli enable security first/);
    assert.deepEqual(h.writes(), []);
  } finally { h.cleanup(); }
});

test('SSM and the marker disagree: SSM wins, with a warning', async () => {
  const h = harness(state(), { marker: false });
  marker(h.repo, { agentSpaceId: 'as-other', codeReviewId: 'cr-other' });
  try {
    assert.equal(await securityCodeReview(cr({ wait: false }), h.deps), 0);
    assert.match(h.out(), /Warning: \.prism\/security\.local\.json names agent space as-other and code review cr-other, but SSM says as-1 and cr-1; using SSM/);
    const start = h.calls.find((c) => c[1] === 'start-code-review-job')!;
    assert.deepEqual([arg(start, '--agent-space-id'), arg(start, '--code-review-id')], ['as-1', 'cr-1']);
  } finally { h.cleanup(); }
});

test('an untracked marker is the fallback when SSM has no code review, and says so', async () => {
  const s = state(); delete s.params[REVIEW_PARAM];
  const h = harness(s, { marker: false });
  marker(h.repo, { codeReviewId: 'cr-local' });
  try {
    assert.equal(await securityCodeReview(cr({ wait: false }), h.deps), 0);
    assert.match(h.out(), /Note: SSM has no \/prism\/continuum\/code-review-id\/github\.com-acme-widgets; using the IDs from the local marker \.prism\/security\.local\.json\./);
    assert.match(h.out(), /Code review: cr-local \(from local marker/);
    assert.equal(arg(h.calls.find((c) => c[1] === 'start-code-review-job')!, '--code-review-id'), 'cr-local');
  } finally { h.cleanup(); }
});

test('findings use the same rule (SSM wins over the marker)', async () => {
  const h = harness(state({ jobs: [{ codeReviewJobId: 'job-1', status: 'COMPLETED', createdAt: '2026-11-07T00:00:00Z' }] }), { marker: false });
  marker(h.repo, { codeReviewId: 'cr-other' });
  try {
    assert.equal(await securityFindings(fo(), h.deps), 0);
    assert.equal(arg(h.calls.find((c) => c[1] === 'list-code-review-jobs-for-code-review')!, '--code-review-id'), 'cr-1');
  } finally { h.cleanup(); }
});

// --------------------------------------------------------------- paths and timing

test('service sandbox paths are shown repo-relative; the raw path is kept', async () => {
  const h = harness(state(), { sandbox: true });
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 0);
    assert.match(h.out(), / {2}Hardcoded key {2}src\/f3\.ts:7/);
    assert.doesNotMatch(h.out(), /source_code/);
    const f = h.results()[0].findings[0];
    assert.equal(f.file, 'src/f3.ts');
    assert.equal(f.raw_file, '/tmp/opt/source_code/code_sc-ab12cd/src/f3.ts');
    const panel = collectSecurity([{ name: 'w', path: h.repo, current: true }]);
    assert.equal(panel.repos[0].findings[0].file, 'src/f3.ts');
  } finally { h.cleanup(); }
});

test('repoRelative strips the sandbox prefix, the repo root and leading ./ or /', () => {
  assert.equal(repoRelative('/tmp/opt/source_code/code_sc-9f/cli/src/security/review.ts'), 'cli/src/security/review.ts');
  assert.equal(repoRelative('/work/repo/src/a.ts', '/work/repo'), 'src/a.ts');
  assert.equal(repoRelative('./src/a.ts'), 'src/a.ts');
  assert.equal(repoRelative('src/a.ts'), 'src/a.ts');
});

test('service duration and our wall time are both recorded and printed', async () => {
  const h = harness(state({ statuses: ['IN_PROGRESS', 'COMPLETED'] }));
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 0);
    const sec = h.results()[0].security;
    assert.equal(sec.service_duration_s, 300);
    assert.equal(sec.wall_s, 30);
    assert.match(h.out(), /Finished in 30s here; the service reports 300s from job creation to its last update\./);
  } finally { h.cleanup(); }
});

// --------------------------------------------------------------- pending records (a lost wait loses nothing)

const SETUP = { agentSpaceId: 'as-1', codeReviewId: 'cr-1', source: 'test' };
function writePending(repo: string, job: string, startedAt: string, account = ACCOUNT): void {
  writeResult(repo, pendingResult({ setup: SETUP, region: REGION, account, scope: 'full', tip: 'c'.repeat(40), startedAt, job: { codeReviewJobId: job, status: 'IN_PROGRESS' } }));
}

test('code-review --no-wait writes a pending record with the job, scope and commits', async () => {
  const h = harness(state());
  try {
    assert.equal(await securityCodeReview(cr({ wait: false }), h.deps), 0);
    const rs = h.results();
    assert.equal(rs.length, 1);
    const [r] = rs;
    assert.equal(r.status, 'pending');
    assert.deepEqual([r.commit, r.base, r.branch, r.upstream, r.started_at], [TIP, BASE, 'work', 'origin/main', '2026-11-07T10:00:00.000Z']);
    assert.deepEqual([r.security.job_id, r.security.code_review_id, r.security.agent_space_id, r.security.region, r.security.account, r.security.scope, r.security.job_status],
      ['job-1', 'cr-1', 'as-1', REGION, ACCOUNT, 'diff', 'IN_PROGRESS']);
    assert.match(h.out(), /Saved .*\(pending\)/);
  } finally { h.cleanup(); }
});

test('Ctrl-C leaves the pending record; a completed wait rewrites the same file', async () => {
  const h = harness(state({ statuses: ['IN_PROGRESS'] }), { interruptOnSleep: 1 });
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 130);
    assert.deepEqual(h.results().map((r) => r.status), ['pending']);
  } finally { h.cleanup(); }
  const h2 = harness(state({ statuses: ['IN_PROGRESS', 'COMPLETED'] }));
  try {
    assert.equal(await securityCodeReview(cr(), h2.deps), 0);
    assert.deepEqual(h2.results().map((r) => r.status), ['findings'], 'one file, completed in place');
  } finally { h2.cleanup(); }
});

test('findings with no --job completes the pending record and keeps its scope and commits', async () => {
  const h = harness(state({ statuses: ['COMPLETED'], jobs: [{ codeReviewJobId: 'job-api', status: 'COMPLETED', createdAt: '2026-11-08T00:00:00Z' }] }));
  try {
    assert.equal(await securityCodeReview(cr({ wait: false }), h.deps), 0);
    h.lines.length = 0;
    assert.equal(await securityFindings(fo(), h.deps), 0);
    assert.ok(!h.calls.some((c) => c[1] === 'list-code-review-jobs-for-code-review'), 'pending first; no API latest');
    assert.match(h.out(), /Pending: {5}recorded by code-review at 2026-11-07T10:00:00\.000Z \(origin\/main\.\.\.aaaaaaaaaaaa\)/);
    const rs = h.results();
    assert.equal(rs.length, 1, 'no second file');
    const [r] = rs;
    assert.equal(r.status, 'findings');
    assert.equal(r.findings.length, 3);
    assert.deepEqual([r.security.job_id, r.security.scope, r.commit, r.base, r.upstream, r.started_at], ['job-1', 'diff', TIP, BASE, 'origin/main', '2026-11-07T10:00:00.000Z']);
    assert.deepEqual(h.writes(), ['s3api put-object', 's3api put-object', 'securityagent start-code-review-job'], 'findings itself writes nothing in AWS');
  } finally { h.cleanup(); }
});

test('findings on a pending job that is still running says so (exit 2) and keeps the record', async () => {
  const h = harness(state({ statuses: ['IN_PROGRESS'] }));
  try {
    assert.equal(await securityCodeReview(cr({ wait: false }), h.deps), 0);
    assert.equal(await securityFindings(fo(), h.deps), 2);
    assert.match(h.out(), /The job is still IN_PROGRESS\. Re-run with --wait/);
    assert.deepEqual(h.results().map((r) => r.status), ['pending']);
  } finally { h.cleanup(); }
});

test('findings picks the newest pending, names the older ones, and ignores another account', async () => {
  const h = harness(state());
  try {
    writePending(h.repo, 'job-old', '2026-11-06T09:00:00.000Z');
    writePending(h.repo, 'job-new', '2026-11-07T09:00:00.000Z');
    writePending(h.repo, 'job-other', '2026-11-08T09:00:00.000Z', '999988887777');
    assert.equal(await securityFindings(fo(), h.deps), 0);
    assert.match(h.out(), /Job: {9}job-new/);
    assert.match(h.out(), /Also pending: job-old \(started 2026-11-06T09:00:00\.000Z\)\. Fetch one with --job <id>\./);
    const by = Object.fromEntries(h.results().map((r) => [r.security.job_id, r]));
    assert.equal(by['job-new'].status, 'findings');
    assert.equal(by['job-new'].security.scope, 'full');
    assert.equal(by['job-old'].status, 'pending');
    assert.equal(by['job-other'].status, 'pending');
    assert.equal(h.results().length, 3);
  } finally { h.cleanup(); }
});

test('findings --job <id> completes that pending record; a FAILED job records the error in place', async () => {
  const h = harness(state());
  try {
    writePending(h.repo, 'job-old', '2026-11-06T09:00:00.000Z');
    writePending(h.repo, 'job-new', '2026-11-07T09:00:00.000Z');
    assert.equal(await securityFindings(fo({ job: 'job-old' }), h.deps), 0);
    const by = Object.fromEntries(h.results().map((r) => [r.security.job_id, r]));
    assert.equal(by['job-old'].status, 'findings');
    assert.equal(by['job-old'].security.scope, 'full');
    assert.equal(by['job-new'].status, 'pending');
  } finally { h.cleanup(); }
  const h2 = harness(state({ statuses: ['FAILED'], failReason: 'boom' }));
  try {
    writePending(h2.repo, 'job-x', '2026-11-07T09:00:00.000Z');
    assert.equal(await securityFindings(fo(), h2.deps), 1);
    const [r] = h2.results();
    assert.deepEqual([r.status, r.security.job_status, r.security.scope, h2.results().length], ['error', 'FAILED', 'full', 1]);
  } finally { h2.cleanup(); }
});

test('poll: a transient AWS CLI failure is retried with backoff and recovers', async () => {
  const s = state({ statuses: ['IN_PROGRESS', 'COMPLETED'], pollErrors: [
    'An error occurred (ThrottlingException) when calling the BatchGetCodeReviewJobs operation: Rate exceeded',
    'Could not connect to the endpoint URL: "https://securityagent.us-west-2.amazonaws.com/"',
  ] });
  const h = harness(s);
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 0);
    assert.deepEqual(h.sleeps, [POLL_FIRST_MS, RETRY_FIRST_MS, 2 * RETRY_FIRST_MS, 20_000]);
    assert.match(h.out(), /Poll failed: aws securityagent batch-get-code-review-jobs failed: .*Rate exceeded; retrying in 2s \(1\/3\)/);
    assert.match(h.out(), /retrying in 4s \(2\/3\)/);
    assert.deepEqual(h.results().map((r) => r.status), ['findings']);
  } finally { h.cleanup(); }
});

test('poll: a permanent failure prints the Error line and the fetch-later hint; the pending record stays', async () => {
  const net = 'Could not connect to the endpoint URL: "https://securityagent.us-west-2.amazonaws.com/"';
  const h = harness(state({ statuses: ['IN_PROGRESS'], pollErrors: [net, net, net, net] }));
  try {
    assert.equal(await securityCodeReview(cr(), h.deps), 1);
    assert.deepEqual(h.sleeps, [POLL_FIRST_MS, 2_000, 4_000, 8_000], `${POLL_RETRIES} retries`);
    assert.match(h.out(), /Error: aws securityagent batch-get-code-review-jobs failed: Could not connect.* \(after 3 retries\)\nThe job keeps running in AWS\. Fetch its results later with: prism-cli security findings --job job-1/);
    assert.deepEqual(h.results().map((r) => r.status), ['pending']);
  } finally { h.cleanup(); }
  // AccessDenied is not retried.
  const denied = 'An error occurred (AccessDeniedException) when calling the BatchGetCodeReviewJobs operation: User is not authorized to perform: securityagent:BatchGetCodeReviewJobs';
  const h2 = harness(state({ statuses: ['IN_PROGRESS'], pollErrors: [denied] }));
  try {
    assert.equal(await securityCodeReview(cr(), h2.deps), 1);
    assert.deepEqual(h2.sleeps, [POLL_FIRST_MS]);
    assert.match(h2.out(), /AccessDenied: BatchGetCodeReviewJobs[\s\S]*Fetch its results later with: prism-cli security findings --job job-1/);
    assert.deepEqual(h2.results().map((r) => r.status), ['pending']);
  } finally { h2.cleanup(); }
});

test('dashboard: a pending repo shows review running with its start time, stale? after 2h', () => {
  const pending = (at: string): PrismResult => ({ ...result('job-p', 'diff', at), status: 'pending', security: { ...result('job-p', 'diff', at).security!, job_status: 'IN_PROGRESS', counts: {} } });
  const now = new Date('2026-11-07T12:00:00Z');
  const fresh = collectSecurity([{ name: 'w', path: '/w', current: true }], () => [pending('2026-11-07T11:00:00Z')], now).repos[0];
  assert.deepEqual([fresh.pending, fresh.stale, fresh.started_at], [true, false, '2026-11-07T11:00:00Z']);
  const old = collectSecurity([{ name: 'w', path: '/w', current: true }], () => [pending('2026-11-07T09:59:00Z')], now);
  assert.deepEqual([old.repos[0].pending, old.repos[0].stale, old.pending_hint], [true, true, 'prism-cli security findings']);
  // A verdict for the same job beats its pending copy.
  const done = collectSecurity([{ name: 'w', path: '/w', current: true }], () => [pending('2026-11-07T11:00:00Z'), result('job-p', 'unknown', '2026-11-07T11:00:00Z')], now).repos[0];
  assert.equal(done.pending, false);
  const html = renderPage('NONCE');
  const panel = html.slice(html.indexOf('function securityPanel(sec) {'), html.indexOf('async function load() {'));
  assert.match(panel, /pill\('warn', 'review running'\)/);
  assert.match(panel, /pill\('skipped', 'stale\?'\)/);
  assert.match(panel, /'started ' \+ when\(r\.started_at\)/);
  assert.match(panel, /sec\.pending_hint/);
});
