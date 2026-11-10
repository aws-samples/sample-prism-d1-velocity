/**
 * Dashboard 1.5: the summary object, truthful Security Agent status, the
 * skipped-run trend, repo ordering and collapsing, same-name labels, per-repo
 * spend, and the page script run against a payload in a tiny DOM stand-in.
 * Local files and fakes only: no codeburn, AWS or network calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeResult, writeResult, type PrismResult } from '../src/codewatch/results.js';
import { collectCodewatch } from '../src/dashboard/codewatch.js';
import { buildPayload, type DashboardPayload } from '../src/dashboard/payload.js';
import { renderPage } from '../src/dashboard/page.js';
import { repoLabels } from '../src/dashboard/repos.js';
import { CODEBURN_ADMIN_HELP, machineChecks, securitySetup, SETUP_DOCS, type CheckItem } from '../src/dashboard/setup.js';
import { buildSummary } from '../src/dashboard/summary.js';
import { emptyUsage, spendByRepo, type CodeburnExport, type UsagePanel } from '../src/dashboard/usage.js';

process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'prism-sum-gcfg-')), 'gitconfig');
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `prism-sum-${p}-`)));

function gitRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('git', ['init', '-q', `--template=${tmp('tpl')}`], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return dir;
}

const review = (at: string, status: PrismResult['status'], extra: Partial<PrismResult> = {}) => makeResult({
  kind: 'review', hook: 'pre-push', status, tool: 'kiro', started_at: at, finished_at: at, branch: 'main', commit: 'a'.repeat(40), ...extra,
});

/** codeburn exports with one month project per given path. */
function exporter(projects: Record<string, number>): CodeburnExport {
  return async (args) => args.includes('--from')
    ? { schema: 'codeburn.export.v2', summary: [{ 'Cost (USD)': 9, 'API Calls': 3, Sessions: 2 }], periods: [{ models: [] }],
      projects: Object.entries(projects).map(([Project, cost]) => ({ Project, 'Cost (USD)': cost, Sessions: 1 })) }
    : { schema: 'codeburn.export.v2', currency: { code: 'USD' }, summary: [{ Period: 'Today', 'Cost (USD)': 1.5, 'API Calls': 2, Sessions: 1 }] };
}

/** A home whose codeburn sync endpoint is configured (codeburn's ~/.config/codeburn/sync.json). */
function syncedHome(p: string): string {
  const home = tmp(p);
  mkdirSync(join(home, '.config', 'codeburn'), { recursive: true });
  writeFileSync(join(home, '.config', 'codeburn', 'sync.json'), JSON.stringify({ baseUrl: 'https://otel.example.com' }));
  return home;
}

