/**
 * Tests for the dashboard speed work (1.7.1): the usage cache, today from the
 * month export, the tool-version cache, the one-call git checks (compared with
 * the old per-question git calls), optional items as info, the /api/usage
 * route's access checks, and a perf guard against serial git spawns.
 * No codeburn, AWS or network calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectUsage, emptyUsage, todayFromDaily, type CodeburnExport, type UsagePanel } from '../src/dashboard/usage.js';
import { UsageCache, USAGE_CACHE_SCHEMA } from '../src/dashboard/usage-cache.js';
import { cachedToolVersion } from '../src/utils/tool-check.js';
import { codewatchSetup, codewatchSetupFrom, gitBool, GIT_CONFIG_LIST, gitFactsFromConfig, globalHooksCheck, machineChecks, readGitFacts, type GitFacts, type GitRunner } from '../src/dashboard/setup.js';
import { buildSummary } from '../src/dashboard/summary.js';
import { buildPayload, GIT_CONCURRENCY } from '../src/dashboard/payload.js';
import { startServer, cookieName, BIND_HOST } from '../src/dashboard/server.js';
import { installHooks } from '../src/codewatch/hooks.js';
import type { GlobalStatus } from '../src/codewatch/globalHooks.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dashboard');
process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'prism-speed-gcfg-')), 'gitconfig');
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `prism-speed-${p}-`));
const NOT_INSTALLED: GlobalStatus = { state: 'not-installed', hooksPath: null, dir: '/x/.prism/hooks' };

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

const okPanel = (cost: number, at = '2026-11-05T10:00:00.000Z'): UsagePanel => ({
  ...emptyUsage('ok', ''), message: null, today: { cost, calls: 1, sessions: 1 }, month: { cost, calls: 1, sessions: 1, from: '2026-11-01', to: '2026-11-05' }, updatedAt: at,
});

// ---------------------------------------------------------------- usage: today from the month export

const monthFixture = () => JSON.parse(readFileSync(join(FIX, 'codeburn-export-month.json'), 'utf8'));

test('usage: one month export; today comes from its per-day rows', async () => {
  const seen: string[][] = [];
  const u = await collectUsage({ exporter: async (a) => { seen.push(a); return monthFixture(); }, now: new Date(2026, 10, 5, 12) });
  assert.deepEqual(seen, [['--from', '2026-11-01', '--to', '2026-11-05']], 'no all-time export, no second export');
  assert.deepEqual(u.today, { cost: 14.46, calls: 65, sessions: 23 });
  assert.equal(u.month?.cost, 24.83);
  assert.equal(u.updatedAt, new Date(2026, 10, 5, 12).toISOString());
});

test('usage: no per-day row for today is zero; an export without per-day rows asks for today alone', async () => {
  assert.deepEqual(todayFromDaily(monthFixture(), '2026-11-01'), { cost: 0, calls: 0, sessions: 0 });
  assert.equal(todayFromDaily({ periods: [{}] }, '2026-11-01'), null);
  const seen: string[][] = [];
  const noDaily: CodeburnExport = async (a) => {
    seen.push(a);
    const j = monthFixture();
    if (a[1] === a[3]) return { ...j, summary: [{ Period: 'x', 'Cost (USD)': 3, 'API Calls': 4, Sessions: 2 }] };
    delete j.periods[0].daily;
    return j;
  };
  const u = await collectUsage({ exporter: noDaily, now: new Date(2026, 10, 5, 12) });
  assert.deepEqual(seen, [['--from', '2026-11-01', '--to', '2026-11-05'], ['--from', '2026-11-05', '--to', '2026-11-05']]);
  assert.deepEqual(u.today, { cost: 3, calls: 4, sessions: 2 });
});

// ---------------------------------------------------------------- usage cache

function cacheWith(collect: () => Promise<UsagePanel>, now: { t: Date }) {
  const file = join(tmp('ucache'), 'cache', 'usage.json');
  return { file, cache: new UsageCache({ file, collect, now: () => now.t, ttlMs: 60_000 }) };
}

test('usage cache: a miss runs codeburn and writes a private file; a hit within the TTL does not run it', async () => {
  const now = { t: new Date(2026, 10, 5, 12) };
  let calls = 0;
  const { file, cache } = cacheWith(async () => { calls++; return okPanel(5); }, now);
  const miss = await cache.get();
  assert.equal(miss.cacheHit, false);
  assert.equal(calls, 1);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schema, USAGE_CACHE_SCHEMA);
  now.t = new Date(now.t.getTime() + 30_000);
  const hit = await cache.get();
  assert.deepEqual([hit.cacheHit, hit.usage.stale, hit.refresh, calls], [true, false, null, 1]);
  assert.equal(hit.usage.today?.cost, 5);
});

test('usage cache: a stale hit is served at once and refreshed once in the background', async () => {
  const now = { t: new Date(2026, 10, 5, 12) };
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { cache } = cacheWith(async () => { calls++; if (calls > 1) await gate; return okPanel(calls); }, now);
  await cache.get();
  now.t = new Date(now.t.getTime() + 61_000);
  const a = await cache.get();
  const b = await cache.get();
  assert.deepEqual([a.cacheHit, a.usage.stale, a.usage.today?.cost], [true, true, 1], 'old data, marked stale');
  assert.ok(a.refresh && b.refresh);
  assert.equal(calls, 2, 'one refresh for both callers');
  release();
  await a.refresh;
  const c = await cache.get();
  assert.deepEqual([c.cacheHit, c.usage.stale, c.usage.today?.cost, calls], [true, false, 2, 2]);
});

test('usage cache: a failure is never cached as data; an older cache stays, marked with the error', async () => {
  const now = { t: new Date(2026, 10, 5, 12) };
  let next: UsagePanel = emptyUsage('error', 'codeburn export failed: boom');
  const { file, cache } = cacheWith(async () => next, now);
  const r = await cache.get();
  assert.equal(r.usage.status, 'error');
  assert.equal(existsSync(file), false, 'nothing written');
  assert.equal(cache.peek(), null);
  assert.equal(cache.current()?.status, 'error', 'the failure is still shown honestly');
  next = emptyUsage('not-installed', 'codeburn is not installed.');
  await cache.get();
  assert.equal(existsSync(file), false);

  next = okPanel(7);
  await cache.get();
  next = emptyUsage('error', 'codeburn export failed: boom');
  now.t = new Date(now.t.getTime() + 61_000);
  const stale = await cache.get();
  await stale.refresh;
  const after = cache.peek()!;
  assert.deepEqual([after.status, after.today?.cost, after.refreshError], ['ok', 7, 'codeburn export failed: boom']);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).panel.today.cost, 7, 'the cached data was not replaced');
});

test('usage cache: fresh bypasses a valid cache; a cache from another day is ignored', async () => {
  const now = { t: new Date(2026, 10, 5, 12) };
  let calls = 0;
  const { cache } = cacheWith(async () => { calls++; return okPanel(calls); }, now);
  await cache.get();
  const fresh = await cache.get({ fresh: true });
  assert.deepEqual([fresh.cacheHit, fresh.usage.today?.cost, calls], [false, 2, 2]);
  now.t = new Date(2026, 10, 6, 0, 0, 30);
  assert.equal(cache.peek(), null, "yesterday's today is not today");
  const next = await cache.get();
  assert.deepEqual([next.cacheHit, calls], [false, 3]);
});

// ---------------------------------------------------------------- tool version cache

test('version cache: reused while the binary is unchanged; a changed binary or a failed probe runs it again', () => {
  const bin = tmp('vbin');
  const log = join(bin, 'calls');
  const exe = join(bin, 'tool');
  const write = (body: string) => { writeFileSync(exe, `#!/bin/sh\necho x >> '${log}'\n${body}\n`); chmodSync(exe, 0o755); };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
  const cacheFile = join(tmp('vcache'), 'cache', 'tool-versions.json');
  write('echo 1.0.0');
  assert.equal(cachedToolVersion(exe, ['--version'], cacheFile), '1.0.0');
  assert.equal(cachedToolVersion(exe, ['--version'], cacheFile), '1.0.0');
  assert.equal(calls(), 1, 'second read from the cache');
  assert.equal(statSync(cacheFile).mode & 0o777, 0o600);
  write('echo 2.0.0-upgraded');
  assert.equal(cachedToolVersion(exe, ['--version'], cacheFile), '2.0.0-upgraded');
  assert.equal(calls(), 2);
  assert.equal(cachedToolVersion(exe, ['version'], cacheFile), '2.0.0-upgraded', 'other args are their own entry');
  assert.equal(calls(), 3);
  write('exit 1');
  assert.equal(cachedToolVersion(exe, ['--version'], cacheFile), null);
  assert.equal(cachedToolVersion(exe, ['--version'], cacheFile), null);
  assert.equal(calls(), 5, 'a failure is not cached');
});

test('version cache: machineChecks uses it for codeburn and gitleaks', () => {
  const bin = tmp('mbin');
  const log = join(bin, 'calls');
  for (const [n, v] of [['codeburn', '0.9.24'], ['gitleaks', 'v8.28.0']]) {
    writeFileSync(join(bin, n), `#!/bin/sh\necho ${n} >> '${log}'\necho ${v}\n`);
    chmodSync(join(bin, n), 0o755);
  }
  const deps = { pathEnv: bin, home: tmp('mh'), env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', global: NOT_INSTALLED, versionCache: join(tmp('mc'), 'v.json') };
  for (let i = 0; i < 3; i++) {
    const by = Object.fromEntries(machineChecks(deps).map((x) => [x.id, x]));
    assert.equal(by.codeburn.detail, '0.9.24');
    assert.equal(by.gitleaks.detail, 'v8.28.0');
  }
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2, 'each version probed once');
});

// ---------------------------------------------------------------- one git call per repo: parity with the old calls

/** The pre-1.7.1 answers: one git call per question, exactly as setup.ts made them. */
function oldFacts(repo: string): GitFacts {
  const g = (args: string[]) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const opt = g(['config', '--bool', '--get', 'prism.codewatch']);
  const local = g(['config', '--local', '--get', 'core.hooksPath']);
  return {
    hooksDir: g(['rev-parse', '--path-format=absolute', '--git-path', 'hooks']) || resolve(repo, '.git/hooks'),
    reviewer: g(['config', '--get', 'prism.reviewer']),
    reviewModels: { kiro: g(['config', '--get', 'prism.kiroModel']), claude: g(['config', '--get', 'prism.claudeModel']) },
    optedOut: opt === 'false',
    localHooksPath: local ? local : null,
  };
}

