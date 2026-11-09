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

const f = (id: string, status: Finding['status'], severity: Finding['severity'] = 'MEDIUM', detail = `${id} detail`): Finding => ({
  id, category: id.split('.')[0], title: id, status, severity, detail, remediation: 'r',
});

function saveCheck(root: string, checks: Finding[], o: { account?: string; region?: string; at?: string; sections?: string[] } = {}): string {
  const info: AwsCheckInfo = {
    account: o.account ?? ACCOUNT, alias: 'sandbox', region: o.region ?? REGION, profile: 'p', profile_source: '--profile',
    sections: o.sections ?? ['baseline'], section_counts: {}, counts: { pass: 0, fail: 0, indeterminate: 0 },
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
    f('bedrock.root-mfa', 'FAIL', 'CRITICAL'),
    f('baseline.guardduty', 'PASS', 'HIGH'),
    f('bedrock.user-admin-policy', 'FAIL', 'HIGH'),               // large
    f('bedrock.provisioned-throughput', 'FAIL', 'HIGH'),          // medium
  ]);
  assert.deepEqual(groups.map((g) => g.section), ['bedrock', 'baseline']);
  assert.deepEqual(groups[0].fixes.map((r) => r.id), ['bedrock.root-mfa', 'bedrock.provisioned-throughput', 'bedrock.user-admin-policy']);
  assert.deepEqual(groups[1].fixes.map((r) => r.id), ['baseline.s3-account-bpa', 'baseline.cloudtrail-multiregion', 'baseline.ebs-default-encryption']);
  // Numbered across sections, in display order.
  assert.deepEqual(groups.flatMap((g) => g.fixes.map((x) => x.number)), [1, 2, 3, 4, 5, 6]);
  const r = (severity: Recommendation['severity'], effort: Recommendation['effort'], id: string) => ({ severity, effort, id }) as Recommendation;
  assert.ok(rank(r('LOW', 'quick', 'a'), r('HIGH', 'large', 'b')) > 0);
});

test('INDETERMINATE from access denied becomes a grant item naming the IAM action; startup-advisor says it is not integrated', () => {
  const [g, sa] = buildRecommendations([
    f('baseline.guardduty', 'INDETERMINATE', 'HIGH', 'Could not check (AccessDeniedException). Needs guardduty:ListDetectors.'),
    f('startup-advisor.not-integrated', 'INDETERMINATE', 'INFO'),
  ]);
  assert.equal(g.fixes.length, 0);
  assert.equal(g.access[0].cause, 'access-denied');
  assert.match(g.access[0].title, /^Grant read access to check:/);
  assert.match(g.access[0].steps[0], /guardduty:ListDetectors, guardduty:GetDetector/);
  assert.match(sa.access[0].steps[0], /Not integrated yet/);
});

test('INDETERMINATE for another reason never says "grant"', () => {
  const [g] = buildRecommendations([f('baseline.guardduty', 'INDETERMINATE', 'HIGH', 'Could not check (NotStubbed).')]);
  assert.equal(g.access[0].cause, 'other');
  assert.doesNotMatch(g.access[0].steps[0], /Grant/);
});

test('budgets: the three budget checks become one fix that names each check and both filters', () => {
  const groups = buildRecommendations([
    f('baseline.budget', 'FAIL', 'MEDIUM'), f('bedrock.bedrock-budget', 'FAIL', 'HIGH'), f('bedrock.marketplace-budget', 'FAIL', 'HIGH'),
  ]);
  const all = groups.flatMap((g) => g.fixes);
  assert.equal(all.length, 1);
  const b = all[0];
  assert.equal(b.id, 'budgets');
  assert.equal(b.severity, 'HIGH');
  assert.match(b.title, /Create AWS Budgets/);
  assert.deepEqual(b.covers.map((c) => c.id).sort(), ['baseline.budget', 'bedrock.bedrock-budget', 'bedrock.marketplace-budget']);
  assert.ok(b.steps.some((s) => /Bedrock/.test(s)) && b.steps.some((s) => /Marketplace/.test(s)) && b.steps.some((s) => /all services/.test(s)));
});

test('budget-alerting waiting on missing budgets points at the budgets item, not at access', () => {
  const groups = buildRecommendations([
    f('bedrock.root-mfa', 'FAIL', 'CRITICAL'),
    f('bedrock.bedrock-budget', 'FAIL', 'HIGH'),
    f('bedrock.budget-alerting', 'INDETERMINATE', 'HIGH', 'No COST budget covers Bedrock or Marketplace, so there is no budget whose alerting could be checked.'),
  ]);
  const budgets = groups[0].fixes.find((x) => x.id === 'budgets')!;
  const alert = groups[0].access[0];
  assert.equal(alert.cause, 'prerequisite');
  assert.equal(alert.steps[0], `Create the budgets in item ${budgets.number} first, then re-run prism-cli aws check.`);
  assert.doesNotMatch(alert.steps[0], /Grant/);
  // Denied listing is still an access problem.
  const [d] = buildRecommendations([f('bedrock.budget-alerting', 'INDETERMINATE', 'HIGH', 'Could not list budgets (AccessDeniedException), so it is unknown.')]);
  assert.match(d.access[0].steps[0], /^Grant budgets:ViewBudget/);
});

