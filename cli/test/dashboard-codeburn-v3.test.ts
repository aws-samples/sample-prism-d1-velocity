/**
 * Tests for 1.21.15: codeburn export v3 (codeburn 0.9.28, camelCase keys) read
 * as v2 is, an unknown schema or a v3 export without the expected keys refused
 * with an error that names it, "loading" once codeburn is on PATH, and a usage
 * cache that is not served across a codeburn binary change.
 * The fixtures are made-up exports of one demo month. No codeburn, AWS or network calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeburnStats, collectUsage, emptyUsage, exportKeys, type CodeburnExport, type UsagePanel } from '../src/dashboard/usage.js';
import { UsageCache } from '../src/dashboard/usage-cache.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dashboard');
const fixture = (v: 'v2' | 'v3') => JSON.parse(readFileSync(join(FIX, `codeburn-export-${v}.json`), 'utf8'));
const NOW = new Date(2026, 10, 4, 12); // 2026-11-04, the fixtures' last day
const PRIOR = { from: '2026-08-10', to: '2026-10-31', day: '2026-11-04', daily: [] };
const collect = (j: unknown, version = '0.9.28') => collectUsage({ exporter: async () => j, now: NOW, prior: PRIOR, codeburnVersion: () => version });

/** The panel minus the collection time and the history range. */
const comparable = (u: UsagePanel) => ({ ...u, updatedAt: null, history: undefined, prior: undefined });

test('codeburn v3: the made-up month reads as its v2 twin: totals, today, daily rows, models, projects, activity, tools, tokens', async () => {
  const v2 = await collect(fixture('v2'), '0.9.27');
  const v3 = await collect(fixture('v3'));
  assert.equal(v3.status, 'ok', v3.message ?? '');
  assert.deepEqual(v3.month, { cost: 4.5, calls: 36, sessions: 6, from: '2026-11-01', to: '2026-11-04' });
  assert.deepEqual(v3.today, { cost: 0.75, calls: 6, sessions: 1 });
  assert.deepEqual(v3.daily!.map((d) => d.date), ['2026-11-02', '2026-11-03', '2026-11-04']);
  assert.deepEqual(v3.topModels, [{ name: 'demo-model-large', cost: 3.5, calls: 24 }, { name: 'demo-model-small', cost: 1, calls: 12 }]);
  assert.deepEqual(v3.topProjects.map((p) => [p.name, p.cost, p.sessions]), [['demo-shop', 3.25, 4], ['payments-api', 1.25, 2]]);
  assert.deepEqual(v3.codeburn, {
    calls: 36, sessions: 6, projects: 2,
    tokens: { input: 3500, output: 700, cacheRead: 10500 },
    activity: [{ name: 'Feature Dev', cost: 3 }, { name: 'Debugging', cost: 1.5 }],
    tools: [{ name: 'Read', calls: 40 }, { name: 'Edit', calls: 15 }, { name: 'Bash', calls: 9 }],
  });
  assert.deepEqual(comparable(v3), comparable(v2), 'v2 and v3 of the same month give the same panel');
});

test('codeburn v2: still read, including a cost column in another currency', async () => {
  const v2 = await collect(fixture('v2'), '0.9.27');
  assert.equal(v2.status, 'ok');
  assert.equal(v2.month!.cost, 4.5);
  const eur = JSON.parse(JSON.stringify(fixture('v2')).replaceAll('(USD)', '(EUR)'));
  eur.currency.code = 'EUR';
  const u = await collect(eur, '0.9.27');
  assert.equal(u.currency, 'EUR');
  assert.equal(u.month!.cost, 4.5, "v2 names the cost column after the currency: 'Cost (EUR)'");
  assert.equal(codeburnStats(eur).activity[0]!.cost, 3);
});

test('codeburn export: an unknown schema version is an error that names it and the codeburn version, never zeros', async () => {
  const v4 = { ...fixture('v3'), schema: 'codeburn.export.v4' };
  const u = await collect(v4, '0.9.40');
  assert.equal(u.status, 'error');
  assert.match(u.message!, /^codeburn 0\.9\.40 wrote an export with "codeburn\.export\.v4"; prism-cli reads codeburn\.export\.v2 and codeburn\.export\.v3\. Update prism-cli: npm i -g @prism-d1\/cli$/);
  assert.equal(u.month, null);
  assert.equal(exportKeys(v4), null);
  const none = await collect({ summary: [] }, 'codeburn 0.9.40');
  assert.match(none.message!, /^codeburn 0\.9\.40 wrote an export with no schema;/, 'a "codeburn " prefix in --version is not doubled');
  const unknownVersion = await collectUsage({ exporter: async () => v4, now: NOW, prior: PRIOR });
  assert.match(unknownVersion.message!, /^codeburn wrote an export with "codeburn\.export\.v4"/, 'no version known: just "codeburn"');
});