const machineDeps = (home = syncedHome('mh')) => ({ home, env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', systemdAvailable: () => false });

// ---------------------------------------------------------------- summary

test('summary: newest review across repos, spend, and setup warnings with the first one', () => {
  const scan = (id: string, at: string, status: string, high = 0) => ({ id, started_at: at, branch: 'main', tool: 'kiro', model: null, status: status as any, high, medium: 1, low: 2, reason: status === 'skipped' ? 'no changes against upstream' : null });
  const repos = [
    { path: '/r/a', label: 'a', codewatch: { scans: [scan('a1', '2026-11-01T00:00:00Z', 'findings', 3)] }, setup: { status: 'ok' as const, detail: '' } },
    { path: '/r/b', label: 'work/b', codewatch: { scans: [scan('b2', '2026-11-09T00:00:00Z', 'skipped'), scan('b1', '2026-10-01T00:00:00Z', 'ok')] }, setup: { status: 'warn' as const, detail: 'hooksPath bypasses the global hooks' } },
    { path: '/r/c', label: 'c', codewatch: { scans: [] }, setup: { status: 'missing' as const, detail: 'not installed' } },
  ];
  const usage: UsagePanel = { ...emptyUsage('ok', ''), message: null, today: { cost: 1.25, calls: 1, sessions: 1 }, month: { cost: 40, calls: 9, sessions: 3, from: '2026-11-01', to: '2026-11-10' } };
  const machine: CheckItem[] = [
    { id: 'codeburn', label: 'codeburn installed', status: 'ok', detail: '0.9.24', fix: '' },
    { id: 'codeburn-sync', label: 'Scheduled codeburn sync push', status: 'warn', detail: 'cannot read your crontab', fix: 'x' },
    { id: 'codewatch-global', label: 'Codewatch global hooks', status: 'missing', detail: 'optional', fix: 'y' },
  ];
  const s = buildSummary(repos, usage, machine);
  assert.deepEqual(s.review, { repo: 'work/b', path: '/r/b', at: '2026-11-09T00:00:00Z', status: 'skipped', reason: 'no changes against upstream', high: 0, medium: 1, low: 2, reviewer: 'kiro', id: 'b2' });
  assert.deepEqual(s.spend, { status: 'ok', currency: 'USD', today: 1.25, month: 40, message: null });
  assert.deepEqual(s.warnings, { count: 2, first: 'Scheduled codeburn sync push: cannot read your crontab' });

  const none = buildSummary([], emptyUsage('not-installed', 'codeburn is not installed.'), []);
  assert.equal(none.review, null);
  assert.deepEqual(none.spend, { status: 'not-installed', currency: 'USD', today: null, month: null, message: 'codeburn is not installed.' });
  assert.deepEqual(none.warnings, { count: 0, first: null });
});

// ---------------------------------------------------------------- security status

test('security status: saved results without a marker are "in use", neither is "not set up"', () => {
  const repo = gitRepo(join(tmp('sec'), 'r'));
  assert.equal(securitySetup(repo).status, 'missing');
  assert.equal(securitySetup(repo, []).detail, 'not set up');
  const tm = makeResult({ kind: 'security-threat-model', hook: 'manual', status: 'findings', tool: 'security-agent', started_at: '2026-11-09T00:00:00Z', finished_at: '2026-11-09T01:00:00Z' });
  const pt = makeResult({ kind: 'security-pentest', hook: 'manual', status: 'ok', tool: 'security-agent', started_at: '2026-11-09T00:00:00Z', finished_at: '2026-11-09T01:00:00Z' });
  const s = securitySetup(repo, [tm, pt, review('2026-11-09T00:00:00Z', 'ok')]);
  assert.deepEqual(s, { status: 'in-use', detail: 'in use (threat model, pentest results found; no local marker)', fix: '' });
  assert.equal(securitySetup(repo, [review('2026-11-09T00:00:00Z', 'ok')]).status, 'missing', 'codewatch results are not Security Agent evidence');
});

// ---------------------------------------------------------------- trend

test('trend: skipped runs are left out by design and counted, so the page can say why the chart is empty', () => {
  const repo = gitRepo(join(tmp('tr'), 'r'));
  for (const [i, at] of ['2026-11-07T22:28:33Z', '2026-11-09T03:05:39Z', '2026-11-09T15:01:41Z'].entries()) {
    writeResult(repo, review(at, 'skipped', { reason: 'no changes against upstream', branch: `refs/tags/v1.${i}` }));
  }
  const cw = collectCodewatch(repo);
  assert.equal(cw.totalRuns, 3);
  assert.deepEqual(cw.trend, []);
  assert.equal(cw.skippedRuns, 3);
  writeResult(repo, review('2026-11-10T00:00:00Z', 'findings', { findings: [{ severity: 'high', category: 'security', file: 'a.ts', line: 1, rule: 'r', message: 'm' }] }));
  const after = collectCodewatch(repo);
  assert.equal(after.trend.length, 1);
  assert.equal(after.skippedRuns, 3);
  const html = renderPage('N');
  assert.match(html, /skipped runs have no findings to chart/);
});

// ---------------------------------------------------------------- labels

test('labels: same-named repos get the shortest parent path that tells them apart', () => {
  const l = repoLabels(['/h/workplace/prism-d1-velocity', '/h/workplace/old/prism-d1-velocity', '/h/x/app', '/h/y/x/app', '/h/z/x/app', '/h/solo']);
  assert.equal(l.get('/h/workplace/prism-d1-velocity'), 'workplace/prism-d1-velocity');
  assert.equal(l.get('/h/workplace/old/prism-d1-velocity'), 'old/prism-d1-velocity');
  assert.equal(l.get('/h/x/app'), 'h/x/app');
  assert.equal(l.get('/h/y/x/app'), 'y/x/app');
  assert.equal(l.get('/h/z/x/app'), 'z/x/app');
  assert.equal(l.get('/h/solo'), 'solo');
});

// ---------------------------------------------------------------- spend

test('spend: each codeburn project counts once, for the deepest repo containing it', () => {
  const m = spendByRepo([
    { path: '/h/ws/A', cost: 5, sessions: 1 },
    { path: '/h/ws/A/src/B', cost: 18, sessions: 2 },
    { path: '/h/ws/A/src/B/lib', cost: 1, sessions: 1 },
    { path: '/h/ws/A-other', cost: 7, sessions: 1 },
    { path: '/h/elsewhere', cost: 3, sessions: 1 },
  ], ['/h/ws/A', '/h/ws/A/src/B']);
  assert.deepEqual(m.get('/h/ws/A'), { cost: 5, sessions: 1 }, 'A-other is a sibling, not inside A');
  assert.deepEqual(m.get('/h/ws/A/src/B'), { cost: 19, sessions: 3 });
  assert.equal(m.size, 2);
});

// ---------------------------------------------------------------- payload ordering and collapsing

async function payloadFixture(deps = machineDeps()): Promise<{ home: string; p: DashboardPayload }> {
  const home = tmp('home');
  const names = ['quiet1', 'quiet2', 'quiet3', 'spender', 'sec', 'cw', 'workplace/dup', 'old/dup'];
  for (const n of names) gitRepo(join(home, n));
  writeResult(join(home, 'cw'), review('2026-11-09T00:00:00Z', 'skipped', { reason: 'no changes against upstream' }));
  writeResult(join(home, 'sec'), makeResult({ kind: 'security-threat-model', hook: 'manual', status: 'findings', tool: 'security-agent', started_at: '2026-11-09T00:00:00Z', finished_at: '2026-11-09T01:00:00Z' }));
  const p = await buildPayload({ cwd: tmp('nowhere'), home, exporter: exporter({ [join(home, 'spender')]: 12.5, [join(home, 'cw', 'pkg')]: 2 }), pathEnv: tmp('path'), machineDeps: deps });
  return { home, p };
}

test('payload: active repos first, the rest collapse; labels, spend and the summary are in --json', async () => {
  const { home, p } = await payloadFixture();
  assert.equal(p.repos.length, 8, 'every repo is still scanned and listed in --json');
  const setup = p.overview.setup.map((r) => [r.label, r.active, r.collapsed]);
  assert.deepEqual(setup.slice(0, 3).map((r) => r[0]).sort(), ['cw', 'sec', 'spender'], 'repos with activity first');
  assert.ok(setup.slice(0, 3).every((r) => r[1] === true && r[2] === false));
  assert.deepEqual(setup.slice(3).map((r) => r[2]), [true, true, true, true, true], 'the rest collapse into one line');
  const byLabel = Object.fromEntries(p.repos.map((r) => [r.label, r]));
  assert.ok(byLabel['workplace/dup'] && byLabel['old/dup'], 'same-named repos are told apart');
  assert.deepEqual(byLabel.spender.spend, { cost: 12.5, sessions: 1 });
  assert.equal(byLabel.cw.spend?.cost, 2, 'a project under the repo counts for it');
  assert.equal(byLabel.sec.security.status, 'in-use');
  assert.deepEqual(p.overview.codewatch.map((r) => [r.label, r.spendMonth]), [['cw', 2]]);
  assert.equal(p.summary.review?.repo, 'cw');
  assert.equal(p.summary.review?.status, 'skipped');
  assert.equal(p.summary.spend.month, 9);
  assert.ok(!JSON.stringify(p.summary).includes(home + '/quiet'), 'summary carries only the reviewed repo');
});

// ---------------------------------------------------------------- page script in a tiny DOM

/** Just enough DOM for the page script: elements, text, attributes, details.open and two selector shapes. */
function fakeDom() {
  class Node { childNodes: Node[] = []; parent: Node | null = null; nodeName = '#node';
    get textContent(): string { return this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(v: string) { this.childNodes = [new Text(String(v))]; }
    append(...kids: (Node | string)[]) { for (const k of kids) { const n = typeof k === 'string' ? new Text(k) : k; n.parent = this; this.childNodes.push(n); } }
    replaceChildren(...kids: Node[]) { this.childNodes = []; this.append(...kids); }
  }
  class Text extends Node { constructor(public data: string) { super(); this.nodeName = '#text'; }
    get textContent() { return this.data; } set textContent(v: string) { this.data = v; } }
  class Element extends Node {
    attrs = new Map<string, string>(); listeners: Record<string, () => void> = {};
    constructor(tag: string) { super(); this.nodeName = tag.toUpperCase(); }
    setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); }
    getAttribute(k: string) { return this.attrs.has(k) ? this.attrs.get(k)! : null; }
    hasAttribute(k: string) { return this.attrs.has(k); }
    get open() { return this.attrs.has('open'); } set open(v: boolean) { if (v) this.attrs.set('open', ''); else this.attrs.delete('open'); }
    get classList() { return { add: (c: string) => this.setAttribute('class', ((this.getAttribute('class') || '') + ' ' + c).trim()) }; }
    addEventListener(t: string, f: () => void) { this.listeners[t] = f; }
    all(): Element[] { return this.childNodes.flatMap((c) => (c instanceof Element ? [c, ...c.all()] : [])); }
    querySelectorAll(sel: string): Element[] {
      const m = /^([a-z]*)((?:\[[a-z-]+\])*)$/.exec(sel)!;
      const attrs = [...m[2].matchAll(/\[([a-z-]+)\]/g)].map((x) => x[1]);
      return this.all().filter((e) => (!m[1] || e.nodeName === m[1].toUpperCase()) && attrs.every((a) => e.hasAttribute(a)));
    }
  }
  const byId: Record<string, Element> = { main: new Element('main'), meta: new Element('span'), refresh: new Element('button') };
  const document = {
    visibilityState: 'visible',
    createElement: (t: string) => new Element(t),
    createElementNS: (_: string, t: string) => new Element(t),
    createTextNode: (s: string) => new Text(s),
    getElementById: (id: string) => byId[id],
    addEventListener: () => {},
  };
  return { Node, document, byId };
}

async function runPage(payloads: unknown[]) {
  const html = renderPage('N');
  const js = html.slice(html.indexOf('<script nonce="N">') + '<script nonce="N">'.length, html.lastIndexOf('</script>'));
  const dom = fakeDom();
  let i = 0;
  const fetch = async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(payloads[Math.min(i++, payloads.length - 1)])) });
  new Function('document', 'Node', 'fetch', 'setInterval', js)(dom.document, dom.Node, fetch, () => 0);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  return { dom, reload: async () => { dom.byId.refresh.listeners.click(); await settle(); }, text: () => dom.byId.main.textContent, meta: () => dom.byId.meta.textContent };
}

