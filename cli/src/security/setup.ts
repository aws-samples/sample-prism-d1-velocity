/**
 * `prism-cli enable security`: sets up AWS Security Agent for PRISM, safely.
 *
 * Compared with the old `securityagent setup`:
 * - deploys only the stack that holds the Security Agent resources, never --all;
 * - shows a resource diff (IAM, network and public endpoints called out) and
 *   asks before any write, naming the account and region; --yes approves for
 *   non-interactive use, and with no terminal and no --yes it refuses;
 * - --dry-run runs every read and prints the exact calls it would make;
 * - is idempotent: existing agent space, application, code review, S3 object
 *   and SSM parameter are reused, and drift is shown before it is changed;
 * - --status is a read-only report;
 * - writes the per-repo code review where the CI eval gate looks for it
 *   (/prism/continuum/code-review-id/<repo-slug>), which the old command did not.
 *
 * Every AWS call goes through deps.aws, so tests run it against a fake.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AwsResult } from '../utils/aws.js';
import type { RunResult } from '../utils/exec.js';
import { diffTemplates, formatDiff, type CfnTemplate, type TemplateDiff } from './cfn-diff.js';
import { cliVersionOk, explainAwsError, MIN_AWS_CLI_TEXT, redact } from './errors.js';
import { readSecurityMarker, writeSecurityMarker } from './marker.js';
import { codeReviewParam, codeReviewTitle, repoIdFromRemote, repoSlug, repoZipKey, SSM_PREFIX } from './repo.js';

/** Hosts Security Agent when deployed with enableSecurityAgent=true (the original layout). */
export const PIPELINE_STACK = 'PrismD1MetricsPipeline';
/** The standalone stack (infra context securityAgentStandalone=true): Security Agent only. */
export const STANDALONE_STACK = 'PrismD1SecurityAgent';
export const AGENT_SPACE_NAME = 'prism-d1-security';
export const SERVICE_ROLE_NAME = `prism-d1-security-agent-${AGENT_SPACE_NAME}`;
export const PARAM_AGENT_SPACE = `${SSM_PREFIX}/agent-space-id`;
export const PARAM_SCAN_BUCKET = `${SSM_PREFIX}/scan-bucket`;
export const PARAM_SERVICE_ROLE = `${SSM_PREFIX}/service-role-arn`;
/** Written by the old `securityagent setup`; nothing reads it. Reported, never written. */
export const LEGACY_PARAM_CODE_REVIEW = `${SSM_PREFIX}/code-review-id`;

export interface SecurityOptions {
  /** Unset: the standard AWS credential chain, and no --profile is passed anywhere. */
  profile?: string;
  /** Unset: resolved like the AWS CLI does (see resolveRegion). */
  region?: string;
  yes?: boolean;
  dryRun?: boolean;
  status?: boolean;
  /** host/owner/name, overriding the origin remote. */
  repo?: string;
  /** Extra `cdk -c key=value` pairs, for stacks deployed with non-default context. */
  context?: string[];
}

/** Where CDK runs: the account from STS and the resolved region (CDK_DEFAULT_*). */
export interface CdkEnv { account: string; region: string }

export interface CdkRunner {
  /** `cdk synth -o outDir -c ...` for the whole app. */
  synth(outDir: string, context: Record<string, string>, env: CdkEnv): RunResult;
  /** `cdk diff --app outDir <stack>`; output is the full text. */
  diff(outDir: string, stack: string, env: CdkEnv): { ok: boolean; output: string };
  /** `cdk deploy --app outDir <stack> --exclusively`, attached to the terminal. */
  deploy(outDir: string, stack: string, env: CdkEnv, opts: { approveAll: boolean }): boolean;
}

export interface Deps {
  /** `aws <args> --region <region>` with --output json, plus --profile only when one was given. */
  aws(args: string[], region: string): AwsResult;
  /** `aws configure get region [--profile p]`: the configured region, or null. Local, no AWS call. */
  configRegion(profile?: string): string | null;
  env: NodeJS.ProcessEnv;
  awsVersion(): string | null;
  cdk: CdkRunner;
  /** `git <args>` in the working directory. */
  git(args: string[]): RunResult;
  makeTempDir(): string;
  isTTY: boolean;
  ask(question: string): Promise<string>;
  log(line?: string): void;
  now(): Date;
}

class Abort extends Error {}

// ---------------------------------------------------------------------------
// Exact AWS calls. Dry-run prints these; apply runs them. One builder each so
// the two can never disagree.
// ---------------------------------------------------------------------------
export const calls = {
  createApplication: () => ['securityagent', 'create-application'],
  updateApplication: (id: string, roleArn: string) => ['securityagent', 'update-application', '--application-id', id, '--role-arn', roleArn],
  putObject: (bucket: string, key: string, file: string) => ['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', file],
  createCodeReview: (spaceId: string, title: string, roleArn: string, bucket: string, key: string) => [
    'securityagent', 'create-code-review', '--agent-space-id', spaceId, '--title', title, '--service-role', roleArn,
    '--assets', JSON.stringify({ sourceCode: [{ s3Location: `s3://${bucket}/${key}` }] }),
  ],
  putParameter: (name: string, value: string, overwrite: boolean) => [
    'ssm', 'put-parameter', '--name', name, '--value', value, '--type', 'String', ...(overwrite ? ['--overwrite'] : []),
  ],
};

