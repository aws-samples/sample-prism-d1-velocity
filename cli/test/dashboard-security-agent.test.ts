/**
 * Tests for the Security Agent page (#security, #security/<repo-id>): the
 * action ids and their argv in the picked repo, repo-id validation, the
 * AWS-writing actions' gate and confirm text, the nav badge rules, the
 * agent-space lookup (timeouts, cache, failures, the shared lock), no AWS call
 * on page load, the routes, the Settings > AWS pointer and the Dashboard links.
 * No AWS, npm or network: every AWS call is a fake.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPayload, type DashboardPayload } from '../src/dashboard/payload.js';
import { ACTIONS, ActionRunner, repoId, type ActionId, type ScanRepo } from '../src/dashboard/actions.js';
import {
  awsTargetFor, commandLine, execAwsCall, identityIn, LOOKUP_TIMEOUT_MS, LookupCache, lookupSpaces, SECURITY_ACTIONS,
  securityAgentGate, securityAgentLookup, securityAgentView, targetArgs, WRITE_KIND, writeNotice, type AwsCall, type Lookup, type SecurityAgentDeps,
} from '../src/dashboard/security-agent.js';
import { setupApi } from '../src/dashboard/setup-api.js';
import type { Gate, GateState } from '../src/dashboard/security-gate.js';
import type { AwsResult } from '../src/utils/aws.js';
import { FakeElement, runPage, SETUP_STUB } from './page-dom.js';

process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'prism-sa-gcfg-')), 'gitconfig');
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `prism-sa-${p}-`)));
const ok = (json: unknown): AwsResult => ({ ok: true, json, errorCode: '', raw: JSON.stringify(json) });
const err = (raw: string): AwsResult => ({ ok: false, json: null, errorCode: (/\(([A-Za-z]+)\)/.exec(raw) || [])[1] || '', raw });

/** A fake AWS: answers by `service verb`, records every call with its target. */
function fakeAws(over: Record<string, AwsResult> = {}) {
  const calls: { args: string[]; profile: string | null; region: string | null; timeoutMs: number }[] = [];
  const answers: Record<string, AwsResult> = {
    'sts get-caller-identity': ok({ Account: '111122223333', Arn: 'arn:aws:sts::111122223333:assumed-role/Dev/demo' }),
    'securityagent list-agent-spaces': ok({ agentSpaceSummaries: [
      { agentSpaceId: 'as-1', name: 'prism-d1-security' }, { agentSpaceId: 'as-2', name: 'pentest-github.com-demo-shop' }, { agentSpaceId: 'as-3', name: 'console-trial' }] }),
    'securityagent batch-get-agent-spaces': ok({ agentSpaces: [
      { agentSpaceId: 'as-1', createdAt: '2026-11-02T00:00:00Z', awsResources: { s3Buckets: ['arn:aws:s3:::prism-scan-demo'] } },
      { agentSpaceId: 'as-3', createdAt: '2026-09-18T00:00:00Z', awsResources: { s3Buckets: [] } }] }),
    'ssm get-parameter /prism/continuum/agent-space-id': ok({ Parameter: { Value: 'as-1' } }),
    'ssm get-parameter /prism/continuum/scan-bucket': ok({ Parameter: { Value: 'prism-scan-demo' } }),
    ...over,
  };
  const call: AwsCall = async (args, t) => {
    calls.push({ args, profile: t.profile, region: t.region, timeoutMs: t.timeoutMs });
    const key = args[0] === 'ssm' ? `ssm get-parameter ${args[3]}` : `${args[0]} ${args[1]}`;
    return answers[key] ?? err('An error occurred (ParameterNotFound)');
  };
  return { call, calls };
}

const T = { profile: 'demo', region: 'us-west-2' };

// ---------------------------------------------------------------- the lookup

test('lookup: the read-only calls, each with a 20 s timeout and the repo\'s profile and region; spaces marked', async () => {
  const { call, calls } = fakeAws();
  const l = (await lookupSpaces(call, T, new Date("2026-11-14T12:00:00Z"))).lookup;
  assert.ok(l.ok);
  assert.deepEqual(calls.map((c) => c.args.slice(0, 2).join(' ')), ['sts get-caller-identity', 'securityagent list-agent-spaces', 'ssm get-parameter', 'ssm get-parameter', 'securityagent batch-get-agent-spaces']);
  for (const c of calls) { assert.equal(c.timeoutMs, LOOKUP_TIMEOUT_MS); assert.equal(c.profile, 'demo'); assert.equal(c.region, 'us-west-2'); }
  assert.ok(calls.every((c) => /^(get|list|batch-get)-/.test(c.args[1])), 'reads only');
  assert.equal(l.account4, '••••3333', 'the account id leaves as its last 4 digits');
  assert.equal(l.inUse, 'as-1');
  assert.equal(l.scanBucket, 'prism-scan-demo');
  assert.deepEqual(l.spaces.map((s) => [s.name, s.inUse, s.pentest, s.bucketListed]),
    [['prism-d1-security', true, false, true], ['console-trial', false, false, false], ['pentest-github.com-demo-shop', false, true, null]]);
  assert.equal(l.consoleUrl, 'https://us-west-2.console.aws.amazon.com/securityagent/home?region=us-west-2');
  assert.ok(!JSON.stringify(l).includes('111122223333'));
});

test('lookup: failed credentials, a refused list, no region, and no space for prism-cli', async () => {
  const expired = (await lookupSpaces(fakeAws({ 'sts get-caller-identity': err('An error occurred (ExpiredToken) when calling GetCallerIdentity: The security token included in the request is expired') }).call, T, new Date())).lookup;
  assert.ok(!expired.ok && expired.credentials, 'credentials');
  assert.match(expired.ok ? '' : expired.error, /ExpiredToken|expired/);
  const denied = (await lookupSpaces(fakeAws({ 'securityagent list-agent-spaces': err('An error occurred (AccessDeniedException): not authorized to perform securityagent:ListAgentSpaces') }).call, T, new Date())).lookup;
  assert.ok(!denied.ok && !denied.credentials);
  const noRegion = fakeAws();
  const nr = (await lookupSpaces(noRegion.call, { profile: null, region: null }, new Date())).lookup;
  assert.ok(!nr.ok && /No AWS region/.test(nr.error));
  assert.equal(noRegion.calls.length, 0, 'no call without a region');
  const none = (await lookupSpaces(fakeAws({ 'ssm get-parameter /prism/continuum/agent-space-id': err('An error occurred (ParameterNotFound)') }).call, T, new Date())).lookup;
  assert.ok(none.ok && none.inUse === null && none.spaces.every((s) => !s.inUse));
  // A refused SSM read is not "not set up": it fails the lookup with its reason.
  const ssmDenied = (await lookupSpaces(fakeAws({ 'ssm get-parameter /prism/continuum/agent-space-id': err('An error occurred (AccessDeniedException) when calling the GetParameter operation: not authorized to perform: ssm:GetParameter') }).call, T, new Date())).lookup;
  assert.ok(!ssmDenied.ok && !ssmDenied.credentials);
  assert.match(ssmDenied.ok ? '' : ssmDenied.error, /reading SSM \/prism\/continuum\/agent-space-id failed \(ssm:GetParameter\).*AccessDenied/);
});

test('lookup cache: verify() re-checks the account right before a write; another account drops the lookup', async () => {
  let account = '111122223333';
  const aws = fakeAws();
  const call: AwsCall = async (args, t) => (args[1] === 'get-caller-identity' ? ok({ Account: account }) : aws.call(args, t));
  const cache = new LookupCache(call);
  assert.match((await cache.verify(T))!, /The agent space has not been checked yet/);
  await cache.get(T);
  assert.equal(await cache.verify(T), null, 'same account');
  account = '444455556666';
  assert.match((await cache.verify(T))!, /now point to account ••••6666, not ••••3333/);
  assert.equal(cache.fresh(T), null, 'the stale lookup is dropped');
});

