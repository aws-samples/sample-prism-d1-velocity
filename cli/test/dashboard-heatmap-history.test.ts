/**
 * The spend heatmap's earlier weeks (a second codeburn export, cached daily):
 * the payload's usage.history (ready / pending / error), the cache running it
 * after the month, the page's loading and unavailable states (never $0), the
 * date-range legend, and a snapshot that never says "loading". No codeburn calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPayload, type DashboardPayload } from '../src/dashboard/payload.js';
import { collectHistory, collectUsage, localDate, type CodeburnExport, type UsagePanel } from '../src/dashboard/usage.js';
import { UsageCache } from '../src/dashboard/usage-cache.js';
import { buildSnapshotHtml } from '../src/dashboard/snapshot.js';
import { SNAPSHOT_MARKERS as M } from '../src/dashboard/page.js';
import { FakeElement, runPage } from './page-dom.js';

process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'prism-hh-gcfg-')), 'gitconfig');
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `prism-hh-${p}-`)));
const NOW = new Date(2026, 10, 14, 12); // Saturday 2026-11-14; earlier weeks 2026-08-17..2026-10-31

const exportOf = (daily: { Date: string; cost: number }[]) => ({
  schema: 'codeburn.export.v2', currency: { code: 'USD' },
  summary: [{ 'Cost (USD)': 10, 'API Calls': 12, Sessions: 3, Projects: 1 }],
  periods: [{ daily: daily.map((d) => ({ Date: d.Date, 'Cost (USD)': d.cost, 'API Calls': 5, Sessions: 1 })), models: [], activity: [] }],
  projects: [],
});

/** Answers the month export at once; the earlier weeks with `prior` (a value or a thrown error). */
function exporter(prior: (() => unknown) = () => exportOf([{ Date: '2026-10-02', cost: 3 }])) {
  const seen: string[][] = [];
  const fn: CodeburnExport = async (a) => { seen.push(a); return a[1] === '2026-11-01' ? exportOf([{ Date: '2026-11-14', cost: 4 }]) : prior(); };
  return { fn, seen };
}

// ---------------------------------------------------------------- payload

test('history: wait (default) is ready with the weeks; defer is pending with only the month exported; a reused copy is ready', async () => {
  const w = exporter();
  const ready = await collectUsage({ exporter: w.fn, now: NOW });
  assert.deepEqual(ready.history, { status: 'ready', from: '2026-08-17', to: '2026-10-31' });
  assert.equal(ready.prior?.daily.length, 1);

  const d = exporter();
  const pending = await collectUsage({ exporter: d.fn, now: NOW, history: 'defer' });
  assert.deepEqual(pending.history, { status: 'pending', from: '2026-08-17', to: '2026-10-31' });
  assert.equal(pending.prior, null);
  assert.deepEqual(d.seen, [['--from', '2026-11-01', '--to', '2026-11-14']], 'the month alone');

  const r = exporter();
  const reused = await collectUsage({ exporter: r.fn, now: NOW, history: 'defer', prior: ready.prior });
  assert.equal(reused.history?.status, 'ready');
  assert.equal(r.seen.length, 1);
});

test('history: collectHistory gives the weeks, or an error with a short reason when the export fails, times out or is malformed', async () => {
  assert.equal((await collectHistory({ exporter: exporter().fn, now: NOW })).history.status, 'ready');
  const boom = await collectHistory({ exporter: exporter(() => { throw new Error('codeburn: database locked\n  at line 2'); }).fn, now: NOW });
  assert.deepEqual(boom, { prior: null, history: { status: 'error', from: '2026-08-17', to: '2026-10-31', error: 'codeburn: database locked' } });
  const slow = await collectHistory({ exporter: exporter(() => { throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }); }).fn, now: NOW });
  assert.equal(slow.history.error, 'codeburn did not answer within 60 s');
  const odd = await collectHistory({ exporter: exporter(() => ({ schema: 'other' })).fn, now: NOW });
  assert.equal(odd.history.error, 'unrecognised codeburn export');
  const none = await collectHistory({ pathEnv: tmp('nopath'), now: NOW });
  assert.equal(none.history.error, 'codeburn is not installed');
});

test('history: the cache writes the month at once, runs the earlier weeks after it and merges them in; settled() waits for both', async () => {
  const file = join(tmp('uc'), 'usage.json');
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const e = exporter();
  const cache = new UsageCache({
    file, now: () => NOW,
    collect: (prior) => collectUsage({ exporter: e.fn, now: NOW, prior, history: 'defer' }),
    collectHistory: async () => { await gate; return collectHistory({ exporter: e.fn, now: NOW }); },
  });
  const first = await cache.get();
  assert.equal(first.usage.history?.status, 'pending');
  assert.equal(cache.peek()?.history?.status, 'pending', 'the month is cached while the weeks load');
  release();
  const done = await cache.settled();
  assert.equal(done?.history?.status, 'ready');
  assert.equal(done?.prior?.daily[0].date, '2026-10-02');
  assert.equal(done?.month?.cost, 10, 'the month is kept');

  const bad = new UsageCache({
    file: join(tmp('uc2'), 'usage.json'), now: () => NOW,
    collect: (prior) => collectUsage({ exporter: e.fn, now: NOW, prior, history: 'defer' }),
    collectHistory: () => collectHistory({ exporter: exporter(() => { throw new Error('offline'); }).fn, now: NOW }),
  });
  await bad.get();
  assert.deepEqual((await bad.settled())?.history, { status: 'error', from: '2026-08-17', to: '2026-10-31', error: 'offline' });
});