test('page: summary on top, collapsed repo lines, labels, trend note and one-line empty sections', async () => {
  const { p } = await payloadFixture();
  const page = await runPage([p]);
  const t = page.text();
  assert.ok(t.startsWith('Summary'), t.slice(0, 80));
  assert.match(t, /Latest codewatch review/);
  assert.match(t, /Latest codewatch reviewSkippedcw · .* · kiro · no changes against upstream/);
  assert.match(t, /Spend today\$1\.50codeburn, all projects/);
  assert.match(t, /Spend this month\$9\.00codeburn, this calendar month/);
  assert.match(t, /Setup warnings1gitleaks available: not on PATH/);
  assert.match(t, /5 other repos: not set up/, 'setup checklist');
  assert.match(t, /7 other repos: no codewatch/, 'codewatch per-repo section');
  assert.match(t, /workplace\/dup/);
  assert.match(t, /old\/dup/);
  assert.match(t, /Trend: nothing to chart\. All 1 run was skipped/);
  assert.match(t, /in use \(threat model results found; no local marker\)/);
  assert.match(t, /Nothing recorded yet/);
  assert.match(t, /AWS account: no checks yet\. Run prism-cli aws check/);
  assert.doesNotMatch(t, /No AWS account checks yet/, 'no full AWS panel');
  assert.match(t, /\$2\.00/, 'per-repo spend next to the codewatch row');
});