test('lookup cache: kept for the session per profile and region (no expiry); refresh forces; a failure is shown but never reused', async () => {
  const { call, calls } = fakeAws();
  let now = new Date('2026-11-14T12:00:00Z');
  const cache = new LookupCache(call, () => now);
  assert.equal(cache.peek(T), null);
  const a = await cache.get(T);
  assert.equal(a.cached, false);
  const n = calls.length;
  assert.equal((await cache.get(T)).cached, true);
  assert.equal(calls.length, n, 'no call within the TTL');
  assert.equal((await cache.get({ ...T, region: 'eu-west-1' })).cached, false, 'keyed by region');
  const m = calls.length;
  await cache.get(T, true);
  assert.ok(calls.length > m, 'refresh calls again');
  now = new Date(now.getTime() + 24 * 3600_000);
  assert.ok(cache.fresh(T), 'a day later: still kept (the dashboard session)');
  assert.equal((await cache.get(T)).cached, true);
  assert.equal(cache.account(T), '111122223333', 'the full account stays on the server');

  const bad = fakeAws({ 'sts get-caller-identity': err('Unable to locate credentials') });
  const c2 = new LookupCache(bad.call, () => now);
  assert.equal((await c2.get(T)).lookup.ok, false);
  assert.equal(c2.peek(T)?.ok, false, 'the failure is shown');
  assert.equal(c2.fresh(T), null);
  const k = bad.calls.length;
  await c2.get(T);
  assert.ok(bad.calls.length > k, 'a failure is never served from the cache');
});

test('execAwsCall refuses anything but a get/list/describe call, before spawning', async () => {
  const r = await execAwsCall(['securityagent', 'create-agent-space', '--name', 'x'], { ...T, timeoutMs: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'NotReadOnly');
});

// ---------------------------------------------------------------- profile, region and command lines

test('the repo\'s own resolution picks --profile and --region; env keys and the default chain pass no --profile', () => {
  const home = tmp('home'), repo = tmp('repo');
  mkdirSync(join(repo, '.prism'), { recursive: true });
  writeFileSync(join(repo, '.prism', 'aws.local.json'), JSON.stringify({ profile: 'repo-demo', region: 'eu-west-1', account: '111122223333', alias: null, verifiedAt: '' }));
  const inRepo = awsTargetFor(identityIn({ identity: { env: {}, home } }, repo));
  assert.deepEqual(inRepo, { profile: 'repo-demo', region: 'eu-west-1' }, 'the repo file counts, as it does for the CLI there');
  assert.deepEqual(awsTargetFor(identityIn({ identity: { env: { AWS_PROFILE: 'dev', AWS_REGION: 'us-east-2' }, home } }, tmp('r2'))), { profile: 'dev', region: 'us-east-2' });
  assert.deepEqual(awsTargetFor(identityIn({ identity: { env: { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_REGION: 'us-east-2' }, home } }, tmp('r3'))), { profile: null, region: 'us-east-2' });
  assert.deepEqual(awsTargetFor(identityIn({ identity: { env: {}, home } }, tmp('r4'))), { profile: null, region: null });
  assert.deepEqual(targetArgs({ profile: 'dev', region: 'us-west-2' }), ['--profile', 'dev', '--region', 'us-west-2']);
  assert.equal(commandLine(ACTIONS['security-code-review'].args, join(home, 'src', 'demo shop'), home, { profile: 'dev', region: 'us-west-2' }),
    "cd '~/src/demo shop' && prism-cli security code-review --no-wait --profile dev --region us-west-2");
});

test('the page actions: fixed ids, in the repo, read-only except the two --no-wait uploads', () => {
  for (const id of SECURITY_ACTIONS) {
    const a = ACTIONS[id];
    assert.equal(a.repo, true, id); assert.equal(a.awsTarget, true, id);
    assert.ok(!!a.readOnlyAws !== !!a.writesAws, `${id}: read-only or writing, not both`);
  }
  const writes = ['security-code-review', 'security-code-review-full', 'security-threat-model', 'security-code-review-force', 'security-code-review-full-force'];
  assert.deepEqual(SECURITY_ACTIONS.filter((id) => ACTIONS[id].writesAws), writes);
  assert.deepEqual(Object.keys(WRITE_KIND).sort(), [...writes].sort());
  assert.deepEqual(ACTIONS['security-code-review-force'].args, ['security', 'code-review', '--no-wait', '--force'], '"Start another anyway" passes --force');
  assert.deepEqual(ACTIONS['security-code-review-full-force'].args, ['security', 'code-review', '--full', '--no-wait', '--force']);
  for (const id of SECURITY_ACTIONS) assert.ok(!/pentest$|pentest --(status|dry-run)|^enable security$/.test(ACTIONS[id].args.join(' ')) || id === 'security-pentest-findings', id);
});

// ---------------------------------------------------------------- the runner gates

interface Spawned { file: string; args: string[]; opts: any; child: any }
const REPO: ScanRepo = { id: repoId('/work/demo'), name: 'demo', path: '/work/demo' };
function fakeSpawn(calls: Spawned[]) {
  return (file: string, args: string[], opts: any) => {
    const child: any = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    calls.push({ file, args, opts, child });
    setTimeout(() => child.emit('close', 0), 1);
    return child;
  };
}
const runnerWith = (calls: Spawned[], over: Partial<ConstructorParameters<typeof ActionRunner>[0]> = {}) => new ActionRunner({
  execPath: '/usr/bin/node', entry: '/opt/prism/dist/bin/prism-cli.js', cwd: '/work', home: tmp('home'), repos: async () => [REPO],
  systemdAvailable: () => false, platform: 'linux', spawn: fakeSpawn(calls) as any,
  awsArgs: () => ['--profile', 'demo', '--region', 'us-west-2'], writeGate: () => null, ...over,
});
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); };

test('runner: a security action needs a repo id from the scan list; the cwd is that repo; the server appends --profile/--region', async () => {
  const calls: Spawned[] = [];
  const r = runnerWith(calls);
  assert.equal((await r.start({ action: 'security-findings' })).status, 400, 'no repo');
  assert.equal((await r.start({ action: 'security-findings', repo: '../../etc' })).status, 400, 'not an id');
  assert.equal((await r.start({ action: 'security-findings', repo: 'ffffffffffffffff' })).status, 400, 'unknown id');
  assert.equal((await r.start({ action: 'security-findings', repo: REPO.id, profile: 'evil' })).status, 400, 'no profile from the page');
  assert.equal((await r.start({ action: 'security-findings', repo: REPO.id, path: '/tmp' })).status, 400, 'no path from the page');
  assert.equal(calls.length, 0);
  const res = await r.start({ action: 'security-findings', repo: REPO.id });
  assert.equal(res.status, 202);
  assert.deepEqual(calls[0].args, ['/opt/prism/dist/bin/prism-cli.js', 'security', 'findings', '--profile', 'demo', '--region', 'us-west-2']);
  assert.equal(calls[0].opts.cwd, '/work/demo');
  assert.equal(calls[0].opts.shell, false);
  assert.equal((res.json as any).command, 'prism-cli security findings --profile demo --region us-west-2');
  await until(() => !r.running);
  const bad = runnerWith([], { awsArgs: () => ['--profile', 'x; rm -rf /'] });
  assert.equal((await bad.start({ action: 'security-findings', repo: REPO.id })).status, 400, 'a resolved value that is not a profile name is refused');
  const dash = runnerWith([], { awsArgs: () => ['--profile', '--endpoint-url=http://evil'] });
  assert.equal((await dash.start({ action: 'security-findings', repo: REPO.id })).status, 400, 'a value that reads as a flag is refused');
});

test('runner: an async write gate holds the action lock while it checks', async () => {
  let release!: (v: string | null) => void;
  const calls: Spawned[] = [];
  const r = runnerWith(calls, { writeGate: () => new Promise((res) => { release = res; }) });
  const first = r.start({ action: 'security-code-review', repo: REPO.id, confirm: true });
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(r.running, true, 'locked during the check');
  assert.equal((await r.start({ action: 'security-findings', repo: REPO.id })).status, 409);
  release('the credentials now point to account ••••6666');
  assert.equal((await first).status, 409);
  assert.equal(r.running, false);
  assert.equal(calls.length, 0);
  const thrower = runnerWith(calls, { writeGate: async () => { throw new Error('boom'); } });
  assert.equal((await thrower.start({ action: 'security-code-review', repo: REPO.id, confirm: true })).status, 409, 'a failing check refuses');
  assert.equal(thrower.running, false);
});

test('runner: the AWS-writing actions need confirm and a passing write gate; one action at a time', async () => {
  const calls: Spawned[] = [];
  assert.equal((await runnerWith(calls).start({ action: 'security-code-review', repo: REPO.id })).status, 400, 'needs confirm: true');
  const gated = await runnerWith(calls, { writeGate: () => 'Look up agent spaces first' }).start({ action: 'security-code-review', repo: REPO.id, confirm: true });
  assert.equal(gated.status, 409);
  assert.match((gated.json as any).error, /Look up agent spaces first/);
  assert.equal((await runnerWith(calls, { writeGate: undefined }).start({ action: 'security-threat-model', repo: REPO.id, confirm: true })).status, 409, 'no gate: refused');
  assert.equal(calls.length, 0);
  let seen: [ActionId, string] | null = null;
  const r = runnerWith(calls, { writeGate: (id, repo) => { seen = [id, repo.path]; return null; }, spawn: ((f: string, a: string[], o: any) => { const c: any = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => true; calls.push({ file: f, args: a, opts: o, child: c }); return c; }) as any });
  assert.equal((await r.start({ action: 'security-code-review-full', repo: REPO.id, confirm: true })).status, 202);
  assert.deepEqual(seen, ['security-code-review-full', '/work/demo']);
  assert.deepEqual(calls[0].args.slice(1), ['security', 'code-review', '--full', '--no-wait', '--profile', 'demo', '--region', 'us-west-2']);
  assert.equal((await r.start({ action: 'security-threat-model', repo: REPO.id, confirm: true })).status, 409, 'one at a time');
  calls[0].child.emit('close', 0);
});