// ---------------------------------------------------------------- page

function gitRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', `--template=${tmp('tpl')}`], { cwd: dir });
  return dir;
}

/** A payload whose month is today's real month, with the given history state. */
async function payload(state: 'ready' | 'pending' | 'error'): Promise<DashboardPayload> {
  const home = tmp('home');
  gitRepo(join(home, 'r'));
  const today = localDate(new Date());
  const ex: CodeburnExport = async (a) => a[1] === `${today.slice(0, 8)}01` ? exportOf([{ Date: today, cost: 4 }]) : exportOf([{ Date: a[1], cost: 7 }]);
  const p = await buildPayload({
    cwd: tmp('nowhere'), home, pathEnv: tmp('path'),
    usage: async () => {
      const u = await collectUsage({ exporter: ex, history: state === 'ready' ? 'wait' : 'defer' });
      if (state === 'error') u.history = { ...u.history!, status: 'error', error: 'codeburn did not answer within 60 s' };
      return { usage: u, cacheHit: false };
    },
    machineDeps: { home, env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', systemdAvailable: () => false },
  });
  return p;
}

const heat = (page: Awaited<ReturnType<typeof runPage>>) => {
  const cells = page.dom.byId.main.querySelectorAll('i').filter((i) => (i.parent as FakeElement).getAttribute('class') === 'heat');
  const note = page.dom.byId.main.byClass('heat-note')[0];
  return { cells, note };
};

test('page: while the earlier weeks load, their days are "no data" with a loading pattern and a polite note; never $0', async () => {
  const page = await runPage([await payload('pending')]);
  const { cells, note } = heat(page);
  const loading = cells.filter((c) => c.getAttribute('class') === 'nd pending');
  assert.ok(loading.length > 30, `${loading.length} loading cells`);
  assert.ok(loading.every((c) => /: loading$/.test(c.getAttribute('title') || '')));
  const before = localDate(new Date()).slice(0, 8) + '01';
  assert.ok(!cells.some((c) => (c.getAttribute('title') || '') < before && /\$|no usage/.test(c.getAttribute('title') || '')), 'no earlier day says $0 or no usage');
  assert.equal(note.textContent, 'Loading earlier weeks from codeburn...');
  assert.equal(note.getAttribute('aria-live'), 'polite');
  assert.equal(note.hidden, false);
});

test('page: when the weeks land the note goes and the days are drawn; on an error they stay "no data" with the reason', async () => {
  const ready = heat(await runPage([await payload('ready')]));
  assert.equal(ready.note.hidden, true);
  assert.ok(!ready.cells.some((c) => /pending/.test(c.getAttribute('class') || '')));
  assert.ok(ready.cells.some((c) => /^l[1-4]$/.test(c.getAttribute('class') || '') && (c.getAttribute('title') || '') < localDate(new Date()).slice(0, 8)), 'an earlier day with spend');

  const err = heat(await runPage([await payload('error')]));
  assert.equal(err.note.textContent, 'Earlier weeks unavailable: codeburn did not answer within 60 s');
  assert.ok(err.cells.filter((c) => c.getAttribute('class') === 'nd').length > 30);
  assert.ok(!err.cells.some((c) => /pending/.test(c.getAttribute('class') || '')));
});

test('page: a pending load redraws when the weeks land (a reload with the new data removes the note)', async () => {
  const page = await runPage([await payload('pending'), await payload('ready')]);
  assert.equal(heat(page).note.textContent, 'Loading earlier weeks from codeburn...');
  await page.reload();
  assert.equal(heat(page).note.hidden, true);
});

test('page: the legend names the date range the heatmap covers', async () => {
  const page = await runPage([await payload('ready')]);
  const range = page.dom.byId.main.byClass('range')[0];
  const first = heat(page).cells[0].getAttribute('title')!.slice(0, 10);
  assert.equal(range.textContent, first + ' to ' + localDate(new Date()));
});

// ---------------------------------------------------------------- snapshot

test('snapshot: earlier weeks still pending are written as unavailable, so the file never says "loading"', async () => {
  const h = tmp('snap');
  const repo = gitRepo(join(h, 'work', 'r'));
  const pending = (await payload('pending')).usage as UsagePanel;
  const html = await buildSnapshotHtml({
    cwd: repo, home: h, version: '9.9.9', pathEnv: '', env: {},
    machineDeps: { home: h, env: {}, scheduleExists: () => false, schedulerName: () => 'cron', systemdAvailable: () => false },
    usage: async () => ({ usage: pending, cacheHit: true }),
  });
  const a = html.indexOf(M.data) + M.data.length;
  const data = JSON.parse(html.slice(a, html.indexOf(M.scriptEnd, a)));
  assert.deepEqual(data.data.usage.history, { ...pending.history, status: 'error', error: 'not loaded when this snapshot was written' });
});
