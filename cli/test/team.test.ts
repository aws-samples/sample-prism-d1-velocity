/**
 * `prism-cli team info` and `team add-developer` against the fake `aws`
 * binary. No real AWS call is made.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDeveloper, teamInfo, type TeamDeps } from '../src/aws/team.js';
import { withFakeAws, type AwsStub } from './helpers.js';
import { ACCOUNT, IDENTITY, REGION } from './aws-fixtures.js';

const POOL = 'us-west-2_AbC123';
const COLLECTOR = 'https://abc123.execute-api.us-west-2.amazonaws.com';
const FAKE_PASSWORD = 'Tmp-Pa55word-SHOULD-NEVER-PRINT';
const stack = (outputs: { OutputKey: string; OutputValue: string }[]): AwsStub =>
  ({ match: ['cloudformation', 'describe-stacks', 'PrismD1MetricsPipeline'], stdout: { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', Outputs: outputs }] } });
const FOUND = stack([{ OutputKey: 'OtelCollectorUrl', OutputValue: COLLECTOR }, { OutputKey: 'OtelUserPoolId', OutputValue: POOL }, { OutputKey: 'Other', OutputValue: 'x' }]);
const NO_STACK: AwsStub = { match: ['cloudformation', 'describe-stacks'], error: 'ValidationError', message: 'Stack with id PrismD1MetricsPipeline does not exist' };
const CREATED: AwsStub = { match: ['cognito-idp', 'admin-create-user'], stdout: { User: { Username: 'dev@example.com', UserStatus: 'FORCE_CHANGE_PASSWORD' }, TemporaryPassword: FAKE_PASSWORD } };

function deps(o: { tty?: boolean; answer?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const d: TeamDeps = {
    env: {}, configRegion: () => null, isTTY: o.tty ?? true,
    ask: async (q) => { asked.push(q); return o.answer ?? ''; },
    log: (l = '') => out.push(l), err: (l = '') => err.push(l),
  };
  return { d, out, err, asked, all: () => [...out, ...err].join('\n') };
}
const createCalls = (calls: string[][]) => calls.filter((c) => c.includes('admin-create-user'));

// ---------------------------------------------------------------- team info

test('team info: prints both outputs and the developer line; read-only notice; --json', () => {
  const t = deps();
  const calls: string[][] = [];
  assert.equal(withFakeAws([...IDENTITY, FOUND], () => teamInfo({ region: REGION }, t.d), calls), 0);
  const text = t.all();
  assert.match(text, /^Read-only \(team info\)/);
  assert.match(text, new RegExp(`Account: +${ACCOUNT}`));
  assert.match(text, new RegExp(`OtelCollectorUrl: ${COLLECTOR}`));
  assert.match(text, new RegExp(`OtelUserPoolId: +${POOL}`));
  assert.match(text, new RegExp(`  prism-cli enable codeburn --url ${COLLECTOR.replace(/\./g, '\\.')}`));
  assert.ok(calls.every((c) => /^(sts|cloudformation)$/.test(c[0])), `reads only: ${JSON.stringify(calls)}`);

  const j = deps();
  assert.equal(withFakeAws([...IDENTITY, FOUND], () => teamInfo({ region: REGION, json: true }, j.d)), 0);
  assert.deepEqual(JSON.parse(j.out.join('\n')), {
    account: ACCOUNT, region: REGION, stack: 'PrismD1MetricsPipeline', otelCollectorUrl: COLLECTOR, otelUserPoolId: POOL,
    developer_command: `prism-cli enable codeburn --url ${COLLECTOR}`,
  });
  assert.match(j.err.join('\n'), /Read-only/, 'the notice goes to stderr so --json stays parseable');
});

test('team info: no stack and no outputs are clear errors', () => {
  const none = deps();
  assert.equal(withFakeAws([...IDENTITY, NO_STACK], () => teamInfo({ region: REGION }, none.d)), 1);
  assert.match(none.all(), /Error: PrismD1MetricsPipeline is not deployed in account \d{12}, us-west-2\. Deploy it first/);
  const empty = deps();
  assert.equal(withFakeAws([...IDENTITY, stack([])], () => teamInfo({ region: REGION }, empty.d)), 1);
  assert.match(empty.all(), /has no OtelCollectorUrl or OtelUserPoolId output/);
  const denied = deps();
  assert.equal(withFakeAws([...IDENTITY, { match: ['cloudformation'], error: 'AccessDenied' }], () => teamInfo({ region: REGION }, denied.d)), 1);
  assert.match(denied.all(), /access denied .* needs cloudformation:DescribeStacks/);
});

// ---------------------------------------------------------------- team add-developer

test('team add-developer: an invalid email is refused before any AWS call', async () => {
  for (const email of ['', 'dev', 'dev@', '@example.com', 'a b@example.com', 'dev@example.com; rm -rf x', '$(id)@example.com']) {
    const t = deps();
    const calls: string[][] = [];
    assert.equal(await withFakeAws([...IDENTITY, FOUND, CREATED], () => addDeveloper({ email, region: REGION, yes: true }, t.d), calls), 1, email);
    assert.match(t.all(), /is not a valid email address/);
    assert.deepEqual(calls, [], email);
  }
});

test('team add-developer --dry-run shows account, region, pool and email, and creates nothing', async () => {
  const t = deps();
  const calls: string[][] = [];
  assert.equal(await withFakeAws([...IDENTITY, FOUND, CREATED], () => addDeveloper({ email: 'dev@example.com', region: REGION, dryRun: true }, t.d), calls), 0);
  const text = t.all();
  assert.match(text, /^AWS write \(team add-developer\)/);
  assert.match(text, /Needs: cloudformation:DescribeStacks \(unless --user-pool-id\) and cognito-idp:AdminCreateUser/);
  assert.match(text, new RegExp(`Account: +${ACCOUNT}`));
  assert.match(text, /Region: +us-west-2/);
  assert.match(text, new RegExp(`User pool: ${POOL}`));
  assert.match(text, /Username: +dev@example\.com/);
  assert.match(text, /Dry run: nothing was changed\./);
  assert.deepEqual(createCalls(calls), []);
  assert.deepEqual(t.asked, []);
});

test('team add-developer: a declined confirmation creates nothing; no TTY without --yes refuses', async () => {
  const no = deps({ answer: 'n' });
  const calls: string[][] = [];
  assert.equal(await withFakeAws([...IDENTITY, FOUND, CREATED], () => addDeveloper({ email: 'dev@example.com', region: REGION }, no.d), calls), 1);
  assert.match(no.asked[0], /Create this user\? \[y\/N\]/);
  assert.match(no.all(), /Not created\. Nothing was changed\./);
  assert.deepEqual(createCalls(calls), []);
  const tty = deps({ tty: false });
  const c2: string[][] = [];
  assert.equal(await withFakeAws([...IDENTITY, FOUND, CREATED], () => addDeveloper({ email: 'dev@example.com', region: REGION }, tty.d), c2), 1);
  assert.match(tty.all(), /no terminal to confirm\. Re-run with --yes/);
  assert.deepEqual(createCalls(c2), []);
});

test('team add-developer: confirmed, creates the user with the email as username; the password is never printed', async () => {
  const t = deps({ answer: 'y' });
  const calls: string[][] = [];
  assert.equal(await withFakeAws([...IDENTITY, FOUND, CREATED], () => addDeveloper({ email: 'dev@example.com', region: REGION }, t.d), calls), 0);
  const [create] = createCalls(calls);
  assert.ok(create, 'one admin-create-user call');
  const at = (flag: string) => create[create.indexOf(flag) + 1];
  assert.equal(at('--user-pool-id'), POOL);
  assert.equal(at('--username'), 'dev@example.com');
  assert.equal(at('--user-attributes'), 'Name=email,Value=dev@example.com');
  assert.ok(!create.includes('--temporary-password'), 'Cognito generates and emails the password');
  assert.match(t.all(), /✓ Created dev@example\.com in us-west-2_AbC123\. Cognito emailed the invite/);
  assert.ok(!t.all().includes(FAKE_PASSWORD), 'the temporary password is never printed');

  const flag = deps();
  const c2: string[][] = [];
  assert.equal(await withFakeAws([...IDENTITY, CREATED], () => addDeveloper({ email: 'dev@example.com', region: REGION, yes: true, userPoolId: 'us-west-2_Other9' }, flag.d), c2), 0);
  assert.ok(!c2.some((c) => c[0] === 'cloudformation'), '--user-pool-id skips the stack read');
  assert.equal(createCalls(c2)[0][createCalls(c2)[0].indexOf('--user-pool-id') + 1], 'us-west-2_Other9');
  assert.deepEqual(flag.asked, [], '--yes does not ask');
});

test('team add-developer: an existing user is "already exists, nothing changed" with exit 0', async () => {
  const t = deps();
  const exists: AwsStub = { match: ['cognito-idp', 'admin-create-user'], error: 'UsernameExistsException', message: `User account already exists ${FAKE_PASSWORD}` };
  assert.equal(await withFakeAws([...IDENTITY, FOUND, exists], () => addDeveloper({ email: 'dev@example.com', region: REGION, yes: true }, t.d)), 0);
  assert.match(t.all(), /dev@example\.com already exists in us-west-2_AbC123; nothing changed\./);
  assert.ok(!t.all().includes(FAKE_PASSWORD), 'AWS error text is not echoed');
});

test('team add-developer: access denied names the permissions it needs', async () => {
  const t = deps();
  const denied: AwsStub = { match: ['cognito-idp', 'admin-create-user'], error: 'AccessDeniedException' };
  assert.equal(await withFakeAws([...IDENTITY, FOUND, denied], () => addDeveloper({ email: 'dev@example.com', region: REGION, yes: true }, t.d)), 1);
  assert.match(t.all(), /Error: access denied \(AccessDeniedException\)\. team add-developer needs cloudformation:DescribeStacks \(unless --user-pool-id\) and cognito-idp:AdminCreateUser\./);
  const bad = deps();
  assert.equal(await withFakeAws([...IDENTITY], () => addDeveloper({ email: 'dev@example.com', region: REGION, userPoolId: 'not a pool' }, bad.d)), 1);
  assert.match(bad.all(), /is not a Cognito user pool id/);
});