test('write notice: names the repo, scan bucket, masked account and region; refuses without a usable lookup', () => {
  const good: Lookup = { ok: true, at: '', profile: 'demo', region: 'us-west-2', account4: '••••3333', spaces: [], inUse: 'as-1', scanBucket: 'prism-scan-demo', consoleUrl: '' };
  assert.equal(writeNotice('code review', 'demo-shop', good).text,
    'Uploads demo-shop source at HEAD to the scan bucket prism-scan-demo in account ••••3333 / us-west-2 and starts a code review job.');
  assert.match(writeNotice('threat model', 'demo-shop', good).text!, /^Uploads demo-shop source at HEAD to the scan bucket prism-scan-demo in account ••••3333 \/ us-west-2 and starts a threat model job\. Its scope docs/);
  assert.match(writeNotice('code review', 'x', null).reason!, /has not been checked yet/);
  assert.match(writeNotice('code review', 'x', { ...good, inUse: null }).reason!, /run enable security first/);
  assert.match(writeNotice('code review', 'x', { ...good, scanBucket: null }).reason!, /scan-bucket is not set/);
  assert.match(writeNotice('code review', 'x', { ok: false, at: '', profile: null, region: 'us-west-2', error: 'e', credentials: true, kind: 'credentials', action: null }).reason!, /has not been checked yet/);
});

// ---------------------------------------------------------------- routes

function saDeps(home: string, repos: (ScanRepo & { current: boolean })[], aws = fakeAws(), runner?: ActionRunner): SecurityAgentDeps & { aws: ReturnType<typeof fakeAws> } {
  const r = runner ?? runnerWith([]);
  return { repos: async () => repos, identity: { env: { AWS_PROFILE: 'demo', AWS_REGION: 'us-west-2' }, home }, cache: new LookupCache(aws.call), exclusive: (fn) => r.exclusive(fn), aws };
}

