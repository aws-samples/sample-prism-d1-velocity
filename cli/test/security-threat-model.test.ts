import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AwsResult } from '../src/utils/aws.js';
import { POLL_FIRST_MS, type ReviewDeps } from '../src/security/review.js';
import {
  DEFAULT_TM_TIMEOUT_MIN, docLimitWarnings, firstParagraph, securityThreatModel, securityThreats, strideLabel, THREAT_MODEL_NOTICE, TINY_DOCS_BYTES, tinyDocsHint, titlePrefix,
  type ThreatModelOptions, type ThreatsOptions,
} from '../src/security/threat-model.js';
import { collectSecurity } from '../src/dashboard/security.js';
import { collectCodewatch } from '../src/dashboard/codewatch.js';
import { writeResult, type PrismResult } from '../src/codewatch/results.js';
import { renderPage } from '../src/dashboard/page.js';

// ---------------------------------------------------------------------------
// A fake AWS account and a fake git repo whose HEAD tree is a map.
// ---------------------------------------------------------------------------
const ACCOUNT = '111122223333';
const REGION = 'us-west-2';
const BUCKET = `security-agent-scans-${ACCOUNT}-${REGION}`;
const SLUG = 'github.com-acme-widgets';
const TIP = 'a'.repeat(40);
const ROLE = `arn:aws:iam::${ACCOUNT}:role/prism-d1-security-agent-prism-d1-security`;
const ZIP = 'fake zip';
const OVERVIEW = '# System overview\n\n## Purpose\nWidgets is a small API\nthat stores widgets.\n\nIt has three components.';

const ok = (json: unknown = {}): AwsResult => ({ ok: true, json, errorCode: '', raw: '' });
const fail = (code: string, raw: string): AwsResult => ({ ok: false, json: null, errorCode: code, raw });
const arg = (a: string[], f: string) => a[a.indexOf(f) + 1];

interface Threat { threatId: string; title: string; severity: string; stride: string[]; evidence?: string[] }
interface State {
  params: Record<string, string>;
  objects: Record<string, string>;
  /** Status of each successive batch-get-threat-model-jobs call; the last one repeats. */
  statuses: string[];
  threats: Threat[];
  error?: { code: string; message: string };
  createError?: string;
  /** awsResources.s3Buckets of agent space as-1. */
  spaceBuckets: string[];
  models: { threatModelId: string; title: string; createdAt: string }[];
  jobs: Record<string, { threatModelJobId: string; createdAt: string }[]>;
}

function state(o: Partial<State> = {}): State {
  return {
    params: { '/prism/continuum/scan-bucket': BUCKET, '/prism/continuum/agent-space-id': 'as-1', '/prism/continuum/service-role-arn': ROLE },
    objects: {}, statuses: ['COMPLETED'],
    threats: [
      { threatId: 't1', title: 'Token replay on the widget API', severity: 'HIGH', stride: ['SPOOFING'], evidence: ['/tmp/opt/source_code/code_sc-ab12/src/auth.ts', '/tmp/opt/source_code/code_sc-ab12/src/api.ts'] },
      { threatId: 't2', title: 'Unbounded upload size', severity: 'MEDIUM', stride: ['DENIAL_OF_SERVICE'] },
      { threatId: 't3', title: 'Audit log can be edited', severity: 'CRITICAL', stride: ['TAMPERING', 'REPUDIATION'], evidence: ['src/log.ts'] },
      { threatId: 't4', title: 'Version banner', severity: 'INFO', stride: ['INFORMATION_DISCLOSURE'] },
    ],
    spaceBuckets: [`arn:aws:s3:::${BUCKET}`], models: [], jobs: {}, ...o,
  };
}

/** The HEAD tree: path -> content, or a mode override for symlinks. */
type Tree = Record<string, string | { mode: string; content: string }>;
const DEFAULT_TREE: Tree = {
  'src/auth.ts': 'x', '.kiro/specs/login/design.md': '# Login design', '.kiro/specs/login/requirements.md': '# Reqs',
  '.kiro/specs/login/tasks.md': '# Tasks', 'docs/ARCH.md': '# Architecture',
};

interface H {
  deps: ReviewDeps; calls: string[][]; lines: string[]; errs: string[]; outs: string[]; sleeps: number[]; repo: string;
  out: () => string; writes: () => string[]; results: () => any[]; cleanup: () => void;
}

