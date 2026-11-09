import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AwsResult } from '../src/utils/aws.js';
import {
  credentialSource, DEPLOY_NOTICE, enableSecurity, isWriteCall, listsBucket, NO_REGION_MESSAGE, PARAM_AGENT_SPACE, PARAM_SCAN_BUCKET, PARAM_SERVICE_ROLE,
  PIPELINE_STACK, resolveRegion, STANDALONE_STACK, type CdkEnv, type Deps, type SecurityOptions,
} from '../src/security/setup.js';
import { codeReviewTitle, repoIdFromRemote, repoSlug } from '../src/security/repo.js';
import { categorize, diffTemplates } from '../src/security/cfn-diff.js';
import { explainAwsError, NO_CREDENTIALS_MESSAGE, redact } from '../src/security/errors.js';
import { MARKER_PATH, readSecurityMarker, readSecurityMarkerWithSource, removeLegacyBlock } from '../src/security/marker.js';
import { securitySetup } from '../src/dashboard/setup.js';
import alias, { DEPRECATION } from '../src/commands/securityagent/setup.js';
import { runEnableSecurity, SECURITY_OPTIONS, type RunHooks } from '../src/commands/enable/security.js';
import { describeUnexpectedError } from '../src/security/errors.js';

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
const meta = (path: string, stack = PIPELINE_STACK) => ({ 'aws:cdk:path': `${stack}/${path}` });

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

/** The standalone stack's template: the Security Agent resources and their own KMS key, nothing else. */
function standaloneTemplate(bucketProps: any = { B: 1 }) {
  const m = (p: string) => meta(p, STANDALONE_STACK);
  return {
    Resources: {
      SecurityAgentKey: { Type: 'AWS::KMS::Key', Properties: { K: 1 }, Metadata: m('SecurityAgentKey/Resource') },
      SecurityAgentRole1: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'r' }, Metadata: m('SecurityAgent/SecurityAgentRole/Resource') },
      SecurityAgentSpace: { Type: 'AWS::SecurityAgent::AgentSpace', Properties: { Name: 'prism-d1-security' }, Metadata: m('SecurityAgent/AgentSpace') },
      SecurityAgentBucket: { Type: 'AWS::S3::Bucket', Properties: bucketProps, Metadata: m('SecurityAgent/ScanBucket/Resource') },
      SecurityAgentBucketPolicy: { Type: 'AWS::S3::BucketPolicy', Properties: { P: 1 }, Metadata: m('SecurityAgent/ScanBucket/Policy/Resource') },
      ContinuumCiPolicy1: { Type: 'AWS::IAM::ManagedPolicy', Properties: { M: 1 }, Metadata: m('ContinuumCiPolicy/Resource') },
    },
  };
}

/** A pipeline deployed without Security Agent (the metrics-only layout). */
function pipelineWithoutSa() {
  const t = synthTemplate();
  return { Resources: { Processor: t.Resources.Processor } };
}

interface State {
  stack: any | null;               // deployed PrismD1MetricsPipeline template, or null when the stack does not exist
  standalone: any | null;          // deployed PrismD1SecurityAgent template, or null
  params: Record<string, string>;
  spaces: { agentSpaceId: string; name: string; s3Buckets?: string[] }[];
  apps: { applicationId: string; roleArn: string | null }[];
  reviews: { codeReviewId: string; title: string }[];
  objects: Record<string, string>; // key -> ETag (md5)
  roles?: string[];                // IAM role names that exist (default: the service role)
  deny?: string;                   // CLI command that returns AccessDenied
}

/** State after a complete setup: nothing left to do. */
function fullySetUp(): State {
  return {
    stack: synthTemplate(),
    standalone: null,
    params: { [PARAM_AGENT_SPACE]: 'as-1', [PARAM_SCAN_BUCKET]: BUCKET, [PARAM_SERVICE_ROLE]: ROLE, [PARAM]: 'cr-1' },
    spaces: [{ agentSpaceId: 'as-1', name: 'prism-d1-security', s3Buckets: [`arn:aws:s3:::${BUCKET}`] }],
    apps: [{ applicationId: 'app-1', roleArn: ROLE }],
    reviews: [{ codeReviewId: 'cr-1', title: codeReviewTitle(SLUG) }],
    objects: { [`repo/${SLUG}/latest.zip`]: ZIP_MD5 },
  };
}
const emptyAccount = (): State => ({ stack: null, standalone: null, params: {}, spaces: [], apps: [], reviews: [], objects: {} });

function arg(args: string[], flag: string): string { return args[args.indexOf(flag) + 1]; }

