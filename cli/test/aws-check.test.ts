/**
 * `prism-cli aws check`: each section's PASS / FAIL / INDETERMINATE outcomes
 * against the fake `aws` binary, the result file, and that it only reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aws } from '../src/utils/aws.js';
import type { Finding } from '../src/utils/audit.js';
import { readResults } from '../src/codewatch/results.js';
import { isWriteCall, type Resolved } from '../src/security/setup.js';
import {
  ALL_CHECK_IDS, baselineSection, bedrockSection, prismSetupSection, SECTIONS, securityContext, selectSections, startupAdvisorSection,
  type CheckContext, type CheckSection,
} from '../src/aws/check.js';
import { awsCheck } from '../src/aws/run-check.js';
import { withFakeAws, type AwsStub } from './helpers.js';
import {
  ACCOUNT, BASELINE_DENIED, BASELINE_FAIL, BASELINE_PASS, IDENTITY, PRISM_DENIED, PRISM_FAIL, PRISM_PASS, REGION,
  captureConsole, checkDeps, gitRepo, homeWithCodeburn,
} from './aws-fixtures.js';
import { SCAN_ACCOUNT_STUBS } from './aws-fixtures.js';

function ctx(home = homeWithCodeburn('ok')): CheckContext {
  const target = { env: { AWS_PAGER: '', AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION } };
  const opts: Resolved = { region: REGION, regionSource: '--region' };
  const security = securityContext(opts, (args, r) => aws([...args, '--region', r], target), {}, () => 'aws-cli/2.36.1', () => {});
  return { target, account: ACCOUNT, region: REGION, home, security };
}

function runSection(s: CheckSection, stubs: AwsStub[], home?: string): { findings: Finding[]; calls: string[][] } {
  const calls: string[][] = [];
  const findings = withFakeAws([...IDENTITY, ...stubs], () => s.run(ctx(home)), calls);
  return { findings, calls };
}

const statuses = (fs: Finding[]) => Object.fromEntries(fs.map((f) => [f.id, f.status]));
const assertAll = (fs: Finding[], status: Finding['status']) => {
  for (const f of fs) assert.equal(f.status, status, `${f.id}: ${f.detail}`);
};
const assertReadOnly = (calls: string[][]) => {
  for (const c of calls) assert.equal(isWriteCall(c), false, `write call: ${c.join(' ')}`);
};

test('baseline: every check passes on a configured account', () => {
  const { findings, calls } = runSection(baselineSection, BASELINE_PASS);
  assert.equal(findings.length, 8);
  assertAll(findings, 'PASS');
  assertReadOnly(calls);
  // The trail status is read in the trail's home region, not the checked one.
  assert.ok(calls.some((c) => c.includes('get-trail-status') && c.includes('us-east-1')));
});

test('baseline: every check fails with a remediation on a bare account', () => {
  const { findings } = runSection(baselineSection, BASELINE_FAIL);
  assertAll(findings, 'FAIL');
  for (const f of findings) assert.ok(f.remediation, f.id);
});

test('baseline: denied reads are INDETERMINATE (never a pass) and name the IAM action', () => {
  const { findings } = runSection(baselineSection, BASELINE_DENIED);
  assertAll(findings, 'INDETERMINATE');
  assert.match(findings.find((f) => f.id === 'baseline.guardduty')!.detail, /AccessDenied.*guardduty:ListDetectors/);
  assert.match(findings.find((f) => f.id === 'baseline.s3-account-bpa')!.detail, /s3:GetAccountPublicAccessBlock/);
});

test('baseline: a trail that exists but is not logging fails; partial S3 Block Public Access fails', () => {
  const { findings } = runSection(baselineSection, [
    { match: ['cloudtrail', 'describe-trails'], stdout: { trailList: [{ Name: 'org', TrailARN: 'a', HomeRegion: REGION, IsMultiRegionTrail: true }] } },
    { match: ['cloudtrail', 'get-trail-status'], stdout: { IsLogging: false } },
    { match: ['s3control', 'get-public-access-block'], stdout: { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: true } } },
    ...BASELINE_PASS,
  ]);
  const s = statuses(findings);
  assert.equal(s['baseline.cloudtrail-multiregion'], 'FAIL');
  assert.equal(s['baseline.s3-account-bpa'], 'FAIL');
  assert.match(findings.find((f) => f.id === 'baseline.s3-account-bpa')!.detail, /Off: BlockPublicPolicy/);
});

test('prism-setup: all pass with the stacks, SSM params, OIDC role and codeburn sync in place', () => {
  const { findings, calls } = runSection(prismSetupSection, PRISM_PASS);
  assert.deepEqual(findings.map((f) => f.id), prismSetupSection.ids.map((id) => `prism-setup.${id}`));
  assertAll(findings, 'PASS');
  assertReadOnly(calls);
  assert.match(findings.find((f) => f.id === 'prism-setup.ci-oidc-role')!.detail, /GitHubActions-prism-d1-velocity/);
});

test('prism-setup: missing stacks, params, role and codeburn sync fail', () => {
  const { findings } = runSection(prismSetupSection, PRISM_FAIL, homeWithCodeburn('none'));
  const s = statuses(findings);
  for (const id of ['metrics-pipeline', 'security-agent-stack', 'security-agent-ssm', 'ci-oidc-role', 'codeburn-sync']) assert.equal(s[`prism-setup.${id}`], 'FAIL', id);
  // No agent space, so whether the bucket is listed cannot be told.
  assert.equal(s['prism-setup.scan-bucket-listed'], 'INDETERMINATE');
  assert.match(findings.find((f) => f.id === 'prism-setup.ci-oidc-role')!.remediation!, /bootstrapper setup-github-oidc/);
  assert.match(findings.find((f) => f.id === 'prism-setup.codeburn-sync')!.remediation!, /enable codeburn/);
});

test('prism-setup: denied reads are INDETERMINATE; an unreadable codeburn config too', () => {
  const { findings } = runSection(prismSetupSection, PRISM_DENIED, homeWithCodeburn('broken'));
  assertAll(findings, 'INDETERMINATE');
});

test('bedrock: the scan-account checks, prefixed, with no credential report generation', () => {
  const stubs = SCAN_ACCOUNT_STUBS.map((s) => (s.match.join(' ') === 'iam get-credential-report' ? { ...s, error: 'ReportNotPresent' } : s));
  const { findings, calls } = runSection(bedrockSection, [{ match: ['iam', 'generate-credential-report'], raw: '' }, ...stubs]);
  assert.equal(findings.length, 16);
  assert.ok(findings.every((f) => f.id.startsWith('bedrock.') && f.category === 'bedrock'));
  assert.equal(statuses(findings)['bedrock.root-mfa'], 'FAIL');
  assert.equal(statuses(findings)['bedrock.access-key-age'], 'INDETERMINATE');
  assert.ok(!calls.some((c) => c.includes('generate-credential-report')), 'aws check must not generate a credential report');
});

test('startup-advisor: a placeholder that is INDETERMINATE, not a pass', () => {
  const f = startupAdvisorSection.run(ctx());
  assert.deepEqual(f.map((x) => [x.id, x.status]), [['startup-advisor.not-integrated', 'INDETERMINATE']]);
});

test('sections: every id a section returns is declared; --section validates names', () => {
  for (const [s, stubs] of [[baselineSection, BASELINE_PASS], [baselineSection, BASELINE_DENIED], [prismSetupSection, PRISM_FAIL]] as const) {
    for (const f of runSection(s, stubs).findings) assert.ok(ALL_CHECK_IDS.includes(f.id), f.id);
  }
  assert.equal(new Set(ALL_CHECK_IDS).size, ALL_CHECK_IDS.length);
  assert.deepEqual(SECTIONS.map((s) => s.name), ['bedrock', 'prism-setup', 'baseline', 'startup-advisor']);
  assert.match((selectSections(['nope']) as { error: string }).error, /choose from bedrock, prism-setup, baseline, startup-advisor/);
});

test('awsCheck: read-only notice first, identity header, result saved with per-section counts', () => {
  const repo = gitRepo();
  const h = checkDeps({ cwd: repo, home: homeWithCodeburn('ok') });
  const calls: string[][] = [];
  const { value, out } = captureConsole(() => withFakeAws([...IDENTITY, ...BASELINE_FAIL],
    () => awsCheck({ region: REGION, section: ['baseline', 'startup-advisor'], profile: 'prism-sa-test', profileSource: 'aws connect, user' }, h.deps), calls));
  assert.equal(value.code, 0, 'report-only by default');
  assert.match(h.lines[0], /^Read-only \(aws check\)/);
  assert.ok(h.lines.includes('Credentials: profile prism-sa-test (aws connect, user)'));
  assert.ok(h.lines.some((l) => l.startsWith(`Account:     ${ACCOUNT} (sandbox)`)));
  assert.match(out, /AWS account check/);
  assertReadOnly(calls);
  const [r] = readResults(repo);
  assert.equal(r.kind, 'aws-check');
  assert.equal(r.aws_check!.account, ACCOUNT);
  assert.equal(r.aws_check!.region, REGION);
  assert.deepEqual(r.aws_check!.section_counts, { baseline: { pass: 0, fail: 8, indeterminate: 0 }, 'startup-advisor': { pass: 0, fail: 0, indeterminate: 1 } });
  assert.equal(r.aws_check!.fail_by_severity.CRITICAL, 1);
  assert.equal(r.aws_check!.profile_source, 'aws connect, user');
});

test('awsCheck: --fail-on exits 1 only on FAIL at or above it; --json keeps stdout pure JSON', () => {
  const run = (failOn: string, stubs: AwsStub[], json = false) => {
    const h = checkDeps({ cwd: gitRepo() });
    const c = captureConsole(() => withFakeAws([...IDENTITY, ...stubs], () => awsCheck({ region: REGION, section: ['baseline'], failOn, json }, h.deps)));
    return { ...c, h };
  };
  assert.equal(run('critical', BASELINE_FAIL).value.code, 1);
  assert.equal(run('critical', BASELINE_DENIED).value.code, 0, 'INDETERMINATE never breaches --fail-on');
  const j = run('none', BASELINE_PASS, true);
  const parsed = JSON.parse(j.out);
  assert.equal(parsed.account, ACCOUNT);
  assert.equal(parsed.findings.length, 8);
  assert.match(j.h.errs[0], /^Read-only/);
});

test('awsCheck: no region refuses before any AWS call; bad --section and --fail-on refuse', () => {
  const calls: string[][] = [];
  const h = checkDeps();
  const r = withFakeAws([], () => awsCheck({}, h.deps), calls);
  assert.equal(r.code, 1);
  assert.match(h.lines.join('\n'), /No AWS region is set.*aws connect/);
  assert.equal(calls.length, 0);
  assert.equal(awsCheck({ region: REGION, section: ['x'] }, checkDeps().deps).code, 1);
  assert.equal(awsCheck({ region: REGION, failOn: 'loud' }, checkDeps().deps).code, 1);
});

test('awsCheck: outside a git repo the result goes to ~/.prism/results', () => {
  const home = homeWithCodeburn('none');
  const h = checkDeps({ home });
  captureConsole(() => withFakeAws([...IDENTITY], () => awsCheck({ region: REGION, section: ['startup-advisor'] }, h.deps)));
  assert.equal(readResults(home)[0].kind, 'aws-check');
});