function harness(s: State, o: { tree?: Tree; cwd?: (repo: string) => string; interruptOnSleep?: number } = {}): H {
  const repo = mkdtempSync(join(tmpdir(), 'prism-tm-repo-'));
  const tree = o.tree ?? DEFAULT_TREE;
  const calls: string[][] = []; const lines: string[] = []; const errs: string[] = []; const outs: string[] = []; const sleeps: number[] = [];
  let clock = Date.parse('2026-11-07T10:00:00Z');
  let polls = 0; let interrupt: (() => void) | null = null;
  const entry = (p: string) => { const e = tree[p]; return e === undefined ? null : typeof e === 'string' ? { mode: '100644', content: e } : e; };
  const deps: ReviewDeps = {
    aws(a) {
      calls.push(a);
      switch (`${a[0]} ${a[1]}`) {
        case 'sts get-caller-identity': return ok({ Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Dev/me` });
        case 'iam list-account-aliases': return ok({ AccountAliases: ['acme-dev'] });
        case 'ssm get-parameter': { const v = s.params[arg(a, '--name')]; return v ? ok({ Parameter: { Value: v } }) : fail('ParameterNotFound', 'ParameterNotFound'); }
        case 's3api head-object': { const e = s.objects[arg(a, '--key')]; return e ? ok({ ETag: `"${e}"` }) : fail('404', 'An error occurred (404) when calling the HeadObject operation: Not Found'); }
        case 's3api put-object': s.objects[arg(a, '--key')] = createHash('md5').update(readFileSync(arg(a, '--body'))).digest('hex'); return ok({});
        case 'securityagent batch-get-agent-spaces':
          return ok({ agentSpaces: arg(a, '--agent-space-ids') === 'as-1' ? [{ agentSpaceId: 'as-1', name: 'prism-d1-security', awsResources: { s3Buckets: s.spaceBuckets } }] : [], notFound: [] });
        case 'securityagent create-threat-model':
          if (s.createError) return fail('', s.createError);
          return ok({ threatModelId: 'tm-1', title: arg(a, '--title') });
        case 'securityagent start-threat-model-job': return ok({ threatModelJobId: 'tmj-1', status: 'IN_PROGRESS', createdAt: '2026-11-07T10:00:00Z' });
        case 'securityagent batch-get-threat-model-jobs': {
          const st = s.statuses[Math.min(polls++, s.statuses.length - 1)];
          return ok({ threatModelJobs: [{
            threatModelJobId: arg(a, '--threat-model-job-ids'), threatModelId: 'tm-1', status: st,
            createdAt: '2026-11-07T10:00:00Z', updatedAt: '2026-11-07T10:12:00Z',
            ...(st === 'COMPLETED' ? { systemOverview: OVERVIEW } : {}),
            ...(st === 'FAILED' && s.error ? { errorInformation: s.error } : {}),
          }] });
        }
        case 'securityagent list-threats':
          return ok({ threats: s.threats.map((t) => ({ threatId: t.threatId, title: t.title, severity: t.severity, stride: t.stride, status: 'OPEN', statement: `${t.title} statement.` })) });
        case 'securityagent batch-get-threats': {
          const ids = a.slice(a.indexOf('--threat-ids') + 1);
          return ok({ threats: s.threats.filter((t) => ids.includes(t.threatId)).map((t) => ({
            threatId: t.threatId, title: t.title, severity: t.severity, stride: t.stride, status: 'OPEN', statement: `${t.title} statement.`,
            recommendation: `Fix ${t.threatId} by doing the right thing.`, evidence: (t.evidence || []).map((p) => ({ packageId: 'p', path: p })),
          })) });
        }
        case 'securityagent list-threat-models': return ok({ threatModelSummaries: s.models });
        case 'securityagent list-threat-model-jobs': return ok({ threatModelJobSummaries: s.jobs[arg(a, '--threat-model-id')] || [] });
        default: return fail('', `fake aws: unexpected ${a.join(' ')}`);
      }
    },
    configRegion: () => null,
    env: {},
    awsVersion: () => 'aws-cli/2.36.19 Python/3.14',
    cdk: { synth: () => { throw new Error('no cdk'); }, diff: () => { throw new Error('no cdk'); }, deploy: () => { throw new Error('no cdk'); } },
    git(a) {
      const has = (x: string) => a.includes(x);
      if (has('--show-toplevel')) {
        const dir = realpathSync(a[a.indexOf('-C') + 1]); const top = realpathSync(repo);
        return dir === top || dir.startsWith(top + '/') ? { ok: true, stdout: top, stderr: '' } : { ok: false, stdout: '', stderr: 'fatal: not a git repository' };
      }
      if (has('remote')) return { ok: true, stdout: 'https://github.com/acme/widgets.git', stderr: '' };
      if (has('--abbrev-ref') && has('HEAD')) return { ok: true, stdout: 'work', stderr: '' };
      if (has('rev-parse') && has('HEAD')) return { ok: true, stdout: TIP, stderr: '' };
      if (has('ls-tree') && has('-r')) {
        const dir = a[a.length - 1];
        return { ok: true, stdout: Object.keys(tree).filter((p) => p.startsWith(dir + '/')).join('\n'), stderr: '' };
      }
      if (has('ls-tree')) {
        const p = a[a.length - 1]; const e = entry(p);
        if (e) return { ok: true, stdout: `${e.mode} blob ${'f'.repeat(40)}\t${p}`, stderr: '' };
        const isDir = Object.keys(tree).some((k) => k.startsWith(p + '/'));
        return { ok: true, stdout: isDir ? `040000 tree ${'e'.repeat(40)}\t${p}` : '', stderr: '' };
      }
      if (has('show')) {
        const file = a.find((x) => x.startsWith('--output='))!.slice('--output='.length);
        const e = entry(a[a.length - 1].replace(/^HEAD:/, ''));
        if (!e) return { ok: false, stdout: '', stderr: 'fatal: path not in HEAD' };
        writeFileSync(file, e.content); return { ok: true, stdout: '', stderr: '' };
      }
      if (has('archive')) { writeFileSync(arg(a, '-o'), ZIP); return { ok: true, stdout: '', stderr: '' }; }
      if (has('cat-file')) {
        const e = entry(a[a.length - 1].replace(/^[0-9a-f]+:/, ''));
        return e ? { ok: true, stdout: String(Buffer.byteLength(e.content)), stderr: '' } : { ok: false, stdout: '', stderr: 'fatal: path not in commit' };
      }
      return { ok: false, stdout: '', stderr: `fake git: ${a.join(' ')}` };
    },
    makeTempDir: () => mkdtempSync(join(tmpdir(), 'prism-tm-tmp-')),
    isTTY: false,
    ask: async () => '',
    log: (l = '') => { lines.push(l); },
    now: () => new Date(clock),
    sleep: async (ms) => {
      sleeps.push(ms);
      if (o.interruptOnSleep === sleeps.length && interrupt) { interrupt(); return; }
      clock += ms;
    },
    onInterrupt: (h) => { interrupt = h; return () => { interrupt = null; }; },
    ticker: () => {},
    err: (l = '') => { errs.push(l); },
    out: (t) => { outs.push(t); },
    cwd: () => (o.cwd ? o.cwd(repo) : repo),
  };
  const writeVerbs = /^(create|update|put|delete|start|stop|add)-/;
  return {
    deps, calls, lines, errs, outs, sleeps, repo,
    out: () => lines.join('\n'),
    writes: () => calls.filter((c) => writeVerbs.test(c[1] || '')).map((c) => `${c[0]} ${c[1]}`),
    results: () => {
      const dir = join(repo, '.prism', 'results');
      try { return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))); } catch { return []; }
    },
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
}

const tm = (o: Partial<ThreatModelOptions> = {}): ThreatModelOptions => ({ region: REGION, ...o });
const th = (o: Partial<ThreatsOptions> = {}): ThreatsOptions => ({ region: REGION, ...o });
const PREFIX = `threat-model/${SLUG}/${TIP.slice(0, 12)}`;

// ---------------------------------------------------------------------------
// threat-model
// ---------------------------------------------------------------------------

test('threat-model: notice first, spec docs by default, uploads, create with source and scope docs, poll, threats grouped, result saved', async () => {
  const s = state({ statuses: ['IN_PROGRESS', 'IN_PROGRESS', 'COMPLETED'] });
  const h = harness(s);
  try {
    assert.equal(await securityThreatModel(tm(), h.deps), 0);
    assert.equal(h.lines[0], THREAT_MODEL_NOTICE);
    assert.deepEqual(h.writes(), ['s3api put-object', 's3api put-object', 's3api put-object', 'securityagent create-threat-model', 'securityagent start-threat-model-job']);
    assert.ok(s.objects[`${PREFIX}/source.zip`]);
    assert.ok(s.objects[`${PREFIX}/docs/.kiro/specs/login/design.md`]);
    assert.ok(s.objects[`${PREFIX}/docs/.kiro/specs/login/requirements.md`]);
    assert.equal(Object.keys(s.objects).length, 3, 'tasks.md and docs/ARCH.md are not default docs');
    const create = h.calls.find((c) => c[1] === 'create-threat-model')!;
    assert.equal(arg(create, '--service-role'), ROLE);
    assert.equal(arg(create, '--agent-space-id'), 'as-1');
    assert.match(arg(create, '--title'), /^github-com-acme-widgets-tm-aaaaaaaaaaaa-20261107T100000Z$/);
    assert.deepEqual(JSON.parse(arg(create, '--assets')), { sourceCode: [{ s3Location: `s3://${BUCKET}/${PREFIX}/source.zip` }] });
    assert.deepEqual(JSON.parse(arg(create, '--scope-docs')), [
      { s3Location: `s3://${BUCKET}/${PREFIX}/docs/.kiro/specs/login/design.md` },
      { s3Location: `s3://${BUCKET}/${PREFIX}/docs/.kiro/specs/login/requirements.md` },
    ]);
    assert.deepEqual(h.sleeps, [POLL_FIRST_MS, 20_000, 40_000]);
    const out = h.out();
    assert.match(out, /System overview:\n {2}Widgets is a small API that stores widgets\./);
    assert.match(out, /CRITICAL \(1\)\n {2}\[Tampering, Repudiation\] Audit log can be edited\n {4}Recommendation: Fix t3 by doing the right thing\.\n {4}Evidence: src\/log\.ts/);
    assert.match(out, /HIGH \(1\)\n {2}\[Spoofing\] Token replay on the widget API\n {4}Recommendation: .*\n {4}Evidence: src\/auth\.ts, src\/api\.ts/, 'sandbox prefix stripped');
    assert.match(out, /INFO \(1\)\n {2}\[Information disclosure\] Version banner/);
    assert.match(out, /STRIDE: 1 spoofing, 1 tampering, 1 repudiation, 1 information disclosure, 1 denial of service/);
    assert.match(out, /4 threats: 1 critical, 1 high, 1 medium, 0 low, 1 info/);

    const rs = h.results();
    assert.equal(rs.length, 1, 'the pending record is completed in place');
    const r = rs[0];
    assert.equal(r.kind, 'security-threat-model');
    assert.equal(r.status, 'findings');
    assert.equal(r.commit, TIP);
    assert.equal(r.branch, 'work');
    assert.equal(r.threat_model.job_id, 'tmj-1');
    assert.equal(r.threat_model.threat_model_id, 'tm-1');
    assert.equal(r.threat_model.account, ACCOUNT);
    assert.deepEqual(r.threat_model.scope_docs, ['.kiro/specs/login/design.md', '.kiro/specs/login/requirements.md']);
    assert.equal(r.threat_model.system_overview, OVERVIEW);
    assert.deepEqual(r.threat_model.counts, { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 0, INFO: 1 });
    assert.equal(r.threat_model.stride_counts.TAMPERING, 1);
    assert.equal(r.findings[0].risk_level, 'CRITICAL');
    assert.equal(r.findings[0].severity, 'high');
    assert.deepEqual(r.findings[1].evidence, ['src/auth.ts', 'src/api.ts']);
    assert.equal(r.findings[1].file, 'src/auth.ts');
    assert.equal(r.findings[3].severity, 'low', 'INFO maps to low');
  } finally { h.cleanup(); }
});

test('threat-model: --doc validated against HEAD; bad docs print one Error line and make no AWS call', async () => {
  const tree: Tree = { ...DEFAULT_TREE, 'docs/link.md': { mode: '120000', content: '../../etc/passwd' }, 'docs/data.bin': 'x' };
  const cases: [Partial<ThreatModelOptions>, RegExp][] = [
    [{ doc: ['../outside.md'] }, /--doc \.\.\/outside\.md is outside the repository/],
    [{ doc: ['/etc/passwd'] }, /is outside the repository/],
    [{ doc: ['docs/NEW.md'] }, /--doc docs\/NEW\.md is not in HEAD\. Commit it first/],
    [{ doc: ['docs/link.md'] }, /is a symlink in HEAD/],
    [{ doc: ['docs/data.bin'] }, /unsupported file type/],
    [{ doc: ['docs'] }, /unsupported file type|not a file/],
    [{ doc: ['docs/ARCH.md'], docs: false }, /--doc and --no-docs cannot be used together/],
  ];
  for (const [opts, re] of cases) {
    const h = harness(state(), { tree });
    try {
      assert.equal(await securityThreatModel(tm(opts), h.deps), 1, JSON.stringify(opts));
      assert.equal(h.lines.length, 1, `only the Error line for ${JSON.stringify(opts)}: ${h.out()}`);
      assert.match(h.lines[0], re);
      assert.equal(h.calls.length, 0, 'no AWS call');
    } finally { h.cleanup(); }
  }
});

test('threat-model: --doc from a subdirectory path, deduplicated; --no-docs sends no scope docs', async () => {
  const h = harness(state());
  try {
    assert.equal(await securityThreatModel(tm({ doc: ['docs/ARCH.md', './docs/ARCH.md'] }), h.deps), 0);
    const create = h.calls.find((c) => c[1] === 'create-threat-model')!;
    assert.deepEqual(JSON.parse(arg(create, '--scope-docs')), [{ s3Location: `s3://${BUCKET}/${PREFIX}/docs/docs/ARCH.md` }]);
  } finally { h.cleanup(); }
  const h2 = harness(state());
  try {
    assert.equal(await securityThreatModel(tm({ docs: false }), h2.deps), 0);
    const create = h2.calls.find((c) => c[1] === 'create-threat-model')!;
    assert.ok(!create.includes('--scope-docs'));
    assert.match(h2.out(), /Scope docs: {2}none \(--no-docs\); the source alone is modeled/);
    assert.deepEqual(h2.results()[0].threat_model.scope_docs, []);
  } finally { h2.cleanup(); }
});

test('threat-model: no spec files in HEAD means source only, said plainly', async () => {
  const h = harness(state(), { tree: { 'src/a.ts': 'x' } });
  try {
    assert.equal(await securityThreatModel(tm(), h.deps), 0);
    assert.match(h.out(), /no --doc and no \.kiro\/specs\/\*\/design\.md or requirements\.md in HEAD/);
  } finally { h.cleanup(); }
});

test('threat-model: identical uploads are skipped on a re-run of the same commit', async () => {
  const s = state();
  const h = harness(s);
  try { assert.equal(await securityThreatModel(tm(), h.deps), 0); } finally { h.cleanup(); }
  const h2 = harness(s);
  try {
    assert.equal(await securityThreatModel(tm(), h2.deps), 0);
    assert.deepEqual(h2.writes(), ['securityagent create-threat-model', 'securityagent start-threat-model-job']);
    assert.match(h2.out(), /source\.zip is already up to date; upload skipped/);
  } finally { h2.cleanup(); }
});

test('threat-model: --no-wait saves a pending record and prints the threats hint', async () => {
  const h = harness(state());
  try {
    assert.equal(await securityThreatModel(tm({ wait: false }), h.deps), 0);
    assert.match(h.out(), /prism-cli security threats --job tmj-1/);
    const [r] = h.results();
    assert.equal(r.status, 'pending');
    assert.equal(r.threat_model.job_status, 'IN_PROGRESS');
    assert.ok(!h.calls.some((c) => c[1] === 'batch-get-threat-model-jobs'));
  } finally { h.cleanup(); }
});

test('threat-model: Ctrl-C exits 130 and leaves the job running; the default timeout is 120 min', async () => {
  const h = harness(state({ statuses: ['IN_PROGRESS'] }), { interruptOnSleep: 2 });
  try {
    assert.equal(await securityThreatModel(tm(), h.deps), 130);
    assert.ok(!h.calls.some((c) => c[1] === 'stop-threat-model-job'));
    assert.equal(h.results()[0].status, 'pending');
  } finally { h.cleanup(); }
  assert.equal(DEFAULT_TM_TIMEOUT_MIN, 120);
  const h2 = harness(state({ statuses: ['IN_PROGRESS'] }));
  try {
    assert.equal(await securityThreatModel(tm(), h2.deps), 2);
    assert.match(h2.out(), /Timed out after 120 min/);
    assert.equal(h2.sleeps.reduce((a, b) => a + b, 0), 120 * 60_000);
  } finally { h2.cleanup(); }
});

test('threat-model: a FAILED job with a client error saves an error result and prints the unknowns hint', async () => {
  const h = harness(state({ statuses: ['FAILED'], error: { code: 'CLIENT_ERROR', message: 'Unable to access s3 location' } }));
  try {
    assert.equal(await securityThreatModel(tm(), h.deps), 1);
    const out = h.out();
    assert.match(out, /Error: job tmj-1 ended FAILED: Unable to access s3 location/);
    assert.match(out, /Try fewer or smaller --doc files, or --no-docs/);
    const rs = h.results();
    assert.equal(rs.length, 1);
    assert.equal(rs[0].status, 'error');
    assert.match(rs[0].reason, /job FAILED: Unable to access s3 location/);
  } finally { h.cleanup(); }
});

test('threat-model: create-threat-model errors get the hint, but not permission errors', async () => {
  const h = harness(state({ createError: 'An error occurred (ValidationException) when calling the CreateThreatModel operation: scopeDocs too large' }));
  try {
    assert.equal(await securityThreatModel(tm(), h.deps), 1);
    assert.match(h.out(), /create-threat-model failed: .*scopeDocs too large/);
    assert.match(h.out(), /open question Q2/);
    assert.equal(h.results().length, 0, 'no job, no record');
  } finally { h.cleanup(); }
  const h3 = harness(state({ createError: 'An error occurred (ValidationException) when calling the CreateThreatModel operation: S3 bucket not found in agent instance S3 buckets' }));
  try {
    assert.equal(await securityThreatModel(tm(), h3.deps), 1);
    assert.match(h3.out(), new RegExp(`Error: the Security Agent space doesn't list the scan bucket ${BUCKET}; run prism-cli enable security to update it\\.`));
    assert.doesNotMatch(h3.out(), /open question/);
  } finally { h3.cleanup(); }
  const h2 = harness(state({ createError: 'An error occurred (AccessDeniedException) when calling the CreateThreatModel operation: User is not authorized to perform: securityagent:CreateThreatModel' }));
  try {
    assert.equal(await securityThreatModel(tm(), h2.deps), 1);
    assert.doesNotMatch(h2.out(), /open questions/);
  } finally { h2.cleanup(); }
});

test('threat-model: an agent space that does not list the scan bucket stops before any write', async () => {
  for (const buckets of [[], ['arn:aws:s3:::some-other-bucket']]) {
    const h = harness(state({ spaceBuckets: buckets }));
    try {
      assert.equal(await securityThreatModel(tm(), h.deps), 1);
      assert.match(h.out(), new RegExp(`Error: the Security Agent space doesn't list the scan bucket ${BUCKET}; run prism-cli enable security to update it\\.`));
      assert.deepEqual(h.writes(), [], 'no upload, no create');
      assert.ok(h.calls.some((c) => c[1] === 'batch-get-agent-spaces'));
    } finally { h.cleanup(); }
  }
  const h2 = harness(state({ spaceBuckets: [BUCKET] }));
  try { assert.equal(await securityThreatModel(tm(), h2.deps), 0, 'a bucket listed by name is fine'); } finally { h2.cleanup(); }
  const s = state(); s.params['/prism/continuum/agent-space-id'] = 'as-gone';
  const h3 = harness(s);
  try {
    assert.equal(await securityThreatModel(tm(), h3.deps), 1);
    assert.match(h3.out(), /did not return agent space as-gone/);
    assert.deepEqual(h3.writes(), []);
  } finally { h3.cleanup(); }
});

test('threat-model: missing setup in SSM points at enable security', async () => {
  const s = state(); delete s.params['/prism/continuum/agent-space-id'];
  const h = harness(s);
  try {
    assert.equal(await securityThreatModel(tm(), h.deps), 1);
    assert.match(h.out(), /agent-space-id is not set .*run prism-cli enable security first/);
    assert.deepEqual(h.writes(), []);
  } finally { h.cleanup(); }
});

test('threat-model: --fail-on high exits 1 on a critical threat; report-only by default', async () => {
  const h = harness(state());
  try { assert.equal(await securityThreatModel(tm({ failOn: 'high' }), h.deps), 1); } finally { h.cleanup(); }
  const h2 = harness(state({ threats: [{ threatId: 't9', title: 'Banner', severity: 'INFO', stride: [] }] }));
  try { assert.equal(await securityThreatModel(tm({ failOn: 'low' }), h2.deps), 0, 'INFO never fails'); } finally { h2.cleanup(); }
});

test('threat-model: --json prints only the result on stdout', async () => {
  const h = harness(state());
  try {
    assert.equal(await securityThreatModel(tm({ json: true }), h.deps), 0);
    assert.equal(h.lines.length, 0);
    assert.equal(JSON.parse(h.outs.join('')).kind, 'security-threat-model');
    assert.equal(h.errs[0], THREAT_MODEL_NOTICE);
  } finally { h.cleanup(); }
});

test('threat-model: not the repo root prints one Error line before the notice', async () => {
  const h = harness(state(), { cwd: (repo) => { mkdirSync(join(repo, 'src'), { recursive: true }); return join(repo, 'src'); } });
  try {
    assert.equal(await securityThreatModel(tm(), h.deps), 1);
    assert.equal(h.lines.length, 1);
    assert.match(h.lines[0], /run from the repository root/);
    assert.equal(h.calls.length, 0);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// threats
// ---------------------------------------------------------------------------

test('threat-model: tiny scope docs warn up front, and again when the job finds no threats', async () => {
  const tiny = /Warning: the scope docs are only 4 bytes in total \(docs\/NOTE\.md\), so the threat model may find no threats\. Pass a fuller design doc with --doc, or commit the Kiro spec docs \(\.kiro\/specs\/<feature>\/design\.md and requirements\.md\)/g;
  const tree: Tree = { ...DEFAULT_TREE, 'docs/NOTE.md': 'hi\n\n' };
  const h = harness(state({ threats: [] }), { tree });
  try {
    assert.equal(await securityThreatModel(tm({ doc: ['docs/NOTE.md'] }), h.deps), 0);
    assert.equal(h.out().match(tiny)?.length, 2, h.out());
    assert.match(h.out(), /No threats\.\nWarning: the scope docs are only/);
  } finally { h.cleanup(); }

  // The same hint from security threats completing a --no-wait run (sizes read from the recorded commit).
  const w = harness(state({ threats: [] }), { tree });
  try {
    assert.equal(await securityThreatModel(tm({ doc: ['docs/NOTE.md'], wait: false }), w.deps), 0);
    w.lines.length = 0;
    assert.equal(await securityThreats(th(), w.deps), 0);
    assert.equal(w.out().match(tiny)?.length, 1, w.out());
  } finally { w.cleanup(); }

  // Large enough docs, or threats found: no hint.
  const big = harness(state({ threats: [] }), { tree: { ...DEFAULT_TREE, 'docs/ARCH.md': 'x'.repeat(TINY_DOCS_BYTES) } });
  try {
    assert.equal(await securityThreatModel(tm({ doc: ['docs/ARCH.md'] }), big.deps), 0);
    assert.doesNotMatch(big.out(), /scope docs are only/);
  } finally { big.cleanup(); }
  assert.equal(tinyDocsHint([]), null, '--no-docs: the source alone, no warning');
});

test('threats: read-only, completes the pending record in place with its commit and docs', async () => {
  const s = state();
  const h = harness(s);
  try {
    assert.equal(await securityThreatModel(tm({ wait: false }), h.deps), 0);
    h.calls.length = 0;
    assert.equal(await securityThreats(th(), h.deps), 0);
    assert.deepEqual(h.writes(), []);
    assert.match(h.out(), /Pending: {5}recorded by threat-model at 2026-11-07T10:00:00\.000Z \(commit aaaaaaaaaaaa\)/);
    const rs = h.results();
    assert.equal(rs.length, 1);
    assert.equal(rs[0].status, 'findings');
    assert.equal(rs[0].commit, TIP);
    assert.equal(rs[0].threat_model.scope_docs.length, 2);
  } finally { h.cleanup(); }
});

test('threats --job for a job that already has a completed record updates it in place, keeping its commit (no nocommit copy)', async () => {
  const h = harness(state());
  try {
    assert.equal(await securityThreatModel(tm({ wait: false }), h.deps), 0);
    assert.equal(await securityThreats(th(), h.deps), 0);
    assert.deepEqual(h.results().map((r) => r.status), ['findings']);
    h.lines.length = 0;
    assert.equal(await securityThreats(th({ job: 'tmj-1' }), h.deps), 0);
    assert.match(h.out(), /Recorded: {4}recorded by threat-model at 2026-11-07T10:00:00\.000Z \(commit aaaaaaaaaaaa\)/);
    const rs = h.results();
    assert.equal(rs.length, 1, 'one result file');
    assert.deepEqual([rs[0].commit, rs[0].threat_model.scope_docs.length, rs[0].findings.length], [TIP, 2, 4]);
  } finally { h.cleanup(); }
});

test('threats: --severity filters the printout, not the saved result', async () => {
  const h = harness(state());
  try {
    assert.equal(await securityThreats(th({ job: 'tmj-1', severity: 'high' }), h.deps), 0);
    const out = h.out();
    assert.match(out, /CRITICAL \(1\)/);
    assert.doesNotMatch(out, /MEDIUM \(1\)/);
    assert.match(out, /\(2 below high not shown; 4 threats/);
    assert.equal(h.results()[0].findings.length, 4);
  } finally { h.cleanup(); }
});

test('threats: still running without --wait exits 2; with --wait it polls', async () => {
  const h = harness(state({ statuses: ['IN_PROGRESS', 'IN_PROGRESS', 'COMPLETED'] }));
  try {
    assert.equal(await securityThreats(th({ job: 'tmj-1' }), h.deps), 2);
    assert.match(h.out(), /still IN_PROGRESS\. Re-run with --wait/);
    assert.equal(await securityThreats(th({ job: 'tmj-1', wait: true }), h.deps), 0);
  } finally { h.cleanup(); }
});

test('threats: with no pending record, the latest job of this repo\'s newest threat model', async () => {
  const s = state({
    models: [
      { threatModelId: 'tm-old', title: `${titlePrefix(SLUG)}aaa-1`, createdAt: '2026-11-01T00:00:00Z' },
      { threatModelId: 'tm-new', title: `${titlePrefix(SLUG)}bbb-2`, createdAt: '2026-11-05T00:00:00Z' },
      { threatModelId: 'tm-other', title: 'someone-elses-model', createdAt: '2026-11-06T00:00:00Z' },
    ],
    jobs: { 'tm-new': [{ threatModelJobId: 'tmj-a', createdAt: '2026-11-05T01:00:00Z' }, { threatModelJobId: 'tmj-b', createdAt: '2026-11-05T02:00:00Z' }] },
  });
  const h = harness(s);
  try {
    assert.equal(await securityThreats(th(), h.deps), 0);
    assert.match(h.out(), /Job: {9}tmj-b \(COMPLETED/);
    assert.ok(!h.calls.some((c) => c[1] === 'list-threat-model-jobs' && arg(c, '--threat-model-id') === 'tm-other'));
  } finally { h.cleanup(); }
  const h2 = harness(state());
  try {
    assert.equal(await securityThreats(th(), h2.deps), 0);
    assert.match(h2.out(), /No threat models yet for github\.com\/acme\/widgets/);
  } finally { h2.cleanup(); }
});

test('threats: a bad --job is refused before any job call', async () => {
  const h = harness(state());
  try {
    assert.equal(await securityThreats(th({ job: 'x; rm -rf' }), h.deps), 1);
    assert.ok(!h.calls.some((c) => c[1] === 'batch-get-threat-model-jobs'));
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('firstParagraph skips headings, joins lines, caps the length', () => {
  assert.equal(firstParagraph(OVERVIEW), 'Widgets is a small API that stores widgets.');
  assert.equal(firstParagraph(null), '');
  assert.equal(firstParagraph('# Only a heading'), '');
  assert.ok(firstParagraph('word '.repeat(500)).length <= 600);
});

test('strideLabel and doc limit warnings', () => {
  assert.equal(strideLabel('ELEVATION_OF_PRIVILEGE'), 'Elevation of privilege');
  assert.deepEqual(docLimitWarnings([{ path: 'a.md', size: 100 }]), []);
  const w = docLimitWarnings([...Array(6)].map((_, i) => ({ path: `d${i}.pdf`, size: 100 })).concat([{ path: 'big.md', size: 600 * 1024 }]));
  assert.equal(w.length, 1);
  assert.match(w[0], /7 scope docs; big\.md is 0\.6 MB\. .*documents no limits/);
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function tmResult(o: Partial<PrismResult> & { job: string; status: PrismResult['status']; started: string; counts?: Record<string, number> }): PrismResult {
  return {
    schema_version: 1, kind: 'security-threat-model', hook: 'manual', status: o.status, tool: 'security-agent', tool_version: null, model: null,
    commit: TIP, tree: null, branch: 'work', upstream: null, base: null, started_at: o.started, finished_at: o.started,
    findings: o.findings ?? [], summary: null, score: null, reason: o.reason ?? null,
    threat_model: {
      job_id: o.job, threat_model_id: 'tm-1', agent_space_id: 'as-1', region: REGION, account: ACCOUNT, job_status: o.status === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
      counts: o.counts ?? {}, stride_counts: {}, scope_docs: ['.kiro/specs/login/design.md'], system_overview: o.status === 'pending' ? null : OVERVIEW,
    },
  };
}

test('dashboard: threat-model rows (pending, done) beside code reviews; codewatch ignores them', () => {
  const repo = mkdtempSync(join(tmpdir(), 'prism-tm-dash-'));
  try {
    writeResult(repo, tmResult({ job: 'tmj-old', status: 'findings', started: '2026-11-01T00:00:00.000Z', counts: { HIGH: 1 },
      findings: [{ severity: 'high', category: 'security', rule: 'SPOOFING', file: 'src/a.ts', line: null, message: 'm', risk_level: 'HIGH', title: 'Token replay', stride: ['SPOOFING'] }] }));
    const now = new Date('2026-11-07T10:30:00Z');
    let panel = collectSecurity([{ name: 'widgets', path: repo, current: true }], undefined, now);
    assert.equal(panel.repos.length, 0, 'no code review row');
    assert.equal(panel.threat_models.length, 1);
    const done = panel.threat_models[0];
    assert.equal(done.status, 'findings');
    assert.equal(done.overview, 'Widgets is a small API that stores widgets.');
    assert.deepEqual(done.threats[0], { severity: 'HIGH', title: 'Token replay', stride: ['SPOOFING'] });
    assert.deepEqual(done.scope_docs, ['.kiro/specs/login/design.md']);

    writeResult(repo, tmResult({ job: 'tmj-new', status: 'pending', started: '2026-11-07T10:00:00.000Z' }));
    panel = collectSecurity([{ name: 'widgets', path: repo, current: true }], undefined, now);
    assert.equal(panel.threat_models[0].job_id, 'tmj-new');
    assert.equal(panel.threat_models[0].pending, true);
    assert.equal(panel.threat_models[0].stale, false);
    assert.equal(panel.threats_hint, 'prism-cli security threats');

    assert.equal(collectCodewatch(repo).totalRuns, 0);
    const html = renderPage('NONCE');
    assert.match(html, /Threat models/);
    assert.match(html, /threat model running/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
