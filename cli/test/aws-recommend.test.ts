/**
 * `prism-cli aws recommend`: mapping completeness, ranking, INDETERMINATE
 * items, reading the right result, --json, --markdown and --refresh.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Finding } from '../src/utils/audit.js';
import { makeResult, writeResult, type AwsCheckInfo } from '../src/codewatch/results.js';
import { ALL_CHECK_IDS } from '../src/aws/check.js';
import { ADVICE } from '../src/aws/advice.js';
import { awsRecommend, buildRecommendations, rank, type Recommendation } from '../src/aws/recommend.js';
import { withFakeAws } from './helpers.js';
import { ACCOUNT, BASELINE_FAIL, IDENTITY, REGION, captureConsole, checkDeps, gitRepo } from './aws-fixtures.js';

const f = (id: string, status: Finding['status'], severity: Finding['severity'] = 'MEDIUM'): Finding => ({
  id, category: id.split('.')[0], title: id, status, severity, detail: `${id} detail`, remediation: 'r',
});

function saveCheck(root: string, checks: Finding[], o: { account?: string; region?: string; at?: string } = {}): string {
  const info: AwsCheckInfo = {
    account: o.account ?? ACCOUNT, alias: 'sandbox', region: o.region ?? REGION, profile: 'p', profile_source: '--profile',
    sections: ['baseline'], section_counts: {}, counts: { pass: 0, fail: 0, indeterminate: 0 },
    fail_by_severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 }, checks,
  };
  const at = o.at ?? '2026-11-07T10:00:00.000Z';
  return writeResult(root, makeResult({ kind: 'aws-check', hook: 'manual', status: 'findings', tool: 'prism-cli', started_at: at, finished_at: at, aws_check: info }));
}

test('mapping: every check id aws check can return has an entry, and nothing else does', () => {
  const missing = ALL_CHECK_IDS.filter((id) => !ADVICE[id]);
  assert.deepEqual(missing, [], `check ids without a recommend mapping: ${missing.join(', ')}`);
  assert.deepEqual(Object.keys(ADVICE).filter((id) => !ALL_CHECK_IDS.includes(id)), []);
  for (const [id, a] of Object.entries(ADVICE)) {
    assert.ok(a.title && a.why && a.steps.length && a.doc, id);
    if (a.command) assert.match(a.command, /^prism-cli /, id);
  }
});

test('mapping: the prism-cli commands it names exist', () => {
  const cmds = new Set(Object.values(ADVICE).map((a) => a.command).filter(Boolean));
  assert.deepEqual([...cmds].sort(), ['prism-cli bootstrapper setup-github-oidc', 'prism-cli enable codeburn', 'prism-cli enable security']);
  for (const c of cmds) {
    const [, group, name] = c!.split(' ');
    assert.ok(existsSync(join(import.meta.dirname, '..', 'src', 'commands', group, `${name}.ts`)), c!);
  }
});

test('ranking: severity first, then quick wins, then id; grouped by section in aws check order', () => {
  const groups = buildRecommendations([
    f('baseline.ebs-default-encryption', 'FAIL', 'MEDIUM'),        // quick
    f('baseline.cloudtrail-multiregion', 'FAIL', 'HIGH'),          // medium
    f('baseline.s3-account-bpa', 'FAIL', 'HIGH'),                  // quick
    f('baseline.root-mfa', 'FAIL', 'CRITICAL'),
    f('baseline.guardduty', 'PASS', 'HIGH'),
    f('bedrock.user-admin-policy', 'FAIL', 'HIGH'),               // large
    f('bedrock.bedrock-budget', 'FAIL', 'HIGH'),                  // quick
  ]);
  assert.deepEqual(groups.map((g) => g.section), ['bedrock', 'baseline']);
  assert.deepEqual(groups[0].fixes.map((r) => r.id), ['bedrock.bedrock-budget', 'bedrock.user-admin-policy']);
  assert.deepEqual(groups[1].fixes.map((r) => r.id), ['baseline.root-mfa', 'baseline.s3-account-bpa', 'baseline.cloudtrail-multiregion', 'baseline.ebs-default-encryption']);
  const r = (severity: Recommendation['severity'], effort: Recommendation['effort'], id: string) => ({ severity, effort, id }) as Recommendation;
  assert.ok(rank(r('LOW', 'quick', 'a'), r('HIGH', 'large', 'b')) > 0);
});

test('INDETERMINATE becomes a grant-read-access item naming the IAM action; startup-advisor says it is not integrated', () => {
  const [g, sa] = buildRecommendations([f('baseline.guardduty', 'INDETERMINATE', 'HIGH'), f('startup-advisor.not-integrated', 'INDETERMINATE', 'INFO')]);
  assert.equal(g.fixes.length, 0);
  assert.equal(g.access[0].kind, 'access');
  assert.match(g.access[0].title, /^Grant read access to check:/);
  assert.match(g.access[0].steps[0], /guardduty:ListDetectors, guardduty:GetDetector/);
  assert.match(sa.access[0].steps[0], /Not integrated yet/);
});

test('an unmapped id (older result) falls back to the check\'s own remediation', () => {
  const [g] = buildRecommendations([f('baseline.retired-check', 'FAIL')]);
  assert.deepEqual(g.fixes[0].steps, ['r']);
});

test('recommend: no result says so and points to aws check / --refresh', () => {
  const h = checkDeps({ cwd: gitRepo() });
  assert.equal(awsRecommend({ region: REGION }, h.deps), 1);
  assert.match(h.lines.join('\n'), /No aws check result for region us-west-2\. Run prism-cli aws check first, or prism-cli aws recommend --refresh/);
});

test('recommend: reads the latest result for the account and region, makes no AWS calls', () => {
  const repo = gitRepo();
  saveCheck(repo, [f('baseline.budget', 'FAIL')], { at: '2026-11-07T09:00:00.000Z' });
  saveCheck(repo, [f('baseline.guardduty', 'FAIL', 'HIGH')], { at: '2026-11-07T10:00:00.000Z' });
  saveCheck(repo, [f('baseline.root-mfa', 'FAIL', 'CRITICAL')], { at: '2026-11-07T11:00:00.000Z', region: 'eu-west-1' });
  saveCheck(repo, [f('baseline.securityhub', 'FAIL')], { at: '2026-11-07T12:00:00.000Z', account: '210987654321' });
  const h = checkDeps({ cwd: repo });
  const calls: string[][] = [];
  const code = withFakeAws([], () => awsRecommend({ region: REGION, account: ACCOUNT }, h.deps), calls);
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  const out = h.lines.join('\n');
  assert.match(h.lines[0], /^No AWS calls \(aws recommend\)/);
  assert.match(out, /1\. \[HIGH · quick\] Enable GuardDuty/);
  assert.doesNotMatch(out, /Budget|root user|Security Hub/);
});

test('recommend: the aws connect account is the default; --json and --markdown', () => {
  const repo = gitRepo();
  const path = saveCheck(repo, [f('prism-setup.ci-oidc-role', 'FAIL'), f('baseline.budget', 'INDETERMINATE')]);
  const conn = { profile: 'p', region: REGION, account: ACCOUNT, alias: null, verifiedAt: '', scope: 'user' as const, path: '' };
  const h = checkDeps({ cwd: repo });
  assert.equal(awsRecommend({ connection: conn, json: true, markdown: true }, h.deps), 0);
  const j = JSON.parse(h.lines.join('\n'));
  assert.equal(j.schema, 'prism.aws-recommend.v1');
  assert.equal(j.groups[0].fixes[0].command, 'prism-cli bootstrapper setup-github-oidc');
  assert.match(j.groups[1].access[0].steps[0], /budgets:ViewBudget/);
  const md = path.replace(/\.json$/, '.recommend.md');
  assert.match(readFileSync(md, 'utf8'), /^# AWS recommendations[\s\S]*### 1\. Create the CI OIDC provider and role[\s\S]*Run `prism-cli bootstrapper setup-github-oidc`/);
  assert.match(h.errs.join('\n'), /Wrote .*\.recommend\.md/);
});

test('recommend --refresh runs aws check first and reads that result', () => {
  const repo = gitRepo();
  const h = checkDeps({ cwd: repo });
  const { value } = captureConsole(() => withFakeAws([...IDENTITY, ...BASELINE_FAIL], () => awsRecommend({ region: REGION, refresh: true }, h.deps)));
  assert.equal(value, 0);
  assert.ok(readdirSync(join(repo, '.prism', 'results')).some((n) => n.endsWith('-aws-check.json')));
  assert.match(h.lines.join('\n'), /Add MFA to the root user/);
});
