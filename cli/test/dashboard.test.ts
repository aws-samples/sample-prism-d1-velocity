/**
 * Tests for `prism-cli dashboard`: collectors against fixture directories,
 * server access control (token, cookie, Host, method, loopback bind), and the
 * --json payload shape. No codeburn, AWS or network calls: codeburn output is
 * a recorded, anonymised export fed through the injectable exporter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectCodewatch, secretScanning } from '../src/dashboard/codewatch.js';
import { makeResult, REASON_GITLEAKS_MISSING, type PrismResult } from '../src/codewatch/results.js';
import { collectUsage, type CodeburnExport } from '../src/dashboard/usage.js';
import { machineChecks, repoChecks, gitleaksInstallHint } from '../src/dashboard/setup.js';
import { discoverRepos, scanForRepos } from '../src/dashboard/repos.js';
import { buildPayload, PAYLOAD_SCHEMA } from '../src/dashboard/payload.js';
import { startServer, cookieName, BIND_HOST } from '../src/dashboard/server.js';
import { renderPage } from '../src/dashboard/page.js';
import { installHooks } from '../src/codewatch/hooks.js';
import { parsePort } from '../src/commands/_top/dashboard.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dashboard');
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `prism-dash-${p}-`));

function exe(dir: string, name: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** A git repo (no global template hooks) with the fixture results copied in. */
function repoWithResults(): string {
  const dir = tmp('repo');
  git(dir, 'init', '-q', `--template=${tmp('tpl')}`);
  cpSync(join(FIX, 'results'), join(dir, '.prism', 'results'), { recursive: true });
  return dir;
}

const fixtureExporter: CodeburnExport = async (args) =>
  JSON.parse(readFileSync(join(FIX, args.includes('--from') ? 'codeburn-export-month.json' : 'codeburn-export.json'), 'utf8'));

// ---------------------------------------------------------------- codewatch collector

test('codewatch: latest run per branch, with the reviewer that ran it', () => {
  const cw = collectCodewatch(repoWithResults());
  assert.equal(cw.hasResults, true);
  assert.equal(cw.totalRuns, 8, 'garbage.json is ignored');
  const byBranch = Object.fromEntries(cw.latestByBranch.map((b) => [b.branch, b]));
  assert.equal(byBranch['main-work'].review?.tool, 'claude');
  assert.equal(byBranch['main-work'].review?.model, 'claude-sonnet-4-5');
  assert.equal(byBranch['main-work'].secrets?.status, 'skipped');
  assert.equal(byBranch['feature-x'].review?.status, 'error');
});

test('codewatch: findings come from the latest review only, sorted by severity', () => {
  const cw = collectCodewatch(repoWithResults());
  assert.deepEqual(cw.findings.map((f) => [f.severity, f.category, f.file, f.line, f.rule]), [
    ['high', 'security', 'src/lookup.ts', 4, 'Command injection'],
    ['low', 'quality', 'src/b.ts', 9, 'Magic numbers'],
  ]);
  assert.deepEqual(cw.bySeverity, { high: 1, medium: 0, low: 1 });
  assert.deepEqual(cw.byCategory, { quality: 1, security: 1 });
});

test('codewatch: gitleaks blocks exclude missing-gitleaks skips; --no-verify skips listed separately', () => {
  const cw = collectCodewatch(repoWithResults());
  assert.equal(cw.gitleaksBlocks.length, 1);
  assert.equal(cw.gitleaksBlocks[0].status, 'findings');
  assert.deepEqual(cw.skipped.map((s) => s.commit), ['c3c3c3c3c3c3c3c3']);
});

test('codewatch: trend is the last N non-skipped runs, oldest first', () => {
  const cw = collectCodewatch(repoWithResults(), 3);
  assert.deepEqual(cw.trend.map((t) => t.started_at), ['2026-11-01T12:00:00.000Z', '2026-11-02T12:00:00.000Z', '2026-11-03T09:00:00.000Z']);
});

