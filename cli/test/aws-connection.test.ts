/**
 * The shared AWS default resolver: explicit flags > env > repo file > user
 * file > default chain, with the saved region only applying to its own profile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  applyConnection, accountChangeWarning, clearConnectionFile, connectionDefaults, loadConnection,
  readConnectionFile, repoConnectionPath, userConnectionPath, writeConnectionFile, type AwsConnection,
} from '../src/aws/connection.js';
import { credentialSource, resolveRegion, printIdentity, type Ctx } from '../src/security/setup.js';
import { auditDefaults } from '../src/utils/audit-account.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `prism-conn-${p}-`));
const USER: AwsConnection = { profile: 'user-prof', region: 'us-west-2', account: '111111111111', alias: 'sandbox', verifiedAt: '2026-11-07T00:00:00.000Z' };
const REPO: AwsConnection = { profile: 'repo-prof', region: 'eu-west-1', account: '222222222222', alias: null, verifiedAt: '2026-11-07T00:00:00.000Z' };

function gitRepo(): string {
  const d = tmp('repo');
  spawnSync('git', ['init', '-q', d]);
  return d;
}

function setup(opts: { user?: boolean; repo?: boolean } = {}) {
  const home = tmp('home');
  const root = gitRepo();
  if (opts.user) writeConnectionFile(userConnectionPath(home), USER);
  if (opts.repo) writeConnectionFile(repoConnectionPath(root), REPO);
  return { home, root };
}

const noConfig = () => null;
const region = (o: any, env: NodeJS.ProcessEnv = {}, cfg: (p?: string) => string | null = noConfig) => resolveRegion(o, { env, configRegion: cfg });

test('no saved files: nothing changes (default chain, profile config region)', () => {
  const { home, root } = setup();
  const o = applyConnection({}, loadConnection(home, root), {});
  assert.equal(o.profile, undefined);
  assert.equal(o.connection, undefined);
  assert.equal(credentialSource(o, {}), 'the default credential chain (default profile, SSO, or an instance role)');
  assert.deepEqual(region(o, {}, () => 'ap-south-1'), { region: 'ap-south-1', source: 'region configured for the default profile' });
  assert.equal(region(o), null);
});

test('user file is the default when nothing else is set, and is named as the source', () => {
  const { home, root } = setup({ user: true });
  const o = applyConnection({}, loadConnection(home, root), {});
  assert.equal(o.profile, 'user-prof');
  assert.equal(credentialSource(o, {}), 'profile user-prof (aws connect, user)');
  assert.deepEqual(region(o), { region: 'us-west-2', source: 'aws connect, user' });
});

test('repo file wins over the user file', () => {
  const { home, root } = setup({ user: true, repo: true });
  const o = applyConnection({}, loadConnection(home, root), {});
  assert.equal(o.profile, 'repo-prof');
  assert.equal(o.connection?.scope, 'repo');
  assert.equal(credentialSource(o, {}), 'profile repo-prof (aws connect, repo)');
  assert.deepEqual(region(o), { region: 'eu-west-1', source: 'aws connect, repo' });
});

test('env wins over saved files: AWS_PROFILE and env keys keep the saved profile out', () => {
  const { home, root } = setup({ user: true });
  const saved = loadConnection(home, root);
  const byProfile = applyConnection({}, saved, { AWS_PROFILE: 'other' });
  assert.equal(byProfile.profile, undefined);
  assert.equal(byProfile.connection, undefined, 'the saved region belongs to another profile');
  const byKeys = applyConnection({}, saved, { AWS_ACCESS_KEY_ID: 'x' });
  assert.equal(byKeys.profile, undefined);
  assert.equal(byKeys.connection, undefined);
  // AWS_PROFILE naming the saved profile keeps its region.
  const same = applyConnection({}, saved, { AWS_PROFILE: 'user-prof' });
  assert.deepEqual(region(same, { AWS_PROFILE: 'user-prof' }), { region: 'us-west-2', source: 'aws connect, user' });
});

test('env region wins over the saved region; --region wins over env', () => {
  const { home, root } = setup({ user: true });
  const o = applyConnection({}, loadConnection(home, root), {});
  assert.deepEqual(region(o, { AWS_DEFAULT_REGION: 'ca-central-1' }), { region: 'ca-central-1', source: 'AWS_DEFAULT_REGION' });
  assert.deepEqual(region(o, { AWS_REGION: 'us-east-2', AWS_DEFAULT_REGION: 'ca-central-1' }), { region: 'us-east-2', source: 'AWS_REGION' });
  assert.deepEqual(region({ ...o, region: 'sa-east-1' }, { AWS_REGION: 'us-east-2' }), { region: 'sa-east-1', source: '--region' });
});

test('--profile wins; the saved region applies only when it is the saved profile', () => {
  const { home, root } = setup({ user: true });
  const saved = loadConnection(home, root);
  const other = applyConnection({ profile: 'other' }, saved, {});
  assert.equal(other.profile, 'other');
  assert.equal(credentialSource(other, {}), 'profile other (--profile)');
  assert.deepEqual(region(other, {}, (p) => (p === 'other' ? 'us-east-1' : null)), { region: 'us-east-1', source: 'region configured for profile other' });
  const same = applyConnection({ profile: 'user-prof' }, saved, {});
  assert.deepEqual(region(same), { region: 'us-west-2', source: 'aws connect, user' });
});

test('connectionDefaults with an explicit env reads the user file only from env.HOME', () => {
  const { home, root } = setup({ user: true });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    assert.equal(connectionDefaults({}, { HOME: home }).profile, 'user-prof');
    assert.equal(connectionDefaults({}, {}).profile, undefined, 'no HOME in env: no user file');
    assert.equal(connectionDefaults({ path: root }, { HOME: home }).profileSource, 'aws connect, user');
  } finally { process.chdir(cwd); }
});

test('invalid or partial files are ignored, not fatal', () => {
  const { home, root } = setup();
  mkdirSync(join(home, '.prism'), { recursive: true });
  writeFileSync(userConnectionPath(home), '{ not json');
  assert.equal(loadConnection(home, root), null);
  writeFileSync(userConnectionPath(home), JSON.stringify({ profile: 'p', region: 'nowhere', account: '1' }));
  assert.equal(readConnectionFile(userConnectionPath(home)), null);
});

test('files hold no credentials, are owner-only, and clear removes them', () => {
  const { home } = setup({ user: true });
  const p = userConnectionPath(home);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(p, 'utf8'))).sort(), ['account', 'alias', 'profile', 'region', 'verifiedAt']);
  assert.equal(statSync(p).mode & 0o077, 0);
  assert.equal(clearConnectionFile(p), true);
  assert.equal(existsSync(p), false);
  assert.equal(clearConnectionFile(p), false);
});

test('identity header warns when the account changed since aws connect verified it', () => {
  const { home, root } = setup({ user: true });
  const o = applyConnection({}, loadConnection(home, root), {});
  const lines: string[] = [];
  const ctx = { opts: { ...o, region: 'us-west-2', regionSource: 'aws connect, user' }, deps: { log: (l = '') => lines.push(l), env: {} } } as unknown as Ctx;
  printIdentity(ctx, { account: '111111111111', arn: 'arn', alias: null });
  assert.ok(!lines.some((l) => /Warning/.test(l)));
  assert.ok(lines.includes('Credentials: profile user-prof (aws connect, user)'));
  printIdentity(ctx, { account: '999999999999', arn: 'arn', alias: null });
  assert.match(lines.at(-1)!, /verified profile user-prof as account 111111111111.*now resolves to account 999999999999/);
  assert.equal(accountChangeWarning(undefined, '1'), null);
});

test('bedrock-protection: saved connection is the default, with the old us-west-2 fallback kept', () => {
  const { home, root } = setup({ user: true });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const d = auditDefaults({}, 'us-west-2', { HOME: home });
    assert.equal(d.profile, 'user-prof');
    assert.match(d.note!, /profile user-prof \(aws connect, user\), region us-west-2 \(aws connect, user\)/);
    const e = auditDefaults({ region: 'eu-central-1', profile: 'x' }, 'us-west-2', { HOME: tmp('empty') });
    assert.deepEqual([e.profile, e.region, e.note], ['x', 'eu-central-1', null]);
  } finally { process.chdir(cwd); }
});
