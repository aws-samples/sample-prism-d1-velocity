/**
 * 1.16.0 AccountGuard gaps: why a check could not run (reason per check,
 * "grant" only on access denied), account-free result file names that still
 * read the old ones, and no full account id in the dashboard's APIs or action
 * output. AWS errors come from the fake `aws` binary (the real CLI's stderr
 * shape); nothing reaches AWS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aws } from '../src/utils/aws.js';
import type { Finding } from '../src/utils/audit.js';
import { makeResult, readResultEntries, resultFileName, writeResult, type AwsCheckInfo } from '../src/codewatch/results.js';
import { baselineSection, SECTIONS, securityContext, type CheckContext } from '../src/aws/check.js';
import { awsCheck } from '../src/aws/run-check.js';
import { classifyAwsError, deniedAction, explainIndeterminate, reasonOf } from '../src/aws/reason.js';
import { buildRecommendations, latestCheck } from '../src/aws/recommend.js';
import { writeConnectionFile } from '../src/aws/connection.js';
import { accountGuardView, type AccountGuardDeps } from '../src/dashboard/accountguard.js';
import { collectAws } from '../src/dashboard/aws.js';
import { redact } from '../src/dashboard/actions.js';
import type { Resolved } from '../src/security/setup.js';
import { withFakeAws, type AwsStub } from './helpers.js';
import { captureConsole, checkDeps, gitRepo, homeWithCodeburn, IDENTITY } from './aws-fixtures.js';

const ACCOUNT = '111122223333', REGION = 'us-west-2';
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `prism-gaps-${p}-`)));

// ---------------------------------------------------------------- classification

test('classify: access denied in each of its AWS spellings', () => {
  for (const t of [
    'AccessDenied', 'AccessDeniedException',
    'An error occurred (UnauthorizedOperation) when calling the GetEbsEncryptionByDefault operation: You are not authorized to perform this operation.',
    'An error occurred (AccessDeniedException) when calling the ListDetectors operation: User: arn:aws:sts::111122223333:assumed-role/R/x is not authorized to perform: guardduty:ListDetectors',
  ]) assert.equal(classifyAwsError(t), 'access-denied', t);
  assert.equal(deniedAction('... is not authorized to perform: guardduty:ListDetectors on resource'), 'guardduty:ListDetectors');
  assert.equal(deniedAction('AccessDenied'), null);
});

test('classify: not enabled / not offered in the region, throttled, no report, and the generic rest', () => {
  for (const t of [
    'OptInRequired', 'SubscriptionRequiredException',
    'An error occurred (AccessDeniedException) when calling the GetAnomalyMonitors operation: User not enabled for cost explorer access',
    'Could not connect to the endpoint URL: "https://securityagent.ap-east-2.amazonaws.com/"',
    'ValidationException: This feature is not available in this region',
  ]) assert.equal(classifyAwsError(t), 'not-available', t);
  for (const t of ['Throttling', 'ThrottlingException', 'TooManyRequestsException', 'RequestLimitExceeded', 'Rate exceeded']) assert.equal(classifyAwsError(t), 'throttled', t);
  assert.equal(classifyAwsError('ReportNotPresent'), 'no-credential-report');
  for (const t of ['InternalFailure', 'ServiceUnavailable', 'Read timeout on endpoint URL', 'unknown error', '']) assert.equal(classifyAwsError(t), 'other', t);
});

// ---------------------------------------------------------------- through aws check

function runBaseline(stubs: AwsStub[]): Finding[] {
  const target = { env: { AWS_PAGER: '', AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION } };
  const opts: Resolved = { region: REGION, regionSource: '--region' };
  const security = securityContext(opts, (args, r) => aws([...args, '--region', r], target), {}, () => 'aws-cli/2.36.1', () => {});
  const ctx: CheckContext = { target, account: ACCOUNT, region: REGION, home: homeWithCodeburn('ok'), security };
  return withFakeAws([...IDENTITY, ...stubs], () => baselineSection.run(ctx));
}
const byId = (fs: Finding[], id: string) => fs.find((f) => f.id === id)!;

test('aws check: each failed read records its reason, and only access denied says Grant', () => {
  const fs = runBaseline([
    { match: ['guardduty'], error: 'AccessDeniedException', message: 'User: arn:aws:sts::111122223333:assumed-role/R/x is not authorized to perform: guardduty:ListDetectors' },
    { match: ['ec2'], error: 'UnauthorizedOperation', message: 'You are not authorized to perform this operation.' },
    { match: ['securityhub'], error: 'SubscriptionRequiredException' },
    { match: ['accessanalyzer'], error: 'OptInRequired' },
    { match: ['budgets'], error: 'ThrottlingException', message: 'Rate exceeded' },
    { match: ['cloudtrail'], error: 'Throttling' },
    { match: ['s3control'], error: 'InternalFailure', message: 'We encountered an internal error.' },
  ]);
  const want: Record<string, string> = {
    'baseline.guardduty': 'access-denied', 'baseline.ebs-default-encryption': 'access-denied',
    'baseline.securityhub': 'not-available', 'baseline.access-analyzer': 'not-available',
    'baseline.budget': 'throttled', 'baseline.cloudtrail-multiregion': 'throttled', 'baseline.s3-account-bpa': 'other',
  };
  for (const [id, reason] of Object.entries(want)) {
    const f = byId(fs, id);
    assert.equal(f.status, 'INDETERMINATE', id);
    assert.equal(f.reason, reason, `${id}: ${f.detail}`);
    if (reason === 'access-denied') {
      assert.match(f.remediation!, /^Grant /, id);
      assert.ok(f.needs?.length, id);
      assert.match(f.detail, / Needs /, id);
    } else {
      assert.doesNotMatch(f.remediation!, /Grant/, id);
      assert.equal(f.needs, undefined, id);
      assert.doesNotMatch(f.detail, /Needs/, id);
    }
  }
  // The action the message names wins over the one the check guessed.
  assert.deepEqual(byId(fs, 'baseline.guardduty').needs, ['guardduty:ListDetectors']);
  assert.deepEqual(byId(fs, 'baseline.ebs-default-encryption').needs, ['ec2:GetEbsEncryptionByDefault']);
  assert.match(byId(fs, 'baseline.securityhub').remediation!, /not enabled for this account, or not offered in this region; there is nothing to grant/);
  assert.match(byId(fs, 'baseline.budget').remediation!, /throttled.*Wait a minute/);
});

test('aws check: the saved result and the report carry the reason; --json findings too', () => {
  const repo = gitRepo();
  const stubs: AwsStub[] = [
    { match: ['guardduty'], error: 'AccessDeniedException' }, { match: ['securityhub'], error: 'OptInRequired' }, { match: ['budgets'], error: 'ThrottlingException' },
    { match: ['cloudtrail'], error: 'ServiceUnavailable' }, { match: ['accessanalyzer'], stdout: { analyzers: [] } }, { match: ['s3control'], error: 'NoSuchPublicAccessBlockConfiguration' },
    { match: ['ec2'], stdout: { EbsEncryptionByDefault: true } },
  ];
  const h = checkDeps({ cwd: repo, home: homeWithCodeburn('ok') });
  const { value, out } = captureConsole(() => withFakeAws([...IDENTITY, ...stubs], () => awsCheck({ region: REGION, section: ['baseline', 'startup-advisor'] }, h.deps)));
  assert.equal(value.code, 0);
  const reasons = Object.fromEntries(value.result!.aws_check!.checks.filter((f) => f.status === 'INDETERMINATE').map((f) => [f.id, f.reason]));
  assert.deepEqual(reasons, {
    'baseline.guardduty': 'access-denied', 'baseline.securityhub': 'not-available', 'baseline.budget': 'throttled',
    'baseline.cloudtrail-multiregion': 'other', 'startup-advisor.not-integrated': 'not-integrated',
  });
  assert.match(out, /Reason: access denied\n\s+→ Grant guardduty:ListDetectors \(read-only\)/);
  assert.match(out, /Reason: throttled by AWS\n\s+→ AWS throttled the call/);
  assert.match(out, /Why: 1 the call failed; 1 access denied; 1 service not enabled, or not offered in this region; 1 throttled by AWS; 1 not integrated yet\./);
  const grants = out.split('\n').filter((l) => /→ Grant/.test(l));
  assert.equal(grants.length, 1, 'only the denied check says Grant');
  const j = captureConsole(() => withFakeAws([...IDENTITY, ...stubs], () => awsCheck({ region: REGION, section: ['baseline'], json: true }, checkDeps({ cwd: gitRepo() }).deps)));
  const parsed = JSON.parse(j.out);
  assert.equal(parsed.findings.find((f: Finding) => f.id === 'baseline.budget').reason, 'throttled');
});

test('old results (no reason, "Needs X." on every failed read) still read the right reason', () => {
  const old = (id: string, detail: string): Finding => ({ id, category: id.split('.')[0], title: id, status: 'INDETERMINATE', severity: 'MEDIUM', detail, remediation: 'Grant x (read-only) and re-run prism-cli aws check.' });
  assert.equal(reasonOf(old('baseline.guardduty', 'Could not check (AccessDeniedException). Needs guardduty:ListDetectors.')), 'access-denied');
  assert.equal(reasonOf(old('baseline.budget', 'Could not check (ThrottlingException). Needs budgets:ViewBudget.')), 'throttled');
  assert.equal(reasonOf(old('baseline.securityhub', 'Could not check (SubscriptionRequiredException). Needs securityhub:DescribeHub.')), 'not-available');
  assert.equal(reasonOf(old('bedrock.budget-alerting', 'No Bedrock budget to check the alerts of.')), 'prerequisite');
  // aws recommend gives the throttled one a re-run step, not a grant.
  const recs = buildRecommendations([old('baseline.budget', 'Could not check (ThrottlingException). Needs budgets:ViewBudget.')]);
  const access = recs.flatMap((g) => g.access);
  assert.equal(access[0].cause, 'throttled');
  assert.doesNotMatch(access[0].steps[0], /Grant/);
  // explainIndeterminate is idempotent.
  const once = explainIndeterminate(old('baseline.guardduty', 'Could not check (AccessDeniedException).'));
  assert.deepEqual(explainIndeterminate(once), once);
});

// ---------------------------------------------------------------- file names

function info(o: Partial<AwsCheckInfo> = {}): AwsCheckInfo {
  return {
    account: ACCOUNT, alias: null, region: REGION, profile: 'demo', profile_source: '--profile', sections: SECTIONS.map((s) => s.name), section_counts: {},
    counts: { pass: 1, fail: 0, indeterminate: 0 }, fail_by_severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
    checks: [{ id: 'baseline.guardduty', category: 'baseline', title: 'GuardDuty', status: 'PASS', severity: 'HIGH', detail: 'ok' }], ...o,
  };
}
const result = (at: string, o: Partial<AwsCheckInfo> = {}) => makeResult({ kind: 'aws-check', hook: 'manual', status: 'ok', tool: 'prism-cli', started_at: at, finished_at: at, aws_check: info(o) });

test('file names: new runs are named by run id with no account id; old account-named files still load', () => {
  const repo = gitRepo();
  const h = checkDeps({ cwd: repo, home: homeWithCodeburn('ok') });
  const { value } = captureConsole(() => withFakeAws([...IDENTITY], () => awsCheck({ region: REGION, section: ['startup-advisor'] }, h.deps)));
  const id = value.result!.aws_check!.run_id!;
  assert.match(id, /^\d{8}T\d{9}Z-[0-9a-f]{6}$/);
  assert.match(value.path!, new RegExp(`/\\.prism/results/aws-${id}-aws-check\\.json$`));
  assert.ok(!value.path!.includes(value.result!.aws_check!.account), 'no account id in the file name');
  // No run id (a result built by hand): still no account id in the name.
  assert.equal(resultFileName(result('2026-11-01T10:00:00.000Z')), 'aws-20261101T100000000Z-aws-check.json');

  // An old-style file next to a new-style one: both read, the newest wins.
  const root = tmp('root');
  writeResult(root, result('2026-11-01T10:00:00.000Z'), `aws-${ACCOUNT}-${REGION}-20261101T100000000Z-aws-check`);
  writeResult(root, result('2026-11-10T10:00:00.000Z', { run_id: '20261110T100000000Z-abc123' }));
  const names = readdirSync(join(root, '.prism', 'results')).sort();
  assert.deepEqual(names, ['aws-111122223333-us-west-2-20261101T100000000Z-aws-check.json', 'aws-20261110T100000000Z-abc123-aws-check.json']);
  const entries = readResultEntries(root);
  assert.equal(entries.length, 2);
  assert.equal(latestCheck(entries, ACCOUNT, REGION)!.id, 'aws-20261110T100000000Z-abc123-aws-check');
  assert.equal(latestCheck(entries.filter((e) => e.id.includes(ACCOUNT)), ACCOUNT, REGION)!.result.started_at, '2026-11-01T10:00:00.000Z');
});

// ---------------------------------------------------------------- dashboard

test('dashboard: AccountGuard reads old and new runs, shows the stored reason, and no full account id leaves the server', async () => {
  const home = tmp('home');
  writeConnectionFile(join(home, '.prism', 'aws.json'), { profile: 'demo', region: REGION, account: ACCOUNT, alias: 'demo', verifiedAt: '2026-11-14T10:00:00.000Z' });
  const s3 = explainIndeterminate({ id: 'baseline.s3-account-bpa', category: 'baseline', title: 'S3', status: 'INDETERMINATE', severity: 'HIGH', detail: 'Could not check (ThrottlingException).' });
  const fail: Finding = { id: 'baseline.budget', category: 'baseline', title: 'Budget', status: 'FAIL', severity: 'MEDIUM', detail: `No budgets in ${ACCOUNT}.`, remediation: `aws budgets create-budget --account-id ${ACCOUNT} ...` };
  writeResult(home, result('2026-11-01T10:00:00.000Z'), `aws-${ACCOUNT}-${REGION}-20261101T100000000Z-aws-check`);
  writeResult(home, result('2026-11-14T09:00:00.000Z', { run_id: '20261114T090000000Z-0a1b2c', checks: [s3, fail] }));
  const d: AccountGuardDeps = { home, repoRoot: null, roots: async () => [home], exclusive: async (fn) => ({ status: 200, json: await fn() }) };
  const v = await accountGuardView(d);
  assert.equal(v.runs.length, 2, 'the old account-named run is listed too');
  assert.equal(v.latest!.checks.find((c) => c.id === 'baseline.s3-account-bpa')!.cause, 'throttled');
  const json = JSON.stringify(v);
  assert.ok(!json.includes(ACCOUNT), 'no full account id in /api/accountguard (file names, detail or fix text)');
  assert.match(json, /--account-id <account>/);

  const panel = collectAws([home]);
  assert.equal(panel.accounts[0].account, '••••3333');
  assert.ok(!JSON.stringify(panel).includes(ACCOUNT));

  const out = redact(`Account:     ${ACCOUNT} (demo)\nCaller:      arn:aws:sts::${ACCOUNT}:assumed-role/R/x\nSaved .prism/results/aws-20261114T090000000Z-0a1b2c-aws-check.json`);
  assert.ok(!out.includes(ACCOUNT));
  assert.match(out, /Account: {5}••••3333 \(demo\)/);
  assert.match(out, /arn:aws:sts::••••3333:assumed-role/);
  assert.match(out, /aws-20261114T090000000Z-0a1b2c-aws-check\.json/, 'a run id is not mistaken for an account id');
});

test('dashboard page: every reason has a label, including the new ones', async () => {
  const { ACCOUNTGUARD_SCRIPT } = await import('../src/dashboard/accountguard-page.js');
  for (const r of ['access-denied', 'not-available', 'throttled', 'prerequisite', 'no-credential-report', 'not-integrated', 'other']) {
    assert.ok(ACCOUNTGUARD_SCRIPT.includes(`'${r}': [`), r);
  }
});