const quote = (a: string) => (/^[A-Za-z0-9_./:=@,<>+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

function display(args: string[], opts: Resolved): string {
  return ['aws', ...args, '--region', opts.region, ...(opts.profile ? ['--profile', opts.profile] : [])].map(quote).join(' ');
}

/** True for any AWS call that changes something. Used by tests and as a guard in dry-run/status. */
export function isWriteCall(args: string[]): boolean {
  const verb = args[1] || '';
  return /^(create|update|put|delete|batch-delete|start|tag|untag|add|remove|attach|detach)-/.test(verb) || (args[0] === 's3' && /^(cp|mv|rm|sync)$/.test(verb));
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------
/** Options after region resolution: every AWS and CDK call uses this region. */
type Resolved = SecurityOptions & { region: string; regionSource: string };

interface Ctx {
  opts: Resolved;
  deps: Deps;
  cliVersion: string | null;
  readOnly: boolean;
}

/** Runs a call; on failure either returns the result (expected codes) or aborts with an explained message. */
function call(ctx: Ctx, args: string[], expected: string[] = []): AwsResult {
  if (ctx.readOnly && isWriteCall(args)) throw new Error(`internal: write call in read-only mode: ${args.slice(0, 2).join(' ')}`);
  const r = ctx.deps.aws(args, ctx.opts.region);
  if (r.ok) return r;
  if (expected.includes(r.errorCode) || expected.some((e) => r.raw.includes(e))) return r;
  throw new Abort(explainAwsError(args, r.raw, ctx.cliVersion).message);
}

function getParam(ctx: Ctx, name: string): string | null {
  const r = call(ctx, ['ssm', 'get-parameter', '--name', name], ['ParameterNotFound']);
  return r.ok ? (r.json?.Parameter?.Value ?? null) : null;
}

/**
 * Does the IAM role behind `roleArn` exist? `iam get-role`, read-only. null when
 * it cannot be told (no iam:GetRole), so a missing permission never reads as
 * "missing role".
 */
export function roleExists(ctx: Ctx, roleArn: string): boolean | null {
  const name = roleArn.split('/').pop() || roleArn;
  const r = ctx.deps.aws(['iam', 'get-role', '--role-name', name], ctx.opts.region);
  if (r.ok) return true;
  if (r.errorCode === 'NoSuchEntity' || /NoSuchEntity/.test(r.raw)) return false;
  return null;
}

const roleName = (arn: string) => arn.split('/').pop() || arn;

interface Identity { account: string; arn: string; alias: string | null }

function identity(ctx: Ctx): Identity {
  const r = call(ctx, ['sts', 'get-caller-identity']);
  const account = String(r.json?.Account || '');
  if (!account) throw new Abort('Failed to get account ID. Check your AWS credentials.');
  // The alias is a nicety for the confirmation; a caller without iam:ListAccountAliases still proceeds.
  const a = ctx.deps.aws(['iam', 'list-account-aliases'], ctx.opts.region);
  const alias = a.ok && Array.isArray(a.json?.AccountAliases) && a.json.AccountAliases[0] ? String(a.json.AccountAliases[0]) : null;
  return { account, arn: String(r.json?.Arn || ''), alias };
}

const accountLabel = (id: Identity) => `${id.account}${id.alias ? ` (${id.alias})` : ' (no account alias)'}`;

/**
 * The region, resolved in the AWS CLI's order: --region, AWS_REGION,
 * AWS_DEFAULT_REGION, then the profile's configured region (the --profile
 * profile, else AWS_PROFILE, else default). Null when none is set.
 */
export function resolveRegion(opts: SecurityOptions, deps: Pick<Deps, 'env' | 'configRegion'>): { region: string; source: string } | null {
  if (opts.region) return { region: opts.region, source: '--region' };
  for (const k of ['AWS_REGION', 'AWS_DEFAULT_REGION']) {
    const v = deps.env[k]?.trim();
    if (v) return { region: v, source: k };
  }
  const v = deps.configRegion(opts.profile)?.trim();
  const which = opts.profile ? `profile ${opts.profile}` : deps.env.AWS_PROFILE ? `profile ${deps.env.AWS_PROFILE} (AWS_PROFILE)` : 'the default profile';
  return v ? { region: v, source: `region configured for ${which}` } : null;
}

export const NO_REGION_MESSAGE = 'No AWS region is set. Pass --region <region>, or set AWS_REGION, or configure one with "aws configure set region <region>".';

/** Where the credentials come from, as far as can be told without reading them. */
export function credentialSource(opts: SecurityOptions, env: NodeJS.ProcessEnv): string {
  if (opts.profile) return `profile ${opts.profile} (--profile)`;
  if (env.AWS_PROFILE) return `profile ${env.AWS_PROFILE} (AWS_PROFILE)`;
  if (env.AWS_ACCESS_KEY_ID) return 'environment variables (AWS_ACCESS_KEY_ID)';
  if (env.AWS_WEB_IDENTITY_TOKEN_FILE) return 'web identity token (AWS_WEB_IDENTITY_TOKEN_FILE)';
  if (env.AWS_CONTAINER_CREDENTIALS_FULL_URI || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) return 'container credentials';
  return 'the default credential chain (default profile, SSO, or an instance role)';
}

export const DEPLOY_NOTICE = [
  'prism-cli enable security deploys AWS resources into the AWS account your credentials point to:',
  'an AWS Security Agent space, an IAM service role and policies, an encrypted S3 scan bucket and SSM',
  'parameters. These may incur cost. It shows the account, a diff and the plan, and asks before any change.',
];

function printIdentity(ctx: Ctx, id: Identity): void {
  const { deps, opts } = ctx;
  deps.log(`Account:     ${accountLabel(id)}`);
  deps.log(`Caller:      ${id.arn || 'unknown'}`);
  deps.log(`Region:      ${opts.region} (${opts.regionSource})`);
  deps.log(`Credentials: ${credentialSource(opts, deps.env)}`);
}

export interface RepoCtx { root: string; id: string; slug: string; title: string; param: string; zipKey: string }

/** The repo whose code review this run manages, or a reason it cannot. */
export function resolveRepo(opts: SecurityOptions, deps: Deps): RepoCtx | { error: string } {
  const top = deps.git(['rev-parse', '--show-toplevel']);
  if (!top.ok) return { error: 'not inside a git repository, so the per-repo code review is skipped (run from the repo to set it up)' };
  let id: string | null;
  if (opts.repo) {
    if (!/^[A-Za-z0-9.-]+(\/[A-Za-z0-9._-]+)+$/.test(opts.repo)) return { error: `--repo must look like github.com/owner/name, got "${opts.repo}"` };
    id = opts.repo;
  } else {
    const remote = deps.git(['remote', 'get-url', 'origin']);
    id = remote.ok ? repoIdFromRemote(remote.stdout) : null;
    if (!id) return { error: 'this repo has no usable "origin" remote; pass --repo github.com/<owner>/<name> (the name the CI eval gate uses)' };
  }
  const slug = repoSlug(id);
  return { root: top.stdout, id, slug, title: codeReviewTitle(slug), param: codeReviewParam(slug), zipKey: repoZipKey(slug) };
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------
export interface StackPlan {
  stack: string;
  cdkEnv: CdkEnv;
  deployed: boolean;
  status: string | null;
  diff: TemplateDiff;
  needsDeploy: boolean;
  reason: string;
  assemblyDir: string;
  diffFile: string | null;
}

/** CDK context that selects each layout; the other key is removed so the two can never combine. */
const MODE_CONTEXT = { pipeline: 'enableSecurityAgent', standalone: 'securityAgentStandalone' } as const;

function parseContext(pairs: string[] = [], mode: Mode): Record<string, string> {
  const ctx: Record<string, string> = {};
  for (const p of pairs) {
    const m = /^([A-Za-z0-9_:@./-]+)=(.*)$/.exec(p);
    if (!m) throw new Abort(`--context must be key=value, got "${p}"`);
    ctx[m[1]] = m[2];
  }
  delete ctx[MODE_CONTEXT.pipeline];
  delete ctx[MODE_CONTEXT.standalone];
  ctx[MODE_CONTEXT[mode]] = 'true';
  return ctx;
}

interface StackState { name: string; deployed: boolean; status: string | null; template: CfnTemplate | null; hasSecurityAgent: boolean }

function readStack(ctx: Ctx, name: string): StackState {
  const r = call(ctx, ['cloudformation', 'describe-stacks', '--stack-name', name], ['does not exist']);
  if (!r.ok) return { name, deployed: false, status: null, template: null, hasSecurityAgent: false };
  const status = String(r.json?.Stacks?.[0]?.StackStatus || 'UNKNOWN');
  const t = call(ctx, ['cloudformation', 'get-template', '--stack-name', name, '--template-stage', 'Original']);
  let template: CfnTemplate | null = null;
  const body = t.json?.TemplateBody;
  if (body && typeof body === 'object') template = body;
  else if (typeof body === 'string') {
    try { template = JSON.parse(body); } catch { throw new Abort(`the deployed ${name} template is not JSON; cannot compare it`); }
  }
  const hasSecurityAgent = Object.values(template?.Resources ?? {}).some((x) => x.Type === 'AWS::SecurityAgent::AgentSpace');
  return { name, deployed: true, status, template, hasSecurityAgent };
}

/** pipeline: Security Agent inside PrismD1MetricsPipeline. standalone: PrismD1SecurityAgent. */
export type Mode = 'pipeline' | 'standalone';

export interface Target { mode: Mode; stack: StackState; why: string; pipeline: StackState }

/**
 * Which stack holds Security Agent in this account and region. Never both:
 * an account that already hosts it in the pipeline keeps that layout (no
 * second agent space, nothing moved); otherwise the standalone stack is used.
 * An agent space named like ours that neither stack owns stops the run.
 */
export function chooseTarget(ctx: Ctx, spaces: { agentSpaceId: string; name: string }[]): Target {
  const pipeline = readStack(ctx, PIPELINE_STACK);
  const standalone = readStack(ctx, STANDALONE_STACK);
  if (pipeline.hasSecurityAgent && standalone.hasSecurityAgent) {
    throw new Abort(`both ${PIPELINE_STACK} and ${STANDALONE_STACK} hold Security Agent resources in this account and region, which should be impossible (they share names and exports). Fix this in CloudFormation before running enable security.`);
  }
  if (pipeline.hasSecurityAgent) {
    return { mode: 'pipeline', stack: pipeline, pipeline, why: `this account already hosts Security Agent in ${PIPELINE_STACK}, so that stack is kept` };
  }
  if (standalone.deployed) {
    return { mode: 'standalone', stack: standalone, pipeline, why: `this account uses the standalone ${STANDALONE_STACK} stack` };
  }
  if (spaces.some((s) => s.name === AGENT_SPACE_NAME)) {
    throw new Abort(`an agent space named ${AGENT_SPACE_NAME} exists, but neither ${PIPELINE_STACK} nor ${STANDALONE_STACK} manages it. Deploying would create a second one; remove it or bring it under CloudFormation first.`);
  }
  return {
    mode: 'standalone', stack: standalone, pipeline,
    why: `no Security Agent resources found, so the standalone ${STANDALONE_STACK} stack is used${pipeline.deployed ? ` (${PIPELINE_STACK} is deployed without them and is not touched)` : ''}`,
  };
}

function planStack(ctx: Ctx, id: Identity, target: Target): StackPlan {
  const { deps, opts } = ctx;
  const st = target.stack;
  const name = st.name;
  if (st.status && /_IN_PROGRESS$/.test(st.status)) throw new Abort(`stack ${name} is busy (${st.status}); wait for it to finish and re-run`);

  const dir = deps.makeTempDir();
  const assemblyDir = join(dir, 'cdk.out');
  const context = parseContext(opts.context, target.mode);
  const cdkEnv = { account: id.account, region: opts.region };
  deps.log(`Synthesizing the CDK app with ${MODE_CONTEXT[target.mode]}=true (local, no AWS writes)...`);
  const s = deps.cdk.synth(assemblyDir, context, cdkEnv);
  if (!s.ok) throw new Abort(`cdk synth failed:\n${redact(s.stderr).split('\n').slice(-15).join('\n')}`);
  const tplPath = join(assemblyDir, `${name}.template.json`);
  if (!existsSync(tplPath)) throw new Abort(`cdk synth produced no ${name} template`);
  const synthesized = JSON.parse(readFileSync(tplPath, 'utf8')) as CfnTemplate;
  // Every resource of the standalone stack is a Security Agent resource.
  const diff = diffTemplates(st.template, synthesized, name, target.mode === 'standalone' ? () => true : undefined);

  let diffFile: string | null = null;
  const full = deps.cdk.diff(assemblyDir, name, cdkEnv);
  if (full.output) {
    diffFile = join(dir, 'cdk-diff.txt');
    writeFileSync(diffFile, redact(full.output));
  }

  let needsDeploy: boolean, reason: string;
  if (target.mode === 'standalone') {
    if (!st.deployed) { needsDeploy = true; reason = `${name} is not deployed in this account and region; it holds only the Security Agent resources`; }
    else if (diff.changes.length) { needsDeploy = true; reason = 'the deployed Security Agent resources differ from the local infra code (drift)'; }
    else { needsDeploy = false; reason = 'up to date'; }
  } else if (diff.touchesSecurityAgent) { needsDeploy = true; reason = 'the deployed Security Agent resources differ from the local infra code (drift)'; }
  else if (diff.changes.length) { needsDeploy = false; reason = `the Security Agent resources are up to date; the other ${diff.changes.length} change(s) in ${name} are not deployed by this command (run cdk deploy yourself if you want them)`; }
  else { needsDeploy = false; reason = 'up to date'; }
  return { stack: name, deployed: st.deployed, status: st.status, diff, needsDeploy, reason, assemblyDir, diffFile, cdkEnv };
}

// ---------------------------------------------------------------------------
// Service-side state (agent space, application, code review, S3, SSM)
// ---------------------------------------------------------------------------
type ItemState = 'ok' | 'create' | 'update' | 'conflict' | 'skip' | 'after-deploy' | 'blocked';

export interface PlanItem {
  key: 'agent-space' | 'application' | 'repo-zip' | 'code-review' | 'ssm-code-review';
  label: string;
  state: ItemState;
  detail: string;
  /** Exact calls this item makes, for display. */
  calls: string[][];
}

interface Service {
  agentSpaceId: string | null;
  scanBucket: string | null;
  serviceRoleArn: string;
  app: { id: string; roleArn: string | null } | null;
  appCount: number;
  /** Code review to use for this repo, if one exists. */
  review: { id: string; title: string; source: 'ssm' | 'title' } | null;
  ssmValue: string | null;
  zip: { path: string; md5: string } | null;
  remoteEtag: string | null;
  items: PlanItem[];
}

function md5(path: string): string {
  return createHash('md5').update(readFileSync(path)).digest('hex');
}

/** Reads everything and decides each item. Makes no writes. */
function planService(ctx: Ctx, id: Identity, repo: RepoCtx | { error: string }, stackReady: boolean, stackName: string): Service {
  const items: PlanItem[] = [];
  const conventionRole = `arn:aws:iam::${id.account}:role/${SERVICE_ROLE_NAME}`;
  const svc: Service = { agentSpaceId: null, scanBucket: null, serviceRoleArn: conventionRole, app: null, appCount: 0, review: null, ssmValue: null, zip: null, remoteEtag: null, items };

  if (!stackReady) {
    const later = (key: PlanItem['key'], label: string, detail: string, c: string[][] = []): void => { items.push({ key, label, state: 'after-deploy', detail, calls: c }); };
    later('agent-space', 'Agent space', `created by the stack (${AGENT_SPACE_NAME})`);
    later('application', 'Application', 'looked up after the deploy; created and given the service role if missing',
      [calls.createApplication(), calls.updateApplication('<application id>', conventionRole)]);
    if ('error' in repo) { items.push({ key: 'code-review', label: 'Code review', state: 'skip', detail: repo.error, calls: [] }); return svc; }
    later('repo-zip', 'Repo snapshot', `git archive HEAD uploaded to s3://<scan bucket>/${repo.zipKey} if missing or different`,
      [calls.putObject('<scan bucket>', repo.zipKey, '<git archive of HEAD>')]);
    later('code-review', 'Code review', `"${repo.title}" created if missing`,
      [calls.createCodeReview('<agent space id>', repo.title, conventionRole, '<scan bucket>', repo.zipKey)]);
    later('ssm-code-review', 'SSM code review id', `${repo.param} set to the code review id`, [calls.putParameter(repo.param, '<code review id>', false)]);
    return svc;
  }

  // Agent space: the stack writes its id to SSM; confirm it exists.
  svc.agentSpaceId = getParam(ctx, PARAM_AGENT_SPACE);
  svc.scanBucket = getParam(ctx, PARAM_SCAN_BUCKET);
  svc.serviceRoleArn = getParam(ctx, PARAM_SERVICE_ROLE) || conventionRole;
  const spaces: any[] = call(ctx, ['securityagent', 'list-agent-spaces']).json?.agentSpaceSummaries || [];
  const space = spaces.find((s) => s.agentSpaceId === svc.agentSpaceId) || spaces.find((s) => s.name === AGENT_SPACE_NAME);
  if (!space) throw new Abort(`${stackName} is deployed but no agent space named ${AGENT_SPACE_NAME} was found (SSM ${PARAM_AGENT_SPACE}: ${svc.agentSpaceId ?? 'missing'}). Check the stack in the CloudFormation console.`);
  if (svc.agentSpaceId && space.agentSpaceId !== svc.agentSpaceId) {
    throw new Abort(`SSM ${PARAM_AGENT_SPACE} holds ${svc.agentSpaceId}, which is not an agent space here; ${AGENT_SPACE_NAME} is ${space.agentSpaceId}. The stack owns that parameter, so redeploy it rather than editing the value.`);
  }
  svc.agentSpaceId = space.agentSpaceId;
  items.push({ key: 'agent-space', label: 'Agent space', state: 'ok', detail: `${space.agentSpaceId} (${space.name})`, calls: [] });

  // Application (one per account; the web console).
  const apps: any[] = call(ctx, ['securityagent', 'list-applications']).json?.applicationSummaries || [];
  svc.appCount = apps.length;
  if (!apps.length) {
    items.push({ key: 'application', label: 'Application', state: 'create', detail: `none yet; create it and attach ${svc.serviceRoleArn}`,
      calls: [calls.createApplication(), calls.updateApplication('<new application id>', svc.serviceRoleArn)] });
  } else {
    const appId = String(apps[0].applicationId);
    const got = call(ctx, ['securityagent', 'get-application', '--application-id', appId]).json;
    const roleArn = got?.roleArn ? String(got.roleArn) : null;
    svc.app = { id: appId, roleArn };
    const many = apps.length > 1 ? ` (${apps.length} applications in this region; using the first)` : '';
    // The stack is deployed, so it owns the expected role: missing means it was
    // deleted outside CloudFormation, and re-attaching it would not help.
    const exists = roleExists(ctx, svc.serviceRoleArn);
    if (exists === false) items.push({ key: 'application', label: 'Application', state: 'blocked', calls: [],
      detail: `${appId}: role ${roleName(svc.serviceRoleArn)} does not exist although the stack is deployed (deleted outside CloudFormation?). Recreate it through the stack before re-running${many}` });
    else if (roleArn === svc.serviceRoleArn) items.push({ key: 'application', label: 'Application', state: 'ok', calls: [],
      detail: `${appId}, role attached${exists === null ? ' (could not check that it exists: no iam:GetRole)' : ''}${many}` });
    else items.push({ key: 'application', label: 'Application', state: 'update', calls: [calls.updateApplication(appId, svc.serviceRoleArn)],
      detail: `${appId}: role is ${roleArn ?? 'not set'}, expected ${svc.serviceRoleArn} (drift)${many}` });
  }

  if ('error' in repo) { items.push({ key: 'code-review', label: 'Code review', state: 'skip', detail: repo.error, calls: [] }); return svc; }
  if (!svc.scanBucket) throw new Abort(`SSM ${PARAM_SCAN_BUCKET} is missing although ${stackName} has the Security Agent resources; redeploy the stack.`);

  // Code review for this repo: the SSM pointer if it is still valid, else one with the CI title.
  svc.ssmValue = getParam(ctx, repo.param);
  const reviews: any[] = call(ctx, ['securityagent', 'list-code-reviews', '--agent-space-id', space.agentSpaceId]).json?.codeReviewSummaries || [];
  const bySsm = svc.ssmValue ? reviews.find((r) => r.codeReviewId === svc.ssmValue) : undefined;
  const byTitle = reviews.find((r) => r.title === repo.title);
  if (bySsm) svc.review = { id: bySsm.codeReviewId, title: bySsm.title, source: 'ssm' };
  else if (byTitle) svc.review = { id: byTitle.codeReviewId, title: byTitle.title, source: 'title' };

  if (svc.review) {
    items.push({ key: 'repo-zip', label: 'Repo snapshot', state: 'skip', detail: 'not needed: the code review already exists', calls: [] });
    items.push({ key: 'code-review', label: 'Code review', state: 'ok', detail: `${svc.review.id} ("${svc.review.title}")`, calls: [] });
  } else {
    // Build the snapshot now so the plan can say whether the upload is needed.
    const dir = ctx.deps.makeTempDir();
    const zipPath = join(dir, 'repo.zip');
    const z = ctx.deps.git(['archive', 'HEAD', '--format=zip', '-o', zipPath]);
    if (!z.ok) throw new Abort(`git archive HEAD failed: ${z.stderr.split('\n').pop()}`);
    svc.zip = { path: zipPath, md5: md5(zipPath) };
    const head = call(ctx, ['s3api', 'head-object', '--bucket', svc.scanBucket, '--key', repo.zipKey], ['404', 'NotFound', 'NoSuchKey']);
    svc.remoteEtag = head.ok ? String(head.json?.ETag || '').replace(/"/g, '') : null;
    if (svc.remoteEtag === svc.zip.md5) {
      items.push({ key: 'repo-zip', label: 'Repo snapshot', state: 'ok', detail: `s3://${svc.scanBucket}/${repo.zipKey} already matches HEAD (MD5 ${svc.zip.md5}); upload skipped`, calls: [] });
    } else {
      items.push({ key: 'repo-zip', label: 'Repo snapshot', state: svc.remoteEtag ? 'update' : 'create', calls: [calls.putObject(svc.scanBucket, repo.zipKey, zipPath)],
        detail: svc.remoteEtag ? `s3://${svc.scanBucket}/${repo.zipKey} differs from HEAD; replace it` : `upload git archive of HEAD to s3://${svc.scanBucket}/${repo.zipKey}` });
    }
    items.push({ key: 'code-review', label: 'Code review', state: 'create', detail: `create "${repo.title}"`,
      calls: [calls.createCodeReview(space.agentSpaceId, repo.title, svc.serviceRoleArn, svc.scanBucket, repo.zipKey)] });
  }

  const target = svc.review?.id ?? null;
  if (target && svc.ssmValue === target) {
    items.push({ key: 'ssm-code-review', label: 'SSM code review id', state: 'ok', detail: `${repo.param} = ${target}`, calls: [] });
  } else if (!svc.ssmValue) {
    items.push({ key: 'ssm-code-review', label: 'SSM code review id', state: 'create', detail: `set ${repo.param}`, calls: [calls.putParameter(repo.param, target ?? '<new code review id>', false)] });
  } else {
    items.push({ key: 'ssm-code-review', label: 'SSM code review id', state: 'conflict', calls: [calls.putParameter(repo.param, target ?? '<new code review id>', true)],
      detail: `${repo.param} holds ${svc.ssmValue}, which is not a code review in this agent space; it would be replaced with ${target ?? 'the new code review id'} (asks first)` });
  }
  return svc;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const STATE_WORD: Record<ItemState, string> = { ok: 'ok', create: 'create', update: 'update', conflict: 'CONFLICT', skip: 'skip', 'after-deploy': 'after deploy', blocked: 'BLOCKED' };

function printPlan(ctx: Ctx, stack: StackPlan, svc: Service): void {
  const { deps, opts } = ctx;
  deps.log('');
  for (const l of formatDiff(stack.diff, stack.stack)) deps.log(l);
  if (stack.diffFile) deps.log(`  Full cdk diff: ${stack.diffFile}`);
  deps.log(`  Deploy: ${stack.needsDeploy ? 'yes' : 'no'} (${stack.reason})`);
  if (stack.needsDeploy) deps.log(`    cdk deploy --app ${stack.assemblyDir} ${stack.stack} --exclusively${opts.profile ? ` --profile ${opts.profile}` : ''}  (CDK_DEFAULT_REGION=${opts.region})`);
  deps.log('');
  deps.log('Security Agent:');
  for (const it of svc.items) {
    deps.log(`  [${STATE_WORD[it.state]}] ${it.label}: ${it.detail}`);
    if (it.state !== 'ok' && it.state !== 'skip' && it.state !== 'blocked') for (const c of it.calls) deps.log(`      ${display(c, opts)}`);
  }
}

function hasWrites(stack: StackPlan, svc: Service): boolean {
  return stack.needsDeploy || svc.items.some((i) => i.state === 'create' || i.state === 'update' || i.state === 'conflict' || i.state === 'after-deploy');
}

async function confirm(ctx: Ctx, id: Identity, question: string): Promise<boolean> {
  const { deps, opts } = ctx;
  if (opts.yes) { deps.log(`--yes: approved for account ${accountLabel(id)} in ${opts.region}.`); return true; }
  if (!deps.isTTY) {
    deps.log('Refusing to change anything: there is no terminal to confirm on. Re-run with --yes to approve these changes, or with --dry-run to only see the plan.');
    return false;
  }
  const a = (await deps.ask(`${question} [y/N] `)).trim();
  return /^y(es)?$/i.test(a);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
function applyService(ctx: Ctx, svc: Service, repo: RepoCtx | { error: string }, overwriteOk: boolean): { applicationId: string; codeReviewId: string | null } {
  const { deps } = ctx;
  const item = (k: PlanItem['key']) => svc.items.find((i) => i.key === k);

  let applicationId = svc.app?.id ?? '';
  const app = item('application');
  if (app?.state === 'create') {
    const r = call(ctx, calls.createApplication());
    applicationId = String(r.json?.applicationId || '');
    if (!applicationId) throw new Abort('create-application returned no applicationId');
    deps.log(`  Created application ${applicationId}`);
  }
  if (app?.state === 'create' || app?.state === 'update') {
    call(ctx, calls.updateApplication(applicationId, svc.serviceRoleArn));
    deps.log(`  Attached role ${svc.serviceRoleArn} to application ${applicationId}`);
  }

  if ('error' in repo) return { applicationId, codeReviewId: null };
  let codeReviewId = svc.review?.id ?? null;
  const zip = item('repo-zip');
  if ((zip?.state === 'create' || zip?.state === 'update') && svc.zip && svc.scanBucket) {
    call(ctx, calls.putObject(svc.scanBucket, repo.zipKey, svc.zip.path));
    deps.log(`  Uploaded repo snapshot to s3://${svc.scanBucket}/${repo.zipKey}`);
  }
  if (item('code-review')?.state === 'create' && svc.agentSpaceId && svc.scanBucket) {
    const r = call(ctx, calls.createCodeReview(svc.agentSpaceId, repo.title, svc.serviceRoleArn, svc.scanBucket, repo.zipKey));
    codeReviewId = String(r.json?.codeReviewId || '');
    if (!codeReviewId) throw new Abort('create-code-review returned no codeReviewId');
    deps.log(`  Created code review ${codeReviewId} ("${repo.title}")`);
  }
  const ssm = item('ssm-code-review');
  if (codeReviewId && (ssm?.state === 'create' || (ssm?.state === 'conflict' && overwriteOk))) {
    call(ctx, calls.putParameter(repo.param, codeReviewId, ssm.state === 'conflict'));
    deps.log(`  Set ${repo.param} = ${codeReviewId}`);
  }
  return { applicationId, codeReviewId };
}

function preflight(ctx: Ctx): Identity {
  const v = cliVersionOk(ctx.cliVersion);
  if (!v.ok) throw new Abort(`prism-cli enable security needs AWS CLI ${MIN_AWS_CLI_TEXT} or later for the securityagent commands (found ${v.version}). Install it from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html`);
  return identity(ctx);
}

/** Runs `enable security`. Returns the process exit code. */
export async function enableSecurity(input: SecurityOptions, deps: Deps): Promise<number> {
  const readOnly = !!(input.dryRun || input.status);
  // Before any AWS call: what this command does, or that this run changes nothing.
  if (input.status) deps.log('Read-only status check (--status): nothing will be changed.');
  else if (input.dryRun) deps.log('Dry run (--dry-run): every lookup runs, nothing will be changed.');
  else for (const l of DEPLOY_NOTICE) deps.log(l);
  deps.log('');

  const r = resolveRegion(input, deps);
  if (!r) { deps.log(`Error: ${NO_REGION_MESSAGE}`); return 1; }
  const opts: Resolved = { ...input, region: r.region, regionSource: r.source };
  const ctx: Ctx = { opts, deps, cliVersion: deps.awsVersion(), readOnly };
  try {
    if (opts.status) return securityStatus(ctx);
    const id = preflight(ctx);
    printIdentity(ctx, id);
    const repo = resolveRepo(opts, deps);
    deps.log('error' in repo ? `Repo:        ${repo.error}` : `Repo:        ${repo.id} (code review slug ${repo.slug})`);
    // Probe the securityagent commands before the slow synth, so an old CLI fails fast.
    const spaces: any[] = call(ctx, ['securityagent', 'list-agent-spaces']).json?.agentSpaceSummaries || [];

    const target = chooseTarget(ctx, spaces);
    deps.log(`Stack:       ${target.stack.name} (${target.why})`);
    const stack = planStack(ctx, id, target);
    const stackReady = target.stack.hasSecurityAgent;
    let svc = planService(ctx, id, repo, stackReady, target.stack.name);
    printPlan(ctx, stack, svc);
    deps.log('');

    if (opts.dryRun) { deps.log('Dry run: nothing was changed.'); return 0; }

    const blocked = svc.items.find((i) => i.state === 'blocked');
    if (blocked) throw new Abort(`${blocked.label}: ${blocked.detail}. Nothing was changed.`);

    if (!hasWrites(stack, svc)) {
      deps.log('Already set up: nothing to change.');
      return finish(ctx, id, repo, svc.agentSpaceId, svc.app?.id ?? '', svc.review?.id ?? null);
    }

    const what = stack.needsDeploy ? `deploy ${stack.stack} and apply the Security Agent changes above` : 'apply the Security Agent changes above';
    if (!(await confirm(ctx, id, `${what[0].toUpperCase()}${what.slice(1)} in account ${accountLabel(id)}, region ${opts.region}?`))) {
      deps.log('Nothing was changed.');
      return 1;
    }

    if (stack.needsDeploy) {
      deps.log(`Deploying ${stack.stack}...`);
      if (!deps.cdk.deploy(stack.assemblyDir, stack.stack, stack.cdkEnv, { approveAll: !!opts.yes })) throw new Abort('cdk deploy failed (see the output above). Nothing after the deploy was attempted.');
      svc = planService(ctx, id, repo, true, stack.stack);
      deps.log('After the deploy:');
      for (const it of svc.items) deps.log(`  [${STATE_WORD[it.state]}] ${it.label}: ${it.detail}`);
    }

    let overwriteOk = false;
    const conflict = svc.items.find((i) => i.state === 'conflict');
    if (conflict) {
      deps.log(`  ${conflict.detail}`);
      overwriteOk = !!opts.yes || (deps.isTTY && /^y(es)?$/i.test((await deps.ask('Overwrite that SSM parameter? [y/N] ')).trim()));
      if (!overwriteOk) deps.log('  Left the SSM parameter unchanged.');
    }

    const res = applyService(ctx, svc, repo, overwriteOk);
    if (conflict && !overwriteOk) {
      deps.log('The CI eval gate still reads the old value. Re-run and approve the overwrite to fix it.');
      return 1;
    }
    return finish(ctx, id, repo, svc.agentSpaceId, res.applicationId, res.codeReviewId);
  } catch (e) {
    if (e instanceof Abort) { deps.log(`Error: ${redact(e.message)}`); return 1; }
    throw e;
  }
}

function finish(ctx: Ctx, id: Identity, repo: RepoCtx | { error: string }, space: string | null, applicationId: string, codeReviewId: string | null): number {
  const { deps, opts } = ctx;
  if (!('error' in repo) && codeReviewId && space) {
    const wrote = writeSecurityMarker(repo.root, { agentSpaceId: space, applicationId, codeReviewId, region: opts.region, account: id.account }, deps.now());
    const file = join(repo.root, '.prism', 'config.json');
    const ig = deps.git(['-C', repo.root, 'check-ignore', '-q', '.prism/config.json']);
    // check-ignore: exit 0 ignored, 1 not ignored, anything else unknown (RunResult only says ok or not).
    const local = ig.ok ? 'local only: git ignores it' : 'local: it holds the account ID, so check before committing it';
    deps.log(wrote ? `Wrote the security block (ids, account and region; no secrets) to ${file} (${local}).` : `The security block in ${file} is already current (${local}).`);
  }
  deps.log('');
  deps.log(`Security Agent web console: https://${opts.region}.console.aws.amazon.com/securityagent/home?region=${opts.region} (choose "Admin access").`);
  if (!('error' in repo)) deps.log(`The CI eval gate reads ${repo.param}; check everything with: prism-cli enable security --status`);
  return 0;
}

// ---------------------------------------------------------------------------
// --status
// ---------------------------------------------------------------------------
type Mark = 'ok' | 'missing' | 'warn' | 'unknown';

/** Local check for the CI step that calls Security Agent (the eval gate's start-code-review-job). */
export function ciWorkflowStep(repoRoot: string): { mark: Mark; detail: string } {
  const files = ['.github/workflows/prism-eval-gate.yml', '.gitlab-ci.yml', '.prism/gitlab-workflows/prism-eval-gate.yml'];
  for (const f of files) {
    try {
      const t = readFileSync(resolve(repoRoot, f), 'utf8');
      if (t.includes('start-code-review-job')) return { mark: 'ok', detail: `${f} runs the Security Agent code review` };
    } catch { /* not present */ }
  }
  return { mark: 'missing', detail: 'no eval gate workflow with the Security Agent step (prism-cli bootstrapper install-github-workflows)' };
}

function securityStatus(ctx: Ctx): number {
  const { deps, opts } = ctx;
  const rows: [Mark, string, string][] = [];
  const add = (m: Mark, label: string, detail: string) => rows.push([m, label, detail]);
  const print = () => {
    deps.log(`Security Agent status (region ${opts.region}, ${opts.regionSource}; credentials: ${credentialSource(opts, deps.env)}):`);
    for (const [m, l, d] of rows) deps.log(`  [${m}] ${l}: ${d}`);
  };
  let id: Identity;
  try { id = preflight(ctx); } catch (e) {
    add('missing', 'Credentials', e instanceof Abort ? redact(e.message).split('\n')[0] : String(e));
    print();
    return 1;
  }
  add('ok', 'Credentials', `account ${accountLabel(id)}, caller ${id.arn || 'unknown'}`);
  const repo = resolveRepo(opts, deps);
  try {
    const pipe = readStack(ctx, PIPELINE_STACK);
    const solo = readStack(ctx, STANDALONE_STACK);
    const host = pipe.hasSecurityAgent && solo.hasSecurityAgent ? null : pipe.hasSecurityAgent ? pipe : solo.hasSecurityAgent ? solo : undefined;
    if (host === null) add('warn', 'Stack', `both ${PIPELINE_STACK} and ${STANDALONE_STACK} hold Security Agent resources (should be impossible)`);
    else if (host) add('ok', 'Stack', `${host.name} ${host.status}, with the Security Agent resources${host === pipe ? ' (pipeline layout)' : ' (standalone layout)'}`);
    else add('missing', 'Stack', `neither ${PIPELINE_STACK}${pipe.deployed ? ` (deployed, ${pipe.status}, without Security Agent)` : ' (not deployed)'} nor ${STANDALONE_STACK} holds Security Agent`);

    const spaceParam = getParam(ctx, PARAM_AGENT_SPACE);
    const spaces: any[] = call(ctx, ['securityagent', 'list-agent-spaces']).json?.agentSpaceSummaries || [];
    const space = spaces.find((s) => s.agentSpaceId === spaceParam) || spaces.find((s) => s.name === AGENT_SPACE_NAME);
    add(space ? 'ok' : 'missing', 'Agent space', space ? `${space.agentSpaceId} (${space.name})` : `none named ${AGENT_SPACE_NAME}`);

    const roleParam = getParam(ctx, PARAM_SERVICE_ROLE);
    const apps: any[] = call(ctx, ['securityagent', 'list-applications']).json?.applicationSummaries || [];
    if (!apps.length) add('missing', 'Application', 'none');
    else {
      const got = call(ctx, ['securityagent', 'get-application', '--application-id', String(apps[0].applicationId)]).json;
      const want = roleParam || `arn:aws:iam::${id.account}:role/${SERVICE_ROLE_NAME}`;
      const appId = String(apps[0].applicationId);
      const many = apps.length > 1 ? ` (${apps.length} applications in this region; checked the first)` : '';
      if (got?.roleArn !== want) add('warn', 'Application', `${appId}, role ${got?.roleArn ?? 'not set'} (expected ${want})${many}`);
      else {
        const exists = roleExists(ctx, want);
        // No stack yet: enable security deploys the role. A deployed stack owns it, so it was deleted outside CloudFormation.
        const fix = host ? `${host.name} is deployed, so it was deleted outside CloudFormation; recreate it through the stack` : 'run prism-cli enable security';
        if (exists === false) add('warn', 'Application', `${appId}: role ${roleName(want)} attached but does not exist; ${fix}${many}`);
        else add('ok', 'Application', `${appId}, role attached${exists === null ? ' (could not check that it exists: no iam:GetRole)' : ''}${many}`);
      }
    }

    for (const [name, label] of [[PARAM_AGENT_SPACE, 'SSM agent-space-id'], [PARAM_SCAN_BUCKET, 'SSM scan-bucket'], [PARAM_SERVICE_ROLE, 'SSM service-role-arn']] as const) {
      const v = name === PARAM_AGENT_SPACE ? spaceParam : name === PARAM_SERVICE_ROLE ? roleParam : getParam(ctx, name);
      add(v ? 'ok' : 'missing', label, v ? `${name} = ${v}` : `${name} not set`);
    }

    if ('error' in repo) add('unknown', 'Code review', repo.error);
    else {
      const v = getParam(ctx, repo.param);
      const reviews: any[] = space ? call(ctx, ['securityagent', 'list-code-reviews', '--agent-space-id', space.agentSpaceId]).json?.codeReviewSummaries || [] : [];
      const found = v ? reviews.find((r) => r.codeReviewId === v) : undefined;
      if (!v) add('missing', 'Code review', `${repo.param} not set (the CI gate creates one on its first run, or run prism-cli enable security)`);
      else add(found ? 'ok' : 'warn', 'Code review', found ? `${v} ("${found.title}") from ${repo.param}` : `${repo.param} = ${v}, but no such code review in the agent space`);
      const legacy = getParam(ctx, LEGACY_PARAM_CODE_REVIEW);
      if (legacy) add('warn', 'Legacy SSM', `${LEGACY_PARAM_CODE_REVIEW} = ${legacy} (written by the old securityagent setup; nothing reads it)`);
      const ci = ciWorkflowStep(repo.root);
      add(ci.mark, 'CI workflow step', ci.detail);
      const m = readSecurityMarker(repo.root);
      add(m ? 'ok' : 'missing', 'Local marker', m ? `.prism/config.json security (code review ${m.codeReviewId}, set up ${m.setupAt || 'unknown'})` : '.prism/config.json has no security block');
    }
  } catch (e) {
    if (!(e instanceof Abort)) throw e;
    add('unknown', 'Stopped', redact(e.message).split('\n')[0]);
    print();
    return 1;
  }
  print();
  return 0;
}
