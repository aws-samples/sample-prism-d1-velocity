/** Canned AWS responses for the aws check / recommend tests (fake `aws` binary). */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { noDetectors, type AwsStub } from './helpers.js';
import type { CheckRunDeps } from '../src/aws/run-check.js';
import { run } from '../src/utils/exec.js';

export const ACCOUNT = '123456789012';
export const REGION = 'us-west-2';
const denied = (...match: string[]): AwsStub => ({ match, error: 'AccessDenied' });

export const IDENTITY: AwsStub[] = [
  { match: ['--version'], raw: 'aws-cli/2.36.1 Python/3.12.0 Linux/6 exe/x86_64' },
  { match: ['sts', 'get-caller-identity'], stdout: { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/ReadOnly/dev` } },
  { match: ['iam', 'list-account-aliases'], stdout: { AccountAliases: ['sandbox'] } },
];

export const BASELINE_PASS: AwsStub[] = [
  { match: ['cloudtrail', 'describe-trails'], stdout: { trailList: [{ Name: 'org', TrailARN: `arn:aws:cloudtrail:us-east-1:${ACCOUNT}:trail/org`, HomeRegion: 'us-east-1', IsMultiRegionTrail: true }] } },
  { match: ['cloudtrail', 'get-trail-status', '--region', 'us-east-1'], stdout: { IsLogging: true } },
  { match: ['guardduty', 'list-detectors'], stdout: { DetectorIds: ['d-1'] } },
  { match: ['guardduty', 'get-detector'], stdout: { Status: 'ENABLED' } },
  { match: ['securityhub', 'describe-hub'], stdout: { HubArn: 'h', SubscribedAt: '2026-01-01' } },
  { match: ['accessanalyzer', 'list-analyzers'], stdout: { analyzers: [{ name: 'acct', type: 'ACCOUNT', status: 'ACTIVE' }] } },
  { match: ['budgets', 'describe-budgets'], stdout: { Budgets: [{ BudgetName: 'monthly' }] } },
  { match: ['s3control', 'get-public-access-block'], stdout: { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } } },
  { match: ['ec2', 'get-ebs-encryption-by-default'], stdout: { EbsEncryptionByDefault: true } },
];

export const BASELINE_FAIL: AwsStub[] = [
  { match: ['cloudtrail', 'describe-trails'], stdout: { trailList: [{ Name: 'local', IsMultiRegionTrail: false }] } },
  { match: ['guardduty', 'list-detectors'], raw: '' },
  { match: ['securityhub', 'describe-hub'], error: 'InvalidAccessException' },
  { match: ['accessanalyzer', 'list-analyzers'], stdout: { analyzers: [] } },
  { match: ['budgets', 'describe-budgets'], raw: '' },
  { match: ['s3control', 'get-public-access-block'], error: 'NoSuchPublicAccessBlockConfiguration' },
  { match: ['ec2', 'get-ebs-encryption-by-default'], stdout: { EbsEncryptionByDefault: false } },
];

export const BASELINE_DENIED: AwsStub[] = [
  denied('cloudtrail'), denied('guardduty'), denied('securityhub'), denied('accessanalyzer'),
  denied('budgets'), denied('s3control'), denied('ec2'),
];

const param = (name: string, value: string): AwsStub => ({ match: ['ssm', 'get-parameter', `/prism/continuum/${name}`], stdout: { Parameter: { Value: value } } });
const stack = (name: string, agent: boolean): AwsStub[] => [
  { match: ['cloudformation', 'describe-stacks', name], stdout: { Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] } },
  { match: ['cloudformation', 'get-template', name], stdout: { TemplateBody: { Resources: agent ? { S: { Type: 'AWS::SecurityAgent::AgentSpace' } } : {} } } },
];
const noStack = (name: string): AwsStub => ({ match: ['cloudformation', 'describe-stacks', name], error: 'ValidationError', message: `Stack with id ${name} does not exist` });

export const PRISM_PASS: AwsStub[] = [
  ...stack('PrismD1MetricsPipeline', false),
  ...stack('PrismD1SecurityAgent', true),
  param('agent-space-id', 'as-1'), param('scan-bucket', 'prism-scan'), param('service-role-arn', `arn:aws:iam::${ACCOUNT}:role/r`),
  { match: ['securityagent', 'list-agent-spaces'], stdout: { agentSpaceSummaries: [{ agentSpaceId: 'as-1', name: 'prism-d1-security' }] } },
  { match: ['securityagent', 'list-applications'], stdout: { applicationSummaries: [] } },
  { match: ['securityagent', 'batch-get-agent-spaces'], stdout: { agentSpaces: [{ agentSpaceId: 'as-1', awsResources: { s3Buckets: ['prism-scan'] } }] } },
  { match: ['iam', 'list-open-id-connect-providers'], stdout: { OpenIDConnectProviderList: [{ Arn: `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com` }] } },
  { match: ['iam', 'list-roles'], stdout: ['GitHubActions-prism-d1-velocity', 'Other'] },
];

export const PRISM_FAIL: AwsStub[] = [
  noStack('PrismD1MetricsPipeline'), noStack('PrismD1SecurityAgent'),
  { match: ['ssm', 'get-parameter'], error: 'ParameterNotFound' },
  { match: ['securityagent', 'list-agent-spaces'], stdout: { agentSpaceSummaries: [] } },
  { match: ['securityagent', 'list-applications'], stdout: { applicationSummaries: [] } },
  { match: ['iam', 'list-open-id-connect-providers'], stdout: { OpenIDConnectProviderList: [] } },
  { match: ['iam', 'list-roles'], stdout: ['Other'] },
];

export const PRISM_DENIED: AwsStub[] = [denied('cloudformation'), denied('iam', 'list-open-id-connect-providers'), denied('iam', 'list-roles')];

export function tmp(p: string): string { return mkdtempSync(join(tmpdir(), `prism-aws-${p}-`)); }

/** A HOME with codeburn sync set up (or with an unreadable config). */
export function homeWithCodeburn(state: 'ok' | 'none' | 'broken'): string {
  const home = tmp('home');
  if (state === 'none') return home;
  mkdirSync(join(home, '.config', 'codeburn'), { recursive: true });
  writeFileSync(join(home, '.config', 'codeburn', 'sync.json'), state === 'ok' ? JSON.stringify({ baseUrl: 'https://collector.example.com' }) : '{ nope');
  return home;
}

export function gitRepo(): string {
  const d = tmp('repo');
  spawnSync('git', ['init', '-q', d]);
  return d;
}

/** Deps for awsCheck with captured output; AWS calls go through the fake binary on PATH. */
export function checkDeps(o: { home?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const lines: string[] = [];
  const errs: string[] = [];
  const deps: CheckRunDeps = {
    env: o.env ?? {},
    home: o.home ?? tmp('home'),
    cwd: () => o.cwd ?? tmp('cwd'),
    configRegion: () => null,
    awsVersion: () => { const r = run('aws', ['--version']); return r.ok ? r.stdout : null; },
    git: (args) => run('git', args),
    log: (l = '') => lines.push(l),
    err: (l = '') => errs.push(l),
    now: () => new Date('2026-11-07T12:00:00.000Z'),
  };
  return { deps, lines, errs };
}

/** Runs fn with console.log captured (renderReport prints through it). */
export function captureConsole<T>(fn: () => T): { value: T; out: string } {
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try { return { value: fn(), out: lines.join('\n') }; } finally { console.log = log; }
}

/** A mix of PASS, FAIL and INDETERMINATE outcomes; everything else is unstubbed and errors. */
export const SCAN_ACCOUNT_STUBS: AwsStub[] = [
  { match: ['sts', 'get-caller-identity'], stdout: { Account: '111111111111', Arn: 'arn:aws:sts::111111111111:assumed-role/ReadOnly/s' } },
  { match: ['iam', 'get-account-summary'], stdout: { SummaryMap: { AccountMFAEnabled: 0, AccountAccessKeysPresent: 0 } } },
  { match: ['iam', 'get-account-password-policy'], error: 'NoSuchEntity' },
  { match: ['iam', 'get-credential-report'], error: 'AccessDenied' },
  { match: ['iam', 'list-users'], stdout: ['alice'] },
  { match: ['iam', 'list-attached-user-policies'], stdout: { AttachedPolicies: [{ PolicyName: 'AdministratorAccess' }] } },
  { match: ['budgets', 'describe-budgets'], raw: '' },
  { match: ['ce', 'get-anomaly-monitors'], error: 'AccessDeniedException' },
  { match: ['cloudwatch', 'describe-alarms'], stdout: { MetricAlarms: [] } },
  noDetectors(),
  { match: ['bedrock', 'list-provisioned-model-throughputs'], stdout: { provisionedModelSummaries: [] } },
  { match: ['bedrock', 'get-model-invocation-logging-configuration'], raw: '' },
];
