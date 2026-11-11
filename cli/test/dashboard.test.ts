/**
 * Tests for `prism-cli dashboard`: collectors against fixture directories,
 * server access control (token, cookie, Host, method, loopback bind), and the
 * --json payload shape. No codeburn, AWS or network calls: codeburn output is
 * a recorded, anonymised export fed through the injectable exporter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectCodewatch, secretScanning } from '../src/dashboard/codewatch.js';
import { makeResult, REASON_GITLEAKS_MISSING, type PrismResult } from '../src/codewatch/results.js';
import { collectUsage, type CodeburnExport } from '../src/dashboard/usage.js';
import { machineChecks, codewatchSetup, gitleaksInstallHint, globalHooksCheck, GLOBAL_INSTALL_CMD, GLOBAL_FORCE_CMD } from '../src/dashboard/setup.js';
import { discoverRepos, scanForRepos } from '../src/dashboard/repos.js';
import { buildPayload, globalSuggestion, PAYLOAD_SCHEMA, sortCodewatchRows, sortSetupRows } from '../src/dashboard/payload.js';
import { startServer, cookieName, BIND_HOST } from '../src/dashboard/server.js';
import { renderPage } from '../src/dashboard/page.js';
import { globalHooksDir, installGlobal, type GlobalStatus } from '../src/codewatch/globalHooks.js';
import { installHooks } from '../src/codewatch/hooks.js';
import { parsePort } from '../src/commands/_top/dashboard.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dashboard');

// Every git --global read in this file sees an empty scratch config, never ~/.gitconfig.
process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'prism-dash-gcfg-')), 'gitconfig');

const NOT_INSTALLED: GlobalStatus = { state: 'not-installed', hooksPath: null, dir: '/x/.prism/hooks' };
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

/** The month export; the dashboard no longer runs codeburn's all-time default export. */
const fixtureExporter: CodeburnExport = async () => JSON.parse(readFileSync(join(FIX, 'codeburn-export-month.json'), 'utf8'));

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
  mkdirSync(join(home, '.config', 'codeburn'), { recursive: true });
  writeFileSync(join(home, '.config', 'codeburn', 'sync.json'), JSON.stringify({ baseUrl: 'https://otel.example.com' }));
  const items = machineChecks({ pathEnv: bin, home, env: { AWS_PROFILE: 'dev' }, scheduleExists: () => true, schedulerName: () => 'crontab', global: { state: 'installed', hooksPath: '~/.prism/hooks', dir: '' } });
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(items.map((i) => i.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(by.codeburn.detail, '0.9.24');
  assert.match(by['codeburn-sync'].detail, /last sync log write/);
  assert.match(by['aws-credentials'].detail, /AWS_PROFILE is set \(dev\) \(not validated\)/);
  for (const i of items) assert.equal(i.fix, '', 'ok items carry no fix');
});