/** realpath of the longest existing prefix, as git's --path-format=absolute prints it. */
const norm = (p: string): string => {
  try { return realpathSync(p); } catch { const up = dirname(p); return up === p ? p : join(norm(up), p.slice(up.length + 1)); }
};

function parityRepos(): Record<string, string> {
  const root = tmp('parity');
  const mk = (name: string, ...config: [string, string][]) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', `--template=${tmp('tpl')}`);
    for (const [k, v] of config) git(dir, 'config', '--add', k, v);
    return dir;
  };
  const repos: Record<string, string> = {
    plain: mk('plain'),
    installed: (() => { const d = mk('installed'); installHooks(join(d, '.git', 'hooks')); return d; })(),
    reviewerTwice: mk('reviewer-twice', ['prism.reviewer', 'kiro'], ['prism.reviewer', ' claude ']),
    reviewModel: mk('review-model', ['prism.claudeModel', 'model-a'], ['prism.claudeModel', 'model-b'], ['prism.kiroModel', 'model-k']),
    optFalse: mk('opt-false', ['prism.codewatch', 'false']),
    optNo: mk('opt-no', ['prism.codewatch', 'No']),
    optZero: mk('opt-zero', ['prism.codewatch', '0']),
    optTrue: mk('opt-true', ['prism.codewatch', 'true']),
    optBad: mk('opt-bad', ['prism.codewatch', 'maybe']),
    optOverridden: mk('opt-overridden', ['prism.codewatch', 'false'], ['prism.codewatch', 'yes']),
    hooksRelative: mk('hooks-relative', ['core.hooksPath', '.husky']),
    hooksAbsolute: mk('hooks-absolute', ['core.hooksPath', join(root, 'shared-hooks')]),
    hooksTilde: mk('hooks-tilde', ['core.hooksPath', '~/hooks-here']),
    hooksTildeUser: mk('hooks-tilde-user', ['core.hooksPath', '~root/hooks']),
    hooksEmpty: mk('hooks-empty', ['core.hooksPath', '']),
    'space dir': mk("space dir's", ['prism.reviewer', 'claude']),
  };
  // A bare core.hooksPath (no value) makes git itself fail here.
  const bare = mk('hooks-bare');
  appendFileSync(join(bare, '.git', 'config'), '[core]\n\thooksPath\n');
  repos.hooksBare = bare;
  // core.hooksPath from an included file: --local does not follow includes, the effective value does.
  const inc = mk('hooks-include');
  writeFileSync(join(inc, 'extra.cfg'), '[core]\n\thooksPath = inc-hooks\n[prism]\n\treviewer = kiro\n');
  appendFileSync(join(inc, '.git', 'config'), '[include]\n\tpath = ../extra.cfg\n');
  repos.hooksInclude = inc;
  // A bare-key reviewer.
  const bareRev = mk('reviewer-bare');
  appendFileSync(join(bareRev, '.git', 'config'), '[prism]\n\treviewer\n');
  repos.reviewerBare = bareRev;
  // A linked worktree (.git is a file) of a repo with a local hooksPath.
  const main = mk('wt-main', ['core.hooksPath', 'team-hooks']);
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x');
  git(main, 'worktree', 'add', '-q', join(root, 'wt-linked'));
  repos.worktree = join(root, 'wt-linked');
  const plainMain = mk('wt-plain-main');
  git(plainMain, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x');
  git(plainMain, 'worktree', 'add', '-q', join(root, 'wt-plain-linked'));
  repos.worktreePlain = join(root, 'wt-plain-linked');
  // Not a repo at all.
  repos.notRepo = join(root, 'not-a-repo');
  mkdirSync(repos.notRepo);
  return repos;
}

