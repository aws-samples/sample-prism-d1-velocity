/**
 * Tests for the Security Agent page's setup gate (security-gate.ts) and the
 * code review start guards (security-runs.ts startGuard): every gate state,
 * AWS_PROFILE against a saved aws connect (prism-cli's own order), an unknown
 * profile, the account check with either, the lookup failure classes, and the
 * server-side write check. No AWS: every call is a fake.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConnectionFile } from '../src/aws/connection.js';
import { resolveAwsIdentity } from '../src/dashboard/aws-identity.js';
import { computeGate, gatePrecedence, gateUsing, LOOKUP_GRANTS, type GateInput } from '../src/dashboard/security-gate.js';
import { gateIn, LookupCache, lookupSpaces, writeGateIn, type AwsCall, type Lookup } from '../src/dashboard/security-agent.js';
import { startGuard } from '../src/dashboard/security-runs.js';
import { makeResult, type ResultEntry } from '../src/codewatch/results.js';
import type { ResolvedSetup } from '../src/security/config.js';
import type { AwsResult } from '../src/utils/aws.js';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `prism-gate-${p}-`)));
const ok = (json: unknown): AwsResult => ({ ok: true, json, errorCode: '', raw: JSON.stringify(json) });
const err = (raw: string): AwsResult => ({ ok: false, json: null, errorCode: (/\(([A-Za-z]+)\)/.exec(raw) || [])[1] || '', raw });

const ACCOUNT = '111122223333', OTHER = '444455556666';
const CONFIG = '[default]\nregion = us-east-1\n[profile prism-demo]\nsso_session = corp\nsso_account_id = 1\nregion = us-west-2\n[profile prism-env]\ncredential_process = /bin/true\nregion = eu-west-1\n';

/** A HOME with ~/.aws/config, and optionally a saved aws connect for prism-demo. */
function home(o: { saved?: string | null } = {}): string {
  const h = tmp('home');
  mkdirSync(join(h, '.aws'), { recursive: true });
  writeFileSync(join(h, '.aws', 'config'), CONFIG);
  if (o.saved !== null) writeConnectionFile(join(h, '.prism', 'aws.json'), { profile: o.saved ?? 'prism-demo', region: 'us-west-2', account: ACCOUNT, alias: null, verifiedAt: '2026-11-15T00:00:00Z' });
  return h;
}
const SETUP: ResolvedSetup = { agentSpaceId: 'as-1', applicationId: 'app-1', region: 'us-west-2', account: ACCOUNT, setupAt: '', source: 'machine', file: '~/.prism/security.json', codeReviewId: null };
const GOOD: Lookup = { ok: true, at: '2026-11-15T12:00:00Z', profile: 'prism-demo', region: 'us-west-2', account4: '••••3333', spaces: [], inUse: 'as-1', scanBucket: 'prism-scan-demo', consoleUrl: '' };
const failed = (kind: 'credentials' | 'denied' | 'other', action: string | null = null): Lookup =>
  ({ ok: false, at: '', profile: 'prism-demo', region: 'us-west-2', error: 'the credentials did not work: Token has expired', credentials: kind === 'credentials', kind, action });
const COMMANDS = { setup: 'prism-cli enable security --profile prism-demo --region us-west-2', repo: 'cd ~/src/demo && prism-cli enable security --repo --profile prism-demo --region us-west-2', replace: 'prism-cli enable security --replace --profile prism-demo --region us-west-2', repoSetup: 'cd ~/src/demo && prism-cli enable security --repo --region us-west-2' };

function input(h: string, env: NodeJS.ProcessEnv, over: Partial<GateInput> = {}): GateInput {
  const identity = resolveAwsIdentity({ env, home: h, repoRoot: null });
  return { identity, savedAccount: identity.saved?.inUse ? ACCOUNT : null, setup: SETUP, lookup: null, lookupAccount: null, repoName: 'demo', region: 'us-west-2', commands: COMMANDS, ...over };
}

// ---------------------------------------------------------------- step 1: the profile, in prism-cli's order