test('GET /api/security-agent: a repo override git tracks is ignored, as in the CLI; the machine setup applies', async () => {
  const { execFileSync } = await import('node:child_process');
  const home = tmp('home'), path = join(home, 'src', 'tracked');
  mkdirSync(join(path, '.prism'), { recursive: true });
  const g = (...a: string[]) => execFileSync('git', ['-C', path, ...a], { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  g('init', '-q');
  writeFileSync(join(path, '.prism', 'security.local.json'), JSON.stringify({ agentSpaceId: 'as-c', applicationId: 'a', codeReviewId: 'cr-c', region: 'eu-west-1', account: '111122223333', setupAt: '2026-11-02T00:00:00Z' }));
  g('add', '-f', '.prism/security.local.json'); g('commit', '-q', '-m', 'committed override');
  mkdirSync(join(home, '.prism'), { recursive: true });
  writeFileSync(join(home, '.prism', 'security.json'), JSON.stringify({ agentSpaceId: 'as-1', applicationId: 'app-1', region: 'us-west-2', account: '111122223333', setupAt: '2026-11-01T00:00:00Z' }));
  const d = saDeps(home, [{ id: repoId(path), name: 'tracked', path, current: true }]);
  const r = (await securityAgentView(d)).repos[0];
  assert.equal(r.setup?.source, 'machine');
  assert.equal(r.target.region, 'us-west-2', 'the committed file does not pick the region');
});

test('GET /api/security-agent makes no AWS call: identity, setup record, commands and notices per repo', async () => {
  const home = tmp('home'), path = join(home, 'src', 'demo');
  mkdirSync(join(path, '.prism'), { recursive: true });
  writeFileSync(join(path, '.prism', 'security.local.json'), JSON.stringify({ agentSpaceId: 'as-1', applicationId: 'app-1', codeReviewId: 'cr-1', region: 'us-west-2', account: '111122223333', setupAt: '2026-11-02T00:00:00Z' }));
  const d = saDeps(home, [{ id: repoId(path), name: 'demo', path, current: true }]);
  const v = await securityAgentView(d);
  assert.equal(d.aws.calls.length, 0, 'no AWS call');
  const r = v.repos[0];
  assert.equal(r.path, '~/src/demo');
  assert.deepEqual([r.target.profile, r.target.region, r.target.source], ['demo', 'us-west-2', 'AWS_PROFILE']);
  assert.deepEqual(r.setup, { source: 'repo', file: '.prism/security.local.json', codeReviewId: 'cr-1', account4: '••••3333', region: 'us-west-2', setupAt: '2026-11-02T00:00:00Z' });
  assert.equal(v.machine, null);
  assert.equal(v.setupCommand, 'prism-cli enable security --profile demo --region us-west-2', 'once per machine: no cd');
  assert.equal((r.copy as Record<string, string>).enableSecurity, undefined);
  assert.equal(r.commands['security-status'], 'cd ~/src/demo && prism-cli enable security --status --profile demo --region us-west-2');
  assert.equal(r.copy.pentest, 'cd ~/src/demo && prism-cli security pentest --profile demo --region us-west-2');
  assert.equal(r.notices['security-code-review'].text, null, 'no lookup yet');
  assert.equal(r.lookup, null);
  assert.equal(r.gate.state, 'profile', 'AWS_PROFILE=demo is in neither AWS file: step 1');
  assert.deepEqual(r.guard, { running: null, reviewed: null });
  assert.ok(!JSON.stringify(v).includes('111122223333'), 'no full account id');
  // After a lookup, the notices name the bucket.
  await d.cache.get({ profile: 'demo', region: 'us-west-2' });
  const v2 = await securityAgentView(d);
  assert.match(v2.repos[0].notices['security-code-review'].text!, /^Uploads demo source at HEAD to the scan bucket prism-scan-demo in account ••••3333 \/ us-west-2/);
});

test('POST /api/security-agent/spaces: repo ids from the scan list only, runs under the action lock', async () => {
  const home = tmp('home'), path = join(home, 'demo');
  const calls: Spawned[] = [];
  const runner = runnerWith(calls, { spawn: ((f: string, a: string[], o: any) => { const c: any = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => true; calls.push({ file: f, args: a, opts: o, child: c }); return c; }) as any, repos: async () => [{ id: repoId(path), name: 'demo', path }] });
  const d = saDeps(home, [{ id: repoId(path), name: 'demo', path, current: true }], fakeAws(), runner);
  assert.equal((await securityAgentLookup(d, [])).status, 400);
  assert.equal((await securityAgentLookup(d, { repo: 'nothex' })).status, 400);
  assert.equal((await securityAgentLookup(d, { repo: 'ffffffffffffffff' })).status, 400, 'unknown repo');
  assert.equal((await securityAgentLookup(d, { repo: repoId(path), region: 'us-east-1' })).status, 400, 'no other fields');
  assert.equal((await securityAgentLookup(d, { repo: repoId(path), refresh: 'yes' })).status, 400);
  assert.equal(d.aws.calls.length, 0);
  await runner.start({ action: 'security-status', repo: repoId(path) });
  assert.equal((await securityAgentLookup(d, { repo: repoId(path) })).status, 409, 'waits for the running action');
  calls[0].child.emit('close', 0);
  const r = await securityAgentLookup(d, { repo: repoId(path) });
  assert.equal(r.status, 200);
  assert.equal((r.json as any).lookup.ok, true);
  assert.equal((r.json as any).cached, false);
  assert.equal(((await securityAgentLookup(d, { repo: repoId(path) })).json as any).cached, true);
  assert.equal(((await securityAgentLookup(d, { repo: repoId(path), refresh: true })).json as any).cached, false);
});

test('setup-api: the routes are mounted; the catalog flags the writing actions', async () => {
  const home = tmp('home');
  const api = setupApi({ runner: runnerWith([]), cwd: '/work', repoPaths: async () => [], identity: { env: {}, home, repoRoot: null }, refresh: async () => ({}), securityAgent: saDeps(home, []) });
  assert.ok(api.getApi['/api/security-agent']);
  assert.ok(api.postApi['/api/security-agent/spaces']);
  const cat = (await api.getApi['/api/setup']()) as any;
  assert.deepEqual(cat.actions.filter((a: any) => a.writesAws).map((a: any) => a.id), ['security-code-review', 'security-code-review-full', 'security-threat-model', 'security-code-review-force', 'security-code-review-full-force']);
  const none = setupApi({ runner: runnerWith([]), cwd: '/work', repoPaths: async () => [], identity: { env: {}, home, repoRoot: null }, refresh: async () => ({}) });
  assert.equal((await none.postApi['/api/security-agent/spaces']({ repo: 'x' })).status, 400);
});

// ---------------------------------------------------------------- the page

async function pagePayload(): Promise<DashboardPayload> {
  const home = tmp('ph');
  for (const n of ['demo-shop', 'payments']) mkdirSync(join(home, n, '.git'), { recursive: true });
  return buildPayload({
    cwd: tmp('nowhere'), home, pathEnv: tmp('path'),
    exporter: async () => ({ schema: 'codeburn.export.v2', currency: { code: 'USD' }, summary: [{ 'Cost (USD)': 0, 'API Calls': 0, Sessions: 0 }], periods: [], projects: [] }),
    machineDeps: { home, env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', systemdAvailable: () => false },
    version: async () => ({ installed: '1.14.0', latest: '1.14.0', publishedAt: '2026-11-13T00:00:00.000Z', update: false, checkedAt: '2026-11-14T00:00:00.000Z' }),
    agentHooks: () => ({ rows: [], plugin: { active: false, version: null, outdated: false } }),
  });
}

const row = (path: string, over: Record<string, unknown> = {}) => ({
  name: 'x', path, current: false, job_id: 'job-1', job_status: 'COMPLETED', status: 'findings', scope: 'diff', started_at: '2026-11-13T10:00:00Z', finished_at: '2026-11-13T10:20:00Z',
  counts: {}, findings: [], truncated: false, reason: null, pending: false, stale: false, threats: [], more: 0, scope_docs: [], overview: '', commit: null, target_host: 'app.internal', teardown_failed: null, ...over,
});

const STEP_OF: Record<GateState, Gate['step']> = { connect: 1, profile: 1, setup: 2, mismatch: 2, checking: 3, sso: 3, denied: 3, nospace: 3, error: 3, ready: null };
/** A gate as GET /api/security-agent sends it (security-gate.ts computes the real one; tested in dashboard-security-gate.test.ts). */
function gate(state: GateState, over: Partial<Gate> = {}): Gate {
  return {
    state, step: STEP_OF[state], title: 'Title of ' + state, detail: ['Detail of ' + state + '.'],
    using: { via: 'aws connect', profile: 'demo', label: 'aws connect: demo' }, precedence: null, copy: {}, action: null,
    account4: '••••3333', region: 'us-west-2', setup: { source: 'machine', file: '~/.prism/security.json', account4: '••••3333', region: 'us-west-2' }, info: [], ...over,
  };
}
const NO_GUARD = { running: null, reviewed: null };

function saAnswer(p: DashboardPayload, lookup: Lookup | null, current = 0, machine = true, g: Gate = gate(lookup?.ok ? 'ready' : lookup ? 'sso' : 'checking'), guard: unknown = NO_GUARD) {
  return {
    repos: p.repos.map((r, i) => ({
      id: r.id, name: r.name, path: '~/' + r.name, current: i === current, setup: i === 0 ? MACHINE_VIEW : null,
      target: { profile: 'demo', region: 'us-west-2', source: 'aws connect, user', credentialLabel: 'IAM Identity Center (SSO)', regionFrom: i === 0 ? 'machine' : null },
      gate: g, guard,
      commands: Object.fromEntries(SECURITY_ACTIONS.map((id) => [id, `cd ~/${r.name} && prism-cli ${ACTIONS[id].args.join(' ')} --profile demo --region us-west-2`])),
      copy: { pentest: 'p', pentestDryRun: 'pd', pentestStatus: 'ps' },
      notices: Object.fromEntries(Object.entries(WRITE_KIND).map(([id, kind]) => [id, writeNotice(kind!, r.name, lookup)])),
      lookup,
    })),
    machine: machine ? MACHINE_VIEW : null,
    setupCommand: 'prism-cli enable security --profile demo --region us-west-2',
  };
}
const MACHINE_VIEW = { source: 'machine', file: '~/.prism/security.json', codeReviewId: null, account4: '••••3333', region: 'us-west-2', setupAt: '2026-11-01T00:00:00Z' };
const GOOD: Lookup = { ok: true, at: '2026-11-14T12:00:00Z', profile: 'demo', region: 'us-west-2', account4: '••••3333', inUse: 'as-1', scanBucket: 'prism-scan-demo', consoleUrl: 'https://us-west-2.console.aws.amazon.com/securityagent/home?region=us-west-2',
  spaces: [{ id: 'as-1', name: 'prism-d1-security', createdAt: null, inUse: true, pentest: false, bucketListed: true }, { id: 'as-2', name: 'pentest-demo', createdAt: null, inUse: false, pentest: true, bucketListed: null }] };
const EXPIRED: Lookup = { ok: false, at: '', profile: 'demo', region: 'us-west-2', error: 'the credentials did not work: Token has expired', credentials: true, kind: 'credentials', action: null };
const SETUP = { ...SETUP_STUB, actions: SECURITY_ACTIONS.map((id) => ({ id, label: ACTIONS[id].label, command: 'prism-cli ' + ACTIONS[id].args.join(' '), repo: true, url: false, confirm: !!ACTIONS[id].confirm, readOnlyAws: !!ACTIONS[id].readOnlyAws, writesAws: !!ACTIONS[id].writesAws, note: ACTIONS[id].note ?? null, installs: false, timeoutSec: 180, available: true })) };

const buttons = (root: FakeElement) => root.querySelectorAll('button');
const btn = (root: FakeElement, label: string) => buttons(root).find((b) => b.textContent === label);
const posts = (page: { requests: { url: string; method: string; body: unknown }[] }, url = '/api/security-agent/spaces') => page.requests.filter((r) => r.method === 'POST' && r.url === url);
const dialogOf = (page: Awaited<ReturnType<typeof runPage>>) => page.dom.document.body.childNodes.find((n) => n instanceof FakeElement && n.nodeName === 'DIALOG') as FakeElement;

test('page: Dashboard | Security Agent | AccountGuard | Settings; #security opens the page on the current repo; #security/<id> on that repo', async () => {
  const p = await pagePayload();
  const [a, b] = p.repos;
  const page = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, GOOD, 0) });
  const sec = page.dom.byId.security;
  assert.equal(sec.hidden, false);
  assert.equal(page.dom.byId.main.hidden, true);
  assert.match(sec.textContent, new RegExp('Results for ' + a.name));
  page.go('#security/' + b.id);
  assert.match(sec.textContent, new RegExp('Results for ' + b.name));
  page.go('#security/ffffffffffffffff');
  assert.match(sec.textContent, new RegExp('Results for ' + b.name), 'an unknown id keeps the last pick');
  const sel = sec.all().find((e) => e.nodeName === 'SELECT')!;
  sel.value = a.id; sel.listeners.change();
  assert.equal(page.location.hash, '#security/' + a.id, 'the picker writes the deep link');
  page.go('');
  assert.equal(sec.hidden, true);
  const { renderPage } = await import('../src/dashboard/page.js');
  assert.match(renderPage('N'), /<a href="#">Dashboard<\/a>|data-view="dashboard">Dashboard<\/a><a href="#security" data-view="security">Security Agent <span class="badge warn" id="security-badge" hidden><\/span><\/a><a href="#accountguard" data-view="accountguard">AccountGuard <span class="badge warn" id="accountguard-badge" hidden><\/span><\/a><a href="#settings" data-view="settings">Settings/);
});