test('one git call per repo gives the same answers as the old per-question calls', async () => {
  const repos = parityRepos();
  for (const withGlobal of [false, true]) {
    if (withGlobal) writeFileSync(process.env.GIT_CONFIG_GLOBAL!, `[core]\n\thooksPath = ${join(tmpdir(), 'global-hooks')}\n[prism]\n\treviewer = claude\n`);
    for (const [name, repo] of Object.entries(repos)) {
      const want = oldFacts(repo);
      const got = await readGitFacts(repo);
      const label = `${name}${withGlobal ? ' (global config)' : ''}`;
      assert.equal(norm(got.hooksDir), norm(want.hooksDir), `${label}: hooksDir`);
      assert.deepEqual({ ...got, hooksDir: '' }, { ...want, hooksDir: '' }, `${label}: config answers`);
      for (const g of [NOT_INSTALLED, { state: 'installed', hooksPath: '~/.prism/hooks', dir: '' } as GlobalStatus]) {
        assert.deepEqual(await codewatchSetup(repo, { pathEnv: tmp('p'), global: g }), codewatchSetupFrom(repo, want, g, tmp('p')), `${label}: setup result`);
      }
    }
  }
  writeFileSync(process.env.GIT_CONFIG_GLOBAL!, '');
});

test('git facts: one call in the common case; a failed call reads as the old failed calls did', async () => {
  const repos = parityRepos();
  const calls: string[][] = [];
  const counting: GitRunner = async (repo, args) => {
    calls.push(args);
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout : null;
  };
  await readGitFacts(repos.plain, counting);
  await readGitFacts(repos.worktree, counting);
  assert.deepEqual(calls, [GIT_CONFIG_LIST, GIT_CONFIG_LIST]);
  assert.deepEqual(gitFactsFromConfig('/nowhere', null), { hooksDir: resolve('/nowhere', '.git/hooks'), reviewer: null, reviewModels: { kiro: null, claude: null }, optedOut: false, localHooksPath: null });
  assert.deepEqual([gitBool(null), gitBool('On'), gitBool(''), gitBool('2'), gitBool('0k'), gitBool('maybe')], [true, true, false, true, false, null]);
});

