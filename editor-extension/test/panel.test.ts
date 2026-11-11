import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findingsToDiagnostics } from '../src/diagnostics';
import { codewatchOff, repoView } from '../src/payload';
import { panelHtml, panelModel, parsePanelMessage, REPORT_CSP, withReportCsp } from '../src/panel-model';
import { payload, ROOT } from './fixtures';

const t = (iso: string) => iso.slice(0, 10);

function model() {
  const p = payload();
  const v = repoView(p, ROOT, 'main');
  const diags = findingsToDiagnostics(v.findings, ROOT, (f) => f.endsWith('src/a.ts'));
  return panelModel(p, v, diags, codewatchOff(v.repo), t);
}

test('panel model: cards, findings with clickable ones mapped to diagnostics, checklist with fixes', () => {
  const m = model();
  assert.deepEqual(m.cards.map((c) => c.title), ['Latest review', 'AI spend', 'Setup warnings', 'Sync mode']);
  assert.equal(m.cards[0].value, '1 high · 1 med · 0 low');
  assert.equal(m.cards[1].detail, '$210.00 this month (all repos) · $3.50 in this repo');
  assert.deepEqual(m.findings.map((f) => [f.location, f.openable, f.index]), [['src/b.ts:3', false, -1], ['src/a.ts:12', true, 0]]);
  assert.deepEqual(m.checklist.map((c) => [c.key, c.group, c.fix]), [
    ['m:codeburn', 'This machine', ''],
    ['m:gitleaks', 'This machine', 'brew install gitleaks'],
    ['r:codewatch', 'This repo', ''],
    ['r:security', 'This repo', 'prism-cli enable security'],
  ]);
  assert.equal(m.hasReport, true);
});

test('panel messages are checked against the model', () => {
  const m = model();
  assert.deepEqual(parsePanelMessage({ type: 'open', index: 0 }, m), { type: 'open', index: 0 });
  assert.equal(parsePanelMessage({ type: 'open', index: -1 }, m), null, 'a finding without a file is not openable');
  assert.equal(parsePanelMessage({ type: 'open', index: 9 }, m), null);
  assert.equal(parsePanelMessage({ type: 'open', index: '0' }, m), null);
  assert.deepEqual(parsePanelMessage({ type: 'copy', key: 'm:gitleaks' }, m), { type: 'copy', key: 'm:gitleaks' });
  assert.equal(parsePanelMessage({ type: 'copy', key: 'm:codeburn' }, m), null, 'nothing to copy');
  assert.equal(parsePanelMessage({ type: 'run', command: 'rm -rf /' }, m), null);
  assert.equal(parsePanelMessage('refresh', m), null);
  assert.deepEqual(parsePanelMessage({ type: 'refresh' }, m), { type: 'refresh' });
});

test('panel HTML: strict CSP, nonce on the one script, no data, nothing remote', () => {
  const html = panelHtml({ nonce: 'N0nce', cspSource: 'vscode-resource:', scriptUri: 'vscode-resource:/media/panel.js', styleUri: 'vscode-resource:/media/panel.css' });
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-N0nce'/);
  assert.ok(!/unsafe-inline|unsafe-eval|https?:/.test(html));
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.match(html, /<script nonce="N0nce" src=/);
});

test('panel script draws recorded text with textContent only', () => {
  const js = readFileSync(join(__dirname, '..', '..', 'media', 'panel.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|\.href\s*=|setAttribute\(/.test(js));
  assert.match(js, /textContent/);
});

test('report HTML gets a no-script CSP', () => {
  assert.equal(withReportCsp('<html><head><title>x</title></head></html>'), `<html><head><meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}"><title>x</title></head></html>`);
  assert.match(withReportCsp('<p>bare</p>'), /^<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy"/);
  assert.ok(!REPORT_CSP.includes('script-src'));
});