test('gate: only the first unmet step, as step n of 3 with a bar; nothing else (no runs, results or Start) until it passes', async () => {
  const p = await pagePayload();
  for (const [state, n] of [['connect', 1], ['profile', 1], ['setup', 2], ['mismatch', 2], ['checking', 3], ['sso', 3], ['denied', 3], ['nospace', 3], ['error', 3]] as const) {
    const page = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, null, 0, true, gate(state)), '/api/security-agent/spaces': { lookup: null, cached: false } });
    const sec = page.dom.byId.security;
    const cards = sec.all().filter((e) => e.getAttribute('id') === 'sa-gate');
    assert.equal(cards.length, 1, state);
    assert.equal(cards[0].getAttribute('data-state'), state);
    const t = sec.textContent;
    assert.match(t, new RegExp('Set up Security Agent · step ' + n + ' of 3' + (n - 1) + ' of 3 done'), state);
    assert.match(t, /AWS connected.*Security Agent set up.*Agent space verified/, state);
    assert.match(t, new RegExp('Title of ' + state + 'Detail of ' + state), state);
    const bar = sec.all().find((e) => e.getAttribute('role') === 'progressbar')!;
    assert.equal(bar.getAttribute('aria-valuenow'), String(n - 1));
    for (const no of ['Results for', 'Start new work', 'Security runs', 'Agent spaces', 'Security Agent ready']) assert.ok(!t.includes(no), `${state}: no ${no}`);
    for (const label of ['Review this branch', 'Fetch findings', 'Start threat model']) assert.equal(btn(sec, label), undefined, `${state}: no ${label}`);
  }
});

test('gate step 1 and 2: Settings › AWS link, enable security copy-only with no cd, both mismatch commands, and a re-check every 10 s from local files', async () => {
  const p = await pagePayload();
  const conn = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, null, 0, true, gate('connect', { using: null })) });
  assert.ok(conn.dom.byId.security.querySelectorAll('a').some((a) => a.getAttribute('href') === '#settings/aws' && a.textContent === 'Open Settings › AWS →'));
  assert.equal(posts(conn).length, 0, 'no lookup before steps 1 and 2 pass');

  const cmd = 'prism-cli enable security --profile demo --region us-west-2';
  let light: Gate = gate('setup', { copy: { setup: cmd } });
  const gateUrl = '/api/security-agent/gate?repo=' + p.repos[0].id;
  const page = await runPage([p], '#security', SETUP, { '/api/security-agent': () => saAnswer(p, null, 0, false, light), [gateUrl]: () => ({ repo: p.repos[0].id, gate: light }) });
  const sec = page.dom.byId.security;
  assert.match(sec.textContent, new RegExp(cmd.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&') + 'Copy'));
  assert.doesNotMatch(sec.textContent, /cd \S+ && prism-cli enable security/, 'once per machine: no cd');
  assert.equal(btn(sec, 'Run'), undefined, 'enable security never runs from the page');
  const gets = () => page.requests.filter((r) => r.url === '/api/security-agent').length;
  const lights = () => page.requests.filter((r) => r.url === gateUrl).length;
  assert.equal(page.pendingTimers().length, 1, 'one 10 s re-check held');
  assert.equal(page.pendingTimers()[0].ms, 10000);
  await page.reload();
  assert.equal(page.pendingTimers().length, 1, 'a redraw keeps the pending re-check instead of pushing it back');
  const before = gets();
  await page.fireTimers();
  assert.deepEqual([lights(), gets()], [1, before], 'the re-check is the light gate endpoint for the picked repo, not the full answer');
  assert.equal(page.pendingTimers().length, 1, 'and it waits again');
  (page.dom.document as { visibilityState: string }).visibilityState = 'hidden';
  await page.fireTimers();
  assert.equal(lights(), 1, 'a hidden tab fetches nothing');
  assert.equal(page.pendingTimers().length, 1, 'it only waits');
  (page.dom.document as { visibilityState: string }).visibilityState = 'visible';
  btn(page.dom.byId.security, 'I ran it, check again')!.listeners.click();
  await page.settle();
  assert.deepEqual([lights(), gets()], [2, before]);
  assert.equal(posts(page).length, 0);
  // The step passes: then, and only then, the full answer.
  light = gate('checking');
  await page.fireTimers();
  await page.settle();
  assert.equal(lights(), 3);
  assert.equal(posts(page).length, 1, 'past step 2: the full answer, then step 3 starts its lookup');
  assert.equal(gets(), before + 2, 'one full answer for the step, one after the lookup');

  const m = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, null, 0, true, gate('mismatch', { copy: { repo: 'cd ~/demo-shop && prism-cli enable security --repo --profile demo --region us-west-2', replace: 'prism-cli enable security --replace --profile demo --region us-west-2' } })) });
  const mt = m.dom.byId.security.textContent;
  assert.match(mt, /Only for this repo.*cd ~\/demo-shop && prism-cli enable security --repo --profile demo --region us-west-2Copy/);
  assert.match(mt, /Change the machine default.*prism-cli enable security --replace --profile demo --region us-west-2Copy/);
  assert.match(mt, /Set upaccount ••••3333, us-west-2 \(~\/\.prism\/security\.json\)In use nowaws connect: demo, account ••••3333/);
});

test('commands wrap only at spaces: one nowrap span per word, and the text is the exact command', async () => {
  const p = await pagePayload();
  const cmd = 'cd ~/demo-shop && prism-cli enable security --repo --profile prism-demo-sandbox-readonly-team-alpha-us-west-2 --region us-west-2';
  const page = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, null, 0, true, gate('mismatch', { copy: { repo: cmd, replace: 'x' } })) });
  const code = page.dom.byId.security.byClass('cmdw').find((c) => c.textContent === cmd)!;
  assert.ok(code, 'the command text is exact');
  const words = code.childNodes.filter((n) => n instanceof FakeElement) as FakeElement[];
  assert.deepEqual(words.map((w) => w.textContent), cmd.split(' '));
  assert.ok(words.filter((w) => w.textContent.length <= 20).every((w) => w.getAttribute('class') === 'w'), '--repo, --profile and the rest never break inside');
  assert.equal(words.find((w) => w.textContent.startsWith('prism-demo-sandbox'))!.getAttribute('class'), 'w long', 'a word over 20 characters may break, so nothing scrolls sideways');
});

test('gate step 3: the lookup starts by itself once (refresh false), never on the minute refresh, and only on the Security Agent view', async () => {
  const p = await pagePayload();
  let answer = saAnswer(p, null, 1);
  const bodies: unknown[] = [];
  const page = await runPage([p, p, p], '#security/' + p.repos[1].id, SETUP, {
    '/api/security-agent': () => answer,
    '/api/security-agent/spaces': (body: unknown) => { bodies.push(body); answer = saAnswer(p, GOOD, 1); return { lookup: GOOD, cached: false }; },
  });
  await page.settle();
  assert.deepEqual(bodies, [{ repo: p.repos[1].id, refresh: false }], 'once, for the picked repo');
  assert.match(page.dom.byId.security.textContent, /Security Agent readyAWS: aws connect: demo, account ••••3333, us-west-2/);
  await page.reload(); await page.reload();
  assert.equal(bodies.length, 1, 'the minute refresh makes no lookup');
  assert.equal(page.pendingTimers().length, 0, 'no re-check timer once ready');
  btn(page.dom.byId.security, 'Check again')!.listeners.click();
  await page.settle();
  assert.deepEqual(bodies[1], { repo: p.repos[1].id, refresh: true }, 'Check again refreshes the kept answer');

  // A lookup the gate is waiting for does not start from the Dashboard view.
  const dash = await runPage([p], '', SETUP, { '/api/security-agent': saAnswer(p, null), '/api/security-agent/spaces': { lookup: GOOD, cached: false } });
  assert.equal(posts(dash).length, 0, 'not on the Dashboard');

  // Refused (another action holds the lock): the card says why, with Retry; it does not retry by itself.
  const busy = await runPage([p, p], '#security', SETUP, { '/api/security-agent': saAnswer(p, null), '/api/security-agent/spaces': { __status: 409, body: { error: 'another action is running; wait for it to finish' } } });
  await busy.settle();
  assert.match(busy.dom.byId.security.textContent, /The check could not start: another action is running; wait for it to finish/);
  await busy.reload();
  assert.equal(posts(busy).length, 1, 'no automatic retry');
  btn(busy.dom.byId.security, 'Retry')!.listeners.click();
  await busy.settle();
  assert.equal(posts(busy).length, 2);
});

test('gate step 3 failures: the sign-in command, the denied action, a missing space; each with Retry', async () => {
  const p = await pagePayload();
  const sso = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, EXPIRED, 0, true, gate('sso', { copy: { login: 'aws sso login --profile demo' } })), '/api/security-agent/spaces': { lookup: GOOD, cached: false } });
  assert.match(sso.dom.byId.security.textContent, /aws sso login --profile demoCopy/);
  assert.match(sso.dom.byId.security.textContent, /AWS: aws connect: demo, account ••••3333, us-west-2/, 'step 3 names the profile in use');
  assert.equal(posts(sso).length, 0, 'a kept failure is not retried by itself');
  btn(sso.dom.byId.security, 'Retry')!.listeners.click();
  await sso.settle();
  assert.deepEqual(posts(sso)[0].body, { repo: p.repos[0].id, refresh: true });
  const denied = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, EXPIRED, 0, true, gate('denied', { action: 'securityagent:ListAgentSpaces', detail: ['Access denied for securityagent:ListAgentSpaces: x'] })) });
  assert.match(denied.dom.byId.security.textContent, /Access denied for securityagent:ListAgentSpaces/);
  assert.ok(btn(denied.dom.byId.security, 'Retry'));
  const none = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, { ...GOOD, inUse: null }, 0, true, gate('nospace', { copy: { setup: 'prism-cli enable security --profile demo --region us-west-2' } })) });
  assert.match(none.dom.byId.security.textContent, /prism-cli enable security --profile demo --region us-west-2Copy/);
  assert.ok(btn(none.dom.byId.security, 'I ran it, check again'));
});