test('step 1: aws connect or AWS_PROFILE passes and is named; nothing connected, or env keys, stops at step 1', () => {
  const c = computeGate(input(home(), {}));
  assert.deepEqual(c.using, { via: 'aws connect', profile: 'prism-demo', label: 'aws connect: prism-demo' });
  assert.equal(c.state, 'checking');
  const e = computeGate(input(home({ saved: null }), { AWS_PROFILE: 'prism-env' }));
  assert.deepEqual(e.using, { via: 'AWS_PROFILE', profile: 'prism-env', label: 'AWS_PROFILE: prism-env' });
  assert.equal(e.state, 'checking');
  assert.equal(e.account4, null, 'AWS_PROFILE: the account is known only after the sts call');

  const none = computeGate(input(home({ saved: null }), {}));
  assert.equal(none.state, 'connect');
  assert.equal(none.step, 1);
  assert.match(none.detail.join(' '), /no saved aws connect and no AWS_PROFILE/);
  const keys = computeGate(input(home(), { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_PROFILE: 'prism-env' }));
  assert.equal(keys.state, 'connect', 'env keys win over both: no named profile');
  assert.match(keys.detail.join(' '), /AWS_ACCESS_KEY_ID is set in the dashboard's environment\. prism-cli uses it before AWS_PROFILE and aws connect/);
  assert.ok(!JSON.stringify(keys).includes('AKIAEXAMPLE'), 'the key value never leaves');
});

test('step 1: AWS_PROFILE wins over a different saved aws connect profile, and the gate says so and why', () => {
  const g = computeGate(input(home(), { AWS_PROFILE: 'prism-env' }));
  assert.equal(g.using?.label, 'AWS_PROFILE: prism-env');
  assert.equal(g.precedence, 'AWS_PROFILE (prism-env) wins over the saved aws connect profile prism-demo: prism-cli reads the environment before ~/.prism/aws.json, as every prism-cli AWS command does. Unset AWS_PROFILE and restart the dashboard to use prism-demo.');
  assert.equal(computeGate(input(home(), { AWS_PROFILE: 'prism-demo' })).precedence, null, 'the same profile: nothing to explain');
  assert.equal(computeGate(input(home(), {})).precedence, null);
  // With AWS_PROFILE in use, the saved connection's verified account is not the account in use.
  assert.equal(computeGate(input(home(), { AWS_PROFILE: 'prism-env' }, { setup: { ...SETUP, account: OTHER } })).state, 'checking', 'not a mismatch before the sts call');
});

test('step 1: a profile that is in neither AWS file is named, for AWS_PROFILE and for aws connect', () => {
  const env = computeGate(input(home({ saved: null }), { AWS_PROFILE: 'typo-profile' }));
  assert.equal(env.state, 'profile');
  assert.equal(env.step, 1);
  assert.match(env.detail[0], /^AWS_PROFILE: typo-profile names a profile that is not in ~\/\.aws\/config or ~\/\.aws\/credentials\.$/);
  assert.match(env.detail[1], /Fix AWS_PROFILE and restart the dashboard/);
  const saved = computeGate(input(home({ saved: 'gone' }), {}));
  assert.equal(saved.state, 'profile');
  assert.match(saved.detail[1], /aws configure sso --profile gone/);
});

test('gateUsing and gatePrecedence follow aws-identity (applyConnection): env first, then the repo file, then the user file', () => {
  const h = home();
  const repo = tmp('repo');
  writeConnectionFile(join(repo, '.prism', 'aws.local.json'), { profile: 'prism-env', region: 'eu-west-1', account: ACCOUNT, alias: null, verifiedAt: '' });
  const inRepo = resolveAwsIdentity({ env: {}, home: h, repoRoot: repo });
  assert.deepEqual(gateUsing(inRepo), { via: 'aws connect', profile: 'prism-env', label: 'aws connect: prism-env' }, 'the repo file wins over ~/.prism/aws.json');
  const envWins = resolveAwsIdentity({ env: { AWS_PROFILE: 'prism-demo' }, home: h, repoRoot: repo });
  assert.match(gatePrecedence(envWins)!, /AWS_PROFILE \(prism-demo\) wins over the saved aws connect profile prism-env: prism-cli reads the environment before \.prism\/aws\.local\.json/);
  assert.equal(gateUsing(resolveAwsIdentity({ env: { AWS_WEB_IDENTITY_TOKEN_FILE: '/t' }, home: h, repoRoot: null })), null);
});

// ---------------------------------------------------------------- step 2: setup and account

test('step 2: no setup record shows enable security with no cd; a setup for another account shows --repo and --replace', () => {
  const s = computeGate(input(home(), {}, { setup: null }));
  assert.equal(s.state, 'setup');
  assert.equal(s.step, 2);
  assert.equal(s.copy.setup, COMMANDS.setup);
  assert.doesNotMatch(s.copy.setup!, /^cd /);
  const m = computeGate(input(home(), {}, { setup: { ...SETUP, account: OTHER, region: 'eu-west-1' } }));
  assert.equal(m.state, 'mismatch', 'aws connect: its verified account is known before any AWS call');
  assert.deepEqual(m.copy, { repo: COMMANDS.repo, replace: COMMANDS.replace });
  assert.match(m.detail[0], /machine setup ~\/\.prism\/security\.json is for account ••••6666, region eu-west-1\. aws connect: prism-demo resolves to account ••••3333\./);
  assert.ok(!JSON.stringify(m).includes(OTHER) && !JSON.stringify(m).includes(ACCOUNT), 'masked');
  // AWS_PROFILE: the lookup's sts call names the account; a different one is a mismatch, before step 3's result.
  const e = computeGate(input(home({ saved: null }), { AWS_PROFILE: 'prism-env' }, { setup: { ...SETUP, account: OTHER }, lookup: GOOD, lookupAccount: ACCOUNT }));
  assert.equal(e.state, 'mismatch');
  assert.match(e.detail[0], /AWS_PROFILE: prism-env resolves to account ••••3333/);
});

test('a repo override is information, not a step', () => {
  const g = computeGate(input(home(), {}, { setup: { ...SETUP, source: 'repo', file: '.prism/security.local.json', codeReviewId: 'cr-1' }, lookup: GOOD, lookupAccount: ACCOUNT }));
  assert.equal(g.state, 'ready');
  assert.equal(g.step, null);
  assert.match(g.info[0], /^demo has its own setup: the repo override \.prism\/security\.local\.json \(account ••••3333, us-west-2\)\. It takes precedence over the machine setup/);
  assert.deepEqual(computeGate(input(home(), {}, { lookup: GOOD, lookupAccount: ACCOUNT })).info, []);
});

// ---------------------------------------------------------------- step 3: the lookup

test('step 3: checking, expired SSO (the exact login command), access denied (the action), another failure, no space, ready', () => {
  const h = home();
  assert.equal(computeGate(input(h, {})).state, 'checking');
  const sso = computeGate(input(h, {}, { lookup: failed('credentials') }));
  assert.equal(sso.state, 'sso');
  assert.equal(sso.copy.login, 'aws sso login --profile prism-demo');
  const cp = computeGate(input(home({ saved: null }), { AWS_PROFILE: 'prism-env' }, { lookup: failed('credentials') }));
  assert.equal(cp.copy.login, undefined, 'not an SSO profile: no aws sso login line');
  assert.match(cp.detail[1], /Refresh the credentials for profile prism-env \(credential_process\)/);
  const denied = computeGate(input(h, {}, { lookup: failed('denied', 'securityagent:ListAgentSpaces') }));
  assert.equal(denied.state, 'denied');
  assert.equal(denied.action, 'securityagent:ListAgentSpaces');
  assert.match(denied.detail.join(' '), new RegExp('Access denied for securityagent:ListAgentSpaces.*' + LOOKUP_GRANTS.join(', ').replace(/[.*/]/g, '\\$&')));
  assert.equal(computeGate(input(h, {}, { lookup: failed('other') })).state, 'error');
  const none = computeGate(input(h, {}, { lookup: { ...GOOD, inUse: null }, lookupAccount: ACCOUNT }));
  assert.equal(none.state, 'nospace');
  assert.equal(none.copy.setup, COMMANDS.setup);
  const noBucket = computeGate(input(h, {}, { lookup: { ...GOOD, scanBucket: null }, lookupAccount: ACCOUNT }));
  assert.equal(noBucket.state, 'nospace');
  const overrideNone = computeGate(input(h, {}, { setup: { ...SETUP, source: 'repo', file: '.prism/security.local.json' }, lookup: { ...GOOD, inUse: null }, lookupAccount: ACCOUNT }));
  assert.equal(overrideNone.copy.repo, COMMANDS.repoSetup, 'a repo override is re-run with --repo, in the repo');
  const ready = computeGate(input(h, {}, { lookup: GOOD, lookupAccount: ACCOUNT }));
  assert.equal(ready.state, 'ready');
  assert.equal(ready.account4, '••••3333');
});

test('lookup failures carry their class: sign-in, access denied with the IAM action, other', async () => {
  const T = { profile: 'demo', region: 'us-west-2' };
  const answers = (over: Record<string, AwsResult>): AwsCall => async (args) => over[`${args[0]} ${args[1]}`] ?? (args[0] === 'sts' ? ok({ Account: ACCOUNT }) : ok({}));
  const sso = (await lookupSpaces(answers({ 'sts get-caller-identity': err('Error when retrieving token from sso: Token has expired and refresh failed') }), T, new Date())).lookup;
  assert.ok(!sso.ok && sso.kind === 'credentials' && sso.credentials && sso.action === null);
  const denied = (await lookupSpaces(answers({ 'securityagent list-agent-spaces': err('An error occurred (AccessDeniedException) when calling the ListAgentSpaces operation: User: arn:aws:sts::111122223333:assumed-role/Dev/me is not authorized to perform: securityagent:ListAgentSpaces') }), T, new Date())).lookup;
  assert.ok(!denied.ok && denied.kind === 'denied' && !denied.credentials);
  assert.equal(denied.ok ? '' : denied.action, 'securityagent:ListAgentSpaces');
  assert.ok(!JSON.stringify(denied).includes(ACCOUNT), 'the account in the ARN is masked');
  const ssm = (await lookupSpaces(answers({ 'ssm get-parameter': err('An error occurred (AccessDeniedException) when calling the GetParameter operation: not authorized to perform: ssm:GetParameter') }), T, new Date())).lookup;
  assert.equal(ssm.ok ? '' : ssm.action, 'ssm:GetParameter');
  const slow = (await lookupSpaces(answers({ 'securityagent list-agent-spaces': err('timed out after 20 s') }), T, new Date())).lookup;
  assert.ok(!slow.ok && slow.kind === 'other');
});

// ---------------------------------------------------------------- the server: gate in a repo, write check

test('gateIn: no AWS call; the lookup kept for the session moves step 3 to ready; writeGateIn refuses until then', async () => {
  const h = home(), repo = tmp('repo');
  writeFileSync(join(h, '.prism', 'security.json'), JSON.stringify({ agentSpaceId: 'as-1', applicationId: 'app-1', region: 'us-west-2', account: ACCOUNT, setupAt: '2026-11-01T00:00:00Z' }));
  const calls: string[][] = [];
  const call: AwsCall = async (args) => {
    calls.push(args);
    if (args[1] === 'get-caller-identity') return ok({ Account: ACCOUNT });
    if (args[1] === 'list-agent-spaces') return ok({ agentSpaceSummaries: [{ agentSpaceId: 'as-1', name: 'prism-d1-security' }] });
    if (args[0] === 'ssm') return ok({ Parameter: { Value: args[3].endsWith('agent-space-id') ? 'as-1' : 'prism-scan-demo' } });
    return ok({});
  };
  const d = { identity: { env: {}, home: h }, cache: new LookupCache(call) };
  const g = gateIn(d, repo, 'demo');
  assert.equal(g.state, 'checking');
  assert.equal(calls.length, 0, 'no AWS call');
  assert.equal(g.region, 'us-west-2');
  const R = { id: '0123456789abcdef', name: 'demo', path: repo };
  assert.match((await writeGateIn(d, 'security-code-review', R))!, /^Security Agent is not ready in demo \(step 3 of 3: Checking the agent space…\)/);
  assert.equal(calls.length, 0, 'refused before any call');
  await d.cache.get({ profile: 'prism-demo', region: 'us-west-2' });
  assert.equal(gateIn(d, repo, 'demo').state, 'ready');
  const n = calls.length;
  assert.equal(await writeGateIn(d, 'security-code-review-force', R), null, 'ready: one sts re-check, then allowed');
  assert.deepEqual(calls.slice(n).map((c) => c.slice(0, 2).join(' ')), ['sts get-caller-identity']);
  assert.equal(await writeGateIn(d, 'security-findings', R), 'not an AWS-writing action');
  // No 5-minute expiry: the answer stays until a refresh.
  assert.ok(d.cache.fresh({ profile: 'prism-demo', region: 'us-west-2' }));
});

// ---------------------------------------------------------------- start guards

const entry = (id: string, o: Record<string, unknown>): ResultEntry => ({
  id, result: makeResult({ kind: 'security-review', hook: 'manual', tool: 'security-agent', status: 'findings', commit: 'a'.repeat(40), branch: 'main', started_at: '2026-11-15T10:00:00Z', finished_at: '2026-11-15T10:20:00Z',
    findings: [], security: { job_id: 'job-' + id, code_review_id: 'cr-1', agent_space_id: 'as-1', region: 'us-west-2', account: ACCOUNT, scope: 'full', job_status: 'COMPLETED', counts: { HIGH: 1 } }, ...o } as never),
});

test('start guard: a running review of the repo, and a finished review of HEAD; stale and other commits do not count', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const HEAD = 'a'.repeat(40);
  const running = entry('r1', { status: 'pending', started_at: '2026-11-15T11:40:00Z', finished_at: '2026-11-15T11:40:00Z' });
  const done = entry('d1', {});
  const g = startGuard([done, running], HEAD, now);
  assert.deepEqual(g.running, { run_id: 'r1', job_id: 'job-r1', started_at: '2026-11-15T11:40:00Z', commit: 'aaaaaaaaaaaa', branch: 'main' });
  assert.deepEqual(g.reviewed, { run_id: 'd1', finished_at: '2026-11-15T10:20:00Z', commit: 'aaaaaaaaaaaa', counts: { critical: 0, high: 1, medium: 0, low: 0 }, total: 0 });
  const stale = entry('s1', { status: 'pending', started_at: '2026-11-15T09:00:00Z' });
  assert.equal(startGuard([stale], HEAD, now).running, null, 'past the stale window');
  assert.equal(startGuard([done], 'b'.repeat(40), now).reviewed, null, 'another commit');
  assert.equal(startGuard([done], null, now).reviewed, null, 'no HEAD');
  assert.deepEqual(startGuard([], HEAD, now), { running: null, reviewed: null });
});

test('tildeHome: a repo path under either spelling of a symlinked home leaves as ~', async () => {
  const { symlinkSync } = await import('node:fs');
  const { tildeHome } = await import('../src/dashboard/payload.js');
  const real = tmp('real'), link = join(tmp('links'), 'home');
  symlinkSync(real, link);
  assert.equal(tildeHome(join(real, 'src', 'demo'), link), '~/src/demo', 'the resolved repo path, the symlinked HOME');
  assert.equal(tildeHome(join(link, 'src', 'demo'), link), '~/src/demo');
  assert.equal(tildeHome(real, link), '~');
  assert.equal(tildeHome('/elsewhere/demo', link), '/elsewhere/demo');
});
