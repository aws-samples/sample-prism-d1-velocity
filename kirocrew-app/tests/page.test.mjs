// Renders the page with a stub createElement and a fixture model; run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, digestParts, nextDigestDay, renderModel, renderNeedsCache, withTimes } from '../ui/index.mjs';

const h = (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat() });
const walk = (n, f) => { if (n && typeof n === 'object') { f(n); n.children.forEach((c) => walk(c, f)); } };
const texts = (n) => { const out = []; walk(n, (x) => x.children.forEach((c) => typeof c === 'string' && out.push(c))); return out; };

const evil = '<img src=x onerror=alert(1)>';
const model = {
  generatedAt: '2026-11-12T10:00:00Z', version: '1.8.0', usageUpdatedAt: '2026-11-12T09:58:00Z', usageStale: false,
  cards: [{ title: 'AI spend today', value: '$1.50', detail: '1 call' }],
  topModels: [{ name: 'model-a', value: '$3.00' }], topProjects: [],
  checklist: [{ key: 'm:gitleaks', label: 'gitleaks', status: 'missing', detail: 'not on PATH', fix: 'brew install gitleaks' }],
  repos: [{ name: evil, review: '1 high · 0 med · 0 low', reviewAt: '2026-11-12T09:55:00Z', badge: { text: '1 high', tone: 'error' }, tone: 'error', hooks: 'hooks on',
    commit: { sha: 'abc1234', at: '2026-11-12T09:00:00Z', subject: 's' },
    findings: [{ severity: 'high', location: 'a.ts:1', message: evil, branch: 'main' }], more: '1 more finding not listed', hasReport: true }],
  reposNote: '1 of 2 repos', digest: { recorded: false, lastRunAt: '', lastNotifiedAt: '', lastMessage: '' },
};
const NOW = Date.parse('2026-11-12T10:00:00Z');

test('recorded text is only ever a text child', () => {
  const tree = renderModel(h, model, { report: null, copy() {}, openReport() {}, refresh() {} });
  walk(tree, (n) => {
    assert.ok(!('dangerouslySetInnerHTML' in n.props), 'no innerHTML');
    for (const [k, v] of Object.entries(n.props)) if (typeof v === 'string') assert.ok(!v.includes(evil), `prop ${k} carries no data`);
  });
  const t = texts(tree);
  assert.ok(t.includes(evil));
  assert.ok(t.includes('brew install gitleaks'));
  assert.ok(t.includes('Repositories with codewatch'));
  assert.ok(t.includes('1 more finding not listed'));
});

test('open report sends only the repo index', () => {
  const calls = [];
  const tree = renderModel(h, model, { report: null, openReport: (i) => calls.push(i) });
  walk(tree, (n) => { if (n.tag === 'button' && n.children.includes('Open report')) n.props.onClick(); });
  assert.deepEqual(calls, [0]);
});

test('report iframe is sandboxed with no permissions', () => {
  const tree = renderModel(h, model, { report: { index: 0, repo: 'r', note: 'covers abc', html: '<script>x</script>' }, downloadReport() {}, closeReport() {} });
  const frames = [];
  walk(tree, (n) => n.tag === 'iframe' && frames.push(n));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].props.sandbox, '');
  assert.equal(frames[0].props.srcDoc, '<script>x</script>');
  assert.ok(texts(tree).includes('covers abc'));
});

test('no usage cache: explains and offers the export only as a button', () => {
  const t = texts(renderNeedsCache(h, { loading: false }));
  assert.ok(t.includes('Load now (runs codeburn export)'));
});

const spans = (n) => { const out = []; walk(n, (x) => x.tag === 'span' && out.push(x)); return out; };