test('ready: the strip, which profile and why (AWS_PROFILE over aws connect), the repo override as information', async () => {
  const p = await pagePayload();
  const using = { via: 'AWS_PROFILE' as const, profile: 'prism-env', label: 'AWS_PROFILE: prism-env' };
  const page = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, GOOD, 0, true, gate('ready', {
    using, precedence: 'AWS_PROFILE (prism-env) wins over the saved aws connect profile demo: prism-cli reads the environment before ~/.prism/aws.json.',
    setup: { source: 'repo', file: '.prism/security.local.json', account4: '••••3333', region: 'us-west-2' }, info: ['demo-shop has its own setup: the repo override .prism/security.local.json.'] })) });
  const t = page.dom.byId.security.textContent;
  assert.match(t, /Security Agent readyAWS: AWS_PROFILE: prism-env, account ••••3333, us-west-2Setup: repo override \(\.prism\/security\.local\.json\)Agent space prism-d1-security, checked /);
  assert.match(t, /AWS_PROFILE \(prism-env\) wins over the saved aws connect profile demo/);
  assert.match(t, /demo-shop has its own setup/);
  assert.match(t, /The first run in a repo also creates its code review, as the CI gate does\./);
  assert.ok(btn(page.dom.byId.security, 'Review this branch'));
});

test('page: the code review dialog names repo, bucket, masked account and region, with Cancel focused', async () => {
  const p = await pagePayload();
  const page = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, GOOD) });
  btn(page.dom.byId.security, 'Review this branch')!.listeners.click();
  const dlg = dialogOf(page);
  assert.ok(dlg.modal);
  const t = dlg.textContent;
  assert.match(t, new RegExp('Uploads ' + p.repos[0].name + ' source at HEAD to the scan bucket prism-scan-demo in account ••••3333 / us-west-2 and starts a code review job\\.'));
  assert.match(t, new RegExp('cd ~/' + p.repos[0].name + ' && prism-cli security code-review --no-wait --profile demo --region us-west-2'));
  const cancel = buttons(dlg).find((b) => b.textContent === 'Cancel')!, run = buttons(dlg).find((b) => b.textContent === 'Upload and start')!;
  assert.ok(cancel.focused, 'Cancel has the focus: Enter never confirms');
  assert.ok(!run.focused);
  run.listeners.click();
  await page.settle();
  const post = page.requests.find((r) => r.url === '/api/action')!;
  assert.deepEqual(post.body, { action: 'security-code-review', repo: p.repos[0].id, confirm: true }, 'only the action id, the repo id and confirm');
});

test('start guards: a running review offers View it or Start another anyway (--force); a reviewed HEAD offers Open those findings first', async () => {
  const p = await pagePayload();
  const running = { run_id: 'run-r1', job_id: 'job-r1', started_at: '2026-11-15T11:40:00Z', commit: 'aaaaaaaaaaaa', branch: 'main' };
  const reviewed = { run_id: 'run-d1', finished_at: '2026-11-15T10:20:00Z', commit: 'aaaaaaaaaaaa', counts: { critical: 1, high: 1, medium: 0, low: 2 }, total: 4 };
  const page = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, GOOD, 0, true, gate('ready'), { running, reviewed }) });
  btn(page.dom.byId.security, 'Review this branch')!.listeners.click();
  let dlg = dialogOf(page);
  assert.match(dlg.textContent, new RegExp('A code review of ' + p.repos[0].name + ' is already running\\. Started .* on main @ aaaaaaaaaaaa \\(job job-r1\\)'));
  assert.deepEqual(buttons(dlg).map((b) => b.textContent), ['Cancel', 'View it →', 'Start another anyway']);
  assert.ok(buttons(dlg)[0].focused, 'Cancel has the focus');
  buttons(dlg)[1].listeners.click();
  assert.equal(page.location.hash, '#security/run/' + p.repos[0].id + '/run-r1');
  assert.equal(dlg.modal, false);
  page.go('#security');
  btn(page.dom.byId.security, 'Review the whole repo')!.listeners.click();
  dlg = dialogOf(page);
  buttons(dlg).find((b) => b.textContent === 'Start another anyway')!.listeners.click();
  assert.match(dlg.textContent, /prism-cli security code-review --full --no-wait --force --profile demo --region us-west-2/, 'then the usual confirm, for the --force command');
  buttons(dlg).find((b) => b.textContent === 'Upload and start')!.listeners.click();
  await page.settle();
  assert.deepEqual(page.requests.find((r) => r.url === '/api/action')!.body, { action: 'security-code-review-full-force', repo: p.repos[0].id, confirm: true });

  const rev = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, GOOD, 0, true, gate('ready'), { running: null, reviewed }) });
  btn(rev.dom.byId.security, 'Review this branch')!.listeners.click();
  const d2 = dialogOf(rev);
  assert.match(d2.textContent, /This commit already has a finished review\. aaaaaaaaaaaa was reviewed .*: 1 critical, 1 high, 0 medium, 2 low\./);
  assert.deepEqual(buttons(d2).map((b) => b.textContent), ['Cancel', 'Open those findings →', 'Review it again']);
  buttons(d2)[2].listeners.click();
  assert.match(d2.textContent, /Upload and start/, 'Review it again: the usual confirm');
  assert.doesNotMatch(d2.textContent, /--force/);
  // Threat models have no guard.
  const tm = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, GOOD, 0, true, gate('ready'), { running, reviewed }) });
  btn(tm.dom.byId.security, 'Start threat model')!.listeners.click();
  assert.match(dialogOf(tm).textContent, /Upload and start/);
});

test('page: copy-only for enable security and every pentest command; Run for the read-only fetches', async () => {
  const p = await pagePayload();
  const page = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, GOOD) });
  const labels = buttons(page.dom.byId.security).map((b) => b.textContent);
  for (const l of ['Fetch findings', 'Fetch threats', 'Fetch pentest findings', 'Review this branch', 'Review the whole repo', 'Start threat model', 'Run status check', 'Dry run']) assert.ok(labels.includes(l), l);
  assert.ok(!labels.some((l) => /pentest/i.test(l) && !/Fetch/.test(l)), 'no Run for pentest');
  const t = page.dom.byId.security.textContent;
  assert.match(t, /prism-cli enable security --profile demo --region us-west-2Copy/);
  assert.doesNotMatch(t, /cd \S+ && prism-cli enable security/, 'enable security is once per machine: no cd');
});

