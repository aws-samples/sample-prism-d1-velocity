// Renders the page with a stub createElement and a fixture model; run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderModel, renderNeedsCache } from '../ui/index.mjs';

const h = (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat() });
const walk = (n, f) => { if (n && typeof n === 'object') { f(n); n.children.forEach((c) => walk(c, f)); } };
const texts = (n) => { const out = []; walk(n, (x) => x.children.forEach((c) => typeof c === 'string' && out.push(c))); return out; };

const evil = '<img src=x onerror=alert(1)>';
const model = {
  generatedAt: '2026-11-12T10:00:00Z', version: '1.8.0', usageUpdatedAt: '2026-11-12T09:58:00Z', usageStale: false,
  cards: [{ title: 'AI spend today', value: '$1.50', detail: '1 call' }],
  topModels: [{ name: 'model-a', value: '$3.00' }], topProjects: [],
  checklist: [{ key: 'm:gitleaks', label: 'gitleaks', status: 'missing', detail: 'not on PATH', fix: 'brew install gitleaks' }],
  repos: [{ name: evil, review: '1 high · 0 med · 0 low', when: '5 min ago', status: 'ok', tone: 'error', commit: 'abc · 1 h ago · s',
    findings: [{ severity: 'high', location: 'a.ts:1', message: evil, branch: 'main' }], more: '1 more finding not listed', hasReport: true }],
  reposNote: '1 of 2 repos', digest: { ran: '2 min ago', notified: 'never', message: '' },
};

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