test('setup (machine): missing items each carry a one-line fix; AWS uses presence only', () => {
  const items = machineChecks({ pathEnv: tmp('none'), home: tmp('home2'), env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', global: NOT_INSTALLED });
  assert.deepEqual(items.map((i) => i.status), ['missing', 'info', 'warn', 'missing', 'info'], 'gitleaks absent is a warning; no sync mode and no endpoint is local only (info); global hooks are optional (info)');
  for (const i of items.filter((x) => x.status !== 'info')) { assert.ok(i.fix.length > 0); assert.ok(!i.fix.includes('\n')); }
  // an existing config file counts, without its contents being needed
  const home = tmp('home3');
  mkdirSync(join(home, '.aws'));
  writeFileSync(join(home, '.aws', 'config'), '');
  const aws = machineChecks({ pathEnv: tmp('none2'), home, env: {}, scheduleExists: () => false }).find((i) => i.id === 'aws-credentials');
  assert.equal(aws?.status, 'ok');
});

test('setup (repo): codewatch only -- hooks and reviewer, with a cd-and-enable fix', async () => {
  const dir = tmp('srepo');
  git(dir, 'init', '-q', `--template=${tmp('tpl2')}`);
  const before = await codewatchSetup(dir, { pathEnv: tmp('p0') });
  assert.equal(before.status, 'missing');
  assert.equal(before.fix, `cd ${dir} && prism-cli enable codewatch`);
  assert.deepEqual(Object.keys(before).sort(), ['detail', 'fix', 'global', 'reviewer', 'reviewerSource', 'status']);

  installHooks(join(dir, '.git', 'hooks'));
  const bin = tmp('p1');
  exe(bin, 'claude', 'exit 0');
  const after = await codewatchSetup(dir, { pathEnv: bin });
  assert.equal(after.status, 'ok');
  assert.equal(after.reviewer, 'claude');
  assert.equal(after.fix, '');
});

test('setup (repo): hooks from before the rename count as missing; paths with spaces are quoted', async () => {
  const dir = join(tmp('orepo'), "my repo's");
  mkdirSync(dir);
  git(dir, 'init', '-q', `--template=${tmp('tpl3')}`);
  exe(join(dir, '.git', 'hooks'), 'pre-commit', '# prism-cli enable security\nexec prism-cli git pre-commit');
  const c = await codewatchSetup(dir, { pathEnv: tmp('p2') });
  assert.equal(c.status, 'missing');
  assert.match(c.detail, /before the codewatch rename/);
  assert.equal(c.fix, `cd '${dir.replace(/'/g, `'\\''`)}' && prism-cli enable codewatch`);
});

// ---------------------------------------------------------------- repo discovery

/** A fake home with repos placed at the given relative paths. */
function fakeHome(spec: Record<string, boolean>): string {
  const home = tmp('home');
  for (const [rel, prism] of Object.entries(spec)) {
    const d = join(home, rel);
    mkdirSync(join(d, '.git'), { recursive: true });
    if (prism) mkdirSync(join(d, '.prism'));
  }
  return home;
}

test('discovery: from an unrelated cwd, finds every git repo under HOME, with or without .prism', () => {
  const home = fakeHome({ 'a': true, 'b-no-prism': false, 'work/c': true, 'work/team/d': false });
  const d = discoverRepos({ cwd: tmp('elsewhere'), home });
  assert.equal(d.currentRepo, null);
  assert.equal(d.error, null);
  assert.equal(d.scannedRoot, home);
  assert.deepEqual(d.repos.map((r) => [r.name, r.hasPrism]), [['a', true], ['b-no-prism', false], ['c', true], ['d', false]]);
  assert.ok(d.repos.every((r) => !r.current));
  assert.ok(d.scanMs >= 0);
});

test('discovery: a linked worktree (.git is a file) counts as a repo', () => {
  const home = tmp('home-wt');
  const main = join(home, 'main');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'trunk', `--template=${tmp('tplw')}`);
  git(main, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i');
  git(main, 'worktree', 'add', '-q', join(home, 'wt'), '-b', 'side');
  const names = scanForRepos(home).repos.map((r) => r.name);
  assert.deepEqual(names, ['main', 'wt']);
});

test('discovery: skips hidden and build dirs, symlinks, nested repos and unreadable dirs', () => {
  const home = fakeHome({
    'ok': true,
    '.hidden/r1': true, '.cache/r2': true, '.venv/r3': true,
    'node_modules/r4': true, 'Library/r5': true, 'build/r6': true, 'dist/r7': true, 'target/r8': true, 'venv/r9': true,
    'ok/nested': true,
  });
  symlinkSync(join(home, 'ok'), join(home, 'link-to-ok'));
  mkdirSync(join(home, 'proj'));
  symlinkSync(join(home, 'ok'), join(home, 'proj', 'linked'));
  const locked = join(home, 'locked');
  mkdirSync(join(locked, 'r10', '.git'), { recursive: true });
  mkdirSync(join(locked, 'r10', '.prism'));
  chmodSync(locked, 0o000);
  try {
    const names = scanForRepos(home).repos.map((r) => r.name);
    assert.deepEqual(names, ['ok']);
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('discovery: depth 3 is the limit', () => {
  const home = fakeHome({ 'one': true, 'l1/two': true, 'l1/l2/three': true, 'l1/l2/l3/four': true });
  // home/one is level 1, l1/two level 2, l1/l2/three level 3; l1/l2/l3/four (level 4) is too deep
  assert.deepEqual(scanForRepos(home).repos.map((r) => r.name).sort(), ['one', 'three', 'two']);
});

test('discovery: the current repo is listed first even without .prism, and not twice', () => {
  const home = fakeHome({ 'a': true, 'z-current': false, 'b': true });
  const cur = join(home, 'z-current');
  rmSync(join(cur, '.git'), { recursive: true });
  git(cur, 'init', '-q', `--template=${tmp('tpl4')}`);
  mkdirSync(join(cur, 'sub'));
  const d = discoverRepos({ cwd: join(cur, 'sub'), home });
  assert.equal(d.repos[0].path, realpathSync(cur));
  assert.equal(d.repos[0].current, true);
  assert.equal(d.repos[0].hasPrism, false);
  assert.deepEqual(d.repos.map((r) => r.name), ['z-current', 'a', 'b']);
  // with .prism the current repo is also found by the scan; it still appears once, first
  mkdirSync(join(cur, '.prism'));
  const again = discoverRepos({ cwd: cur, home });
  assert.deepEqual(again.repos.map((r) => r.name), ['z-current', 'a', 'b']);
});

test('discovery: --root overrides HOME; a bad root is reported', () => {
  const home = fakeHome({ 'a': true });
  const other = fakeHome({ 'x': true });
  assert.deepEqual(discoverRepos({ cwd: tmp('c'), home, root: other }).repos.map((r) => r.name), ['x']);
  assert.match(discoverRepos({ cwd: tmp('c'), home, root: join(home, 'nope') }).error || '', /not a directory/);
});

// ---------------------------------------------------------------- overview sort order

test('overview: setup rows put the current repo first, then installed, then missing', () => {
  const row = (name: string, status: 'ok' | 'missing', current = false) => ({ name, label: name, path: '/r/' + name, active: false, current, status, reviewer: null, detail: '', fix: '', collapsed: false, global: false, security: { status: 'missing' as const, detail: '', fix: '' } });
  const sorted = sortSetupRows([row('a', 'ok'), row('b', 'missing'), row('c', 'missing', true), row('d', 'ok')]);
  assert.deepEqual(sorted.map((r) => r.name), ['c', 'a', 'd', 'b'], 'current repo, then installed, then missing');
});

test('overview: codewatch rows sort by high, then medium, then low', () => {
  const row = (name: string, high: number, medium: number, low: number) =>
    ({ name, label: name, path: '/r/' + name, current: false, active: true, spendMonth: null, high, medium, low, lastRunAt: null, lastReviewId: null, reviewer: null, unscannedCommits: 0, gitleaksWarning: false });
  const sorted = sortCodewatchRows([row('quiet', 0, 0, 0), row('med', 0, 3, 0), row('hi1', 1, 0, 0), row('hi2', 2, 0, 9), row('low', 0, 0, 4)]);
  assert.deepEqual(sorted.map((r) => r.name), ['hi2', 'hi1', 'med', 'low', 'quiet']);
});

test('overview: counts, collapsed missing group, and an empty codewatch table', async () => {
  const home = fakeHome({ 'one': false, 'two': false, 'three': false });
  installHooks(join(home, 'two', '.git', 'hooks'));
  const bin = tmp('pk');
  exe(bin, 'kiro-cli', 'exit 0');
  const p = await buildPayload({ cwd: tmp('nowhere'), home, exporter: fixtureExporter, pathEnv: bin, machineDeps: { home: tmp('h5'), env: {}, scheduleExists: () => false } });
  assert.deepEqual(p.overview.counts, { repos: 3, codewatch: 1 });
  assert.equal(p.repos.length, 3, 'every repo is in --json, codewatch or not');
  assert.deepEqual(p.overview.setup.map((r) => [r.name, r.status, r.collapsed]), [['two', 'ok', false], ['one', 'missing', true], ['three', 'missing', true]]);
  assert.ok(p.overview.setup.filter((r) => r.collapsed).every((r) => r.fix.endsWith('&& prism-cli enable codewatch')));
  assert.deepEqual(p.overview.codewatch.map((r) => r.name), ['two'], 'installed with no results still listed');

  const none = await buildPayload({ cwd: tmp('nowhere2'), home: fakeHome({ 'x': false, 'y': true }), exporter: fixtureExporter, pathEnv: bin, machineDeps: { home: tmp('h6'), env: {}, scheduleExists: () => false } });
  assert.deepEqual(none.overview.counts, { repos: 2, codewatch: 0 });
  assert.deepEqual(none.overview.codewatch, [], 'empty table when codewatch is enabled nowhere');
  const html = renderPage('N');
  assert.ok(html.includes("Codewatch isn't enabled in any repo yet."));
  assert.ok(html.includes("': not set up'"));
});

// ---------------------------------------------------------------- global hooks

/** HOME and GIT_CONFIG_GLOBAL in a scratch dir for the duration of fn. */
async function withFakeGlobal<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const home = tmp('ghome');
  const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig');
  assert.ok(process.env.GIT_CONFIG_GLOBAL.startsWith(tmpdir()));
  try { return await fn(home); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('machine row for the global hooks: ok, not installed, pointing elsewhere', () => {
  assert.equal(globalHooksCheck({ state: 'installed', hooksPath: '/h/.prism/hooks', dir: '' }).status, 'ok');
  const none = globalHooksCheck(NOT_INSTALLED);
  assert.equal(none.status, 'info', 'optional: not a setup warning');
  assert.equal(none.fix, '');
  assert.ok(none.detail.includes(GLOBAL_INSTALL_CMD), 'the command stays visible in the detail');
  const other = globalHooksCheck({ state: 'elsewhere', hooksPath: '/opt/team', dir: '' });
  assert.equal(other.status, 'warn');
  assert.match(other.detail, /\/opt\/team/);
  assert.match(other.fix, /--global --force/);
});

test('repo status under the global hooks: ok (global), husky bypass warns, opt-out', () => withFakeGlobal(async (home) => {
  assert.ok(installGlobal().ok);
  const g: GlobalStatus = { state: 'installed', hooksPath: globalHooksDir(home), dir: globalHooksDir(home) };
  const plain = join(home, 'plain');
  mkdirSync(plain);
  git(plain, 'init', '-q', `--template=${tmp('t1')}`);
  const ok = await codewatchSetup(plain, { pathEnv: tmp('pp'), global: g });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.global, true);
  assert.match(ok.detail, /\(global\)/);

  const husky = join(home, 'husky');
  mkdirSync(husky);
  git(husky, 'init', '-q', `--template=${tmp('t2')}`);
  git(husky, 'config', 'core.hooksPath', '.husky');
  const w = await codewatchSetup(husky, { pathEnv: tmp('pp'), global: g });
  assert.equal(w.status, 'warn');
  assert.match(w.detail, /core\.hooksPath \(\.husky\) bypasses the global hooks/);
  assert.equal(w.fix, `cd ${husky} && prism-cli enable codewatch`);

  git(plain, 'config', 'prism.codewatch', 'false');
  const out = await codewatchSetup(plain, { pathEnv: tmp('pp'), global: g });
  assert.equal(out.status, 'opted-out');
  assert.match(out.detail, /opted out/);
}));

test('payload: globally covered repos count as having codewatch; no suggestion once installed', () => withFakeGlobal(async (home) => {
  installGlobal();
  for (const n of ['a', 'b', 'c']) { const d = join(home, 'src', n); mkdirSync(d, { recursive: true }); git(d, 'init', '-q', `--template=${tmp('t' + n)}`); }
  const p = await buildPayload({ cwd: tmp('nowhere'), home, exporter: fixtureExporter, pathEnv: tmp('pb'), machineDeps: { home, env: {}, scheduleExists: () => false } });
  assert.deepEqual(p.overview.counts, { repos: 3, codewatch: 3 });
  assert.ok(p.overview.setup.every((r) => r.status === 'ok' && r.global && !r.collapsed));
  assert.equal(p.machine.globalHooks.state, 'installed');
  assert.equal(p.machine.setup.find((i) => i.id === 'codewatch-global')?.status, 'ok');
  assert.deepEqual(p.suggestions, []);
}));

test('global suggestion: shown at 2+ missing repos, hidden at 1 or when installed; warn variant for a foreign hooksPath', () => {
  const info = globalSuggestion(NOT_INSTALLED, 2);
  assert.deepEqual(info && [info.id, info.style, info.command, info.missing], ['codewatch-global', 'info', GLOBAL_INSTALL_CMD, 2]);
  assert.match(info!.reason, /^2 repos don't have codewatch\. Cover all of them at once\.$/);
  assert.equal(globalSuggestion(NOT_INSTALLED, 1), null);
  assert.equal(globalSuggestion({ state: 'installed', hooksPath: 'x', dir: '' }, 30), null);
  const warn = globalSuggestion({ state: 'elsewhere', hooksPath: '/opt/team-hooks', dir: '' }, 5);
  assert.equal(warn?.style, 'warn');
  assert.equal(warn?.command, GLOBAL_FORCE_CMD);
  assert.equal(warn?.currentHooksPath, '/opt/team-hooks');
  assert.match(warn!.reason, /\/opt\/team-hooks.*still runs its hooks/);
  // an incomplete install is suggested like a fresh one
  assert.equal(globalSuggestion({ state: 'incomplete', hooksPath: 'x', dir: '' }, 3)?.command, GLOBAL_INSTALL_CMD);
});

test('payload carries the suggestion; opted-out repos are not counted as missing', () => withFakeGlobal(async (home) => {
  for (const n of ['a', 'b', 'c']) { const d = join(home, n); mkdirSync(d); git(d, 'init', '-q', `--template=${tmp('u' + n)}`); }
  git(join(home, 'c'), 'config', 'prism.codewatch', 'false');
  const p = await buildPayload({ cwd: tmp('nw'), home, exporter: fixtureExporter, pathEnv: tmp('pc'), machineDeps: { home, env: {}, scheduleExists: () => false } });
  assert.equal(p.suggestions.length, 1);
  assert.equal(p.suggestions[0].missing, 2);
  assert.equal(p.overview.setup.find((r) => r.name === 'c')?.status, 'opted-out');
  const html = renderPage('N');
  assert.ok(html.includes("Applies to every repo on this machine, including new clones."));
  assert.ok(html.includes('Cover every repo at once: '));
  assert.ok(!/<button[^>]*(install|enable)/i.test(html), 'no action buttons');
}));

// ---------------------------------------------------------------- --json payload

test('--json payload shape', async () => {
  const repo = repoWithResults();
  const home = fakeHome({ 'other': true });
  const p = await buildPayload({ cwd: repo, home, exporter: fixtureExporter, pathEnv: tmp('p3'), machineDeps: { home: tmp('h4'), env: {}, scheduleExists: () => false } });
  assert.equal(p.schema, PAYLOAD_SCHEMA);
  assert.deepEqual(p.overview.counts, { repos: 2, codewatch: 0 });
  assert.deepEqual(Object.keys(p).sort(), ['aws', 'generated_at', 'machine', 'overview', 'repos', 'schema', 'scope', 'security', 'suggestions', 'summary', 'timing', 'usage']);
  assert.deepEqual(Object.keys(p.timing).sort(), ['cacheHit', 'scan', 'setup', 'total', 'usage']);
  assert.equal(p.timing.cacheHit, false);
  assert.deepEqual(p.aws.accounts, [], 'no aws check results in the fixtures');
  assert.deepEqual(Object.keys(p.scope).sort(), ['current_repo', 'error', 'root', 'root_display', 'scan_ms', 'truncated']);
  assert.equal(p.scope.root_display, '~');
  assert.deepEqual(Object.keys(p.repos[0]).sort(), ['active', 'codewatch', 'current', 'hasPrism', 'label', 'name', 'path', 'security', 'setup', 'spend']);
  assert.deepEqual(p.repos[0].security, { status: 'missing', detail: 'not set up', fix: `cd ${p.repos[0].path} && prism-cli enable security` });
  assert.ok(p.overview.setup.every((r) => r.security && r.security.status === 'missing'));
  assert.equal(p.repos.length, 2);
  assert.equal(p.repos[0].current, true);
  assert.equal(p.repos[0].codewatch.hasResults, true);
  assert.equal(p.repos[0].codewatch.lastRunAt, '2026-11-03T09:00:00.000Z');
  assert.equal(p.repos[0].codewatch.lastReviewer, 'claude');

  // overview: the repo with a high finding sorts first; both repos lack hooks
  assert.deepEqual(Object.keys(p.overview.codewatch[0]).sort(),
    ['active', 'current', 'gitleaksWarning', 'high', 'label', 'lastReviewId', 'lastRunAt', 'low', 'medium', 'name', 'path', 'reviewer', 'spendMonth', 'unscannedCommits']);
  assert.equal(p.overview.codewatch[0].path, p.repos[0].path);
  assert.equal(p.overview.codewatch[0].high, 1);
  assert.equal(p.overview.codewatch[0].gitleaksWarning, true);
  assert.equal(p.overview.codewatch[0].unscannedCommits, 2);
  assert.ok(p.overview.setup.every((r) => r.status === 'missing' && r.fix.endsWith('&& prism-cli enable codewatch')));
  assert.equal(p.overview.setup[0].current, true);
  // 'other' has no hooks and no results: in the setup list (collapsed), not in the codewatch summary
  assert.equal(p.overview.codewatch.length, 1);
  assert.deepEqual(p.overview.setup.map((r) => [r.current, r.collapsed]), [[true, false], [false, true]]);

  // banner is machine-level and sums the repos
  const ss = p.machine.secretScanning;
  assert.deepEqual(Object.keys(ss).sort(), ['banner', 'gitleaksAvailable', 'installHint', 'unscannedCommits', 'unscannedSince']);
  assert.equal(ss.gitleaksAvailable, false, 'pathEnv has no gitleaks');
  assert.equal(ss.unscannedCommits, 2);
  assert.match(ss.banner || '', /Secret scanning is off: gitleaks is not installed\. 2 commits since/);

  // machine checks unchanged
  assert.deepEqual(p.machine.setup.map((i) => i.id), ['codeburn', 'codeburn-sync', 'gitleaks', 'aws-credentials', 'codewatch-global']);
  assert.equal(p.usage.status, 'ok');
  assert.deepEqual(p.security, { repos: [], pentests: [], hint: 'prism-cli security code-review', pending_hint: 'prism-cli security findings', pentest_hint: 'prism-cli security pentest --status', threat_models: [], threats_hint: 'prism-cli security threats' });
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

test('the Security findings panel is a one-column card: compact blocks and wrapping rows, no wide table', () => {
  const html = renderPage('NONCE');
  const panel = html.slice(html.indexOf('function securityPanel(sec) {'), html.indexOf('async function load('));
  assert.ok(panel.length > 0);
  assert.match(panel, /el\('section', \{ class: 'card' \}, el\('h2', \{\}, 'Security findings'\)\)/);
  assert.doesNotMatch(panel, /card wide|table\(/, 'not full-width and no table');
  assert.match(panel, /'no findings'/, 'all-zero state');
  assert.match(panel, /filter\(\(k\) => \(counts\[k\] \|\| 0\) > 0\)/, 'zero counts hidden');
  assert.match(panel, /showing the first/, 'cap note kept');
  assert.match(panel, /No Security Agent code reviews, threat models or penetration tests yet/, 'empty state kept');
  assert.match(html, /ul\.sec-findings li \{[^}]*overflow-wrap:anywhere/, 'rows wrap');
  // Order in the grid: Codewatch (full width), then Usage, Setup, Security and AWS account side by side.
  assert.match(html, /\[summaryPanel\(data\.summary\), codewatchPanel\(data\), usagePanel\(data\.usage\), setupPanel\(data\), securityPanel\(data\.security\), awsPanel\(data\.aws\)\]/);
});

test('parsePort validates --port', () => {
  assert.equal(parsePort(undefined), 0);
  assert.equal(parsePort('8123'), 8123);
  assert.throws(() => parsePort('80'), /1024/);
  assert.throws(() => parsePort('abc'), /number/);
});