test('codewatch: empty state when there are no results', () => {
  const cw = collectCodewatch(tmp('empty'));
  assert.equal(cw.hasResults, false);
  assert.deepEqual(cw.findings, []);
});

test('secret scanning banner: counts commits since the last real scan when gitleaks is missing', () => {
  const cw = collectCodewatch(repoWithResults(), 20, false);
  const ss = cw.secretScanning;
  assert.equal(ss.gitleaksAvailable, false);
  // aaa ran (ok), bbb ran (findings), then ccc and eee were committed without gitleaks
  assert.equal(ss.unscannedCommits, 2);
  assert.equal(ss.unscannedSince, '2026-11-01T11:30:00.000Z');
  assert.match(ss.banner || '', /^Secret scanning is off: gitleaks is not installed\. 2 commits since 2026-11-0[12] were not scanned\.$/);
  assert.equal(ss.installHint, gitleaksInstallHint());
  // gitleaks-missing skips are not reported again as --no-verify
  assert.ok(!cw.skipped.some((r) => r.reason === REASON_GITLEAKS_MISSING));
});

test('secret scanning banner: hidden when gitleaks is available; counts kept', () => {
  const ss = collectCodewatch(repoWithResults(), 20, true).secretScanning;
  assert.equal(ss.banner, null);
  assert.equal(ss.unscannedCommits, 2);
});

test('secret scanning banner: streak resets after a real scan; never-ran counts from the first', () => {
  const r = (t: string, status: PrismResult['status'], reason: string | null = null) =>
    makeResult({ kind: 'secrets', hook: 'pre-commit', tool: 'gitleaks', status, reason, started_at: t, finished_at: t });
  const missing = (t: string) => r(t, 'skipped', REASON_GITLEAKS_MISSING);
  assert.equal(secretScanning([missing('2026-01-01T00:00:00Z'), r('2026-01-02T00:00:00Z', 'ok')], false).unscannedCommits, 0);
  const once = secretScanning([missing('2026-01-05T12:00:00Z')], false);
  assert.equal(once.unscannedCommits, 1);
  assert.match(once.banner || '', /1 commit since 2026-01-0[56] was not scanned\./);
  const none = secretScanning([], false);
  assert.equal(none.banner, 'Secret scanning is off: gitleaks is not installed. No unscanned commits recorded yet.');
});

test('gitleaks install hint is per platform and never pipes curl into a shell', () => {
  assert.match(gitleaksInstallHint('darwin'), /^brew install gitleaks/);
  assert.match(gitleaksInstallHint('win32'), /^scoop install gitleaks/);
  assert.match(gitleaksInstallHint('linux'), /github\.com\/gitleaks\/gitleaks\/releases/);
  for (const p of ['darwin', 'win32', 'linux'] as const) assert.doesNotMatch(gitleaksInstallHint(p), /curl|\|\s*(ba|z)?sh/);
});

test('setup (machine): gitleaks row is a warning with the install hint', () => {
  const g = machineChecks({ pathEnv: tmp('nogl'), home: tmp('hg'), env: {}, scheduleExists: () => false }).find((i) => i.id === 'gitleaks');
  assert.equal(g?.status, 'warn');
  assert.equal(g?.fix, gitleaksInstallHint());
  assert.match(g?.detail || '', /secret scanning is off/);
});

// ---------------------------------------------------------------- usage collector

test('usage: today, this month, top models and projects from codeburn export', async () => {
  const u = await collectUsage({ exporter: fixtureExporter, now: new Date(2026, 10, 5, 12) });
  assert.equal(u.status, 'ok');
  assert.equal(u.currency, 'USD');
  assert.deepEqual(u.today, { cost: 14.46, calls: 65, sessions: 23 });
  assert.equal(u.month?.from, '2026-11-01');
  assert.equal(u.month?.to, '2026-11-05');
  assert.equal(u.month?.cost, 24.83);
  assert.ok(u.topModels.length >= 1 && u.topModels.length <= 5);
  assert.ok(u.topProjects.length <= 5);
  for (let i = 1; i < u.topProjects.length; i++) assert.ok(u.topProjects[i - 1].cost >= u.topProjects[i].cost);
  assert.equal(u.fullView, 'codeburn web');
  for (const p of u.topProjects) {
    assert.ok(!p.name.includes('/'), `folder name only: ${p.name}`);
    assert.ok(p.path.endsWith('/' + p.name), 'full path kept for the tooltip');
  }
});