test('codeburn v3 without the expected keys: an error naming the codeburn version, not "no usage"', async () => {
  // v3 schema with v2 rows: what a mislabelled export, or renamed keys in a later v3, would look like.
  const mislabelled = { ...fixture('v2'), schema: 'codeburn.export.v3' };
  const u = await collect(mislabelled);
  assert.equal(u.status, 'error');
  assert.match(u.message!, /^codeburn 0\.9\.28 wrote a codeburn\.export\.v3 export without the fields prism-cli reads \(cost, apiCalls, sessions, date\)/);
  // Only the daily rows renamed: still refused.
  const j = fixture('v3');
  j.periods[0].daily = j.periods[0].daily.map(({ date, ...r }: any) => ({ ...r, day: date }));
  assert.equal((await collect(j)).status, 'error');
  // A real empty month (all keys present, zeros) is still "no data".
  const empty = fixture('v3');
  empty.summary[0] = { ...empty.summary[0], cost: 0, apiCalls: 0, sessions: 0, projects: 0 };
  empty.periods[0].daily = [];
  const e = await collect(empty);
  assert.equal(e.status, 'no-data');
});

test('codeburn v3: the earlier weeks of the heatmap are read from a v3 export too', async () => {
  const month = fixture('v3');
  const weeks = { ...fixture('v3'), periods: [{ label: 'x', daily: [{ date: '2026-10-02', cost: 3, apiCalls: 1, sessions: 1 }, { date: '2026-07-01', cost: 9 }] }] };
  const exporter: CodeburnExport = async (a) => (a[1] === '2026-11-01' ? month : weeks);
  const u = await collectUsage({ exporter, now: NOW });
  assert.equal(u.history!.status, 'ready');
  assert.deepEqual(u.prior!.daily, [{ date: '2026-10-02', cost: 3 }], 'rows outside the range dropped');
  const v4 = await collectUsage({ exporter: async (a) => (a[1] === '2026-11-01' ? month : { ...weeks, schema: 'codeburn.export.v4' }), now: NOW });
  assert.equal(v4.history!.status, 'error');
  assert.match(v4.history!.error!, /codeburn\.export\.v4/);
});

// ---------------------------------------------------------------- the usage cache and codeburn's binary

const okPanel = (cost: number): UsagePanel => ({
  ...emptyUsage('ok', ''), message: null, today: { cost, calls: 1, sessions: 1 }, month: { cost, calls: 1, sessions: 1, from: '2026-11-01', to: '2026-11-04' }, updatedAt: NOW.toISOString(),
});

test('usage cache: a panel cached with another codeburn binary is not served; the next read exports again', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'prism-cbv3-')), 'usage.json');
  let binary: string | null = 'cb-0.9.27';
  let runs = 0;
  const cache = new UsageCache({ file, now: () => NOW, binary: () => binary, collect: async () => { runs++; return okPanel(runs); } });
  await cache.get();
  assert.equal(cache.peek()!.month!.cost, 1);
  binary = 'cb-0.9.28';
  assert.equal(cache.peek(), null, 'written by the old binary');
  const r = await cache.get();
  assert.equal(r.cacheHit, false);
  assert.equal(r.usage.month!.cost, 2);
  assert.equal(cache.peek()!.month!.cost, 2, 'stored with the new binary');
  // A cache with no binary (prism-cli before 1.21.15) is not served either.
  const old = new UsageCache({ file, now: () => NOW, collect: async () => okPanel(9) });
  await old.refresh();
  assert.equal(cache.peek(), null);
  // Without the dep (prism-cli mcp reads the cache only), the binary is not checked.
  assert.equal(old.peek()!.month!.cost, 9);
});

test('usage cache: "not installed" turns into loading (null) once codeburn is on PATH, until the first export answers', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'prism-cbv3-')), 'usage.json');
  let binary: string | null = null;
  let release!: () => void;
  const cache = new UsageCache({
    file, now: () => NOW, binary: () => binary,
    collect: async () => (binary ? new Promise<UsagePanel>((res) => { release = () => res(okPanel(5)); }) : emptyUsage('not-installed', 'codeburn is not installed.')),
  });
  await cache.get();
  assert.equal(cache.current()!.status, 'not-installed');
  binary = 'cb-0.9.28'; // Set up codeburn finished
  assert.equal(cache.current(), null, 'the page shows "loading", not the setup button again');
  const running = cache.get();
  assert.equal(cache.current(), null, 'still loading while the export runs');
  release();
  assert.equal((await running).usage.status, 'ok');
  assert.equal(cache.current()!.status, 'ok');
});
