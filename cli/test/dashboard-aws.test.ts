/** The dashboard's AWS account panel: latest aws check per account, from local results only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Finding } from '../src/utils/audit.js';
import { makeResult, writeResult, type PrismResult } from '../src/codewatch/results.js';
import { collectAws, MAX_TOP_FAILURES } from '../src/dashboard/aws.js';
import { collectCodewatch } from '../src/dashboard/codewatch.js';
import { renderPage } from '../src/dashboard/page.js';
import { gitRepo, tmp } from './aws-fixtures.js';

const fail = (id: string, severity: Finding['severity']): Finding => ({ id, category: id.split('.')[0], title: `t ${id}`, status: 'FAIL', severity, detail: '' });

function check(account: string, at: string, checks: Finding[], region = 'us-west-2'): PrismResult {
  const n = (s: Finding['status']) => checks.filter((c) => c.status === s).length;
  return makeResult({
    kind: 'aws-check', hook: 'manual', status: 'findings', tool: 'prism-cli', started_at: at, finished_at: at,
    aws_check: {
      account, alias: account === '111111111111' ? 'sandbox' : null, region, profile: 'p', profile_source: 'aws connect, user',
      sections: ['baseline'], section_counts: {}, counts: { pass: n('PASS'), fail: n('FAIL'), indeterminate: n('INDETERMINATE') },
      fail_by_severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 }, checks,
    },
  });
}

test('aws panel: latest result per account across repos and home, newest account first', () => {
  const a = gitRepo();
  const home = tmp('home');
  writeResult(a, check('111111111111', '2026-11-06T10:00:00.000Z', [fail('baseline.budget', 'MEDIUM')]));
  writeResult(home, check('111111111111', '2026-11-07T10:00:00.000Z', [fail('baseline.guardduty', 'HIGH')], 'eu-west-1'));
  writeResult(a, check('222222222222', '2026-11-05T10:00:00.000Z', []));
  const p = collectAws([a, home, a]);
  assert.deepEqual(p.accounts.map((r) => [r.account, r.region]), [['111111111111', 'eu-west-1'], ['222222222222', 'us-west-2']]);
  assert.equal(p.accounts[0].top_failures[0].id, 'baseline.guardduty');
  assert.equal(p.accounts[0].profile_source, 'aws connect, user');
  assert.equal(p.hint, 'prism-cli aws check');
});

test('aws panel: top failures are the worst first, capped, with the rest counted', () => {
  const checks = [fail('a.low', 'LOW'), fail('a.crit', 'CRITICAL'), fail('a.high', 'HIGH'), fail('a.m1', 'MEDIUM'), fail('a.m2', 'MEDIUM'), fail('a.m3', 'MEDIUM'),
    { ...fail('a.pass', 'CRITICAL'), status: 'PASS' as const }];
  const [row] = collectAws(['x'], () => [check('111111111111', '2026-11-07T00:00:00.000Z', checks)]).accounts;
  assert.equal(row.top_failures.length, MAX_TOP_FAILURES);
  assert.deepEqual(row.top_failures.slice(0, 2).map((f) => f.id), ['a.crit', 'a.high']);
  assert.equal(row.more, 1);
});

test('aws panel: empty without results; aws-check results stay out of the codewatch panel', () => {
  assert.deepEqual(collectAws([tmp('none')]).accounts, []);
  const repo = gitRepo();
  writeResult(repo, check('111111111111', '2026-11-07T00:00:00.000Z', []));
  assert.equal(collectCodewatch(repo).hasResults, false);
});

test('page: has the AWS account panel and places values as text', () => {
  const html = renderPage('n0nce');
  assert.match(html, /function awsPanel\(aws\)/);
  assert.match(html, /awsPanel\(data\.aws\)/);
  assert.match(html, /No AWS account checks yet/);
  assert.doesNotMatch(html.slice(html.indexOf('function awsPanel'), html.indexOf('async function load')), /innerHTML/);
});