test('usage: asks codeburn for this calendar month', async () => {
  const seen: string[][] = [];
  await collectUsage({ exporter: async (a) => { seen.push(a); return fixtureExporter(a); }, now: new Date(2026, 1, 9) });
  assert.deepEqual(seen.find((a) => a.includes('--from')), ['--from', '2026-02-01', '--to', '2026-02-09']);
});

test('usage: not-installed, error and no-data states', async () => {
  assert.equal((await collectUsage({ pathEnv: tmp('nopath') })).status, 'not-installed');
  assert.equal((await collectUsage({ exporter: async () => { throw new Error('boom'); } })).status, 'error');
  const empty = { schema: 'codeburn.export.v2', currency: { code: 'USD' }, summary: [{ Period: 'Today', 'Cost (USD)': 0, 'API Calls': 0, Sessions: 0 }], periods: [], projects: [] };
  assert.equal((await collectUsage({ exporter: async () => empty })).status, 'no-data');
  assert.equal((await collectUsage({ exporter: async () => ({ schema: 'other' }) })).status, 'error');
});

// ---------------------------------------------------------------- setup checklist

test('setup (machine): ok when tools, schedule, sync log and AWS profile are present', () => {
  const bin = tmp('bin');
  exe(bin, 'codeburn', 'echo 0.9.24');
  exe(bin, 'gitleaks', 'echo v8.28.0');
  const home = tmp('home');
  mkdirSync(join(home, '.prism', 'logs'), { recursive: true });
  writeFileSync(join(home, '.prism', 'logs', 'otel-sync.log'), 'pushed 12 records\n');
  const items = machineChecks({ pathEnv: bin, home, env: { AWS_PROFILE: 'dev' }, scheduleExists: () => true, schedulerName: () => 'crontab' });
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(items.map((i) => i.status), ['ok', 'ok', 'ok', 'ok']);
  assert.equal(by.codeburn.detail, '0.9.24');
  assert.match(by['codeburn-sync'].detail, /last sync log write/);
  assert.match(by['aws-credentials'].detail, /AWS_PROFILE is set \(dev\) \(not validated\)/);
  for (const i of items) assert.equal(i.fix, '', 'ok items carry no fix');
});

test('setup (machine): missing items each carry a one-line fix; AWS uses presence only', () => {
  const items = machineChecks({ pathEnv: tmp('none'), home: tmp('home2'), env: {}, scheduleExists: () => false, schedulerName: () => 'crontab' });
  assert.deepEqual(items.map((i) => i.status), ['missing', 'missing', 'warn', 'missing'], 'gitleaks absent is a warning, not missing');
  for (const i of items) { assert.ok(i.fix.length > 0); assert.ok(!i.fix.includes('\n')); }
  // an existing config file counts, without its contents being needed
  const home = tmp('home3');
  mkdirSync(join(home, '.aws'));
  writeFileSync(join(home, '.aws', 'config'), '');
  const aws = machineChecks({ pathEnv: tmp('none2'), home, env: {}, scheduleExists: () => false }).find((i) => i.id === 'aws-credentials');
  assert.equal(aws?.status, 'ok');
});

