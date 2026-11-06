import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AwsResult } from '../src/utils/aws.js';
import {
  enableSecurity, isWriteCall, PARAM_AGENT_SPACE, PARAM_SCAN_BUCKET, PARAM_SERVICE_ROLE, STACK_NAME, type Deps, type SecurityOptions,
} from '../src/security/setup.js';
import { codeReviewTitle, repoIdFromRemote, repoSlug } from '../src/security/repo.js';
import { categorize, diffTemplates } from '../src/security/cfn-diff.js';
import { explainAwsError, NO_CREDENTIALS_MESSAGE, redact } from '../src/security/errors.js';
import { readSecurityMarker } from '../src/security/marker.js';
import { securitySetup } from '../src/dashboard/setup.js';
import alias, { DEPRECATION } from '../src/commands/securityagent/setup.js';
import { SECURITY_OPTIONS } from '../src/commands/enable/security.js';

// ---------------------------------------------------------------------------
// A fake AWS account. Each `aws` call is answered from in-memory state, and
// every call is recorded, so tests assert on exactly which writes happened.
// ---------------------------------------------------------------------------
const ACCOUNT = '111122223333';
const REGION = 'us-west-2';
const ROLE = `arn:aws:iam::${ACCOUNT}:role/prism-d1-security-agent-prism-d1-security`;
const BUCKET = `security-agent-scans-${ACCOUNT}-${REGION}`;
const REMOTE = 'https://github.com/acme/widgets.git';
const SLUG = 'github.com-acme-widgets';
const PARAM = `/prism/continuum/code-review-id/${SLUG}`;
const ZIP = Buffer.from('fake zip of HEAD');
const ZIP_MD5 = createHash('md5').update(ZIP).digest('hex');

const res = (r: Partial<AwsResult>): AwsResult => ({ ok: true, json: {}, errorCode: '', raw: '', ...r });
const fail = (code: string, raw: string): AwsResult => ({ ok: false, json: null, errorCode: code, raw });
const meta = (path: string) => ({ 'aws:cdk:path': `${STACK_NAME}/${path}` });

/** The synthesized template: the Security Agent resources plus one unrelated function. */
function synthTemplate(lambdaCode = 'v1') {
  return {
    Resources: {
      SecurityAgentRole1: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'r' }, Metadata: meta('SecurityAgent/SecurityAgentRole/Resource') },
      SecurityAgentSpace: { Type: 'AWS::SecurityAgent::AgentSpace', Properties: { Name: 'prism-d1-security' }, Metadata: meta('SecurityAgent/AgentSpace') },
      SecurityAgentBucket: { Type: 'AWS::S3::Bucket', Properties: { B: 1 }, Metadata: meta('SecurityAgent/ScanBucket/Resource') },
      SecurityAgentBucketPolicy: { Type: 'AWS::S3::BucketPolicy', Properties: { P: 1 }, Metadata: meta('SecurityAgent/ScanBucket/Policy/Resource') },
      ContinuumCiPolicy1: { Type: 'AWS::IAM::ManagedPolicy', Properties: { M: 1 }, Metadata: meta('ContinuumCiPolicy/Resource') },
      Processor: { Type: 'AWS::Lambda::Function', Properties: { Code: lambdaCode }, Metadata: meta('Processor/Resource') },
      CDKMetadata: { Type: 'AWS::CDK::Metadata', Properties: { Analytics: Math.random().toString() } },
    },
  };
}

interface State {
  stack: any | null;               // deployed template, or null when the stack does not exist
  params: Record<string, string>;
  spaces: { agentSpaceId: string; name: string }[];
  apps: { applicationId: string; roleArn: string | null }[];
  reviews: { codeReviewId: string; title: string }[];
  objects: Record<string, string>; // key -> ETag (md5)
  deny?: string;                   // CLI command that returns AccessDenied
}

/** State after a complete setup: nothing left to do. */
function fullySetUp(): State {
  return {
    stack: synthTemplate(),
    params: { [PARAM_AGENT_SPACE]: 'as-1', [PARAM_SCAN_BUCKET]: BUCKET, [PARAM_SERVICE_ROLE]: ROLE, [PARAM]: 'cr-1' },
    spaces: [{ agentSpaceId: 'as-1', name: 'prism-d1-security' }],
    apps: [{ applicationId: 'app-1', roleArn: ROLE }],
    reviews: [{ codeReviewId: 'cr-1', title: codeReviewTitle(SLUG) }],
    objects: { [`repo/${SLUG}/latest.zip`]: ZIP_MD5 },
  };
}
const emptyAccount = (): State => ({ stack: null, params: {}, spaces: [], apps: [], reviews: [], objects: {} });