test('a missing credential report says how to create one, once for the three checks, with no grant', () => {
  const detail = 'Credential report unavailable (ReportNotPresent).';
  const [g] = buildRecommendations(['bedrock.access-key-age', 'bedrock.console-user-no-mfa', 'bedrock.unused-credentials'].map((id) => f(id, 'INDETERMINATE', 'HIGH', detail)));
  assert.equal(g.access.length, 1);
  assert.equal(g.access[0].cause, 'no-credential-report');
  assert.equal(g.access[0].covers.length, 3);
  assert.match(g.access[0].steps[0], /^No credential report exists yet\. Run `prism-cli bedrock-protection scan-account` once \(it generates one, which is a write\) or `aws iam generate-credential-report`, then re-run aws check\.$/);
  assert.doesNotMatch(g.access[0].steps[0], /Grant/);
});

test('the result\'s account and region fill the <account> and <region> placeholders', () => {
  const groups = buildRecommendations([f('baseline.ebs-default-encryption', 'FAIL'), f('baseline.s3-account-bpa', 'FAIL', 'HIGH'), f('baseline.access-analyzer', 'FAIL')], { account: ACCOUNT, region: REGION });
  const text = JSON.stringify(groups);
  assert.doesNotMatch(text, /<region>|<account>/);
  assert.match(text, /enable-ebs-encryption-by-default --region us-west-2/);
  assert.match(text, new RegExp(`--account-id ${ACCOUNT}`));
});

test('root MFA advice carries the generic managed-account caveat; no internal tool is named', () => {
  assert.ok(ADVICE['bedrock.root-mfa'].steps.some((s) => s === 'In some managed or organization accounts the root user is controlled centrally; check with your account owner.'));
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  const src = join(import.meta.dirname, '..', 'src');
  for (const p of [...files(src).filter((x) => x.endsWith('.ts')), join(import.meta.dirname, '..', '..', 'docs', 'BEDROCK-PROTECTION.md')]) {
    assert.doesNotMatch(readFileSync(p, 'utf8'), /Isengard/, p);
  }
});

test('a cached result from before the baseline root-MFA check was dropped still shows one root-MFA fix', () => {
  const groups = buildRecommendations([f('baseline.root-mfa', 'FAIL', 'CRITICAL'), f('bedrock.root-mfa', 'FAIL', 'CRITICAL')]);
  const all = groups.flatMap((g) => g.fixes);
  assert.equal(all.length, 1);
  assert.equal(all[0].section, 'bedrock');
  assert.equal(all[0].title, 'Add MFA to the root user');
  assert.deepEqual(all[0].covers.map((c) => c.id), ['bedrock.root-mfa', 'baseline.root-mfa']);
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
  saveCheck(repo, [f('bedrock.root-mfa', 'FAIL', 'CRITICAL')], { at: '2026-11-07T11:00:00.000Z', region: 'eu-west-1' });
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
  const path = saveCheck(repo, [f('prism-setup.ci-oidc-role', 'FAIL'), f('baseline.budget', 'INDETERMINATE', 'MEDIUM', 'Could not check (AccessDeniedException).')]);
  assert.match(path, new RegExp(`/aws-${ACCOUNT}-${REGION}-\\d{8}T\\d+Z-aws-check\\.json$`), 'account checks are named by account and region, not commit');
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

test('recommend: prefers the newest full run over a newer --section run; a section-only run never says every check passed', () => {
  const ALL = ['bedrock', 'prism-setup', 'baseline', 'startup-advisor'];
  const repo = gitRepo();
  saveCheck(repo, [f('baseline.guardduty', 'FAIL', 'HIGH')], { at: '2026-11-07T09:00:00.000Z', sections: ALL });
  saveCheck(repo, [f('prism-setup.ci-oidc-role', 'PASS')], { at: '2026-11-07T10:00:00.000Z', sections: ['prism-setup'] });
  const full = checkDeps({ cwd: repo });
  assert.equal(awsRecommend({ region: REGION, account: ACCOUNT }, full.deps), 0);
  assert.match(full.lines.join('\n'), /Enable GuardDuty/);
  assert.match(full.lines.join('\n'), /From aws check at 2026-11-07T09:00:00/);
  assert.doesNotMatch(full.lines.join('\n'), /every check passed|covered only/);

  const only = gitRepo();
  saveCheck(only, [f('prism-setup.ci-oidc-role', 'PASS')], { sections: ['prism-setup'] });
  const part = checkDeps({ cwd: only });
  assert.equal(awsRecommend({ region: REGION, account: ACCOUNT, markdown: true }, part.deps), 0);
  const out = part.lines.join('\n');
  assert.match(out, /This aws check covered only prism-setup \(a --section run\); run prism-cli aws check for every section\./);
  assert.match(out, /Nothing to fix in prism-setup; the other sections were not checked\./);
  assert.doesNotMatch(out, /every check passed/);
  const md = readdirSync(join(only, '.prism', 'results')).find((n) => n.endsWith('.recommend.md'))!;
  const mdText = readFileSync(join(only, '.prism', 'results', md), 'utf8');
  assert.match(mdText, /covered only prism-setup/);
  assert.doesNotMatch(mdText, /every check passed/);
});

test('recommend --refresh runs aws check first and reads that result', () => {
  const repo = gitRepo();
  const h = checkDeps({ cwd: repo });
  const { value } = captureConsole(() => withFakeAws([...IDENTITY, ...BASELINE_FAIL], () => awsRecommend({ region: REGION, refresh: true }, h.deps)));
  assert.equal(value, 0);
  assert.ok(readdirSync(join(repo, '.prism', 'results')).some((n) => n.endsWith('-aws-check.json')));
  assert.match(h.lines.join('\n'), /Turn on S3 Block Public Access for the account/);
  assert.match(h.lines.join('\n'), new RegExp(`--account-id ${ACCOUNT}`), 'placeholders filled from the result');
});
