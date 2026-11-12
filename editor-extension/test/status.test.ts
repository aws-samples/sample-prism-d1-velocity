import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePayload, PayloadError, repoView } from '../src/payload';
import { INSTALL_CMD, statusView } from '../src/status';
import { payload, repo, ROOT } from './fixtures';

const t = (iso: string) => `T(${iso})`;

test('ready: counts of the checked-out branch review, spend today and warnings', () => {
  const p = payload();
  const v = statusView({ kind: 'ready', payload: p, view: repoView(p, ROOT, 'main') }, t);
  assert.equal(v.text, '$(shield) PRISM: 1 high · 1 med | $12.40 today | 1 warning');
  assert.equal(v.command, 'prism.openPanel');
  assert.equal(v.tint, 'error');
  assert.match(v.tooltip, /Last review: T\(2026-11-10T10:00:00.000Z\) \(findings\)/);
  assert.match(v.tooltip, /Reviewer: kiro/);
  assert.match(v.tooltip, /Spend this month \(all repos\): \$210.00/);
  assert.match(v.tooltip, /Sync mode: local/);
});

test('ready on a branch with no review: newest review, noted as another branch', () => {
  const p = payload();
  const view = repoView(p, ROOT, 'no-such-branch');
  assert.equal(view.review?.branch, 'feature');
  assert.equal(view.review?.onBranch, false);
  const v = statusView({ kind: 'ready', payload: p, view }, t);
  assert.equal(v.text, '$(shield) PRISM: 0 high · 1 med | $12.40 today | 1 warning');
  assert.match(v.tooltip, /branch feature, so the Problems panel shows no markers/);
  assert.equal(v.tint, null);
});

test('repoView keeps only the selected review\'s findings', () => {
  const p = payload();
  const v = repoView(p, ROOT, 'main');
  assert.deepEqual(v.findings.map((f) => f.message), ['Token logged', 'Unchecked result']);
  assert.equal(v.review?.id, 'def-20261110T100000000Z-pre-push-review');
});

test('no review yet, spend not ok, no warnings', () => {
  const r = repo({ codewatch: { hasResults: false, findings: [], findingsTruncated: false, scans: [] } });
  const p = payload({ summary: { spend: { status: 'not-installed', currency: 'USD', today: null, month: null, message: 'codeburn is not installed' }, warnings: { count: 0, first: null } } }, r);
  const v = statusView({ kind: 'ready', payload: p, view: repoView(p, ROOT, 'main') }, t);
  assert.equal(v.text, '$(shield) PRISM: no review yet');
  assert.match(v.tooltip, /Spend: codeburn is not installed/);
});

test('codewatch off: Enable action', () => {
  const r = repo({ setup: { status: 'missing', reviewer: null, detail: 'no hooks', fix: '' }, codewatch: { hasResults: false, findings: [], findingsTruncated: false, scans: [] } });
  const p = payload({}, r);
  const v = statusView({ kind: 'ready', payload: p, view: repoView(p, ROOT, 'main') }, t);
  assert.equal(v.text, '$(shield) PRISM: codewatch off · Enable | $12.40 today | 1 warning');
  assert.equal(v.command, 'prism.enableCodewatch');
});

test('cli missing, loading and error states', () => {
  const m = statusView({ kind: 'cli-missing', reason: 'prism-cli is not on PATH', searched: ['PATH', '/home/user/.nvm/versions/node/*/bin', '/home/user/.local/bin'] });
  assert.equal(m.text, '$(shield) PRISM: install prism-cli');
  assert.ok(m.tooltip.includes(INSTALL_CMD));
  assert.match(m.tooltip, /Searched:\n  PATH\n  \/home\/user\/\.nvm\/versions\/node\/\*\/bin\n  \/home\/user\/\.local\/bin/);
  assert.match(m.tooltip, /prism\.cliPath .*`command -v prism-cli`/);
  assert.equal(m.command, 'prism.showInstallHint');
  assert.equal(statusView({ kind: 'loading' }).text, '$(sync~spin) PRISM');
  const e = statusView({ kind: 'error', message: 'boom\nsecond line' });
  assert.equal(e.command, 'prism.refresh');
  assert.ok(!e.tooltip.includes('boom\nsecond'), 'error text is one line');
});

test('recorded text in the tooltip is plain: controls and bidi overrides removed', () => {
  const r = repo();
  r.codewatch.scans[1].reason = 'evil\u202Etxt.exe\u0007';
  const p = payload({}, r);
  const v = statusView({ kind: 'ready', payload: p, view: repoView(p, ROOT, 'main') }, t);
  assert.ok(v.tooltip.includes('eviltxt.exe'));
  assert.ok(!/[\u202E\u0007]/.test(v.tooltip));
});

test('non-USD currency', () => {
  const p = payload({ summary: { spend: { status: 'ok', currency: 'EUR', today: 1, month: 2, message: null }, warnings: { count: 2, first: 'x' } } });
  assert.match(statusView({ kind: 'ready', payload: p, view: repoView(p, ROOT, 'main') }).text, /1\.00 EUR today \| 2 warnings$/);
});

test('parsePayload: rejects non-JSON and other schemas', () => {
  assert.throws(() => parsePayload('not json'), PayloadError);
  assert.throws(() => parsePayload('{"schema":"prism.dashboard.v1"}'), /Update prism-cli/);
  assert.equal(parsePayload(JSON.stringify(payload())).schema, 'prism.dashboard.v2');
});