test('page: one machine-wide setup card; each repo says whether it uses the machine setup or a repo override', async () => {
  const p = await pagePayload();
  const set = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, GOOD) });
  const t = set.dom.byId.security.textContent;
  assert.match(t, /Set up Security Agent on this machine/);
  assert.doesNotMatch(t, /Set up Security Agent in /);
  assert.match(t, /Uses the machine setup \(~\/\.prism\/security\.json\): account ••••3333 \/ us-west-2/);
  assert.match(t, /uses machine setup · from this repo's \.prism\/results/);
  assert.match(t, /Which setup \S+ uses \(uses machine setup\)/);
  assert.match(t, /us-west-2 \(machine setup\)/);
  assert.doesNotMatch(t, /has not run in this repo|no \.prism\/security\.local\.json/);

  const a = saAnswer(p, GOOD);
  a.repos[0].setup = { ...MACHINE_VIEW, source: 'repo', file: '.prism/security.local.json', codeReviewId: 'cr-1' } as typeof MACHINE_VIEW & { codeReviewId: string };
  const over = await runPage([p], '#security', SETUP, { '/api/security-agent': a });
  assert.match(over.dom.byId.security.textContent, /Repo override: \.prism\/security\.local\.json \(code review cr-1, account ••••3333 \/ us-west-2/);
  assert.match(over.dom.byId.security.textContent, /repo override · from this repo's/);
});

test('nav badge: a setup step not met, high latest results, pending reviews and threat models; not a running pentest or a running check', async () => {
  const p = await pagePayload();
  const path = p.repos[0].path;
  const badge = async (sec: unknown, lookup: Lookup | null, g?: Gate) => {
    const q = JSON.parse(JSON.stringify(p)) as DashboardPayload;
    (q as any).security = { repos: [], pentests: [], threat_models: [], hint: '', pending_hint: '', pentest_hint: '', threats_hint: '', ...(sec as object) };
    const page = await runPage([q], '', SETUP, { '/api/security-agent': saAnswer(q, lookup, 0, true, g) });
    const b = page.dom.byId['security-badge'];
    return b.hidden ? 0 : Number(b.textContent);
  };
  assert.equal(await badge({}, null), 0, 'the check has not run: no badge, no guess');
  assert.equal(await badge({}, GOOD), 0);
  assert.equal(await badge({ pentests: [row(path, { pending: true, status: 'pending' })] }, GOOD), 0, 'a running pentest is not counted');
  assert.equal(await badge({ pentests: [row(path, { counts: { HIGH: 1 } })] }, GOOD), 1, 'a finished pentest with a high finding is');
  assert.equal(await badge({ repos: [row(path, { pending: true, status: 'pending' })] }, GOOD), 1, 'pending code review');
  assert.equal(await badge({ threat_models: [row(path, { pending: true, status: 'pending' })] }, GOOD), 1, 'pending threat model');
  assert.equal(await badge({ repos: [row(path, { counts: { CRITICAL: 1 } })], threat_models: [row(path, { counts: { HIGH: 2 } })] }, GOOD), 2);
  assert.equal(await badge({ repos: [row(path, { counts: { MEDIUM: 4 } })] }, GOOD), 0, 'medium only: nothing to act on');
  assert.equal(await badge({ repos: [row(p.repos[1].path, { counts: { HIGH: 1 } })] }, GOOD), 0, 'another repo\'s finding is not the picked repo\'s');
  for (const s of ['connect', 'setup', 'mismatch', 'sso', 'denied', 'nospace'] as const) assert.equal(await badge({}, null, gate(s)), 1, s);
});

test('Settings > AWS points to the Security Agent page; the Dashboard\'s security rows link to it per repo', async () => {
  const p = await pagePayload();
  const settings = await runPage([p], '#settings/aws', { ...SETUP, aws: { steps: [], warnings: [] } });
  const aws = settings.dom.byId.settings.all().find((e) => e.getAttribute('data-pane') === 'aws')!;
  assert.match(aws.textContent, /Account checks moved to AccountGuard → · Security Agent has its own page →/);
  assert.ok(aws.querySelectorAll('a').some((a) => a.getAttribute('href') === '#security'));
  assert.doesNotMatch(aws.textContent, /Security Agent runs/, 'the copy-only Security Agent rows moved to the page');
  const q = JSON.parse(JSON.stringify(p)) as DashboardPayload;
  q.security_runs = [{ repo_id: q.repos[1].id, run_id: 'abc123456789-20261115T120000000Z-manual-security-review', repo: q.repos[1].label, type: 'code-review', status: 'complete', started_at: '2026-11-15T12:00:00Z',
    duration_s: 600, branch: 'main', commit: 'abc123456789', counts: { critical: 0, high: 1, medium: 0, low: 0 }, total: 1, top_title: 'x', reason: null, job_id: 'job-1', check: null }];
  const dash = await runPage([q]);
  const link = dash.dom.byId.main.querySelectorAll('a').find((a) => a.textContent === 'View findings →');
  assert.equal(link?.getAttribute('href'), '#security/run/' + q.repos[1].id + '/abc123456789-20261115T120000000Z-manual-security-review');
});

test('GET /api/security-agent/gate: one known repo, local files only: no git process, no repo scan', { skip: process.platform === 'win32' && 'a /bin/sh recorder git' }, async () => {
  const { chmodSync } = await import('node:fs');
  const home = tmp('home'), path = join(home, 'src', 'demo');
  mkdirSync(join(path, '.prism'), { recursive: true });
  const d = saDeps(home, [{ id: repoId(path), name: 'demo', path, current: true }]);
  let scans = 0;
  const repos = d.repos;
  d.repos = async () => { scans++; return repos(); };
  // Every git the dashboard spawns resolves through PATH: a recorder git first on it.
  const bin = tmp('bin'), mark = join(bin, 'git-calls');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${mark}'\nexit 1\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = bin + (saved ? ':' + saved : '');
  try {
    assert.equal(securityAgentGate(d, repoId(path)), null, 'before a full answer the id is not known');
    await securityAgentView(d);
    assert.ok(existsSync(mark), 'the full answer runs git (rev-parse, ls-files): the recorder works');
    rmSync(mark);
    const n = scans;
    const g = securityAgentGate(d, repoId(path));
    assert.equal(g?.gate.state, 'profile');
    assert.equal(existsSync(mark), false, 'the re-check spawned no git process');
    assert.equal(scans, n, 'and listed no repos');
    assert.equal(d.aws.calls.length, 0, 'and made no AWS call');
    assert.equal(securityAgentGate(d, 'ffffffffffffffff'), null);
    assert.equal(securityAgentGate(d, '../x'), null);
  } finally { process.env.PATH = saved; }
  const api = setupApi({ runner: runnerWith([]), cwd: home, repoPaths: async () => [], identity: { env: {}, home, repoRoot: null }, refresh: async () => ({}), securityAgent: d } as never);
  assert.equal(((await api.getApi['/api/security-agent/gate'](new URL('http://x/api/security-agent/gate?repo=' + repoId(path)))) as { gate: { state: string } }).gate.state, 'profile');
  assert.equal(((await api.getApi['/api/security-agent/gate'](new URL('http://x/api/security-agent/gate?repo=nope'))) as { status: number }).status, 404);
});

test('code review item: one item, branch first then whole repo; nothing new since the upstream disables the branch Start, the whole-repo Start keeps its guards', async () => {
  const p = await pagePayload();
  const scopeUrl = '/api/security-agent/scope?repo=' + p.repos[0].id;
  const empty = { branch: 'feat/receiver-tool-usage', base: { upstream: 'origin/feat/receiver-tool-usage', fromUpstream: true, commit: 'd0975a99cf85' }, empty: true, dirty: 3 };
  const running = { run_id: 'run-r1', job_id: 'job-r1', started_at: '2026-11-15T11:40:00Z', commit: 'aaaaaaaaaaaa', branch: 'main' };
  const page = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, GOOD, 0, true, gate('ready'), { running, reviewed: null }), [scopeUrl]: { repo: p.repos[0].id, scope: empty } });
  await page.settle();
  const sec = page.dom.byId.security;
  const item = sec.all().find((e) => e.getAttribute('data-branch-review'))!;
  assert.equal(item.getAttribute('data-branch-review'), 'blocked');
  assert.match(item.textContent, /Nothing new on feat\/receiver-tool-usage since origin\/feat\/receiver-tool-usage; a branch review would have nothing to check\./);
  assert.match(item.textContent, /The branch review diffs against the upstream, origin\/feat\/receiver-tool-usage\./);
  assert.equal(item.querySelectorAll('b')[0].textContent, 'Code review');
  assert.deepEqual(item.querySelectorAll('button').map((b) => b.textContent), ['Review this branch', 'Review the whole repo'], 'two choices, branch first');
  // The whole-repo review is no longer its own item in the Start card.
  assert.doesNotMatch(sec.textContent, /Code review of the whole repo|Code review of this branch|Start full review/);
  assert.equal(btn(sec, 'Review the whole repo instead'), undefined, 'the drawer keeps that offer; the card has the item\'s own button');
  assert.equal(sec.all().filter((e) => e.getAttribute('data-branch-review')).length, 1);
  assert.match(item.textContent, /3 uncommitted changes here will not be reviewed: commit them first\./);
  const start = item.querySelectorAll('button').find((b) => b.textContent === 'Review this branch')!;
  assert.ok(start.hasAttribute('disabled'), 'the branch Start is disabled');
  assert.equal(start.listeners.click, undefined);
  const full = item.querySelectorAll('button').find((b) => b.textContent === 'Review the whole repo')!;
  assert.ok(full.hasAttribute('data-full-start') && !full.hasAttribute('disabled'));
  full.listeners.click();
  const dlg = dialogOf(page);
  assert.match(dlg.textContent, /Start a code review of the whole repo/);
  assert.deepEqual(buttons(dlg).map((b) => b.textContent), ['Cancel', 'View it →', 'Start another anyway'], 'the running guard still applies to --full');

  // No upstream and no default branch: say so; the same offer.
  const none = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, GOOD), [scopeUrl]: { repo: p.repos[0].id, scope: { branch: 'spike', base: null, empty: false, dirty: 0 } } });
  await none.settle();
  const nt = none.dom.byId.security.textContent;
  assert.match(nt, /No upstream for spike and no default branch on the remote, so there is nothing to diff against\./);
  assert.match(nt, /Uncommitted changes are never reviewed\./);
  assert.ok(btn(none.dom.byId.security, 'Review this branch')!.hasAttribute('disabled'));
  assert.ok(btn(none.dom.byId.security, 'Review the whole repo')!.listeners.click);
  // No upstream, a default branch, new commits: the usual Start, and what it diffs against.
  const fb = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, GOOD), [scopeUrl]: { repo: p.repos[0].id, scope: { branch: 'spike', base: { upstream: 'origin/trunk', fromUpstream: false, commit: 'abc' }, empty: false, dirty: 0 } } });
  await fb.settle();
  assert.match(fb.dom.byId.security.textContent, /No upstream for spike: the branch review diffs against origin\/trunk, the remote's default branch\./);
  const s2 = btn(fb.dom.byId.security, 'Review this branch')!;
  assert.ok(!s2.hasAttribute('disabled') && s2.listeners.click, 'something to review: the usual Start');
  assert.ok(btn(fb.dom.byId.security, 'Review the whole repo')!.listeners.click, 'both choices offered');
  // The check unknown (it failed): the usual Start; the CLI decides.
  const unknown = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, GOOD) });
  await unknown.settle();
  assert.ok(btn(unknown.dom.byId.security, 'Review this branch')!.listeners.click);
});

