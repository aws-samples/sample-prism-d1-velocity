/**
 * `prism-cli aws connect`: save, read, --status, --clear, the account-change
 * warning, and that every AWS call it makes is a read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { awsConnect, accessLevel, principalOf, type ConnectDeps } from '../src/aws/connect.js';
import { readConnectionFile, repoConnectionPath, userConnectionPath, writeConnectionFile } from '../src/aws/connection.js';
import { isWriteCall } from '../src/security/setup.js';
import { run } from '../src/utils/exec.js';
import type { AwsResult } from '../src/utils/aws.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `prism-connect-${p}-`));
const ok = (json: unknown): AwsResult => ({ ok: true, json, errorCode: '', raw: '' });
const err = (code: string): AwsResult => ({ ok: false, json: null, errorCode: code, raw: `An error occurred (${code})` });

type Table = Record<string, AwsResult>;
const ACCOUNT = '123456789012';
const BASE: Table = {
  'sts get-caller-identity': ok({ Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_ReadOnly_abc/dev` }),
  'iam list-account-aliases': ok({ AccountAliases: ['sandbox'] }),
  'organizations describe-organization': err('AccessDeniedException'),
  'iam list-attached-role-policies': ok({ AttachedPolicies: [{ PolicyName: 'ReadOnlyAccess' }] }),
};

function harness(o: { table?: Table; tty?: boolean; answers?: string[]; env?: NodeJS.ProcessEnv; repo?: boolean; profiles?: string[] } = {}) {
  const home = tmp('home');
  const cwd = tmp('cwd');
  if (o.repo) spawnSync('git', ['init', '-q', cwd]);
  const lines: string[] = [];
  const calls: string[][] = [];
  const answers = [...(o.answers ?? [])];
  const table = { ...BASE, ...(o.table ?? {}) };
  const deps: ConnectDeps = {
    aws: (args, profile, region) => {
      calls.push([...args, '--profile', profile, '--region', region]);
      return table[args.slice(0, 2).join(' ')] ?? err('NotStubbed');
    },
    listProfiles: () => o.profiles ?? ['default', 'prism-sa-test'],
    configRegion: (p) => (p === 'prism-sa-test' ? 'us-west-2' : null),
    git: (args) => run('git', args),
    env: o.env ?? {},
    home,
    cwd: () => cwd,
    isTTY: !!o.tty,
    ask: async () => answers.shift() ?? '',
    log: (l = '') => lines.push(l),
    now: () => new Date('2026-11-07T12:00:00.000Z'),
  };
  return { deps, home, cwd, lines, calls, out: () => lines.join('\n') };
}

test('connect: validates, reports, and saves only the profile name, region, account and alias', async () => {
  const h = harness();
  assert.equal(await awsConnect({ profile: 'prism-sa-test', region: 'us-west-2' }, h.deps), 0);
  const out = h.out();
  assert.match(out, /^Read-only \(aws connect\)/);
  assert.match(out, /Account:     123456789012 \(sandbox\)/);
  assert.match(out, /Org management account: unknown \(AccessDeniedException\)/);
  assert.match(out, /Access:      read-only \(attached policies ReadOnlyAccess\)/);
  const saved = JSON.parse(readFileSync(userConnectionPath(h.home), 'utf8'));
  assert.deepEqual(saved, { profile: 'prism-sa-test', region: 'us-west-2', account: ACCOUNT, alias: 'sandbox', verifiedAt: '2026-11-07T12:00:00.000Z' });
  for (const c of h.calls) assert.equal(isWriteCall(c), false, c.join(' '));
});

test('connect: region defaults to the profile\'s configured region when not on a terminal', async () => {
  const h = harness();
  assert.equal(await awsConnect({ profile: 'prism-sa-test' }, h.deps), 0);
  assert.equal(readConnectionFile(userConnectionPath(h.home))?.region, 'us-west-2');
});

test('connect: interactive choice from aws configure list-profiles', async () => {
  const h = harness({ tty: true, answers: ['2', ''] });
  assert.equal(await awsConnect({}, h.deps), 0);
  assert.match(h.out(), /  2\) prism-sa-test/);
  const c = readConnectionFile(userConnectionPath(h.home))!;
  assert.deepEqual([c.profile, c.region], ['prism-sa-test', 'us-west-2']);
});

test('connect: no terminal and no --profile refuses; an unknown profile refuses; nothing saved', async () => {
  const a = harness();
  assert.equal(await awsConnect({}, a.deps), 1);
  assert.match(a.out(), /no --profile given and there is no terminal/);
  const b = harness();
  assert.equal(await awsConnect({ profile: 'nope', region: 'us-west-2' }, b.deps), 1);
  assert.match(b.out(), /profile nope is not configured here/);
  assert.equal(existsSync(userConnectionPath(a.home)) || existsSync(userConnectionPath(b.home)), false);
});

test('connect: a missing profile is named as missing, not as a region or sign-in problem', async () => {
  // No profiles configured at all, no --region: previously "has no configured region".
  const none = harness({ profiles: [] });
  assert.equal(await awsConnect({ profile: 'nosuchprof' }, none.deps), 1);
  assert.match(none.out(), /Error: profile nosuchprof is not configured here \(aws configure list-profiles lists no profiles\)\. Check the name, or create it with aws configure sso --profile nosuchprof/);
  assert.doesNotMatch(none.lines.filter((l) => l.startsWith('Error:')).join('\n'), /region|sso login/);
  assert.equal(none.calls.length, 0);

  // The AWS CLI itself reports the profile missing: no sign-in hint.
  const raw = 'aws: [ERROR]: The config profile (default) could not be found';
  const gone = harness({ table: { 'sts get-caller-identity': { ok: false, json: null, errorCode: '', raw } } });
  assert.equal(await awsConnect({ profile: 'default', region: 'us-west-2' }, gone.deps), 1);
  assert.match(gone.out(), /could not be found\. Check the name, or create it with aws configure sso --profile default.*Nothing was saved/);
  assert.doesNotMatch(gone.out(), /sso login/);
});

test('connect: a profile that does not validate saves nothing', async () => {
  const h = harness({ table: { 'sts get-caller-identity': err('ExpiredToken') } });
  assert.equal(await awsConnect({ profile: 'prism-sa-test', region: 'us-west-2' }, h.deps), 1);
  assert.match(h.out(), /does not validate: ExpiredToken.*Nothing was saved/);
  assert.equal(existsSync(userConnectionPath(h.home)), false);
});

test('connect --repo: writes .prism/aws.local.json and git-ignores it in this clone', async () => {
  const h = harness({ repo: true });
  assert.equal(await awsConnect({ profile: 'prism-sa-test', region: 'us-west-2', repo: true }, h.deps), 0);
  assert.ok(readConnectionFile(repoConnectionPath(h.cwd)));
  assert.equal(existsSync(userConnectionPath(h.home)), false);
  assert.equal(run('git', ['-C', h.cwd, 'check-ignore', '-q', '.prism/aws.local.json']).ok, true);
  assert.match(readFileSync(join(h.cwd, '.git', 'info', 'exclude'), 'utf8'), /# prism-cli aws connect/);
  const outside = harness();
  assert.equal(await awsConnect({ profile: 'prism-sa-test', region: 'us-west-2', repo: true }, outside.deps), 1);
});

test('connect: warns when the same profile now resolves to a different account', async () => {
  const h = harness();
  writeConnectionFile(userConnectionPath(h.home), { profile: 'prism-sa-test', region: 'us-west-2', account: '210987654321', alias: null, verifiedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(await awsConnect({ profile: 'prism-sa-test', region: 'us-west-2' }, h.deps), 0);
  assert.match(h.out(), /was saved as account 210987654321; it now resolves to account 123456789012/);
});

test('--status: nothing saved', async () => {
  const h = harness();
  assert.equal(await awsConnect({ status: true }, h.deps), 0);
  assert.match(h.out(), /No saved connection/);
  assert.equal(h.calls.length, 0);
});

test('--status: shows files and source, validates, and warns on an account change', async () => {
  const h = harness({ repo: true });
  writeConnectionFile(userConnectionPath(h.home), { profile: 'prism-sa-test', region: 'us-west-2', account: ACCOUNT, alias: 'sandbox', verifiedAt: 'v' });
  assert.equal(await awsConnect({ status: true }, h.deps), 0);
  assert.match(h.out(), /In use: profile prism-sa-test, region us-west-2 \(aws connect, user/);
  assert.match(h.out(), /Validation: ok/);
  assert.match(h.out(), /repo: .*aws\.local\.json \(not set\)/);

  const moved = harness({ table: { 'sts get-caller-identity': ok({ Account: '999999999999', Arn: 'a' }) } });
  writeConnectionFile(userConnectionPath(moved.home), { profile: 'prism-sa-test', region: 'us-west-2', account: ACCOUNT, alias: null, verifiedAt: 'v' });
  assert.equal(await awsConnect({ status: true }, moved.deps), 1);
  assert.match(moved.out(), /verified profile prism-sa-test as account 123456789012.*now resolves to account 999999999999/);

  const env = harness({ env: { AWS_PROFILE: 'other' } });
  writeConnectionFile(userConnectionPath(env.home), { profile: 'prism-sa-test', region: 'us-west-2', account: ACCOUNT, alias: null, verifiedAt: 'v' });
  await awsConnect({ status: true }, env.deps);
  assert.match(env.out(), /Not in use for credentials: AWS_PROFILE is set/);
});

test('--clear removes the user file (or the repo file with --repo), and touches nothing in AWS', async () => {
  const h = harness({ repo: true });
  writeConnectionFile(userConnectionPath(h.home), { profile: 'p', region: 'us-west-2', account: ACCOUNT, alias: null, verifiedAt: 'v' });
  writeConnectionFile(repoConnectionPath(h.cwd), { profile: 'p', region: 'us-west-2', account: ACCOUNT, alias: null, verifiedAt: 'v' });
  assert.equal(await awsConnect({ clear: true, repo: true }, h.deps), 0);
  assert.equal(existsSync(repoConnectionPath(h.cwd)), false);
  assert.equal(existsSync(userConnectionPath(h.home)), true);
  assert.equal(await awsConnect({ clear: true }, h.deps), 0);
  assert.equal(existsSync(userConnectionPath(h.home)), false);
  assert.equal(await awsConnect({ clear: true }, h.deps), 0);
  assert.match(h.out(), /Nothing to clear/);
  assert.equal(h.calls.length, 0);
});

test('organizations: management, member and not-in-an-org', async () => {
  const cases: [AwsResult, RegExp][] = [
    [ok({ Organization: { Id: 'o-abc', MasterAccountId: ACCOUNT } }), /yes, the management account of o-abc/],
    [ok({ Organization: { Id: 'o-abc', MasterAccountId: '000000000000' } }), /no, a member account of o-abc/],
    [err('AWSOrganizationsNotInUseException'), /no, not in an organization/],
  ];
  for (const [r, re] of cases) {
    const h = harness({ table: { 'organizations describe-organization': r } });
    await awsConnect({ profile: 'prism-sa-test', region: 'us-west-2' }, h.deps);
    assert.match(h.out(), re);
  }
});

test('access level: policies when readable, else the name, else unknown', () => {
  const d = (t: Table) => harness({ table: t }).deps;
  const arn = (role: string) => `arn:aws:sts::${ACCOUNT}:assumed-role/${role}/s`;
  assert.deepEqual(accessLevel(d({ 'iam list-attached-role-policies': ok({ AttachedPolicies: [{ PolicyName: 'AdministratorAccess' }] }) }), 'p', 'r', arn('Dev')), { level: 'admin', basis: 'attached policy AdministratorAccess' });
  assert.equal(accessLevel(d({ 'iam list-attached-role-policies': err('AccessDenied') }), 'p', 'r', arn('AWSReservedSSO_AdministratorAccess_x')).level, 'admin');
  assert.equal(accessLevel(d({ 'iam list-attached-role-policies': err('AccessDenied') }), 'p', 'r', arn('ReadOnlyRole')).level, 'read-only');
  assert.deepEqual(accessLevel(d({ 'iam list-attached-role-policies': err('AccessDenied') }), 'p', 'r', arn('Dev')), { level: 'unknown', basis: 'policies not readable (AccessDenied)' });
  assert.equal(accessLevel(d({ 'iam list-attached-role-policies': ok({ AttachedPolicies: [{ PolicyName: 'TeamPolicy' }] }) }), 'p', 'r', arn('Dev')).level, 'unknown');
  assert.equal(accessLevel(d({}), 'p', 'r', `arn:aws:iam::${ACCOUNT}:root`).level, 'admin');
  assert.deepEqual(principalOf(`arn:aws:iam::${ACCOUNT}:user/team/alice`), { kind: 'user', name: 'alice' });
});

test('aws connect is registered as `prism-cli aws connect` with its flags', async () => {
  const mod = await import('../src/commands/aws/connect.js');
  const flags = mod.default.options.map((o: { flags: string }) => o.flags.split(' ')[0]);
  assert.deepEqual(flags, ['--profile', '--region', '--repo', '--status', '--clear']);
});