test('setup (repo): hooks, reviewer, CI workflow, OIDC and Security Agent evidence', () => {
  const dir = tmp('srepo');
  git(dir, 'init', '-q', `--template=${tmp('tpl2')}`);
  let by = Object.fromEntries(repoChecks(dir, { pathEnv: tmp('p0') }).map((i) => [i.id, i]));
  assert.equal(by['codewatch-hooks'].status, 'missing');
  assert.equal(by['codewatch-hooks'].fix, 'prism-cli enable codewatch');
  assert.equal(by['ci-eval'].status, 'missing');

  installHooks(join(dir, '.git', 'hooks'));
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'prism-eval-gate.yml'),
    'env:\n  METRICS_ROLE_ARN: ${{ secrets.PRISM_METRICS_ROLE_ARN }}\nsteps:\n  - run: aws securityagent list-findings\n');
  const bin = tmp('p1');
  exe(bin, 'claude', 'exit 0');
  by = Object.fromEntries(repoChecks(dir, { pathEnv: bin }).map((i) => [i.id, i]));
  assert.equal(by['codewatch-hooks'].status, 'ok');
  assert.match(by['codewatch-hooks'].detail, /reviewer claude/);
  assert.equal(by['ci-eval'].status, 'ok');
  assert.equal(by.oidc.status, 'warn', 'local evidence only: wired, not verified');
  assert.equal(by['security-agent'].status, 'warn');
});

test('setup (repo): hooks written before the codewatch rename are flagged', () => {
  const dir = tmp('orepo');
  git(dir, 'init', '-q', `--template=${tmp('tpl3')}`);
  exe(join(dir, '.git', 'hooks'), 'pre-commit', '# prism-cli enable security\nexec prism-cli git pre-commit');
  const hooks = repoChecks(dir, { pathEnv: tmp('p2') }).find((i) => i.id === 'codewatch-hooks');
  assert.equal(hooks?.status, 'warn');
});

// ---------------------------------------------------------------- repo discovery

test('discoverRepos: current repo by default; --all scans a root for .prism repos', () => {
  const root = tmp('root');
  const mk = (rel: string, prism: boolean) => {
    const d = join(root, rel);
    mkdirSync(join(d, '.git'), { recursive: true });
    if (prism) mkdirSync(join(d, '.prism'));
  };
  mk('a', true);
  mk('b', false);
  mk('group/c', true);
  mk('node_modules/d', true);
  mk('x/y/z/too-deep', true);
  assert.deepEqual(scanForRepos(root).map((r) => r.name), ['a', 'c']);

  const repo = repoWithResults();
  const one = discoverRepos({ cwd: repo });
  assert.equal(one.repos.length, 1);
  assert.equal(one.error, null);
  const all = discoverRepos({ cwd: repo, all: true, root });
  assert.equal(all.scannedRoot, root);
  assert.equal(all.repos.length, 2);
  assert.match(discoverRepos({ cwd: root }).error || '', /not inside a git repository/);
});

// ---------------------------------------------------------------- --json payload

test('--json payload shape', async () => {
  const repo = repoWithResults();
  const p = await buildPayload({ cwd: repo, exporter: fixtureExporter, pathEnv: tmp('p3'), machineDeps: { home: tmp('h4'), env: {}, scheduleExists: () => false } });
  assert.equal(p.schema, PAYLOAD_SCHEMA);
  assert.deepEqual(Object.keys(p).sort(), ['generated_at', 'machine', 'repos', 'schema', 'scope', 'security', 'usage']);
  assert.deepEqual(Object.keys(p.repos[0]).sort(), ['codewatch', 'name', 'path', 'setup']);
  assert.equal(p.repos[0].codewatch.hasResults, true);
  const ss = p.repos[0].codewatch.secretScanning;
  assert.deepEqual(Object.keys(ss).sort(), ['banner', 'gitleaksAvailable', 'installHint', 'unscannedCommits', 'unscannedSince']);
  assert.equal(ss.gitleaksAvailable, false, 'pathEnv has no gitleaks');
  assert.equal(ss.unscannedCommits, 2);
  assert.match(ss.banner || '', /Secret scanning is off/);
  assert.equal(p.usage.status, 'ok');
  assert.equal(p.security.status, 'coming-soon');
  assert.match(p.security.message, /coming with prism-cli security findings/i);
  assert.ok(p.machine.setup.every((i) => ['ok', 'warn', 'missing'].includes(i.status)));
  JSON.parse(JSON.stringify(p));
});

// ---------------------------------------------------------------- server

