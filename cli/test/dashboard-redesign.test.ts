/**
 * Tests for the 1.13.0 dashboard redesign: the update check (cache, offline,
 * opt-out), the heatmap's prior weeks and the codeburn strip, the payload's
 * trend / version / reviews30d fields, the #repo/<id> route, empty sections
 * in the "Get more" strip, severity pills, the heatmap's no-data cells and
 * the version pill. No codeburn, npm, AWS or network calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeResult, writeResult, type PrismResult } from '../src/codewatch/results.js';
import { buildPayload, type DashboardPayload } from '../src/dashboard/payload.js';
import { collectUsage, codeburnStats, heatmapStart, priorRange, type CodeburnExport, type UsagePanel } from '../src/dashboard/usage.js';
import { UsageCache, USAGE_CACHE_SCHEMA } from '../src/dashboard/usage-cache.js';
import { readCapped, UpdateCheck, UPDATE_CACHE_SCHEMA, UPDATE_CHECK_INTERVAL_MS, type RegistryFetch } from '../src/dashboard/update-check.js';
import { renderPage } from '../src/dashboard/page.js';
import { FakeElement, runPage } from './page-dom.js';

process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'prism-rd-gcfg-')), 'gitconfig');
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `prism-rd-${p}-`)));

// ---------------------------------------------------------------- update check

function updates(o: { latest?: string; fail?: boolean; env?: NodeJS.ProcessEnv; installed?: string } = {}) {
  const file = join(tmp('upd'), 'cache', 'update-check.json');
  const now = { t: new Date('2026-11-14T12:00:00Z') };
  let calls = 0;
  const fetch: RegistryFetch = async () => {
    calls++;
    if (o.fail) throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    return { latest: o.latest ?? '1.13.1', publishedAt: '2026-11-13T09:00:00.000Z' };
  };
  const check = new UpdateCheck({ installed: o.installed ?? '1.13.0', file, env: o.env ?? {}, fetch, now: () => now.t });
  return { check, file, now, calls: () => calls };
}

test('update check: asks the registry when due, caches the answer (0600) and does not ask again within a day', async () => {
  const u = updates();
  assert.deepEqual(u.check.current(), { installed: '1.13.0', latest: null, publishedAt: null, update: false, checkedAt: null }, 'never checked');
  assert.equal(u.check.due(), true);
  const v = await u.check.get();
  assert.deepEqual(v, { installed: '1.13.0', latest: '1.13.1', publishedAt: '2026-11-13T09:00:00.000Z', update: true, checkedAt: '2026-11-14T12:00:00.000Z' });
  assert.equal(statSync(u.file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(u.file, 'utf8')).schema, UPDATE_CACHE_SCHEMA);
  u.now.t = new Date(u.now.t.getTime() + UPDATE_CHECK_INTERVAL_MS - 1000);
  assert.equal(u.check.due(), false);
  assert.deepEqual(await u.check.get(), v, 'served from the cache');
  assert.equal(u.calls(), 1, 'one registry request a day');
  u.now.t = new Date(u.now.t.getTime() + 2000);
  assert.equal(u.check.due(), true, 'due again after a day');
  await u.check.get();
  assert.equal(u.calls(), 2);
});

test('update check: offline is silent, keeps the last known version and waits a day before asking again', async () => {
  const u = updates();
  await u.check.get();
  const offline = new UpdateCheck({ installed: '1.13.0', file: u.file, env: {}, fetch: async () => { throw new Error('offline'); }, now: () => new Date('2026-11-16T12:00:00Z') });
  const v = await offline.get();
  assert.equal(v.latest, '1.13.1', 'last known answer kept');
  assert.equal(v.checkedAt, '2026-11-16T12:00:00.000Z', 'the attempt counts');
  assert.equal(offline.due(), false, 'no retry the same day');

  const first = updates({ fail: true });
  const none = await first.check.get();
  assert.deepEqual([none.latest, none.update], [null, false], 'offline on the first check: no version, no error');
  assert.equal(first.check.due(), false);
});

test('update check: the registry body is read with a running byte count and cut off past the cap, content-length or not', async () => {
  const MB = 1024 * 1024;
  let pulled = 0, cancelled = false;
  /** A chunked body (no content-length): 1 MB chunks, forever. */
  const endless = new ReadableStream<Uint8Array>({
    pull(c) { pulled++; c.enqueue(new Uint8Array(MB)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readCapped(new Response(endless), 5 * MB), /too large/);
  assert.ok(cancelled, 'the read is cancelled');
  assert.ok(pulled <= 7, `stops right after the cap (${pulled} chunks read)`);
  const declared = new Response('{}', { headers: { 'content-length': String(6 * MB) } });
  await assert.rejects(readCapped(declared, 5 * MB), /too large/, 'a declared size over the cap is refused before reading');
  assert.equal(await readCapped(new Response('{"dist-tags":{"latest":"1.0.0"}}'), 5 * MB), '{"dist-tags":{"latest":"1.0.0"}}');
});

test('update check: PRISM_NO_UPDATE_CHECK=1 turns it off; same or older latest is no update; a clock moved back is due', async () => {
  const off = updates({ env: { PRISM_NO_UPDATE_CHECK: '1' } });
  assert.equal(off.check.due(), false);
  assert.deepEqual(await off.check.get(), { installed: '1.13.0', latest: null, publishedAt: null, update: false, checkedAt: null });
  assert.equal(off.calls(), 0, 'never asks npm');
  assert.equal(existsSync(off.file), false, 'writes nothing');

  assert.equal((await updates({ latest: '1.13.0' }).check.get()).update, false);
  assert.equal((await updates({ latest: '1.12.9' }).check.get()).update, false);
  assert.equal((await updates({ latest: '2.0.0', installed: 'unknown' }).check.get()).update, false, 'unknown installed version: no claim');

  const u = updates();
  await u.check.get();
  u.now.t = new Date('2026-11-01T00:00:00Z');
  assert.equal(u.check.due(), true, 'a cache from the future is not trusted');
});

// ---------------------------------------------------------------- usage: heatmap weeks and the codeburn strip

const exportOf = (daily: { Date: string; cost: number }[], extra: Record<string, unknown> = {}) => ({
  schema: 'codeburn.export.v2', currency: { code: 'USD' },
  summary: [{ 'Cost (USD)': 10, 'API Calls': 120, Sessions: 7, Projects: 3 }],
  periods: [{ daily: daily.map((d) => ({ Date: d.Date, 'Cost (USD)': d.cost, 'API Calls': 10, Sessions: 1, 'Input Tokens': 1000, 'Output Tokens': 100, 'Cache Read Tokens': 5000 })),
    models: [], activity: [{ Activity: 'Debugging', 'Cost (USD)': 2 }, { Activity: 'Feature Dev', 'Cost (USD)': 7 }] }],
  projects: [],
  tools: Array.from({ length: 10 }, (_, i) => ({ Tool: 't' + i, Calls: i * 10 })),
  ...extra,
});

test('usage: the heatmap starts on a Monday 12 weeks back; the weeks before this month are one extra export', async () => {
  const now = new Date(2026, 10, 14, 12); // Saturday 2026-11-14
  assert.equal(heatmapStart(now), '2026-08-17', 'Monday on or before 2026-08-23');
  assert.deepEqual(priorRange(now), { from: '2026-08-17', to: '2026-10-31' });
  const seen: string[][] = [];
  const exporter: CodeburnExport = async (a) => {
    seen.push(a);
    return a[1] === '2026-11-01' ? exportOf([{ Date: '2026-11-14', cost: 4 }]) : exportOf([{ Date: '2026-08-10', cost: 9 }, { Date: '2026-10-02', cost: 3 }]);
  };
  const u = await collectUsage({ exporter, now });
  assert.deepEqual(seen.sort(), [['--from', '2026-08-17', '--to', '2026-10-31'], ['--from', '2026-11-01', '--to', '2026-11-14']]);
  assert.deepEqual(u.prior, { from: '2026-08-17', to: '2026-10-31', daily: [{ date: '2026-10-02', cost: 3 }] }, 'rows outside the range are dropped');

  seen.length = 0;
  const again = await collectUsage({ exporter, now, prior: u.prior });
  assert.deepEqual(seen, [['--from', '2026-11-01', '--to', '2026-11-14']], 'same range: the cached weeks are reused');
  assert.deepEqual(again.prior, u.prior);

  const failing: CodeburnExport = async (a) => { if (a[1] !== '2026-11-01') throw new Error('boom'); return exportOf([]); };
  const partial = await collectUsage({ exporter: failing, now });
  assert.equal(partial.status, 'ok', 'a failed prior export does not fail the panel');
  assert.equal(partial.prior, null, 'those days are unknown, not zero');
});

test('usage: codeburn strip from the month export: calls, sessions, projects, summed tokens, activity and top tools', () => {
  const cb = codeburnStats(exportOf([{ Date: '2026-11-01', cost: 1 }, { Date: '2026-11-02', cost: 2 }]));
  assert.deepEqual([cb.calls, cb.sessions, cb.projects], [120, 7, 3]);
  assert.deepEqual(cb.tokens, { input: 2000, output: 200, cacheRead: 10000 });
  assert.deepEqual(cb.activity.map((a) => a.name), ['Feature Dev', 'Debugging'], 'most first');
  assert.equal(cb.tools.length, 8);
  assert.deepEqual(cb.tools[0], { name: 't9', calls: 90 });
  const bare = codeburnStats({ schema: 'codeburn.export.v2' });
  assert.deepEqual(bare, { calls: 0, sessions: 0, projects: 0, tokens: { input: 0, output: 0, cacheRead: 0 }, activity: [], tools: [] });
});

test('usage cache: a refresh hands the cached weeks to the collector', async () => {
  const file = join(tmp('uc'), 'usage.json');
  const prior = { from: '2026-08-17', to: '2026-10-31', daily: [{ date: '2026-10-02', cost: 3 }] };
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ schema: USAGE_CACHE_SCHEMA, savedAt: 0, day: '2026-11-13', panel: { status: 'ok', prior } }));
  let got: unknown = 'not called';
  const cache = new UsageCache({ file, collect: async (p) => { got = p; return { status: 'error', message: 'x' } as UsagePanel; } });
  await cache.refresh();
  assert.deepEqual(got, prior, 'from an earlier day too: collectUsage decides by range');
});