function arg(args: string[], flag: string): string { return args[args.indexOf(flag) + 1]; }

function fakeAws(state: State, log: string[][]) {
  let next = 1;
  return (args: string[]): AwsResult => {
    log.push(args);
    const [svc, cmd] = args;
    if (state.deny === cmd) return fail('AccessDeniedException', `An error occurred (AccessDeniedException) when calling the ${cmd.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('')} operation: User: arn:aws:sts::${ACCOUNT}:assumed-role/Dev/me is not authorized to perform: ${svc}:${cmd.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('')} on resource: *`);
    switch (`${svc} ${cmd}`) {
      case 'sts get-caller-identity': return res({ json: { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Dev/me` } });
      case 'iam list-account-aliases': return res({ json: { AccountAliases: ['acme-dev'] } });
      case 'cloudformation describe-stacks':
        return state.stack ? res({ json: { Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] } }) : fail('ValidationError', `An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${STACK_NAME} does not exist`);
      case 'cloudformation get-template': return res({ json: { TemplateBody: state.stack } });
      case 'ssm get-parameter': {
        const v = state.params[arg(args, '--name')];
        return v ? res({ json: { Parameter: { Value: v } } }) : fail('ParameterNotFound', 'An error occurred (ParameterNotFound) when calling the GetParameter operation: ');
      }
      case 'ssm put-parameter': {
        const name = arg(args, '--name');
        if (state.params[name] && !args.includes('--overwrite')) return fail('ParameterAlreadyExists', 'An error occurred (ParameterAlreadyExists)');
        state.params[name] = arg(args, '--value');
        return res({});
      }
      case 'securityagent list-agent-spaces': return res({ json: { agentSpaceSummaries: state.spaces } });
      case 'securityagent list-applications': return res({ json: { applicationSummaries: state.apps.map((a) => ({ applicationId: a.applicationId, applicationName: 'x', domain: 'd' })) } });
      case 'securityagent get-application': return res({ json: state.apps.find((a) => a.applicationId === arg(args, '--application-id')) });
      case 'securityagent create-application': { const id = `app-new-${next++}`; state.apps.push({ applicationId: id, roleArn: null }); return res({ json: { applicationId: id } }); }
      case 'securityagent update-application': { const a = state.apps.find((x) => x.applicationId === arg(args, '--application-id'))!; a.roleArn = arg(args, '--role-arn'); return res({}); }
      case 'securityagent list-code-reviews': return res({ json: { codeReviewSummaries: state.reviews } });
      case 'securityagent create-code-review': { const id = `cr-new-${next++}`; state.reviews.push({ codeReviewId: id, title: arg(args, '--title') }); return res({ json: { codeReviewId: id } }); }
      case 's3api head-object': {
        const e = state.objects[arg(args, '--key')];
        return e ? res({ json: { ETag: `"${e}"` } }) : fail('404', 'An error occurred (404) when calling the HeadObject operation: Not Found');
      }
      case 's3api put-object': state.objects[arg(args, '--key')] = createHash('md5').update(readFileSync(arg(args, '--body'))).digest('hex'); return res({});
      default: return fail('', `fake aws: unexpected call ${args.join(' ')}`);
    }
  };
}

interface Harness {
  deps: Deps;
  state: State;
  calls: string[][];
  lines: string[];
  deploys: { approveAll: boolean }[];
  questions: string[];
  repo: string;
  out: () => string;
  writes: () => string[];
  cleanup: () => void;
}

function harness(state: State, o: { tty?: boolean; answers?: string[]; synth?: any; cliVersion?: string; inRepo?: boolean } = {}): Harness {
  const repo = mkdtempSync(join(tmpdir(), 'prism-sec-repo-'));
  const calls: string[][] = []; const lines: string[] = []; const deploys: { approveAll: boolean }[] = []; const questions: string[] = [];
  const answers = [...(o.answers ?? [])];
  const synth = o.synth ?? synthTemplate();
  const deps: Deps = {
    aws: fakeAws(state, calls),
    awsVersion: () => o.cliVersion ?? 'aws-cli/2.36.19 Python/3.14',
    cdk: {
      synth(outDir) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `${STACK_NAME}.template.json`), JSON.stringify(synth));
        return { ok: true, stdout: '', stderr: '' };
      },
      diff: () => ({ ok: true, output: 'Stack PrismD1MetricsPipeline\nIAM Statement Changes\n...' }),
      deploy(_dir, _acct, opts) {
        deploys.push(opts);
        state.stack = synth;
        state.params[PARAM_AGENT_SPACE] = 'as-1'; state.params[PARAM_SCAN_BUCKET] = BUCKET; state.params[PARAM_SERVICE_ROLE] = ROLE;
        if (!state.spaces.length) state.spaces.push({ agentSpaceId: 'as-1', name: 'prism-d1-security' });
        return true;
      },
    },
    git(args) {
      if (o.inRepo === false) return { ok: false, stdout: '', stderr: 'fatal: not a git repository' };
      if (args[0] === 'rev-parse') return { ok: true, stdout: repo, stderr: '' };
      if (args[0] === 'remote') return { ok: true, stdout: REMOTE, stderr: '' };
      if (args[0] === 'archive') { writeFileSync(args[args.indexOf('-o') + 1], ZIP); return { ok: true, stdout: '', stderr: '' }; }
      return { ok: false, stdout: '', stderr: 'unexpected git call' };
    },
    makeTempDir: () => mkdtempSync(join(tmpdir(), 'prism-sec-tmp-')),
    isTTY: o.tty ?? false,
    ask: async (q) => { questions.push(q); return answers.shift() ?? ''; },
    log: (l = '') => { lines.push(l); },
    now: () => new Date('2026-11-06T05:00:00Z'),
  };
  return {
    deps, state, calls, lines, deploys, questions, repo,
    out: () => lines.join('\n'),
    writes: () => calls.filter(isWriteCall).map((c) => `${c[0]} ${c[1]}`),
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
}

const opts = (o: Partial<SecurityOptions> = {}): SecurityOptions => ({ region: REGION, ...o });

// ---------------------------------------------------------------------------

test('--dry-run on a fresh account: full plan with exact calls, no writes, no deploy', async () => {
  const h = harness(emptyAccount());
  try {
    assert.equal(await enableSecurity(opts({ dryRun: true }), h.deps), 0);
    assert.deepEqual(h.writes(), []);
    assert.equal(h.deploys.length, 0);
    const out = h.out();
    assert.match(out, /Account 111122223333 \(acme-dev\), region us-west-2/);
    assert.match(out, /Stack PrismD1MetricsPipeline \(new stack\): 6 to add, 0 to change, 0 to remove/);
    assert.match(out, /IAM and resource policies:\n\s+\+ AWS::IAM::ManagedPolicy {2}ContinuumCiPolicy/);
    assert.match(out, /cdk deploy --app \S+ PrismD1MetricsPipeline --exclusively/);
    assert.match(out, /aws securityagent create-application --region us-west-2/);
    assert.match(out, new RegExp(`aws ssm put-parameter --name ${PARAM} --value '<code review id>' --type String --region us-west-2`));
    assert.match(out, /Dry run: nothing was changed\./);
    assert.equal(readSecurityMarker(h.repo), null);
  } finally { h.cleanup(); }
});

test('--dry-run when deployed: real lookups, still no writes', async () => {
  const s = fullySetUp(); s.apps[0].roleArn = null; delete s.params[PARAM]; s.reviews = [];
  const h = harness(s);
  try {
    assert.equal(await enableSecurity(opts({ dryRun: true }), h.deps), 0);
    assert.deepEqual(h.writes(), []);
    assert.match(h.out(), /\[update\] Application: app-1: role is not set/);
    assert.match(h.out(), /\[ok\] Repo snapshot: .* upload skipped/);
    assert.match(h.out(), /\[create\] Code review: create "github-com-acme-widgets-ci-diff-scan"/);
  } finally { h.cleanup(); }
});

test('no terminal and no --yes: refuses before any write', async () => {
  const h = harness(emptyAccount(), { tty: false });
  try {
    assert.equal(await enableSecurity(opts(), h.deps), 1);
    assert.deepEqual(h.writes(), []);
    assert.equal(h.deploys.length, 0);
    assert.match(h.out(), /Refusing to change anything: there is no terminal to confirm on\. Re-run with --yes/);
  } finally { h.cleanup(); }
});

test('confirmation names the account, alias and region; "n" changes nothing', async () => {
  const h = harness(emptyAccount(), { tty: true, answers: ['n'] });
  try {
    assert.equal(await enableSecurity(opts(), h.deps), 1);
    assert.match(h.questions[0], /Deploy PrismD1MetricsPipeline .* in account 111122223333 \(acme-dev\), region us-west-2\? \[y\/N\]/);
    assert.deepEqual(h.writes(), []);
    assert.equal(h.deploys.length, 0);
  } finally { h.cleanup(); }
});

test('confirmed fresh setup: deploy (CDK still asks), then application, upload, code review, SSM, marker', async () => {
  const h = harness(emptyAccount(), { tty: true, answers: ['y'] });
  try {
    assert.equal(await enableSecurity(opts(), h.deps), 0);
    assert.deepEqual(h.deploys, [{ approveAll: false }]);
    assert.deepEqual(h.writes(), ['securityagent create-application', 'securityagent update-application', 's3api put-object', 'securityagent create-code-review', 'ssm put-parameter']);
    const put = h.calls.find((c) => c[1] === 'put-parameter')!;
    assert.equal(put[put.indexOf('--name') + 1], PARAM);
    assert.ok(!put.includes('--overwrite'));
    const cr = h.calls.find((c) => c[1] === 'create-code-review')!;
    assert.equal(cr[cr.indexOf('--title') + 1], 'github-com-acme-widgets-ci-diff-scan');
    const m = readSecurityMarker(h.repo)!;
    assert.deepEqual({ ...m }, { agentSpaceId: 'as-1', applicationId: h.state.apps[0].applicationId, codeReviewId: h.state.params[PARAM], region: REGION, account: ACCOUNT, setupAt: '2026-11-06T05:00:00.000Z' });
  } finally { h.cleanup(); }
});

test('--yes without a terminal proceeds and tells CDK not to ask again', async () => {
  const h = harness(emptyAccount(), { tty: false });
  try {
    assert.equal(await enableSecurity(opts({ yes: true }), h.deps), 0);
    assert.deepEqual(h.deploys, [{ approveAll: true }]);
    assert.equal(h.questions.length, 0);
    assert.match(h.out(), /--yes: approved for account 111122223333 \(acme-dev\) in us-west-2/);
  } finally { h.cleanup(); }
});

test('re-run when everything is set up: "already set up", no writes, marker left as is', async () => {
  const h = harness(fullySetUp(), { tty: false });
  try {
    assert.equal(await enableSecurity(opts(), h.deps), 0);
    assert.match(h.out(), /Already set up: nothing to change\./);
    assert.deepEqual(h.writes(), []);
    const first = readFileSync(join(h.repo, '.prism/config.json'), 'utf8');
    h.deps.now = () => new Date('2027-01-01T00:00:00Z');
    assert.equal(await enableSecurity(opts(), h.deps), 0);
    assert.equal(readFileSync(join(h.repo, '.prism/config.json'), 'utf8'), first, 'setupAt is kept when nothing changed');
    assert.deepEqual(h.writes(), []);
  } finally { h.cleanup(); }
});

test('drift outside the Security Agent resources is shown but not deployed', async () => {
  const h = harness(fullySetUp(), { synth: synthTemplate('v2') });
  try {
    assert.equal(await enableSecurity(opts(), h.deps), 0);
    assert.equal(h.deploys.length, 0);
    assert.match(h.out(), /0 to add, 1 to change, 0 to remove/);
    assert.match(h.out(), /Deploy: no \(the Security Agent resources are up to date; the other 1 change\(s\)/);
  } finally { h.cleanup(); }
});

test('application role drift is shown and fixed after confirmation', async () => {
  const s = fullySetUp(); s.apps[0].roleArn = 'arn:aws:iam::111122223333:role/other';
  const h = harness(s, { tty: true, answers: ['y'] });
  try {
    assert.equal(await enableSecurity(opts(), h.deps), 0);
    assert.match(h.out(), /role is arn:aws:iam::111122223333:role\/other, expected .* \(drift\)/);
    assert.deepEqual(h.writes(), ['securityagent update-application']);
    assert.equal(h.state.apps[0].roleArn, ROLE);
  } finally { h.cleanup(); }
});

test('SSM conflict: a different value is not overwritten without a second yes', async () => {
  const s = fullySetUp(); s.params[PARAM] = 'cr-stale';
  const h = harness(s, { tty: true, answers: ['y', 'n'] });
  try {
    assert.equal(await enableSecurity(opts(), h.deps), 1);
    assert.match(h.out(), /\[CONFLICT\] SSM code review id: .* holds cr-stale, which is not a code review in this agent space; it would be replaced with cr-1/);
    assert.equal(h.questions[1], 'Overwrite that SSM parameter? [y/N] ');
    assert.deepEqual(h.writes(), []);
    assert.equal(h.state.params[PARAM], 'cr-stale');
    assert.equal(readSecurityMarker(h.repo), null);
  } finally { h.cleanup(); }
});

test('SSM conflict with --yes overwrites, using --overwrite', async () => {
  const s = fullySetUp(); s.params[PARAM] = 'cr-stale';
  const h = harness(s);
  try {
    assert.equal(await enableSecurity(opts({ yes: true }), h.deps), 0);
    const put = h.calls.find((c) => c[1] === 'put-parameter')!;
    assert.ok(put.includes('--overwrite'));
    assert.equal(h.state.params[PARAM], 'cr-1');
  } finally { h.cleanup(); }
});

test('S3 upload is skipped when the object already matches HEAD, and done when it differs', async () => {
  const s = fullySetUp(); s.reviews = []; delete s.params[PARAM];
  const h = harness(s, { tty: true, answers: ['y'] });
  try {
    assert.equal(await enableSecurity(opts(), h.deps), 0);
    assert.deepEqual(h.writes(), ['securityagent create-code-review', 'ssm put-parameter']);
    assert.match(h.out(), /already matches HEAD \(MD5 [0-9a-f]{32}\); upload skipped/);
  } finally { h.cleanup(); }

  const s2 = fullySetUp(); s2.reviews = []; delete s2.params[PARAM]; s2.objects[`repo/${SLUG}/latest.zip`] = 'deadbeef';
  const h2 = harness(s2);
  try {
    assert.equal(await enableSecurity(opts({ yes: true }), h2.deps), 0);
    assert.deepEqual(h2.writes(), ['s3api put-object', 'securityagent create-code-review', 'ssm put-parameter']);
  } finally { h2.cleanup(); }
});

test('an existing code review with the CI title is reused (the gate may have created it)', async () => {
  const s = fullySetUp(); delete s.params[PARAM];
  const h = harness(s);
  try {
    assert.equal(await enableSecurity(opts({ yes: true }), h.deps), 0);
    assert.deepEqual(h.writes(), ['ssm put-parameter']);
    assert.equal(h.state.params[PARAM], 'cr-1');
  } finally { h.cleanup(); }
});

test('--status is read-only and reports every item', async () => {
  const s = fullySetUp(); s.params['/prism/continuum/code-review-id'] = 'cr-old';
  const h = harness(s);
  mkdirSync(join(h.repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(h.repo, '.github/workflows/prism-eval-gate.yml'), 'run: aws securityagent start-code-review-job');
  try {
    assert.equal(await enableSecurity(opts({ status: true }), h.deps), 0);
    assert.deepEqual(h.writes(), []);
    const out = h.out();
    for (const re of [
      /\[ok\] Credentials: account 111122223333 \(acme-dev\)/,
      /\[ok\] Stack: PrismD1MetricsPipeline UPDATE_COMPLETE, with the Security Agent resources/,
      /\[ok\] Agent space: as-1 \(prism-d1-security\)/,
      /\[ok\] Application: app-1, role attached/,
      /\[ok\] SSM scan-bucket: \/prism\/continuum\/scan-bucket = security-agent-scans/,
      /\[ok\] Code review: cr-1 \(".*"\) from \/prism\/continuum\/code-review-id\/github\.com-acme-widgets/,
      /\[warn\] Legacy SSM: \/prism\/continuum\/code-review-id = cr-old/,
      /\[ok\] CI workflow step: \.github\/workflows\/prism-eval-gate\.yml/,
      /\[missing\] Local marker/,
    ]) assert.match(out, re);
  } finally { h.cleanup(); }
});

test('--status on an account with nothing deployed', async () => {
  const h = harness(emptyAccount());
  try {
    assert.equal(await enableSecurity(opts({ status: true }), h.deps), 0);
    assert.match(h.out(), /\[missing\] Stack: PrismD1MetricsPipeline not deployed/);
    assert.match(h.out(), /\[missing\] Code review: .* not set/);
    assert.deepEqual(h.writes(), []);
  } finally { h.cleanup(); }
});

test('outside a git repo: account-level setup only, no marker', async () => {
  const s = fullySetUp(); s.apps = [];
  const h = harness(s, { inRepo: false });
  try {
    assert.equal(await enableSecurity(opts({ yes: true }), h.deps), 0);
    assert.deepEqual(h.writes(), ['securityagent create-application', 'securityagent update-application']);
    assert.match(h.out(), /\[skip\] Code review: not inside a git repository/);
  } finally { h.cleanup(); }
});

test('the marker holds ids only and keeps the rest of .prism/config.json', async () => {
  const h = harness(fullySetUp());
  mkdirSync(join(h.repo, '.prism'));
  writeFileSync(join(h.repo, '.prism/config.json'), JSON.stringify({ team_id: 'team-a', eval: { reviewer: 'kiro' } }));
  try {
    assert.equal(await enableSecurity(opts(), h.deps), 0);
    const cfg = JSON.parse(readFileSync(join(h.repo, '.prism/config.json'), 'utf8'));
    assert.equal(cfg.team_id, 'team-a');
    assert.deepEqual(cfg.eval, { reviewer: 'kiro' });
    assert.deepEqual(Object.keys(cfg.security).sort(), ['account', 'agentSpaceId', 'applicationId', 'codeReviewId', 'region', 'setupAt']);
  } finally { h.cleanup(); }
});

test('AccessDenied names the failed API and the permission it needed', async () => {
  const s = fullySetUp(); s.deny = 'list-code-reviews';
  const h = harness(s);
  try {
    assert.equal(await enableSecurity(opts({ dryRun: true }), h.deps), 1);
    assert.match(h.out(), /Error: AccessDenied: ListCodeReviews \(aws securityagent list-code-reviews\) was refused\. The caller needs the IAM permission securityagent:ListCodeReviews\./);
  } finally { h.cleanup(); }
});

test('an AWS CLI older than 2.36 gets the version it needs', async () => {
  const h = harness(fullySetUp(), { cliVersion: 'aws-cli/2.30.1 Python/3.11' });
  try {
    assert.equal(await enableSecurity(opts(), h.deps), 1);
    assert.match(h.out(), /needs AWS CLI v2\.36 or later for the securityagent commands \(found 2\.30\.1\)/);
    assert.equal(h.calls.length, 0);
  } finally { h.cleanup(); }
  const e = explainAwsError(['securityagent', 'list-agent-spaces'], "aws: error: argument command: Invalid choice, valid choices are: ...", 'aws-cli/2.15.0 Python');
  assert.equal(e.kind, 'old-cli');
  assert.match(e.message, /needs AWS CLI v2\.36 or later \(found aws-cli\/2\.15\.0\)/);
});

test('missing credentials keep the old message', () => {
  const e = explainAwsError(['sts', 'get-caller-identity'], 'Unable to locate credentials. You can configure credentials by running "aws configure".');
  assert.equal(e.kind, 'no-credentials');
  assert.ok(e.message.startsWith(NO_CREDENTIALS_MESSAGE));
});

test('credentials never reach printed output', () => {
  const t = redact('key AKIAABCDEFGHIJKLMNOP secret aws_secret_access_key = abc/def+ghi token SessionToken: "zzz" url?X-Amz-Security-Token=qqq&x=1');
  assert.doesNotMatch(t, /AKIAABCDEFGHIJKLMNOP|abc\/def\+ghi|zzz|qqq/);
});

test('repo id and slug match the CI eval gate, and drop credentials from the remote', () => {
  assert.equal(repoIdFromRemote('https://github.com/acme/widgets.git'), 'github.com/acme/widgets');
  assert.equal(repoIdFromRemote('git@github.com:acme/widgets.git'), 'github.com/acme/widgets');
  assert.equal(repoIdFromRemote('ssh://git@gitlab.example.com:2222/grp/sub/proj.git'), 'gitlab.example.com/grp/sub/proj');
  assert.equal(repoIdFromRemote('https://user:ghp_secret@github.com/acme/widgets'), 'github.com/acme/widgets');
  assert.equal(repoSlug('github.com/acme/widgets'), 'github.com-acme-widgets');
  // CI: printf '%s-ci-diff-scan' "$REPO_SLUG" | tr -c 'A-Za-z0-9_-' '-' | cut -c1-100
  assert.equal(codeReviewTitle('github.com-acme-widgets'), 'github.com-acme-widgets-ci-diff-scan'.replace('.', '-'));
  assert.equal(codeReviewTitle('x'.repeat(120)).length, 100);
});

test('template diff: IAM, network and endpoint changes are called out', () => {
  assert.equal(categorize('AWS::IAM::Role'), 'iam');
  assert.equal(categorize('AWS::S3::BucketPolicy'), 'iam');
  assert.equal(categorize('AWS::EC2::SecurityGroupIngress'), 'network');
  assert.equal(categorize('AWS::ApiGatewayV2::Api'), 'endpoint');
  const d = diffTemplates(synthTemplate(), { Resources: { ...synthTemplate().Resources, Extra: { Type: 'AWS::EC2::SecurityGroup', Properties: {} } } } as any, STACK_NAME);
  assert.deepEqual(d.changes.map((c) => [c.change, c.type]), [['add', 'AWS::EC2::SecurityGroup']]);
  assert.equal(d.touchesSecurityAgent, false);
  // The scan bucket's autoDeleteObjects adds a stack-level provider; it belongs to the feature.
  const p = diffTemplates({ Resources: {} }, { Resources: { Prov: { Type: 'AWS::IAM::Role', Metadata: meta('Custom::S3AutoDeleteObjectsCustomResourceProvider/Role') } } } as any, STACK_NAME);
  assert.equal(p.changes[0].securityAgent, true);
  const r = diffTemplates(synthTemplate(), { Resources: {} }, STACK_NAME);
  assert.equal(r.counts.remove, 6, 'CDK metadata is ignored');
});

test('dashboard Security Agent row comes from the marker', () => {
  const repo = mkdtempSync(join(tmpdir(), 'prism-sec-dash-'));
  try {
    assert.deepEqual(securitySetup(repo), { status: 'missing', detail: 'not set up', fix: `cd ${repo} && prism-cli enable security` });
    mkdirSync(join(repo, '.prism'));
    writeFileSync(join(repo, '.prism/config.json'), JSON.stringify({ security: { agentSpaceId: 'as-1', applicationId: 'app-1', codeReviewId: 'cr-1', region: 'us-west-2', account: ACCOUNT, setupAt: '2026-11-06T05:00:00.000Z' } }));
    assert.deepEqual(securitySetup(repo), { status: 'ok', detail: `code review cr-1 in account ${ACCOUNT} (us-west-2), set up 2026-11-06`, fix: '' });
    writeFileSync(join(repo, '.prism/config.json'), JSON.stringify({ security: { agentSpaceId: 'as-1' } }));
    assert.equal(securitySetup(repo).status, 'missing', 'an incomplete marker does not count');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('securityagent setup is a deprecated alias with the same flags', () => {
  assert.match(alias.description, /^\[deprecated\] Alias for "prism-cli enable security"/);
  assert.equal(alias.options, SECURITY_OPTIONS);
  assert.match(DEPRECATION[0], /deprecated; use "prism-cli enable security"/);
  assert.match(DEPRECATION[1], /--yes/);
  for (const f of ['--profile <name>', '--region <region>', '--yes', '--dry-run', '--status']) {
    assert.ok(SECURITY_OPTIONS.some((o) => o.flags === f), f);
  }
  assert.equal(SECURITY_OPTIONS.find((o) => o.flags === '--region <region>')!.default, 'us-west-2');
  assert.ok(!SECURITY_OPTIONS.some((o) => /uninstall|teardown|destroy/.test(o.flags)), 'no teardown in this command');
});