interface Resp { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = request({ host: BIND_HOST, port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn: (port: number, token: string) => Promise<void>, port = 0) {
  const srv = await startServer({ port, getPayload: async () => ({ ok: true, x: '<b>' }) });
  try { await fn(srv.port, srv.token); } finally { await srv.close(); }
}

test('server binds to 127.0.0.1 only, on a random port by default', async () => {
  await withServer(async (port) => {
    assert.ok(port > 0);
  });
  const srv = await startServer({ getPayload: async () => ({}) });
  try {
    const addr = srv.server.address() as { address: string; port: number };
    assert.equal(addr.address, '127.0.0.1');
    assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{43}$/);
  } finally { await srv.close(); }
});

test('server with --port still binds to loopback', async () => {
  const probe = await startServer({ getPayload: async () => ({}) });
  const free = probe.port;
  await probe.close();
  const srv = await startServer({ port: free, getPayload: async () => ({}) });
  try {
    assert.equal(srv.port, free);
    assert.equal((srv.server.address() as any).address, '127.0.0.1');
  } finally { await srv.close(); }
});

test('server refuses a missing or wrong token', async () => {
  await withServer(async (port, token) => {
    assert.equal((await get(port, '/')).status, 401);
    assert.equal((await get(port, '/api/data')).status, 401);
    assert.equal((await get(port, '/?token=wrong')).status, 401);
    assert.equal((await get(port, `/?token=${token}x`)).status, 401);
    assert.equal((await get(port, '/api/data', { Cookie: `${cookieName(port)}=nope` })).status, 401);
    // the URL token is only exchanged on the page, not accepted on the API
    assert.equal((await get(port, `/api/data?token=${token}`)).status, 401);
  });
});

test('server exchanges the URL token for an HttpOnly SameSite=Strict cookie', async () => {
  await withServer(async (port, token) => {
    const r = await get(port, `/?token=${token}`);
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, '/');
    const set = String(r.headers['set-cookie']);
    assert.match(set, new RegExp(`^${cookieName(port)}=${token};`));
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    const cookie = { Cookie: `${cookieName(port)}=${token}` };
    const page = await get(port, '/', cookie);
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-security-policy']), /script-src 'nonce-/);
    const data = await get(port, '/api/data', cookie);
    assert.equal(data.status, 200);
    assert.deepEqual(JSON.parse(data.body), { ok: true, x: '<b>' });
    for (const h of Object.keys(data.headers)) assert.ok(!h.startsWith('access-control-'), `no CORS header: ${h}`);
    assert.equal((await get(port, '/nope', cookie)).status, 404);
  });
});

test('server rejects a bad Host header (DNS rebinding) even with a valid cookie', async () => {
  await withServer(async (port, token) => {
    const cookie = `${cookieName(port)}=${token}`;
    for (const host of ['evil.example.com', `evil.example.com:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `0.0.0.0:${port}`]) {
      const r = await get(port, '/api/data', { Host: host, Cookie: cookie });
      assert.equal(r.status, 403, host);
    }
    assert.equal((await get(port, '/api/data', { Host: `localhost:${port}`, Cookie: cookie })).status, 200);
  });
});

test('server is GET-only', async () => {
  await withServer(async (port, token) => {
    const cookie = { Cookie: `${cookieName(port)}=${token}` };
    for (const m of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const r = await get(port, '/api/data', cookie, m);
      assert.equal(r.status, 405, m);
      assert.equal(r.headers.allow, 'GET');
    }
  });
});

test('page uses textContent for data and loads nothing from the network', () => {
  const html = renderPage('NONCE');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html));
  assert.ok(!/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(html), 'no external URLs');
  assert.match(html, /<script nonce="NONCE">/);
  assert.match(html, /function scanBanner\(ss\)/);
  assert.match(html, /role: 'alert'/);
  assert.match(html, /title: p\.path/);
});

test('parsePort validates --port', () => {
  assert.equal(parsePort(undefined), 0);
  assert.equal(parsePort('8123'), 8123);
  assert.throws(() => parsePort('80'), /1024/);
  assert.throws(() => parsePort('abc'), /number/);
});