test('pentest picker: tracked Dockerfiles as radios, pentest.json preselected; a pick or a typed path re-checks and the commands follow; errors inline', async () => {
  const p = await pagePayload();
  const id = p.repos[0].id;
  const cmd = (flags: string, dry = false) => `cd ~/demo-shop && prism-cli security pentest${dry ? ' --dry-run' : ''} ${flags} --profile demo --region us-west-2`;
  const okCheck = (flags: string) => ({ repo: id, ok: true, errors: {}, resolved: null, copy: { pentestDryRun: cmd(flags, true), pentest: cmd(flags) } });
  const CFG = '--app-dir sample-app --dockerfile sample-app/Dockerfile --port 3000 --health-path /healthz';
  const listing = {
    repo: id, dockerfiles: [{ path: 'Dockerfile', fromConfig: false }, { path: 'sample-app/Dockerfile', fromConfig: true }], truncated: false, max: 50, listError: null,
    config: { ok: true, path: 'sample-app', dockerfile: 'sample-app/Dockerfile', port: 3000, healthPath: '/healthz' }, defaults: { port: 8080, healthPath: '/health' }, port: '3000', healthPath: '/healthz',
    preselect: { dockerfile: 'sample-app/Dockerfile', appDir: 'sample-app', port: '3000', healthPath: '/healthz', from: 'pentest.json' }, check: okCheck(CFG),
  };
  const q = (o: Record<string, string>) => '/api/security-agent/pentest/check?' + new URLSearchParams({ repo: id, ...o }).toString();
  const ROOT = '--app-dir . --dockerfile Dockerfile --port 3000 --health-path /healthz';
  const page = await runPage([p], '#security', SETUP, {
    '/api/security-agent': saAnswer(p, GOOD), ['/api/security-agent/pentest?repo=' + id]: listing,
    [q({ dockerfile: 'Dockerfile', port: '3000', health_path: '/healthz' })]: okCheck(ROOT),
    [q({ dockerfile: '../x', port: '3000', health_path: '/healthz' })]: { repo: id, ok: false, errors: { dockerfile: 'the path must stay inside the repo (no ..)' }, resolved: null, copy: null },
  });
  await page.settle();
  const sec = page.dom.byId.security;
  const radios = () => sec.querySelectorAll('input').filter((i) => i.getAttribute('type') === 'radio');
  const pres = () => sec.querySelectorAll('code').map((x) => x.textContent).filter((t) => /^cd .*security pentest(?! --status)/.test(t));
  assert.deepEqual(radios().map((r) => r.getAttribute('value')), ['Dockerfile', 'sample-app/Dockerfile', '__other__']);
  assert.deepEqual(radios().map((r) => !!(r as unknown as { checked: boolean }).checked), [false, true, false], 'pentest.json\'s Dockerfile is preselected');
  assert.match(sec.textContent, /sample-app\/Dockerfilefrom \.prism\/pentest\.json/);
  assert.match(sec.textContent, /Other folder…/);
  const field = (k: string) => sec.querySelectorAll('input').find((i) => i.getAttribute('id') === `sa-pt-${k}-${id}`)!;
  assert.deepEqual(['dir', 'port', 'health'].map((k) => field(k).value), ['sample-app', '3000', '/healthz']);
  assert.match(sec.textContent, /Asked each time: nothing here is saved to the repo or to \.prism\/pentest\.json/);
  assert.deepEqual(pres(), [cmd(CFG, true), cmd(CFG)]);
  assert.ok(!sec.querySelectorAll('button').some((b) => b.textContent === 'Run' && /pentest/.test(b.parent?.textContent || '')), 'no Run for a pentest');
  assert.match(sec.textContent, /Pentest status/, 'the status item stays');

  // Pick ./Dockerfile: the build folder follows it, and the commands come back with its flags.
  const root = radios()[0] as unknown as { checked: boolean; listeners: Record<string, () => void> };
  root.checked = true; root.listeners.change();
  assert.match(sec.textContent, /checking…/, 'no stale command to copy while it checks');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(field('dir').value, '.');
  assert.deepEqual(pres(), [cmd(ROOT, true), cmd(ROOT)]);
  assert.ok(page.requests.some((x) => x.url === q({ dockerfile: 'Dockerfile', port: '3000', health_path: '/healthz' })));

  // Other folder…, then a path outside the repo: the reason inline, Copy disabled, no command.
  const other = radios()[2] as unknown as { checked: boolean; listeners: Record<string, () => void> };
  other.checked = true; other.listeners.change();
  const box = sec.querySelectorAll('input').find((i) => i.getAttribute('id') === `sa-pt-other-${id}`)!;
  assert.equal(box.disabled, false);
  box.value = '../x'; box.listeners.input();
  await new Promise((r) => setTimeout(r, 400));
  assert.match(sec.textContent, /the path must stay inside the repo \(no \.\.\)/);
  assert.match(sec.textContent, /fix the choice above/);
  assert.deepEqual(pres(), []);
  // The choice is page memory: a redraw (another repo and back) keeps it.
  page.go('#security/' + p.repos[1].id); page.go('#security/' + id); await page.settle();
  const again = sec.querySelectorAll('input').find((i) => i.getAttribute('id') === `sa-pt-other-${id}`)!;
  assert.equal(again.value, '../x');
  assert.equal(page.requests.filter((x) => x.url === '/api/security-agent/pentest?repo=' + id).length, 1, 'listed once per page load');
  assert.ok(!page.requests.some((x) => x.method === 'POST' && /pentest/.test(x.url)), 'nothing is written');
});

test('pentest picker: a listing that fails keeps the plain copy-only commands; a bad pentest.json is named; the snapshot has no picker', async () => {
  const p = await pagePayload();
  const page = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, GOOD) });
  await page.settle();
  const t = page.dom.byId.security.textContent;
  assert.match(t, /The Dockerfile picker could not load/);
  assert.match(t, /Pentest plan/);
  const id = p.repos[0].id;
  const bad = await runPage([p], '#security', SETUP, { '/api/security-agent': saAnswer(p, GOOD), ['/api/security-agent/pentest?repo=' + id]: {
    repo: id, dockerfiles: [], truncated: false, max: 50, listError: null, config: { ok: false, error: '.prism/pentest.json is not valid JSON: Unexpected end of JSON input' },
    defaults: { port: 8080, healthPath: '/health' }, port: '8080', healthPath: '/health', preselect: null, check: null } });
  await bad.settle();
  const bt = bad.dom.byId.security.textContent;
  assert.match(bt, /\.prism\/pentest\.json has a problem, so its values are not used here: \.prism\/pentest\.json is not valid JSON/);
  assert.match(bt, /git tracks no Dockerfile in this repo/);
  assert.match(bt, /prism-cli default \(8080\)/);
  assert.match(bt, /choose a Dockerfile above/);
  // The static snapshot never draws the page's live parts; the picker returns its plain items first.
  const { renderPage } = await import('../src/dashboard/page.js');
  assert.match(renderPage('N'), /if \(SNAPSHOT\) return plain\(\);\s*saPtLoad\(repo\);/);
});
