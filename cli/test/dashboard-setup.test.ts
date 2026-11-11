/**
 * The dashboard Setup page: the action endpoint's gates, the fixed argv per
 * action, the AWS identity section and Check now, and the theme toggle.
 * Fakes only: spawn is faked (nothing is installed or run), AWS calls are a
 * stub function, and HOME is a temp dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { startServer, cookieName, BIND_HOST } from '../src/dashboard/server.js';
import { ActionRunner, ACTIONS, actionLogPath, collectorUrlError, redact, repoId, type ActionId, type SpawnFn } from '../src/dashboard/actions.js';
import { setupApi } from '../src/dashboard/setup-api.js';
import { checkNow, classifyProfile, iniKeys, resolveAwsIdentity, STATIC_DEFAULT_WARNING, NO_CREDENTIALS_WARNING } from '../src/dashboard/aws-identity.js';
import { readConnectionFile, writeConnectionFile, loadConnection } from '../src/aws/connection.js';
import { renderPage } from '../src/dashboard/page.js';
import { THEME_BOOT, THEME_SCRIPT } from '../src/dashboard/setup-page.js';
import type { AwsResult } from '../src/utils/aws.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `prism-setup-${p}-`));

// ---------------------------------------------------------------- fakes

interface Spawned { file: string; args: string[]; opts: any; child: FakeChild }
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  kill(sig: string) { this.killed.push(sig); if (sig === 'SIGTERM') setImmediate(() => this.emit('close', null)); return true; }
}
function fakeSpawn(calls: Spawned[], auto = true): SpawnFn {
  return ((file: string, args: string[], opts: any) => {
    const child = new FakeChild();
    calls.push({ file, args, opts, child });
    if (auto) setImmediate(() => { child.stdout.emit('data', Buffer.from('done AKIAABCDEFGHIJKLMNOP\n')); child.emit('close', 0); });
    return child as any;
  }) as SpawnFn;
}

const REPO_A = '/work/repo-a';
const REPOS = [{ id: repoId(REPO_A), name: 'repo-a', path: REPO_A }];

function runner(calls: Spawned[], over: Partial<ConstructorParameters<typeof ActionRunner>[0]> = {}) {
  return new ActionRunner({
    execPath: '/usr/bin/node', entry: '/opt/prism/dist/bin/prism-cli.js', cwd: '/work', home: tmp('home'),
    repos: async () => REPOS, systemdAvailable: () => true, platform: 'linux', spawn: fakeSpawn(calls), ...over,
  });
}

const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); };

// ---------------------------------------------------------------- server gates

interface Resp { status: number; body: string; headers: Record<string, any> }
function call(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = request({ host: BIND_HOST, port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: b, headers: res.headers }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function withSetupServer(fn: (h: {
  port: number; post: (body: unknown, extra?: Record<string, string | null>) => Promise<Resp>; calls: Spawned[]; cookie: string; csrf: string;
}) => Promise<void>, auto = true) {
  const calls: Spawned[] = [];
  const r = runner(calls, { spawn: fakeSpawn(calls, auto) });
  const home = tmp('srvhome');
  const api = setupApi({
    runner: r, cwd: '/work', repoPaths: async () => [REPO_A], refresh: async () => ({}),
    identity: { env: {}, home, repoRoot: null, readText: () => null },
    checkAws: () => ({ ok: false, json: null, errorCode: '', raw: 'unused' }),
  });
  const srv = await startServer({ getPayload: async () => ({}), ...api });
  const cookie = `${cookieName(srv.port)}=${srv.token}`;
  const post = (body: unknown, extra: Record<string, string | null> = {}) => {
    const h: Record<string, string> = { Cookie: cookie, Origin: `http://127.0.0.1:${srv.port}`, 'X-Prism-CSRF': srv.csrf, 'Content-Type': 'application/json' };
    for (const [k, v] of Object.entries(extra)) { if (v === null) delete h[k]; else h[k] = v; }
    return call(srv.port, 'POST', '/api/action', h, typeof body === 'string' ? body : JSON.stringify(body));
  };
  try { await fn({ port: srv.port, post, calls, cookie, csrf: srv.csrf }); } finally { await srv.close(); }
}

test('action endpoint: rejects no cookie, no or wrong CSRF, foreign or missing Origin, GET and non-JSON', async () => {
  await withSetupServer(async ({ port, post, calls, cookie }) => {
    const ok = { action: 'codeburn-status' };
    assert.equal((await post(ok, { Cookie: null })).status, 401, 'no cookie');
    assert.equal((await post(ok, { Cookie: `${cookieName(port)}=nope` })).status, 401, 'wrong cookie');
    assert.equal((await post(ok, { 'X-Prism-CSRF': null })).status, 403, 'no CSRF header');
    assert.equal((await post(ok, { 'X-Prism-CSRF': 'x'.repeat(43) })).status, 403, 'wrong CSRF');
    assert.equal((await post(ok, { Origin: 'http://evil.example.com' })).status, 403, 'foreign Origin');
    assert.equal((await post(ok, { Origin: 'null' })).status, 403, 'opaque Origin');
    assert.equal((await post(ok, { Origin: `http://127.0.0.1:${port + 1}` })).status, 403, 'other port');
    assert.equal((await post(ok, { Origin: null })).status, 403, 'no Origin and no Referer');
    assert.equal((await post(ok, { Origin: null, Referer: 'http://evil.example.com/' })).status, 403, 'foreign Referer');
    assert.equal((await post(ok, { 'Content-Type': 'text/plain' })).status, 415, 'text/plain');
    assert.equal((await post(ok, { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415, 'form');
    assert.equal((await post('{nope', {})).status, 400, 'bad JSON');
    assert.equal((await post('x'.repeat(20_000), {})).status, 413, 'body too large');
    const get = await call(port, 'GET', '/api/action', { Cookie: cookie });
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, 'POST');
    assert.equal(calls.length, 0, 'nothing ran');
    // A same-origin Referer stands in for a missing Origin.
    assert.equal((await post(ok, { Origin: null, Referer: `http://localhost:${port}/` })).status, 202);
    await until(() => calls.length === 1);
    assert.equal(calls.length, 1);
  });
});

test('action endpoint: rejects unknown actions, extra fields, repos outside the scan list and bad URLs', async () => {
  await withSetupServer(async ({ post, calls }) => {
    const bad = async (body: unknown, re: RegExp) => {
      const r = await post(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(JSON.parse(r.body).error, re);
    };
    await bad({ action: 'rm-rf' }, /unknown action/);
    await bad({ action: '__proto__' }, /unknown action/);
    await bad({ action: 'constructor' }, /unknown action/);
    await bad([], /JSON object/);
    await bad({ action: 'codeburn-status', args: ['--yes'] }, /unexpected field args/);
    await bad({ action: 'codewatch-repo' }, /repo must be an id/);
    await bad({ action: 'codewatch-repo', repo: REPO_A }, /repo must be an id/);
    await bad({ action: 'codewatch-repo', repo: '../../etc' }, /repo must be an id/);
    await bad({ action: 'codewatch-repo', repo: repoId('/somewhere/else') }, /not in the scan list/);
    await bad({ action: 'codewatch-global', repo: repoId(REPO_A) }, /does not take a repo/);
    for (const url of ['http://collector.example.com/', 'https://user:pw@collector.example.com/', 'https://user@collector.example.com/', 'javascript:alert(1)',
      'file:///etc/passwd', 'https://', 'https:// space.example.com', 'https://collector.example.com/\n--yes', `https://a.example.com/${'x'.repeat(2048)}`, '']) {
      await bad({ action: 'codeburn-team', url }, /collector URL/);
    }
    await bad({ action: 'codeburn-team', url: 42 }, /collector URL/);
    await bad({ action: 'codeburn-local', url: 'https://collector.example.com/' }, /does not take a URL/);
    await bad({ action: 'codeburn-remove' }, /confirm: true/);
    await bad({ action: 'codeburn-remove', confirm: 'yes' }, /confirm: true/);
    assert.equal(calls.length, 0, 'nothing ran');
  });
});

test('action endpoint: one action at a time', async () => {
  await withSetupServer(async ({ post, calls, port, cookie }) => {
    assert.equal((await post({ action: 'codeburn-status' })).status, 202);
    const second = await post({ action: 'codewatch-global' });
    assert.equal(second.status, 409);
    assert.match(JSON.parse(second.body).error, /another action is running/);
    assert.equal(calls.length, 1);
    const st = JSON.parse((await call(port, 'GET', '/api/action/status', { Cookie: cookie })).body);
    assert.equal(st.state, 'running');
    assert.equal(st.command, 'prism-cli enable codeburn --status');
    calls[0].child.stdout.emit('data', Buffer.from('aws_secret_access_key = abc123SECRET\n'));
    calls[0].child.emit('close', 0);
    const done = JSON.parse((await call(port, 'GET', '/api/action/status', { Cookie: cookie })).body);
    assert.equal(done.state, 'done');
    assert.equal(done.exitCode, 0);
    assert.ok(!done.output.includes('abc123SECRET'), 'output is redacted');
    assert.equal((await post({ action: 'codewatch-global' })).status, 202, 'free again');
  }, false);
});

test('the page embeds the CSRF token; GET routes stay GET-only', async () => {
  await withSetupServer(async ({ port, cookie, csrf }) => {
    const page = await call(port, 'GET', '/', { Cookie: cookie });
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(`<meta name="prism-csrf" content="${csrf}">`));
    const setup = await call(port, 'GET', '/api/setup', { Cookie: cookie });
    assert.equal(setup.status, 200);
    const j = JSON.parse(setup.body);
    assert.deepEqual(j.repoIds, { [REPO_A]: repoId(REPO_A) });
    assert.equal(j.repoCd[REPO_A], `cd ${REPO_A}`);
    assert.deepEqual(j.actions.map((a: any) => a.id).sort(), Object.keys(ACTIONS).sort());
    assert.equal((await call(port, 'POST', '/api/setup', { Cookie: cookie })).status, 405);
    assert.equal((await call(port, 'GET', '/api/setup', {})).status, 401);
  });
  assert.throws(() => renderPage('N', '"><script>'), /bad CSRF token/);
});

// ---------------------------------------------------------------- argv

test('each allowed action spawns the CLI binary with a fixed argv and shell:false', async () => {
  const expected: Record<ActionId, { args: string[]; cwd: string; body?: Record<string, unknown> }> = {
    'codewatch-repo': { args: ['enable', 'codewatch'], cwd: REPO_A, body: { repo: repoId(REPO_A) } },
    'codewatch-global': { args: ['enable', 'codewatch', '--global'], cwd: '/work' },
    'codeburn-local': { args: ['enable', 'codeburn', '--local'], cwd: '/work' },
    'codeburn-systemd': { args: ['enable', 'codeburn', '--schedule', 'systemd'], cwd: '/work' },
    'codeburn-team': { args: ['enable', 'codeburn', '--url', 'https://collector.example.com/otel?x=1'], cwd: '/work', body: { url: 'https://collector.example.com/otel?x=1' } },
    'codeburn-remove': { args: ['enable', 'codeburn', '--remove'], cwd: '/work', body: { confirm: true } },
    'codeburn-status': { args: ['enable', 'codeburn', '--status'], cwd: '/work' },
    'aws-check': { args: ['aws', 'check'], cwd: '/work' },
    'team-info': { args: ['team', 'info'], cwd: '/work' },
  };
  for (const [id, e] of Object.entries(expected) as [ActionId, typeof expected[ActionId]][]) {
    const calls: Spawned[] = [];
    const r = runner(calls);
    const res = await r.start({ action: id, ...e.body });
    assert.equal(res.status, 202, id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, '/usr/bin/node', id);
    assert.deepEqual(calls[0].args, ['/opt/prism/dist/bin/prism-cli.js', ...e.args], id);
    assert.equal(calls[0].opts.shell, false, id);
    assert.equal(calls[0].opts.cwd, e.cwd, id);
    assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe'], `${id}: stdin closed`);
    await until(() => !r.running);
  }
  // No AWS-writing command is in the allowlist.
  for (const a of Object.values(ACTIONS)) {
    assert.ok(!/^(security|team add-developer|enable security|aws connect)/.test(a.args.join(' ')), a.args.join(' '));
  }
});

test('systemd action is refused where systemctl --user is not available', async () => {
  const calls: Spawned[] = [];
  assert.equal((await runner(calls, { systemdAvailable: () => false }).start({ action: 'codeburn-systemd' })).status, 400);
  assert.equal((await runner(calls, { platform: 'darwin' }).start({ action: 'codeburn-systemd' })).status, 400);
  assert.equal(calls.length, 0);
});

test('each run is logged with time, action, repo name and exit code only', async () => {
  const calls: Spawned[] = [];
  const home = tmp('loghome');
  const r = runner(calls, { home });
  await r.start({ action: 'codeburn-team', url: 'https://collector.example.com/?token=SECRETTOKEN' });
  await until(() => !r.running);
  await r.start({ action: 'codewatch-repo', repo: repoId(REPO_A) });
  await until(() => !r.running);
  const lines = readFileSync(actionLogPath(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['action', 'exit', 'repo', 'time']);
  assert.deepEqual([lines[0].action, lines[0].repo, lines[0].exit], ['codeburn-team', null, 0]);
  assert.deepEqual([lines[1].action, lines[1].repo, lines[1].exit], ['codewatch-repo', 'repo-a', 0]);
  const raw = readFileSync(actionLogPath(home), 'utf8');
  assert.ok(!raw.includes('SECRETTOKEN') && !raw.includes('collector') && !raw.includes('done'), 'no URL and no output');
  assert.ok(!r.status().output!.includes('AKIAABCDEFGHIJKLMNOP'), 'key id redacted in output');
});

test('an action that runs past its timeout is stopped and reported', async () => {
  const calls: Spawned[] = [];
  const saved = ACTIONS['codeburn-status'].timeoutMs;
  (ACTIONS['codeburn-status'] as any).timeoutMs = 20;
  try {
    const r = runner(calls, { spawn: fakeSpawn(calls, false) });
    await r.start({ action: 'codeburn-status' });
    await until(() => !r.running);
    assert.deepEqual(calls[0].child.killed, ['SIGTERM']);
    const s = r.status();
    assert.equal(s.timedOut, true);
    assert.equal(s.exitCode, 124);
    assert.match(s.output!, /timed out/);
  } finally { (ACTIONS['codeburn-status'] as any).timeoutMs = saved; }
});

test('collector URL rule and redaction', () => {
  assert.equal(collectorUrlError('https://collector.example.com/v1'), null);
  assert.match(collectorUrlError('HTTP://collector.example.com')!, /https/);
  assert.match(collectorUrlError('https://a:b@x.example.com')!, /user name/);
  const out = redact('key AKIAABCDEFGHIJKLMNOP\naws_secret_access_key=wJalrXUtnFEMIabc\nAuthorization: Bearer abcdefghijkl\n'
    + 'https://user:pw@host.example.com/x?token=abc&ok=1 eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl \u001b[31mred\u001b[0m');
  for (const s of ['AKIAABCDEFGHIJKLMNOP', 'wJalrXUtnFEMIabc', 'abcdefghijkl', 'user:pw', 'token=abc', 'eyJhbGciOiJI', '\u001b']) assert.ok(!out.includes(s), s);
  assert.ok(out.includes('ok=1') && out.includes('red'));
});

// ---------------------------------------------------------------- AWS identity

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYSECRETVALUE';
function awsHome(config: string, creds: string | null) {
  const home = tmp('aws');
  mkdirSync(join(home, '.aws'), { recursive: true });
  writeFileSync(join(home, '.aws', 'config'), config);
  if (creds !== null) writeFileSync(join(home, '.aws', 'credentials'), creds);
  return home;
}

test('iniKeys keeps key names and the region only', () => {
  const k = iniKeys(`[default]\nregion = us-west-2\naws_secret_access_key = ${SECRET}\n[profile dev]\ncredential_process = /bin/get-creds --secret ${SECRET}\ns3 =\n  max_concurrent_requests = 5\n[sso-session corp]\nsso_start_url = https://example.com\n`, 'config');
  assert.deepEqual([...k.keys()], ['default', 'dev']);
  assert.equal(k.get('default')!.region, 'us-west-2');
  assert.deepEqual([...k.get('dev')!.keys], ['credential_process', 's3']);
  assert.ok(!JSON.stringify([...k.entries()].map(([n, v]) => [n, [...v.keys], v.region])).includes('SECRET'));
});

test('credential types are classified from key names, in the AWS CLI order', () => {
  const config = iniKeys('[profile cp]\ncredential_process = x\n[profile sso]\nsso_session = corp\nsso_account_id = 1\n[profile both]\ncredential_process = x\n[profile role]\nrole_arn = arn\nsource_profile = cp\n', 'config');
  const creds = iniKeys('[both]\naws_access_key_id = A\naws_secret_access_key = B\n[keys]\naws_access_key_id = A\n', 'credentials');
  assert.deepEqual(classifyProfile('cp', config, creds), { type: 'credential_process', shadowed: [] });
  assert.equal(classifyProfile('sso', config, creds).type, 'sso');
  assert.deepEqual(classifyProfile('both', config, creds), { type: 'static-credentials-file', shadowed: ['credential_process'] });
  assert.equal(classifyProfile('keys', config, creds).type, 'static-credentials-file');
  assert.equal(classifyProfile('role', config, creds).type, 'assume-role');
  assert.equal(classifyProfile('missing', config, creds).type, 'none');
});

test('AWS section: static keys in [default] win over credential_process, with a warning; no secret is returned', () => {
  const home = awsHome('[default]\nregion = us-west-2\ncredential_process = /bin/get-creds\n', `[default]\naws_access_key_id = AKIAABCDEFGHIJKLMNOP\naws_secret_access_key = ${SECRET}\n`);
  const v = resolveAwsIdentity({ env: {}, home, repoRoot: null });
  assert.equal(v.profile, 'default');
  assert.equal(v.source, 'default chain');
  assert.equal(v.credentialType, 'static-credentials-file');
  assert.deepEqual(v.region, { value: 'us-west-2', source: 'region configured for the default profile' });
  assert.ok(v.warnings.includes(STATIC_DEFAULT_WARNING));
  assert.deepEqual(v.steps.map((s) => [s.id, s.state]), [['flags', 'n/a'], ['env', 'not-set'], ['repo', 'not-set'], ['user', 'not-set'], ['default', 'used']]);
  const json = JSON.stringify(v);
  assert.ok(!json.includes(SECRET) && !json.includes('AKIAABCDEFGHIJKLMNOP') && !json.includes('/bin/get-creds'), 'only key names are used');
  assert.ok(!json.includes(home), 'paths shown with ~');
});

test('AWS section: env, saved aws connect profile (repo over user) and no credentials', () => {
  const home = awsHome('[profile work]\nsso_session = corp\nregion = eu-west-1\n[profile cp]\ncredential_process = x\n', null);
  const env1 = resolveAwsIdentity({ env: { AWS_ACCESS_KEY_ID: 'AKIAABCDEFGHIJKLMNOP', AWS_PROFILE: 'work' }, home, repoRoot: null });
  assert.equal(env1.credentialType, 'env');
  assert.equal(env1.profile, null);
  const env2 = resolveAwsIdentity({ env: { AWS_PROFILE: 'work' }, home, repoRoot: null });
  assert.deepEqual([env2.profile, env2.source, env2.credentialType, env2.region?.value], ['work', 'AWS_PROFILE', 'sso', 'eu-west-1']);

  writeConnectionFile(join(home, '.prism', 'aws.json'), { profile: 'cp', region: 'us-east-2', account: '111122223333', alias: 'sandbox', verifiedAt: '2026-11-01T00:00:00.000Z' });
  const user = resolveAwsIdentity({ env: {}, home, repoRoot: null });
  assert.deepEqual([user.profile, user.source, user.credentialType, user.region?.value], ['cp', 'aws connect, user', 'credential_process', 'us-east-2']);
  assert.deepEqual({ ...user.saved, path: '' }, { scope: 'user', path: '', profile: 'cp', region: 'us-east-2', account: '111122223333', alias: 'sandbox', verifiedAt: '2026-11-01T00:00:00.000Z', inUse: true });
  assert.equal(user.saved!.path, '~/.prism/aws.json');

  const repo = tmp('repo');
  writeConnectionFile(join(repo, '.prism', 'aws.local.json'), { profile: 'work', region: 'eu-west-1', account: '444455556666', alias: null, verifiedAt: '' });
  const r = resolveAwsIdentity({ env: {}, home, repoRoot: repo });
  assert.deepEqual([r.profile, r.source], ['work', 'aws connect, repo']);
  assert.deepEqual(r.steps.map((s) => s.state), ['n/a', 'not-set', 'used', 'not-set', 'not-set']);

  const shadowed = resolveAwsIdentity({ env: { AWS_PROFILE: 'work' }, home, repoRoot: null });
  assert.ok(shadowed.warnings.some((w) => /saved aws connect profile cp is not used/.test(w)));

  const none = resolveAwsIdentity({ env: {}, home: tmp('empty'), repoRoot: null });
  assert.equal(none.credentialType, 'none');
  assert.ok(none.warnings.includes(NO_CREDENTIALS_WARNING));
});

// ---------------------------------------------------------------- Check now

function checkSetup(account: string | null, error?: string) {
  const home = awsHome('[profile cp]\ncredential_process = x\nregion = us-east-2\n', null);
  const path = join(home, '.prism', 'aws.json');
  writeConnectionFile(path, { profile: 'cp', region: 'us-east-2', account: '111122223333', alias: null, verifiedAt: '2026-11-01T00:00:00.000Z' });
  const calls: [string[], string, string][] = [];
  const awsFn = (args: string[], profile: string, region: string): AwsResult => {
    calls.push([args, profile, region]);
    return error ? { ok: false, json: null, errorCode: error, raw: '' } : { ok: true, json: { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/Dev/me` }, errorCode: '', raw: '' };
  };
  const identity = resolveAwsIdentity({ env: {}, home, repoRoot: null });
  const run = () => checkNow({ identity, saved: loadConnection(home, null), aws: awsFn, now: () => new Date('2026-11-11T10:00:00.000Z'), redact });
  return { run, calls, path };
}

test('Check now: success and match updates the saved verified time', () => {
  const t = checkSetup('111122223333');
  const r = t.run();
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual([r.account, r.matches, r.updated, r.region], ['111122223333', true, true, 'us-east-2']);
  assert.deepEqual(t.calls, [[['sts', 'get-caller-identity'], 'cp', 'us-east-2']], 'one read-only call');
  assert.equal(readConnectionFile(t.path)!.verifiedAt, '2026-11-11T10:00:00.000Z');
  assert.match(r.note, /updated the verified time in ~\/\.prism\/aws\.json/);
});

test('Check now: a different account is reported and the saved file is not changed', () => {
  const t = checkSetup('999988887777');
  const r = t.run();
  assert.ok(r.ok && r.matches === false && !r.updated);
  if (r.ok) assert.match(r.note, /Does not match the saved account 111122223333/);
  assert.equal(readConnectionFile(t.path)!.verifiedAt, '2026-11-01T00:00:00.000Z');
});

test('Check now: expired credentials give a clear message and fixes', () => {
  const t = checkSetup(null, 'ExpiredTokenException');
  const r = t.run();
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.expired, true);
  assert.equal(r.error, 'ExpiredTokenException');
  assert.ok(r.fixes.some((f) => /credential_process/.test(f)));
  assert.ok(r.fixes.includes('prism-cli aws connect'));
  assert.equal(readConnectionFile(t.path)!.verifiedAt, '2026-11-01T00:00:00.000Z');
});

test('Check now goes through the POST gates and the action lock', async () => {
  const calls: Spawned[] = [];
  const r = runner(calls, { spawn: fakeSpawn(calls, false) });
  let awsCalls = 0;
  const api = setupApi({
    runner: r, cwd: '/work', repoPaths: async () => [], refresh: async () => ({}),
    identity: { env: {}, home: tmp('cn'), repoRoot: null, readText: () => null },
    checkAws: () => { awsCalls++; return { ok: true, json: { Account: '111122223333', Arn: 'arn:aws:iam::111122223333:user/me' }, errorCode: '', raw: '' }; },
  });
  const srv = await startServer({ getPayload: async () => ({}), ...api });
  try {
    const h = { Cookie: `${cookieName(srv.port)}=${srv.token}`, Origin: `http://127.0.0.1:${srv.port}`, 'X-Prism-CSRF': srv.csrf, 'Content-Type': 'application/json' };
    assert.equal((await call(srv.port, 'POST', '/api/check-now', { ...h, 'X-Prism-CSRF': '' }, '{}')).status, 403);
    assert.equal((await call(srv.port, 'GET', '/api/check-now', { Cookie: h.Cookie })).status, 405);
    assert.equal((await call(srv.port, 'POST', '/api/check-now', h, '{"profile":"x"}')).status, 400, 'no inputs');
    const ok = await call(srv.port, 'POST', '/api/check-now', h, '{}');
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).account, '111122223333');
    await r.start({ action: 'codeburn-status' });
    assert.equal((await call(srv.port, 'POST', '/api/check-now', h, '{}')).status, 409, 'locked while an action runs');
    assert.equal(awsCalls, 1);
    calls[0].child.emit('close', 0);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- theme

function fakeDom(stored: Record<string, string>) {
  const attrs = new Map<string, string>();
  const buttons = ['light', 'dark', 'system'].map((t) => {
    const a = new Map<string, string>([['data-theme-set', t]]);
    const handlers: (() => void)[] = [];
    return { getAttribute: (k: string) => a.get(k) ?? null, setAttribute: (k: string, v: string) => a.set(k, v), addEventListener: (_: string, f: () => void) => handlers.push(f), click: () => handlers.forEach((f) => f()), a };
  });
  const document = {
    documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k), getAttribute: (k: string) => attrs.get(k) ?? null },
    querySelectorAll: () => buttons,
  };
  const localStorage = { getItem: (k: string) => stored[k] ?? null, setItem: (k: string, v: string) => { stored[k] = v; }, removeItem: (k: string) => { delete stored[k]; } };
  return { ctx: vm.createContext({ document, localStorage }), attrs, buttons };
}

test('theme toggle: saved in localStorage, applied before first paint, System follows the OS', () => {
  const stored: Record<string, string> = {};
  const page = fakeDom(stored);
  vm.runInContext(THEME_BOOT, page.ctx);
  assert.equal(page.attrs.get('data-theme'), undefined, 'nothing saved: no data-theme');
  vm.runInContext(THEME_SCRIPT, page.ctx);
  assert.equal(page.buttons[2].a.get('aria-pressed'), 'true', 'System pressed by default');
  page.buttons[1].click();
  assert.equal(stored['prism-theme'], 'dark');
  assert.equal(page.attrs.get('data-theme'), 'dark');
  assert.equal(page.buttons[1].a.get('aria-pressed'), 'true');

  // Next load: the head script applies the saved choice before the body renders.
  const next = fakeDom(stored);
  vm.runInContext(THEME_BOOT, next.ctx);
  assert.equal(next.attrs.get('data-theme'), 'dark');
  vm.runInContext(THEME_SCRIPT, next.ctx);
  next.buttons[0].click();
  assert.equal(stored['prism-theme'], 'light');
  assert.equal(next.attrs.get('data-theme'), 'light');
  next.buttons[2].click();
  assert.equal(stored['prism-theme'], undefined, 'System clears the saved choice');
  assert.equal(next.attrs.get('data-theme'), undefined);

  stored['prism-theme'] = '"><x';
  const junk = fakeDom(stored);
  vm.runInContext(THEME_BOOT, junk.ctx);
  assert.equal(junk.attrs.get('data-theme'), undefined, 'unknown values are ignored');
});

test('page: theme boot script runs in <head>, dark tokens apply for Dark and for System on a dark OS', () => {
  const html = renderPage('N', 'tok');
  assert.ok(html.indexOf(THEME_BOOT) < html.indexOf('<style'), 'boot script before the stylesheet');
  assert.match(html, /@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{ color-scheme: dark; --bg:#0d1117;/);
  assert.match(html, /:root\[data-theme="dark"\] \{ color-scheme: dark; --bg:#0d1117;/);
  assert.match(html, /data-theme-set="light">Light<\/button><button type="button" data-theme-set="dark">Dark<\/button><button type="button" data-theme-set="system">System/);
  for (const s of [...html.matchAll(/<script nonce="N">([\s\S]*?)<\/script>/g)].map((m) => m[1])) new vm.Script(s);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(html));
});
