import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountIdsIn, redact } from '../src/utils/redact.js';
import { makeResult, resultFileName } from '../src/codewatch/results.js';

const ACCOUNT = '111122223333';
const OTHER = '444455556666';
/** A commit whose 12-character prefix has no hex letter: about 1 commit in 280 looks like this. */
const COMMIT = '123456789012' + 'abcdef0123456789abcdef0123456789';
const SHORT = COMMIT.slice(0, 12);

test('redact masks account ids in every account context', () => {
  const out = redact([
    `Account:     ${ACCOUNT} (demo)`,
    `Caller:      arn:aws:sts::${ACCOUNT}:assumed-role/R/someone`,
    `{"Account": "${ACCOUNT}", "MasterAccountId":"${OTHER}"}`,
    `aws s3control put-public-access-block --account-id ${ACCOUNT}`,
    `SSM scan-bucket = security-agent-scans-${ACCOUNT}-us-west-2`,
    `Bucket policy grants arn:aws:iam::${OTHER}:role/Reader in ${ACCOUNT}. Remove the grant to ${OTHER}.`,
  ].join('\n'));
  assert.ok(!out.includes(ACCOUNT) && !out.includes(OTHER), out);
  assert.match(out, /Account: {5}••••3333 \(demo\)/);
  assert.match(out, /arn:aws:sts::••••3333:assumed-role\/R\/…/);
  assert.match(out, /security-agent-scans-••••3333-us-west-2/);
});

test('a 12-digit commit prefix, result id, job id or UUID group is left whole so it can be copied', () => {
  const id = resultFileName(makeResult({ kind: 'security-review', hook: 'manual', tool: 'security-agent', status: 'ok', commit: COMMIT, started_at: '2026-11-15T12:34:06.301Z', finished_at: '2026-11-15T12:34:06.301Z' })).replace(/\.json$/, '');
  assert.equal(id, `${SHORT}-20261115T123406301Z-manual-security-review`);
  const lines = [
    `Saved .prism/results/${id}.json (pending)`,
    `Scope:       origin/main...${SHORT}`,
    `Review context: s3://bucket/repo/x/latest.zip is already HEAD ${SHORT}; upload skipped`,
    `Uploaded s3://bucket/diffs/x/local/${SHORT}-${SHORT}.patch`,
    `Source:      the repo at ${SHORT}`,
    `s3://bucket/threat-model/github.com-acme-widgets/${SHORT}/repo.zip`,
    `Started job ${SHORT}`,
    `Job:         0f8fad5b-d9cb-469f-a165-${SHORT} (COMPLETED)`,
    `{"id":"${SHORT}","job_id":"${SHORT}","commit":"${SHORT}"}`,
    `(commit ${SHORT})`,
  ];
  const out = redact(lines.join('\n'));
  assert.equal(out, lines.join('\n'));
  assert.deepEqual(accountIdsIn(out), []);
});

test('an id shape next to an account does not shield the account', () => {
  const out = redact(`Started job ${SHORT} in account ${ACCOUNT}; role arn:aws:iam::${ACCOUNT}:role/x`);
  assert.equal(out, `Started job ${SHORT} in account ••••3333; role arn:aws:iam::••••3333:role/x`);
  assert.deepEqual(accountIdsIn(`HEAD ${SHORT} ${OTHER}`), [OTHER]);
});