// ---------------------------------------------------------------- payload and page

function gitRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('git', ['init', '-q', `--template=${tmp('tpl')}`], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return dir;
}
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const review = (at: string, status: PrismResult['status'], findings: PrismResult['findings'] = [], extra: Partial<PrismResult> = {}) => makeResult({
  kind: 'review', hook: 'pre-push', status, tool: 'kiro', started_at: at, finished_at: at, branch: 'main', commit: 'a'.repeat(40), findings, ...extra,
});
const finding = (severity: 'high' | 'medium' | 'low', file = 'a.ts') => ({ severity, category: 'security' as const, rule: 'r', file, line: 1, message: 'm ' + severity });

/** One reviewed repo (`busy`) and one with nothing (`quiet`); the month export has no rows before today. */
async function fixture(): Promise<{ home: string; p: DashboardPayload }> {
  const home = tmp('home');
  const busy = gitRepo(join(home, 'busy'));
  gitRepo(join(home, 'quiet'));
  writeResult(busy, review(daysAgo(40), 'findings', [finding('high')]));
  writeResult(busy, review(daysAgo(3), 'skipped', [], { reason: 'no changes against upstream' }));
  writeResult(busy, review(daysAgo(2), 'ok'));
  writeResult(busy, review(daysAgo(1), 'findings', [finding('medium', 'b.ts'), finding('low', 'c.ts')]));
  const exporter: CodeburnExport = async (a) => a[3] === a[1] ? exportOf([]) : exportOf(a[1].endsWith('-01') ? [{ Date: a[3], cost: 2 }] : []);
  const p = await buildPayload({
    cwd: tmp('nowhere'), home, exporter, pathEnv: tmp('path'),
    machineDeps: { home, env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', systemdAvailable: () => false },
    version: async () => ({ installed: '1.13.0', latest: '1.14.0', publishedAt: null, update: true, checkedAt: '2026-11-14T00:00:00.000Z' }),
  });
  return { home, p };
}

test('payload: row trend (skipped included), reviews in the last 30 days, the version block and repo ids', async () => {
  const { p } = await fixture();
  const busy = p.repos.find((r) => r.name === 'busy')!;
  const row = p.overview.codewatch.find((r) => r.name === 'busy')!;
  assert.equal(row.id, busy.id);
  assert.deepEqual(row.trend.map((t) => [t.status, t.high, t.medium, t.low]), [['findings', 1, 0, 0], ['skipped', 0, 0, 0], ['ok', 0, 0, 0], ['findings', 0, 1, 1]], 'oldest first');
  assert.deepEqual(busy.codewatch.reviews30d, { total: 3, skipped: 1 }, 'the 40-day-old review is outside the window');
  assert.deepEqual(p.version, { installed: '1.13.0', latest: '1.14.0', publishedAt: null, update: true, checkedAt: '2026-11-14T00:00:00.000Z' });
  assert.ok(p.usage.codeburn && p.usage.prior !== undefined, 'codeburn strip and prior weeks in --json');
});

const mainOf = (page: Awaited<ReturnType<typeof runPage>>) => page.dom.byId.main;

test('page: a codewatch row opens #repo/<id>; the hash route shows that repo and Back returns to the dashboard', async () => {
  const { p } = await fixture();
  const busy = p.repos.find((r) => r.name === 'busy')!;
  const page = await runPage([p]);
  const tr = mainOf(page).querySelectorAll('tr').find((r) => (r.getAttribute('class') || '') === 'click')!;
  tr.listeners.click({ target: tr });
  assert.equal(page.location.hash, '#repo/' + busy.id, 'a row click sets the hash');
  page.go('#repo/' + busy.id);
  const repo = page.dom.byId.repo;
  assert.equal(repo.hidden, false);
  assert.equal(mainOf(page).hidden, true);
  const t = repo.textContent;
  assert.match(t, /^Dashboard \/ busy/);
  assert.match(t, /Open findings2latest review of each branch/);
  assert.match(t, /Reviews \(30 days\)31 skipped · 4 results recorded/);
  assert.match(t, /Secrets blocked0pre-commit gitleaks/);
  assert.match(t, /Spend this month-no codeburn project here/);
  assert.match(t, /Findings over timelast 4 pre-push reviews/);
  assert.match(t, /Reviewsnewest 4 of 4/);
  assert.match(t, /skippedno changes against upstream/, 'skip reasons in the review list');
  assert.match(t, /Security Agent/);
  assert.match(t, /Open findingslatest review of each branch/);
  assert.match(t, /Commitssecret scan and review per commit/);
  assert.equal(repo.querySelectorAll('a').filter((a) => a.textContent === 'Report' && (a.getAttribute('href') || '').startsWith('/report/')).length, 4, 'one report link per review');
  page.go('');
  assert.equal(repo.hidden, true);
  assert.equal(mainOf(page).hidden, false);

  page.go('#repo/0000000000000000');
  assert.match(page.dom.byId.repo.textContent, /No repo with this id/);
  page.go('#repo/../../etc');
  assert.equal(page.dom.byId.repo.hidden, true, 'anything but 16 hex digits is the dashboard');
});

test('page: a repo view hides Commits and Open findings when empty; the old inline per-repo expansion is gone', async () => {
  const { p } = await fixture();
  const noRows = JSON.parse(JSON.stringify(p)) as DashboardPayload;
  const b = noRows.repos.find((r) => r.name === 'busy')!;
  b.codewatch.commits.rows = [];
  b.codewatch.findings = [];
  const bt = (await runPage([noRows], '#repo/' + b.id)).dom.byId.repo.textContent;
  assert.doesNotMatch(bt, /Commitssecret scan|Open findingslatest/);
  assert.match(bt, /Findings over time/);
  const quiet = p.repos.find((r) => r.name === 'quiet')!;
  const page = await runPage([p], '#repo/' + quiet.id);
  assert.match(page.dom.byId.repo.textContent, /No codewatch results yet/);
  assert.doesNotMatch(page.dom.byId.repo.textContent, /Open findings/);
  assert.doesNotMatch(renderPage('N'), /Per repo|codewatchDetail|details\.repo/);
});

test('page: empty sections are hidden and listed in the Get more from PRISM strip with their commands', async () => {
  const { p } = await fixture();
  const t = (await runPage([p])).text();
  assert.match(t, /Get more from PRISMSecurity Agent: prism-cli enable security, then prism-cli security code-reviewAWS account checks: prism-cli aws check \(read-only\)/);
  assert.doesNotMatch(t, /Security findings|AWS accountlatest/);
  const none = JSON.parse(JSON.stringify(p)) as DashboardPayload;
  none.usage.status = 'not-installed';
  none.usage.message = 'codeburn is not installed.';
  none.overview.codewatch = [];
  none.machine.secretScanning.banner = null;
  const t2 = (await runPage([none])).text();
  assert.match(t2, /Codewatch: prism-cli enable codewatch/);
  assert.match(t2, /Spend: codeburn is not installed\. prism-cli enable codeburn/);
  assert.doesNotMatch(t2, /Trend \(last 12 runs\)|By model/);
});

test('page: severity pills share one shape per level everywhere', async () => {
  const html = renderPage('N');
  assert.match(html, /\.pill\.high::before \{ clip-path:polygon\(50% 0,100% 100%,0 100%\)/, 'high: triangle');
  assert.match(html, /\.pill\.medium::before \{ transform:rotate\(45deg\)/, 'medium: diamond');
  assert.match(html, /\.pill::before \{[^}]*border-radius:50%/, 'low and ok: dot');
  assert.match(html, /\.pill\.blocked::before \{ width:8px; height:8px; border-radius:1px; \}/, 'blocked: square');
  assert.match(html, /\.pill\.zero \{ color:var\(--muted\)/, 'zero / skipped: muted');
  assert.match(html, /const SEV_CLASS = \{ high: 'high', critical: 'high', medium: 'medium', low: 'low', ok: 'ok', blocked: 'blocked', zero: 'zero' \}/, 'Security Agent and AWS levels map onto the same pills');
  const { p } = await fixture();
  const page = await runPage([p]);
  const pills = mainOf(page).byClass('pill').map((e) => [e.getAttribute('class'), e.textContent]);
  assert.ok(pills.some(([c, t]) => c === 'pill medium' && t === '1 medium'));
  assert.ok(pills.some(([c, t]) => c === 'pill low' && t === '1 low'));
});

test('page: heatmap days neither export covered are drawn as no data, distinct from a zero day', async () => {
  const { p } = await fixture();
  const page = await runPage([p]);
  const cells = mainOf(page).querySelectorAll('i').filter((i) => i.parent && (i.parent as FakeElement).getAttribute('class') === 'heat');
  assert.ok(cells.length >= 12 * 7 && cells.length <= 13 * 7, `${cells.length} days`);
  const today = cells[cells.length - 1];
  assert.match(today.getAttribute('class') || '', /^l[1-4]$/, 'today has spend');
  assert.ok(cells.some((c) => /: no usage$/.test(c.getAttribute('title') || '') && (c.getAttribute('class') || '') === ''), 'a covered day without a row is zero');

  const lost = JSON.parse(JSON.stringify(p)) as DashboardPayload;
  lost.usage.prior = null;
  const page2 = await runPage([lost]);
  const cells2 = mainOf(page2).querySelectorAll('i').filter((i) => (i.parent as FakeElement).getAttribute('class') === 'heat');
  assert.ok(cells2.filter((c) => c.getAttribute('class') === 'nd').length > 20, 'without the prior weeks those days are unknown');
  assert.ok(cells2.every((c) => c.getAttribute('class') !== 'nd' || /: no data$/.test(c.getAttribute('title') || '')));
});

test('page: the version pill is grey with the installed version, orange with the update, linking to the Setup update section', async () => {
  const { p } = await fixture();
  const up = await runPage([p]);
  const a = up.dom.byId.ver.querySelectorAll('a')[0];
  assert.equal(a.textContent, 'Update: 1.13.0 → 1.14.0');
  assert.equal(a.getAttribute('class'), 'verpill up');
  assert.equal(a.getAttribute('href'), '#setup/updates');
  const current = JSON.parse(JSON.stringify(p)) as DashboardPayload;
  current.version = { installed: '1.13.0', latest: '1.13.0', publishedAt: null, update: false, checkedAt: null };
  const b = (await runPage([current])).dom.byId.ver.querySelectorAll('a')[0];
  assert.equal(b.textContent, 'prism-cli 1.13.0');
  assert.equal(b.getAttribute('class'), 'verpill');
});

test('page: crew workspaces read as crew: <name> in By project; the codeburn web pointer is shown', async () => {
  const { p } = await fixture();
  p.usage.topProjects = [{ name: 'workspace-member-reviewer', path: '/x/.kiro/crew/workspace-member-reviewer', cost: 3, sessions: 1 }];
  const t = (await runPage([p])).text();
  assert.match(t, /By projectcrew: reviewer/);
  assert.match(t, /codeburn web --period month · in the terminal: codeburn month/);
  assert.match(t, /API calls120Sessions7Projects3/);
});