test('page: a refresh outlines values that changed since the previous load and keeps open sections open', async () => {
  const { p } = await payloadFixture();
  const next = JSON.parse(JSON.stringify(p)) as DashboardPayload;
  next.summary.spend.today = 99;
  const page = await runPage([p, next]);
  const group = page.dom.byId.main.querySelectorAll('details').find((d) => d.getAttribute('data-key') === 'setup:other')!;
  group.open = true;
  await page.reload();
  const changed = page.dom.byId.main.querySelectorAll('').filter((e) => (e.getAttribute('class') || '').includes('changed'));
  assert.deepEqual(changed.map((e) => e.getAttribute('data-track')), ['sum:today']);
  assert.match(changed[0].getAttribute('title') || '', /was 1\.5/);
  assert.match(page.meta(), /1 value changed \(outlined\)/);
  assert.ok(page.dom.byId.main.querySelectorAll('details').find((d) => d.getAttribute('data-key') === 'setup:other')!.open, 'stays open');
  const html = renderPage('N');
  assert.match(html, /document\.visibilityState === 'visible'/, 'auto-refresh pauses while hidden');
  assert.match(html, /AUTO_REFRESH_MS = 60000/);
  assert.match(html, /@media \(prefers-reduced-motion: no-preference\) \{ \.changed \{ animation/, 'motion only when not reduced');
});

test('page: the summary is a full-width card grid that stacks below 640px; long details are clamped with a title', async () => {
  const html = renderPage('N');
  assert.match(html, /\.summary \{ display:grid; gap:14px; grid-template-columns: repeat\(auto-fit, minmax\(220px, 1fr\)\); \}/);
  assert.match(html, /@media \(max-width: 640px\) \{ \.summary \{ grid-template-columns: 1fr;/);
  assert.match(html, /\.scard \.v \{[^}]*font-variant-numeric:tabular-nums/);
  assert.match(html, /\.scard \.d \{[^}]*overflow-wrap:anywhere[^}]*-webkit-line-clamp:3/);
  assert.match(html, /minmax\(min\(420px, 100%\), 1fr\)/, 'columns never force sideways scroll on a narrow screen');
  assert.match(html, /const s = el\('section', \{ class: 'card wide' \}, el\('h2', \{\}, 'Summary'\)\)/, 'spans every column');

  const { p } = await payloadFixture();
  const long = 'Scheduled codeburn sync push: ' + 'cannot read your crontab '.repeat(10);
  p.summary.warnings = { count: 2, first: long };
  p.summary.review = { ...p.summary.review!, status: 'findings', reason: null, high: 3, medium: 1, low: 0 };
  const page = await runPage([p]);
  const cards = page.dom.byId.main.querySelectorAll('div').filter((d) => d.getAttribute('class') === 'scard');
  assert.deepEqual(cards.map((c) => (c.childNodes[0] as any).textContent), ['Latest codewatch review', 'Spend today', 'Spend this month', 'Setup warnings']);
  for (const c of cards) assert.equal(c.childNodes.length, 3, 'label, value, one detail line');
  assert.equal((cards[0].childNodes[1] as any).textContent, '3high1med0low');
  const warnDetail = cards[3].childNodes[2] as any;
  assert.equal(warnDetail.getAttribute('class'), 'd');
  assert.equal(warnDetail.getAttribute('title'), long, 'full text in the title');
  assert.equal((cards[3].childNodes[1] as any).textContent, '2');
  assert.equal((cards[1].childNodes[2] as any).getAttribute('title'), null, 'short details get no title');
});

test('page: low counts have their own colour, apart from muted text, in both themes; dark summary cards are raised', () => {
  const html = renderPage('N');
  const light = /:root \{ color-scheme: light dark;[^}]*\}/.exec(html)![0];
  const dark = /@media \(prefers-color-scheme: dark\) \{ :root \{[^}]*\}/.exec(html)![0];
  const v = (block: string, name: string) => new RegExp(`--${name}:([^;]+);`).exec(block)![1];
  for (const b of [light, dark]) assert.notEqual(v(b, 'low'), v(b, 'muted'), 'low differs from muted');
  assert.notEqual(v(dark, 'raised'), v(dark, 'card'), 'dark cards differ from the panel');
  assert.notEqual(v(dark, 'raised'), v(dark, 'bg'));
  assert.match(html, /\.scard \{[^}]*background:var\(--raised\)/);
  assert.match(html, /class: rv\.low \? 'sev-low' : ''/, 'a zero low count keeps the default colour');
});


// ---------------------------------------------------------------- codeburn sync: ask your administrator

const syncRow = (home: string, scheduleExists: () => boolean) =>
  machineChecks({ pathEnv: tmp('none'), home, env: {}, scheduleExists, schedulerName: () => 'crontab', systemdAvailable: () => false, global: { state: 'not-installed', hooksPath: null, dir: '' } })
    .find((i) => i.id === 'codeburn-sync')!;

test('codeburn sync: no endpoint shows the ask-your-administrator hint with both links and counts as the first warning', async () => {
  const row = syncRow(tmp('noep'), () => true);
  assert.equal(row.status, 'missing');
  assert.deepEqual(row.help, CODEBURN_ADMIN_HELP);
  assert.match(row.help!.text, /^codeburn sync is not set up on this machine\. Ask your PRISM administrator .* prism-cli enable codeburn --url <collector URL>\.$/);
  assert.deepEqual(row.help!.links.map((l) => [l.label, l.url]), [
    ['Setup instructions', 'https://github.com/aws-samples/sample-prism-d1-velocity/blob/main/README.md#2-give-each-developer-a-telemetry-account'],
    ['Administrator guide', 'https://github.com/aws-samples/sample-prism-d1-velocity/blob/main/USER_GUIDE.md#administrator-setup'],
  ]);

  const { p } = await payloadFixture(machineDeps(tmp('noep2')));
  assert.deepEqual(p.summary.warnings, { count: 2, first: CODEBURN_ADMIN_HELP.text }, 'the hint, then gitleaks');
  const json = JSON.parse(JSON.stringify(p));
  assert.deepEqual(json.machine.setup.find((i: CheckItem) => i.id === 'codeburn-sync').help, CODEBURN_ADMIN_HELP, '--json carries the hint');

  const page = await runPage([p]);
  assert.match(page.text(), /Setup warnings2codeburn sync is not set up on this machine\. Ask your PRISM administrator/);
  const links = page.dom.byId.main.querySelectorAll('a').filter((a) => (a.getAttribute('href') || '').startsWith('https://github.com/aws-samples/'));
  assert.deepEqual(links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]), [
    ['Setup instructions', SETUP_DOCS.telemetryAccount, '_blank', 'noopener noreferrer'],
    ['Administrator guide', SETUP_DOCS.adminGuide, '_blank', 'noopener noreferrer'],
  ]);
});

test('codeburn sync: endpoint plus schedule shows no admin hint', () => {
  const row = syncRow(syncedHome('ep'), () => true);
  assert.equal(row.help, undefined);
  assert.match(row.detail, /^crontab entry installed/);
  assert.equal(buildSummary([], emptyUsage('ok', ''), [row]).warnings.first?.includes('administrator') ?? false, false);
});

test('codeburn sync: endpoint but no schedule keeps the self-fix and no admin hint', () => {
  const row = syncRow(syncedHome('ep2'), () => false);
  assert.equal(row.status, 'missing');
  assert.equal(row.help, undefined);
  assert.equal(row.fix, 'prism-cli enable codeburn');
  assert.deepEqual(buildSummary([], emptyUsage('ok', ''), [row]).warnings, { count: 0, first: null });
});