test('repo badge comes from the latest review, hook status is small text', () => {
  const tree = renderModel(h, model, { report: null, now: NOW });
  const t = texts(tree);
  assert.ok(t.includes('1 high'));
  assert.ok(t.includes('hooks on'));
  assert.ok(!t.some((s) => s.startsWith('codewatch ')));
  const badge = spans(tree).find((s) => s.children.includes('1 high'));
  assert.equal(badge.props.title, 'Latest review: 1 high · 0 med · 0 low');
  let border = '';
  walk(tree, (n) => { if (n.tag === 'li' && n.props.style && n.props.style.borderLeft) border = n.props.style.borderLeft; });
  assert.ok(border.includes('--danger'), 'left border uses the badge tone');
});

test('timestamps are relative with the full time as a tooltip', () => {
  const m = { ...model, generatedAt: '2026-11-12T09:58:00Z', usageUpdatedAt: '2026-11-12T09:54:00Z',
    checklist: [{ label: 'sync', status: 'ok', detail: 'last sync log write 2026-11-12T07:00:10.185Z', fix: '' }] };
  const tree = renderModel(h, m, { report: null, now: NOW });
  const t = texts(tree);
  for (const s of ['updated ', '2 min ago', ' · usage cached ', '6 min ago', 'last sync log write ', '3 h ago', '1 h ago', '5 min ago']) assert.ok(t.includes(s), s);
  assert.ok(!t.some((s) => /\d{4}-\d{2}-\d{2}T/.test(s)), 'no raw ISO left on the page');
  const tip = spans(tree).find((s) => s.children.includes('2 min ago'));
  assert.equal(tip.props.title, new Date('2026-11-12T09:58:00Z').toLocaleString());
  // The same model at a later clock re-renders the relative text.
  assert.ok(texts(renderModel(h, m, { report: null, now: NOW + 60 * 60000 })).includes('1 h ago'));
});

test('withTimes keeps text around a stamp and ignores dates without a time', () => {
  assert.deepEqual(withTimes(h, 'month 2026-11-01 to 2026-11-12', NOW), ['month 2026-11-01 to 2026-11-12']);
  const parts = withTimes(h, 'at 2026-11-12T09:30:00Z.', NOW);
  assert.equal(parts[0], 'at ');
  assert.deepEqual(parts[1].children, ['30 min ago']);
  assert.equal(parts[2], '.');
  assert.equal(ago('bad', NOW), 'unknown');
});

test('last digest lines', () => {
  const morning = new Date(2026, 10, 12, 8, 0).getTime();
  const noon = new Date(2026, 10, 12, 12, 0).getTime();
  assert.equal(nextDigestDay(morning), 'today');
  assert.equal(nextDigestDay(noon), 'tomorrow');
  assert.deepEqual(digestParts(h, { recorded: false }, morning).parts, ['Not run yet. First run: today at 09:00.']);
  assert.deepEqual(digestParts(h, null, noon).parts, ['Not run yet. First run: tomorrow at 09:00.']);
  const run = new Date(2026, 10, 12, 9, 0).toISOString();
  const flat = (parts) => parts.map((p) => (typeof p === 'string' ? p : p.children.join(''))).join('');
  const quiet = digestParts(h, { recorded: true, lastRunAt: run, lastNotifiedAt: '', lastMessage: '' }, noon);
  assert.equal(flat(quiet.parts), 'Last run 3 h ago · nothing new');
  assert.equal(quiet.message, '');
  const sent = digestParts(h, { recorded: true, lastRunAt: run, lastNotifiedAt: run, lastMessage: 'PRISM daily digest\n- x' }, noon);
  assert.equal(flat(sent.parts), 'Last run 3 h ago · notified:');
  assert.equal(sent.message, 'PRISM daily digest\n- x');
  // An older notification than the last run is not this run's news.
  assert.equal(digestParts(h, { recorded: true, lastRunAt: run, lastNotifiedAt: '2026-11-01T09:00:00Z', lastMessage: 'old' }, noon).message, '');
  assert.match(digestParts(h, { recorded: true, lastRunAt: '' }, noon).parts[0], /state from v0\.1/);
});