// ---------------------------------------------------------------- optional items are info

test('optional items are info: shown with the info badge, not counted as setup warnings', () => {
  const g = globalHooksCheck(NOT_INSTALLED);
  assert.equal(g.status, 'info');
  assert.match(g.detail, /optional/);
  const machine = machineChecks({ pathEnv: tmp('none'), home: tmp('h'), env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', global: NOT_INSTALLED });
  const s = buildSummary([], emptyUsage('ok', ''), machine);
  const checklist = machine.filter((i) => i.status === 'missing' || i.status === 'warn');
  assert.equal(s.warnings.count, checklist.length, 'count matches the checklist');
  assert.ok(!checklist.some((i) => i.id === 'codewatch-global'));
  assert.equal(s.warnings.count, 3, 'codeburn missing, gitleaks warn, AWS missing');
});

// ---------------------------------------------------------------- /api/usage access checks

function call(port: number, path: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: BIND_HOST, port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => done({ status: res.statusCode || 0, body }));
    });
    req.on('error', fail);
    req.end();
  });
}

test('/api/usage: needs the cookie and the Host check, like /api/data; passes fresh=1 through', async () => {
  const seen: (string | null)[] = [];
  const srv = await startServer({
    getPayload: async () => ({}),
    getApi: { '/api/usage': async (url: URL) => { seen.push(url.searchParams.get('fresh')); return { usage: emptyUsage('loading', 'x'), cacheHit: false }; } },
  });
  try {
    const host = `127.0.0.1:${srv.port}`;
    const cookie = `${cookieName(srv.port)}=${srv.token}`;
    assert.equal((await call(srv.port, '/api/usage', { Host: host })).status, 401, 'no cookie');
    assert.equal((await call(srv.port, '/api/usage', { Host: host, Cookie: `${cookieName(srv.port)}=wrong` })).status, 401, 'wrong cookie');
    assert.equal((await call(srv.port, '/api/usage', { Host: `evil.example:${srv.port}`, Cookie: cookie })).status, 403, 'foreign Host');
    assert.equal((await call(srv.port, `/api/usage?token=${srv.token}`, { Host: host })).status, 401, 'the URL token is not accepted here');
    assert.equal((await call(srv.port, '/api/usage', { Host: host, Cookie: cookie }, 'POST')).status, 405);
    assert.deepEqual(seen, [], 'never reached without the checks');
    const ok = await call(srv.port, '/api/usage?fresh=1', { Host: host, Cookie: cookie });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).usage.status, 'loading');
    await call(srv.port, '/api/usage', { Host: `localhost:${srv.port}`, Cookie: cookie });
    assert.deepEqual(seen, ['1', null]);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- perf guard

test('perf guard: 30 repos with slow fake git and codeburn finish well under serial time', async () => {
  const GIT_MS = 60;
  const USAGE_MS = 400;
  const home = tmp('perf');
  for (let i = 0; i < 30; i++) mkdirSync(join(home, `repo${String(i).padStart(2, '0')}`, '.git'), { recursive: true });
  let running = 0, peak = 0, gitCalls = 0;
  const slowGit: GitRunner = async (repo) => {
    gitCalls++;
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, GIT_MS));
    running--;
    return `local\0file:${join(repo, '.git', 'config')}\0core.bare\nfalse\0`;
  };
  const usage = async () => { await new Promise((r) => setTimeout(r, USAGE_MS)); return { usage: emptyUsage('no-data', 'none'), cacheHit: false }; };
  const t0 = Date.now();
  const p = await buildPayload({
    cwd: tmp('nowhere'), home, pathEnv: tmp('nopath'), git: slowGit, usage,
    machineDeps: { home: tmp('mh'), env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', systemdAvailable: () => false },
  });
  const ms = Date.now() - t0;
  assert.equal(p.repos.length, 30);
  assert.equal(gitCalls, 30, 'one git call per repo');
  assert.ok(peak <= GIT_CONCURRENCY && peak > 1, `concurrent, capped at ${GIT_CONCURRENCY} (peak ${peak})`);
  // Serial git alone would be 30 x 60 = 1800 ms, plus usage after it.
  assert.ok(ms < 1500, `took ${ms} ms`);
  assert.ok(p.timing.total >= p.timing.usage && p.timing.usage >= USAGE_MS - 20, JSON.stringify(p.timing));
  assert.ok(p.timing.total < p.timing.setup + p.timing.usage, 'usage runs alongside setup');
});