function fakeAws(state: State, log: string[][], regions: string[]) {
  let next = 1;
  return (args: string[], region: string): AwsResult => {
    log.push(args);
    regions.push(region);
    const tpl = () => (arg(args, '--stack-name') === STANDALONE_STACK ? state.standalone : state.stack);
    const [svc, cmd] = args;
    if (state.deny === cmd) return fail('AccessDeniedException', `An error occurred (AccessDeniedException) when calling the ${cmd.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('')} operation: User: arn:aws:sts::${ACCOUNT}:assumed-role/Dev/me is not authorized to perform: ${svc}:${cmd.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('')} on resource: *`);
    switch (`${svc} ${cmd}`) {
      case 'sts get-caller-identity': return res({ json: { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Dev/me` } });
      case 'iam list-account-aliases': return res({ json: { AccountAliases: ['acme-dev'] } });
      case 'iam get-role': {
        const existing = state.roles ?? ((state.stack || state.standalone) ? [ROLE.split('/').pop()!] : []);
        return existing.includes(arg(args, '--role-name')) ? res({ json: { Role: { RoleName: arg(args, '--role-name') } } }) : fail('NoSuchEntity', `An error occurred (NoSuchEntity) when calling the GetRole operation: The role with name ${arg(args, '--role-name')} cannot be found.`);
      }
      case 'cloudformation describe-stacks':
        return tpl() ? res({ json: { Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] } }) : fail('ValidationError', `An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${arg(args, '--stack-name')} does not exist`);
      case 'cloudformation get-template': return res({ json: { TemplateBody: tpl() } });
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
      case 'securityagent list-agent-spaces': return res({ json: { agentSpaceSummaries: state.spaces.map(({ agentSpaceId, name }) => ({ agentSpaceId, name })) } });
      case 'securityagent batch-get-agent-spaces': {
        const ids = args.slice(args.indexOf('--agent-space-ids') + 1);
        return res({ json: { agentSpaces: state.spaces.filter((s) => ids.includes(s.agentSpaceId)).map((s) => ({ agentSpaceId: s.agentSpaceId, name: s.name, awsResources: { iamRoles: [ROLE], s3Buckets: s.s3Buckets ?? [] } })) } });
      }
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
  /** Stack and CDK env of each deploy. */
  targets: { stack: string; env: CdkEnv }[];
  /** Synth contexts. */
  contexts: Record<string, string>[];
  /** The region every aws call was given. */
  regions: string[];
  questions: string[];
  repo: string;
  out: () => string;
  writes: () => string[];
  cleanup: () => void;
}

function harness(state: State, o: { ignored?: boolean; tty?: boolean; answers?: string[]; synth?: any; synthStandalone?: any; cliVersion?: string; inRepo?: boolean; env?: NodeJS.ProcessEnv; configRegion?: string | null } = {}): Harness {
  const repo = mkdtempSync(join(tmpdir(), 'prism-sec-repo-'));
  const calls: string[][] = []; const lines: string[] = []; const deploys: { approveAll: boolean }[] = []; const questions: string[] = [];
  const answers = [...(o.answers ?? [])];
  const synth = o.synth ?? synthTemplate();
  const synthStandalone = o.synthStandalone ?? standaloneTemplate();
  const targets: { stack: string; env: CdkEnv }[] = []; const contexts: Record<string, string>[] = []; const regions: string[] = [];
  const deps: Deps = {
    aws: fakeAws(state, calls, regions),
    configRegion: () => (o.configRegion === undefined ? null : o.configRegion),
    env: o.env ?? {},
    awsVersion: () => o.cliVersion ?? 'aws-cli/2.36.19 Python/3.14',
    cdk: {
      synth(outDir, context) {
        contexts.push(context);
        mkdirSync(outDir, { recursive: true });
        if (context.securityAgentStandalone === 'true') writeFileSync(join(outDir, `${STANDALONE_STACK}.template.json`), JSON.stringify(synthStandalone));
        else writeFileSync(join(outDir, `${PIPELINE_STACK}.template.json`), JSON.stringify(synth));
        return { ok: true, stdout: '', stderr: '' };
      },
      diff: (_dir, stack) => ({ ok: true, output: `Stack ${stack}\nIAM Statement Changes\n...` }),
      deploy(_dir, stack, env, opts) {
        deploys.push(opts);
        targets.push({ stack, env });
        if (stack === STANDALONE_STACK) state.standalone = synthStandalone; else state.stack = synth;
        state.params[PARAM_AGENT_SPACE] = 'as-1'; state.params[PARAM_SCAN_BUCKET] = BUCKET; state.params[PARAM_SERVICE_ROLE] = ROLE;
        if (!state.spaces.length) state.spaces.push({ agentSpaceId: 'as-1', name: 'prism-d1-security' });
        return true;
      },
    },
    git(args) {
      if (o.inRepo === false) return { ok: false, stdout: '', stderr: 'fatal: not a git repository' };
      if (args.includes('--git-path')) return { ok: true, stdout: join(repo, '.git-dir', 'info', 'exclude'), stderr: '' };
      if (args.includes('rev-parse')) return { ok: true, stdout: repo, stderr: '' };
      if (args[0] === 'remote') return { ok: true, stdout: REMOTE, stderr: '' };
      if (args.includes('check-ignore')) {
        const ex = join(repo, '.git-dir', 'info', 'exclude');
        const inExclude = existsSync(ex) && readFileSync(ex, 'utf8').split('\n').includes('.prism/security.local.json');
        return { ok: !!o.ignored || inExclude, stdout: '', stderr: '' };
      }
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
    deps, state, calls, lines, deploys, targets, contexts, regions, questions, repo,
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
    assert.match(out, /Account: {5}111122223333 \(acme-dev\)/);
    assert.match(out, /Stack: {7}PrismD1SecurityAgent \(no Security Agent resources found, so the standalone PrismD1SecurityAgent stack is used\)/);
    assert.match(out, /Stack PrismD1SecurityAgent \(new stack\): 6 to add, 0 to change, 0 to remove/);
    assert.match(out, /IAM and resource policies:\n\s+\+ AWS::IAM::ManagedPolicy {2}ContinuumCiPolicy/);
    assert.match(out, /Public endpoints \(.*\): none/);
    assert.match(out, /cdk deploy --app \S+ PrismD1SecurityAgent --exclusively/);
    assert.deepEqual(h.contexts, [{ securityAgentStandalone: 'true' }]);
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
    assert.match(h.questions[0], /Deploy PrismD1SecurityAgent .* in account 111122223333 \(acme-dev\), region us-west-2\? \[y\/N\]/);
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
    const first = readFileSync(join(h.repo, MARKER_PATH), 'utf8');
    h.deps.now = () => new Date('2027-01-01T00:00:00Z');
    assert.equal(await enableSecurity(opts(), h.deps), 0);
    assert.equal(readFileSync(join(h.repo, MARKER_PATH), 'utf8'), first, 'setupAt is kept when nothing changed');
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

test('--status with no credentials prints the same sign-in hint as the other commands', async () => {
  const h = harness(fullySetUp());
  const real = h.deps.aws;
  h.deps.aws = (args, region) => args[0] === 'sts'
    ? { ok: false, json: null, errorCode: '', raw: 'Unable to locate credentials. You can configure credentials by running "aws configure".' }
    : real(args, region);
  try {
    assert.equal(await enableSecurity(opts({ status: true }), h.deps), 1);
    const out = h.out();
    assert.match(out, /\[missing\] Credentials: Failed to get account ID\. Check your AWS credentials\.\n {2}Configure them with "aws configure" or "aws sso login", or pass --profile <name>\./);
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
      /\[ok\] Scan bucket on agent space: security-agent-scans-\S+ is in awsResources\.s3Buckets/,
      /\[ok\] Code review: cr-1 \(".*"\) from \/prism\/continuum\/code-review-id\/github\.com-acme-widgets/,
      /\[warn\] Legacy SSM: \/prism\/continuum\/code-review-id = cr-old/,
      /\[ok\] CI workflow step: \.github\/workflows\/prism-eval-gate\.yml/,
      /\[missing\] Local marker/,
    ]) assert.match(out, re);
  } finally { h.cleanup(); }
});

test('--status flags an agent space that does not list the scan bucket', async () => {
  const s = fullySetUp(); s.spaces[0].s3Buckets = [];
  const h = harness(s);
  try {
    assert.equal(await enableSecurity(opts({ status: true }), h.deps), 0);
    assert.match(h.out(), /\[missing\] Scan bucket on agent space: security-agent-scans-\S+ is not in awsResources\.s3Buckets, so security threat-model fails; run prism-cli enable security/);
    assert.deepEqual(h.writes(), []);
  } finally { h.cleanup(); }
});

test('listsBucket matches a bucket by name or ARN, nothing else', () => {
  assert.ok(listsBucket(['my-bucket'], 'my-bucket'));
  assert.ok(listsBucket(['arn:aws:s3:::my-bucket'], 'my-bucket'));
  assert.ok(listsBucket(['arn:aws-cn:s3:::my-bucket'], 'my-bucket'));
  assert.ok(!listsBucket(['arn:aws:s3:::my-bucket-2', 'other'], 'my-bucket'));
  assert.ok(!listsBucket([], 'my-bucket'));
});

test('--status on an account with nothing deployed', async () => {
  const h = harness(emptyAccount());
  try {
    assert.equal(await enableSecurity(opts({ status: true }), h.deps), 0);
    assert.match(h.out(), /\[missing\] Stack: neither PrismD1MetricsPipeline \(not deployed\) nor PrismD1SecurityAgent holds Security Agent/);
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

test('the marker is its own file with ids only, and .prism/config.json is left alone', async () => {
  const h = harness(fullySetUp());
  mkdirSync(join(h.repo, '.prism'));
  writeFileSync(join(h.repo, '.prism/config.json'), JSON.stringify({ team_id: 'team-a', eval: { reviewer: 'kiro' } }));
  try {
    assert.equal(await enableSecurity(opts(), h.deps), 0);
    assert.equal(readFileSync(join(h.repo, '.prism/config.json'), 'utf8'), JSON.stringify({ team_id: 'team-a', eval: { reviewer: 'kiro' } }));
    const m = JSON.parse(readFileSync(join(h.repo, MARKER_PATH), 'utf8'));
    assert.deepEqual(Object.keys(m).sort(), ['account', 'agentSpaceId', 'applicationId', 'codeReviewId', 'region', 'setupAt']);
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
  const d = diffTemplates(synthTemplate(), { Resources: { ...synthTemplate().Resources, Extra: { Type: 'AWS::EC2::SecurityGroup', Properties: {} } } } as any, PIPELINE_STACK);
  assert.deepEqual(d.changes.map((c) => [c.change, c.type]), [['add', 'AWS::EC2::SecurityGroup']]);
  assert.equal(d.touchesSecurityAgent, false);
  // The scan bucket's autoDeleteObjects adds a stack-level provider; it belongs to the feature.
  const p = diffTemplates({ Resources: {} }, { Resources: { Prov: { Type: 'AWS::IAM::Role', Metadata: meta('Custom::S3AutoDeleteObjectsCustomResourceProvider/Role') } } } as any, PIPELINE_STACK);
  assert.equal(p.changes[0].securityAgent, true);
  const r = diffTemplates(synthTemplate(), { Resources: {} }, PIPELINE_STACK);
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
  // No hardcoded defaults: the AWS credential chain and region resolution apply.
  assert.equal(SECURITY_OPTIONS.find((o) => o.flags === '--region <region>')!.default, undefined);
  assert.equal(SECURITY_OPTIONS.find((o) => o.flags === '--profile <name>')!.default, undefined);
  assert.ok(!SECURITY_OPTIONS.some((o) => /uninstall|teardown|destroy/.test(o.flags)), 'no teardown in this command');
});

// --------------------------------------------------------------- notice, identity, region

test('the deploy notice comes before any AWS call; identity is shown before the plan', async () => {
  const s = emptyAccount();
  const h = harness(s, { tty: true, answers: ['n'], env: { AWS_PROFILE: 'dev' } });
  const order: string[] = [];
  const log = h.deps.log, aws = h.deps.aws;
  h.deps.log = (l = '') => { order.push(`log:${l}`); log(l); };
  h.deps.aws = (a, r) => { order.push(`aws:${a[0]} ${a[1]}`); return aws(a, r); };
  try {
    await enableSecurity(opts(), h.deps);
    const firstAws = order.findIndex((x) => x.startsWith('aws:'));
    assert.deepEqual(order.slice(0, DEPLOY_NOTICE.length).map((x) => x.slice(4)), DEPLOY_NOTICE);
    assert.ok(firstAws > DEPLOY_NOTICE.length);
    assert.match(DEPLOY_NOTICE.join(' '), /Security Agent space, an IAM service role and policies, an encrypted S3 scan bucket and SSM parameters\. These may incur cost/);
    const out = h.out();
    assert.match(out, /Account: {5}111122223333 \(acme-dev\)\nCaller: {6}arn:aws:sts::111122223333:assumed-role\/Dev\/me\nRegion: {6}us-west-2 \(--region\)\nCredentials: profile dev \(AWS_PROFILE\)/);
    assert.ok(out.indexOf('Caller:') < out.indexOf('to add'), 'identity before the diff');
  } finally { h.cleanup(); }
});

test('--status and --dry-run print a one-line read-only notice instead', async () => {
  for (const [flag, re] of [['status', /^Read-only status check \(--status\): nothing will be changed\.$/], ['dryRun', /^Dry run \(--dry-run\): every lookup runs, nothing will be changed\.$/]] as const) {
    const h = harness(fullySetUp());
    try {
      await enableSecurity(opts({ [flag]: true }), h.deps);
      assert.match(h.lines[0], re);
      assert.ok(!h.out().includes(DEPLOY_NOTICE[0]));
    } finally { h.cleanup(); }
  }
});

test('region: --region, then AWS_REGION, AWS_DEFAULT_REGION, then the profile region', () => {
  const none = { env: {}, configRegion: () => null };
  assert.deepEqual(resolveRegion({ region: 'eu-west-1' }, { env: { AWS_REGION: 'us-east-1' }, configRegion: () => 'ap-south-1' }), { region: 'eu-west-1', source: '--region' });
  assert.deepEqual(resolveRegion({}, { env: { AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-2' }, configRegion: () => 'x' }), { region: 'us-east-1', source: 'AWS_REGION' });
  assert.deepEqual(resolveRegion({}, { env: { AWS_DEFAULT_REGION: 'us-east-2' }, configRegion: () => 'x' }), { region: 'us-east-2', source: 'AWS_DEFAULT_REGION' });
  let asked: string | undefined = 'unset';
  assert.deepEqual(resolveRegion({ profile: 'dev' }, { env: {}, configRegion: (p) => { asked = p; return 'ap-south-1'; } }), { region: 'ap-south-1', source: 'region configured for profile dev' });
  assert.equal(asked, 'dev', 'asks the --profile profile');
  assert.deepEqual(resolveRegion({}, { env: { AWS_PROFILE: 'ops' }, configRegion: () => 'ca-central-1' }), { region: 'ca-central-1', source: 'region configured for profile ops (AWS_PROFILE)' });
  assert.equal(resolveRegion({}, none), null);
});

test('no region anywhere: refuses with no AWS call', async () => {
  const h = harness(fullySetUp());
  try {
    assert.equal(await enableSecurity({ dryRun: true }, h.deps), 1);
    assert.match(h.out(), new RegExp(`Error: ${NO_REGION_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(h.calls.length, 0);
  } finally { h.cleanup(); }
});

test('the resolved region reaches every aws call and CDK', async () => {
  const h = harness(emptyAccount(), { env: { AWS_REGION: 'eu-central-1' } });
  try {
    assert.equal(await enableSecurity({ yes: true }, h.deps), 0);
    assert.ok(h.regions.length > 5);
    assert.ok(h.regions.every((r) => r === 'eu-central-1'), [...new Set(h.regions)].join(','));
    assert.deepEqual(h.targets.map((t) => t.env), [{ account: ACCOUNT, region: 'eu-central-1' }]);
    assert.match(h.out(), /Region: {6}eu-central-1 \(AWS_REGION\)/);
    assert.ok(!h.out().includes('--profile'), 'no --profile in any printed command when none was given');
  } finally { h.cleanup(); }
});

test('credential source is described without reading credentials', () => {
  assert.equal(credentialSource({ profile: 'p' }, { AWS_PROFILE: 'q' }), 'profile p (--profile)');
  assert.equal(credentialSource({}, { AWS_PROFILE: 'q' }), 'profile q (AWS_PROFILE)');
  assert.equal(credentialSource({}, { AWS_ACCESS_KEY_ID: 'AKIA...' }), 'environment variables (AWS_ACCESS_KEY_ID)');
  assert.match(credentialSource({}, {}), /^the default credential chain/);
});

// --------------------------------------------------------------- which stack

test('an account with Security Agent in the pipeline keeps the pipeline layout', async () => {
  const h = harness(fullySetUp(), { tty: false });
  try {
    assert.equal(await enableSecurity(opts({ dryRun: true }), h.deps), 0);
    assert.match(h.out(), /Stack: {7}PrismD1MetricsPipeline \(this account already hosts Security Agent in PrismD1MetricsPipeline, so that stack is kept\)/);
    assert.deepEqual(h.contexts, [{ enableSecurityAgent: 'true' }]);
  } finally { h.cleanup(); }
});

test('a pipeline deployed without Security Agent is left alone; the standalone stack is used', async () => {
  const s = emptyAccount(); s.stack = pipelineWithoutSa();
  const h = harness(s);
  try {
    assert.equal(await enableSecurity(opts({ yes: true }), h.deps), 0);
    assert.deepEqual(h.targets.map((t) => t.stack), [STANDALONE_STACK]);
    assert.deepEqual(h.state.stack, pipelineWithoutSa(), 'pipeline not redeployed');
    assert.match(h.out(), /PrismD1MetricsPipeline is deployed without them and is not touched/);
  } finally { h.cleanup(); }
});

test('the standalone layout is re-used, re-runs change nothing, and drift redeploys it', async () => {
  const s = fullySetUp(); s.stack = null; s.standalone = standaloneTemplate();
  const h = harness(s);
  try {
    assert.equal(await enableSecurity(opts(), h.deps), 0);
    assert.match(h.out(), /Already set up: nothing to change\./);
    assert.equal(h.targets.length, 0);
  } finally { h.cleanup(); }
  const s2 = fullySetUp(); s2.stack = null; s2.standalone = standaloneTemplate();
  const h2 = harness(s2, { synthStandalone: standaloneTemplate({ B: 2 }) });
  try {
    assert.equal(await enableSecurity(opts({ yes: true }), h2.deps), 0);
    assert.match(h2.out(), /0 to add, 1 to change, 0 to remove/);
    assert.deepEqual(h2.targets.map((t) => t.stack), [STANDALONE_STACK]);
  } finally { h2.cleanup(); }
});

test('an agent space no stack manages stops the run instead of creating a second one', async () => {
  const s = emptyAccount(); s.spaces = [{ agentSpaceId: 'as-manual', name: 'prism-d1-security' }];
  const h = harness(s);
  try {
    assert.equal(await enableSecurity(opts({ yes: true }), h.deps), 1);
    assert.match(h.out(), /an agent space named prism-d1-security exists, but neither PrismD1MetricsPipeline nor PrismD1SecurityAgent manages it/);
    assert.equal(h.targets.length, 0);
    assert.deepEqual(h.writes(), []);
  } finally { h.cleanup(); }
});

test('both layouts present is refused', async () => {
  const s = fullySetUp(); s.standalone = standaloneTemplate();
  const h = harness(s);
  try {
    assert.equal(await enableSecurity(opts({ yes: true }), h.deps), 1);
    assert.match(h.out(), /both PrismD1MetricsPipeline and PrismD1SecurityAgent hold Security Agent resources/);
    assert.deepEqual(h.writes(), []);
  } finally { h.cleanup(); }
});

test('--context cannot switch the layout: the mode key is set by the command', async () => {
  const h = harness(emptyAccount());
  try {
    assert.equal(await enableSecurity(opts({ dryRun: true, context: ['enableSecurityAgent=true', 'securityAgentKmsKeyArn=arn:aws:kms:us-west-2:111122223333:key/k'] }), h.deps), 0);
    assert.deepEqual(h.contexts, [{ securityAgentKmsKeyArn: 'arn:aws:kms:us-west-2:111122223333:key/k', securityAgentStandalone: 'true' }]);
  } finally { h.cleanup(); }
});

// --------------------------------------------------------------- role existence, marker message

test('--status warns when the attached role does not exist (leftover application, no stack)', async () => {
  const s = emptyAccount(); s.apps = [{ applicationId: 'app-old', roleArn: ROLE }];
  const h = harness(s);
  try {
    assert.equal(await enableSecurity(opts({ status: true }), h.deps), 0);
    assert.match(h.out(), /\[warn\] Application: app-old: role prism-d1-security-agent-prism-d1-security attached but does not exist; run prism-cli enable security/);
    assert.deepEqual(h.writes(), []);
  } finally { h.cleanup(); }
});

test('--status names the application it checked when there are several', async () => {
  const s = fullySetUp(); s.apps.push({ applicationId: 'app-2', roleArn: null });
  const h = harness(s);
  try {
    assert.equal(await enableSecurity(opts({ status: true }), h.deps), 0);
    assert.match(h.out(), /\[ok\] Application: app-1, role attached \(2 applications in this region; checked the first\)/);
  } finally { h.cleanup(); }
});

test('setup plan: a deployed stack whose role is gone is BLOCKED, and nothing is changed', async () => {
  const s = fullySetUp(); s.roles = [];
  const h = harness(s);
  try {
    assert.equal(await enableSecurity(opts({ dryRun: true }), h.deps), 0);
    assert.match(h.out(), /\[BLOCKED\] Application: app-1: role prism-d1-security-agent-prism-d1-security does not exist although the stack is deployed/);
  } finally { h.cleanup(); }
  const s2 = fullySetUp(); s2.roles = [];
  const h2 = harness(s2);
  try {
    assert.equal(await enableSecurity(opts({ yes: true }), h2.deps), 1);
    assert.match(h2.out(), /Error: Application: .* Nothing was changed\./);
    assert.deepEqual(h2.writes(), []);
  } finally { h2.cleanup(); }
});

test('a leftover application with a missing role is fixed by the deploy, not blocked', async () => {
  const s = emptyAccount(); s.apps = [{ applicationId: 'app-old', roleArn: ROLE }];
  const h = harness(s);
  try {
    assert.equal(await enableSecurity(opts({ yes: true }), h.deps), 0);
    assert.deepEqual(h.targets.map((t) => t.stack), [STANDALONE_STACK]);
    assert.match(h.out(), /\[ok\] Application: app-old, role attached/);
  } finally { h.cleanup(); }
});

test('the marker message names the new file and says it is local and not committed', async () => {
  const h = harness(fullySetUp(), { ignored: true });
  try {
    assert.equal(await enableSecurity(opts(), h.deps), 0);
    assert.ok(h.out().includes(`Wrote ${join(h.repo, MARKER_PATH)} (ids, account and region; no secrets; local only, not committed)`), h.out());
    assert.doesNotMatch(h.out(), /commit it|teammates|Added .* so git ignores it/);
    assert.equal(existsSync(join(h.repo, '.git-dir', 'info', 'exclude')), false, 'already ignored: info/exclude untouched');
  } finally { h.cleanup(); }
});

test('not ignored: the marker path is added to info/exclude once, never to .gitignore', async () => {
  const h = harness(fullySetUp(), { ignored: false });
  const ex = join(h.repo, '.git-dir', 'info', 'exclude');
  mkdirSync(join(h.repo, '.git-dir', 'info'), { recursive: true });
  writeFileSync(ex, '# existing\n*.swp');
  try {
    assert.equal(await enableSecurity(opts(), h.deps), 0);
    assert.match(h.out(), new RegExp(`Added \\.prism/security\\.local\\.json to ${ex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} so git ignores it`));
    assert.equal(await enableSecurity(opts(), h.deps), 0);
    const lines = readFileSync(ex, 'utf8').split('\n');
    assert.equal(lines.filter((l) => l === MARKER_PATH).length, 1, 'added once');
    assert.equal(lines[1], '*.swp', 'existing lines kept');
    assert.equal(existsSync(join(h.repo, '.gitignore')), false);
  } finally { h.cleanup(); }
});

const LEGACY = { agentSpaceId: 'as-1', applicationId: 'app-1', codeReviewId: 'cr-1', region: 'us-west-2', account: ACCOUNT, setupAt: '2026-11-06T05:00:00.000Z' };

test('readers fall back to a legacy security block in .prism/config.json', () => {
  const repo = mkdtempSync(join(tmpdir(), 'prism-sec-legacy-'));
  try {
    mkdirSync(join(repo, '.prism'));
    writeFileSync(join(repo, '.prism/config.json'), JSON.stringify({ team_id: 't', security: LEGACY }));
    assert.deepEqual(readSecurityMarkerWithSource(repo), { marker: LEGACY, source: 'legacy' });
    assert.equal(securitySetup(repo).status, 'ok');
    writeFileSync(join(repo, MARKER_PATH), JSON.stringify({ ...LEGACY, codeReviewId: 'cr-new' }));
    assert.equal(readSecurityMarkerWithSource(repo)!.source, 'local', 'the local file wins');
    assert.match(securitySetup(repo).detail, /code review cr-new/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('--status reports a legacy block as waiting to move', async () => {
  const h = harness(fullySetUp());
  mkdirSync(join(h.repo, '.prism'));
  writeFileSync(join(h.repo, '.prism/config.json'), JSON.stringify({ security: LEGACY }));
  try {
    assert.equal(await enableSecurity(opts({ status: true }), h.deps), 0);
    assert.match(h.out(), /\[warn\] Local marker: legacy security block in \.prism\/config\.json .* moves it to \.prism\/security\.local\.json/);
    assert.ok(JSON.parse(readFileSync(join(h.repo, '.prism/config.json'), 'utf8')).security, '--status never moves it');
  } finally { h.cleanup(); }
});

test('a successful run moves the legacy block: new file, only the security key removed, formatting kept', async () => {
  const h = harness(fullySetUp(), { ignored: true });
  mkdirSync(join(h.repo, '.prism'));
  const before = { team_id: 'team-a', eval: { reviewer: 'kiro', timeout_seconds: 300 }, security: LEGACY, zeta: [1, 2] };
  writeFileSync(join(h.repo, '.prism/config.json'), JSON.stringify(before, null, 4) + '\n');
  try {
    assert.equal(await enableSecurity(opts(), h.deps), 0);
    const { security, ...rest } = before;
    assert.equal(readFileSync(join(h.repo, '.prism/config.json'), 'utf8'), JSON.stringify(rest, null, 4) + '\n');
    assert.deepEqual(JSON.parse(readFileSync(join(h.repo, MARKER_PATH), 'utf8')), security, 'same ids, setupAt kept');
    assert.match(h.out(), /Moved the security block out of \.prism\/config\.json into \.prism\/security\.local\.json/);
  } finally { h.cleanup(); }
});

test('removeLegacyBlock leaves a config without a security key untouched', () => {
  const repo = mkdtempSync(join(tmpdir(), 'prism-sec-legacy-'));
  try {
    mkdirSync(join(repo, '.prism'));
    const text = '{\n  "team_id": "t"\n}';
    writeFileSync(join(repo, '.prism/config.json'), text);
    assert.equal(removeLegacyBlock(repo), false);
    assert.equal(readFileSync(join(repo, '.prism/config.json'), 'utf8'), text);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('dashboard Security Agent row reads the new file', () => {
  const repo = mkdtempSync(join(tmpdir(), 'prism-sec-dash-'));
  try {
    mkdirSync(join(repo, '.prism'));
    writeFileSync(join(repo, MARKER_PATH), JSON.stringify(LEGACY));
    assert.deepEqual(securitySetup(repo), { status: 'ok', detail: `code review cr-1 in account ${ACCOUNT} (us-west-2), set up 2026-11-06`, fix: '' });
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// --------------------------------------------------------------- unexpected (non-Abort) errors

/** Runs the real entry point with a harness whose step `where` throws `err`. */
async function runThrowing(where: 'synth' | 'deploy', err: Error, env: NodeJS.ProcessEnv = {}, viaAlias = false) {
  const h = harness(emptyAccount());
  if (where === 'synth') h.deps.cdk.synth = () => { throw err; };
  else h.deps.cdk.deploy = () => { throw err; };
  const errors: string[] = []; const exits: number[] = [];
  const hooks: RunHooks = { deps: () => h.deps, error: (l) => errors.push(l), exit: (c) => exits.push(c), env };
  const warn = console.warn; console.warn = () => {};
  try {
    if (viaAlias) await alias.action(opts({ yes: true }), hooks);
    else await runEnableSecurity(opts({ yes: true }), hooks);
  } finally { console.warn = warn; h.cleanup(); }
  return { errors, exits };
}

/** Shaped like an execFileSync failure: the message names the command, and cmd/envPairs carry more. */
function childError(message: string): Error {
  return Object.assign(new Error(message), {
    status: 1, cmd: 'npm install AWS_SECRET_ACCESS_KEY=leak', envPairs: ['AWS_SECRET_ACCESS_KEY=leak'],
    stderr: 'aws_secret_access_key = leak', spawnargs: ['npm', 'install'],
  });
}

test('a thrown npm failure: exit 1, one redacted Error line plus a hint, no stack, no child-process fields', async () => {
  const { errors, exits } = await runThrowing('synth', childError('Command failed: npm install --no-audit --no-fund\nnpm ERR! network AKIAABCDEFGHIJKLMNOP'));
  assert.deepEqual(exits, [1]);
  assert.equal(errors[0], 'Error: Command failed: npm install --no-audit --no-fund');
  assert.match(errors[1], /Installing the CDK app dependencies failed/);
  assert.equal(errors.length, 2);
  const all = errors.join('\n');
  assert.doesNotMatch(all, /leak|AKIA|\n\s+at /);
});

test('a thrown deploy error and a JSON parse error: exit 1, Error line, matching hint, no stack', async () => {
  const d = await runThrowing('deploy', new Error('spawnSync cdk ENOENT'));
  assert.deepEqual(d.exits, [1]);
  assert.equal(d.errors[0], 'Error: spawnSync cdk ENOENT');
  assert.match(d.errors[1], /The CDK step failed/);
  assert.ok(!d.errors.join('\n').includes('    at '));
  let parseErr: Error;
  try { JSON.parse('{nope'); throw new Error('unreachable'); } catch (e) { parseErr = e as Error; }
  const j = await runThrowing('synth', parseErr!);
  assert.deepEqual(j.exits, [1]);
  assert.match(j.errors[0], /^Error: /);
  assert.match(j.errors[1], /not valid JSON/);
  assert.equal(j.errors.length, 2);
});

test('PRISM_DEBUG=1 adds the redacted stack', async () => {
  const err = new Error('boom with AKIAABCDEFGHIJKLMNOP');
  const { errors, exits } = await runThrowing('synth', err, { PRISM_DEBUG: '1' });
  assert.deepEqual(exits, [1]);
  assert.equal(errors[0], 'Error: boom with [redacted access key]');
  assert.match(errors.join('\n'), /\n\s+at /, 'stack shown');
  assert.doesNotMatch(errors.join('\n'), /AKIAABCDEFGHIJKLMNOP/, 'stack redacted');
});

test('the deprecated alias gets the same handling', async () => {
  const { errors, exits } = await runThrowing('deploy', new Error('fatal: not a git repository'), {}, true);
  assert.deepEqual(exits, [1]);
  assert.equal(errors[0], 'Error: fatal: not a git repository');
  assert.match(errors[1], /git command failed/);
  assert.equal(errors.length, 2);
});

test('Abort errors keep their own message and exit code; the wrapper adds nothing', async () => {
  const h = harness(fullySetUp());
  const errors: string[] = []; const exits: number[] = [];
  try {
    await runEnableSecurity({ dryRun: true }, { deps: () => h.deps, error: (l) => errors.push(l), exit: (c) => exits.push(c), env: {} });
    assert.deepEqual(exits, [1]);
    assert.deepEqual(errors, []);
    assert.match(h.out(), /Error: No AWS region is set/);
  } finally { h.cleanup(); }
});

test('file-system errors get a code and syscall hint; a non-Error value still prints one line', () => {
  const fsErr = Object.assign(new Error("EACCES: permission denied, open '/x/.prism/security.local.json'"), { code: 'EACCES', syscall: 'open' });
  assert.match(describeUnexpectedError(fsErr, {})[1], /EACCES during open/);
  assert.deepEqual(describeUnexpectedError('plain string', {}), ['Error: plain string']);
});

test('paths containing cdk or .git do not pick the cdk or git hint', () => {
  const gitPath = Object.assign(new Error("EACCES: permission denied, open '/repo/.git/config'"), { code: 'EACCES', syscall: 'open' });
  assert.match(describeUnexpectedError(gitPath, {})[1], /File system error \(EACCES during open\)/);
  let parse: Error;
  try { JSON.parse('{x'); throw new Error('unreachable'); } catch (e) { parse = e as Error; }
  parse!.message += ' in /tmp/cdk.out/PrismD1SecurityAgent.template.json (aws-cdk-lib)';
  assert.match(describeUnexpectedError(parse!, {})[1], /not valid JSON/);
  const noCdk = Object.assign(new Error('spawn /infra/node_modules/.bin/cdk ENOENT'), { code: 'ENOENT', syscall: 'spawn /infra/node_modules/.bin/cdk' });
  assert.match(describeUnexpectedError(noCdk, {})[1], /Could not start a program \(ENOENT/);
  assert.match(describeUnexpectedError(new Error('cdk deploy exited 1'), {})[1], /The CDK step failed/);
  assert.match(describeUnexpectedError(new Error('fatal: not a git repository'), {})[1], /git command failed/);
});
