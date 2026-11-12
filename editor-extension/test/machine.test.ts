import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machineDashboardRun } from '../src/cli';
import { machinePanelModel, panelModel, parsePanelMessage } from '../src/panel-model';
import { codewatchOff, repoView } from '../src/payload';
import { OPEN_REPO_HINT, statusView } from '../src/status';
import { HOME, machinePayload, payload, ROOT } from './fixtures';

const t = (iso: string) => `T(${iso})`;

test('machine mode argv: no --root, run from the home folder, --fresh only when asked', () => {
  assert.deepEqual(machineDashboardRun(false, HOME), { args: ['dashboard', '--json'], cwd: HOME });
  assert.deepEqual(machineDashboardRun(true, HOME), { args: ['dashboard', '--json', '--fresh'], cwd: HOME });
  assert.ok(!machineDashboardRun(false).args.includes('--root'));
});

test('machine mode status: spend today and warnings, no review counts', () => {
  const v = statusView({ kind: 'machine', payload: machinePayload() }, t);
  assert.equal(v.text, '$(shield) PRISM: $34.08 today | 1 warning');
  assert.equal(v.command, 'prism.openPanel');
  assert.equal(v.tint, null);
  const none = statusView({ kind: 'machine', payload: machinePayload({ summary: { spend: { status: 'not-installed', currency: 'USD', today: null, month: null, message: 'codeburn is not installed' }, warnings: { count: 0, first: null }, review: null } }) }, t);
  assert.equal(none.text, '$(shield) PRISM');
  assert.match(none.tooltip, /Spend: codeburn is not installed/);
  assert.match(none.tooltip, /No pre-push review recorded in any repo yet/);
});

test('machine mode tooltip: month spend, latest review, repos with codewatch, open-a-repo line', () => {
  const tip = statusView({ kind: 'machine', payload: machinePayload() }, t).tooltip;
  assert.match(tip, /Spend this month: \$480\.14/);
  assert.match(tip, /Latest review: app, T\(2026-11-11T10:00:00\.000Z\) \(2 high, 1 medium, 0 low\)/);
  assert.match(tip, /Repos with codewatch: 2 of 3/);
  assert.ok(tip.includes(OPEN_REPO_HINT));
  assert.equal(OPEN_REPO_HINT, 'Open a repository folder to see its findings.');
});

test('machine panel model: spend cards, top lists by name only, machine checklist, repos with codewatch', () => {
  const m = machinePanelModel(machinePayload(), t);
  assert.equal(m.mode, 'machine');
  assert.deepEqual(m.cards.map((c) => [c.title, c.value, c.detail]), [
    ['AI spend today', '$34.08', '79 calls · 1 session'],
    ['AI spend this month', '$480.14', '1301 calls · 453 sessions · 2026-11-01 to 2026-11-12'],
    ['Setup warnings', '1', 'gitleaks available: not on PATH'],
  ]);
  assert.deepEqual(m.topModels, [{ name: 'Model A', value: '$478.64 · 1240 calls' }]);
  assert.deepEqual(m.topProjects.map((p) => p.name), ['app', 'lib'], 'a project is never shown by its full path');
  assert.deepEqual(m.checklist.map((c) => [c.key, c.group]), [['m:codeburn', 'This machine'], ['m:gitleaks', 'This machine']]);
  assert.deepEqual(m.repos.map((r) => [r.name, r.review, r.when, r.status, r.tone]), [
    ['app', '2 high · 1 med · 0 low', 'T(2026-11-11T10:00:00.000Z)', 'ok', 'error'],
    ['lib', 'no review yet', '', 'warn', 'none'],
  ]);
  assert.equal(m.reposNote, '2 of 3 repos found under your home folder have codewatch.');
});

test('machine panel model: usage not available is one spend card', () => {
  const p = machinePayload();
  p.usage = { ...p.usage!, status: 'not-installed', message: 'codeburn is not installed', today: null, month: null, topModels: [], topProjects: [] };
  const m = machinePanelModel(p, t);
  assert.deepEqual(m.cards.map((c) => [c.title, c.value]), [['AI spend', 'not-installed'], ['Setup warnings', '1']]);
});

test('Open folder: only a repo path from the last prism-cli JSON is accepted', () => {
  const m = machinePanelModel(machinePayload(), t);
  assert.deepEqual(parsePanelMessage({ type: 'openFolder', path: `${HOME}/src/app` }, m), { type: 'openFolder', path: `${HOME}/src/app` });
  assert.equal(parsePanelMessage({ type: 'openFolder', path: `${HOME}/src/old` }, m), null, 'a repo without codewatch is not listed');
  assert.equal(parsePanelMessage({ type: 'openFolder', path: '/etc' }, m), null);
  assert.equal(parsePanelMessage({ type: 'openFolder', path: `${HOME}/src/app/../../` }, m), null);
  assert.equal(parsePanelMessage({ type: 'openFolder', path: [`${HOME}/src/app`] }, m), null);
  assert.equal(parsePanelMessage({ type: 'openFolder', path: `${HOME}/src/app` }, null), null);
  const p = payload();
  const repoModel = panelModel(p, repoView(p, ROOT, 'main'), [], codewatchOff(p.repos[0]), t);
  assert.equal(parsePanelMessage({ type: 'openFolder', path: ROOT }, repoModel), null, 'repo mode has no Open folder');
  assert.equal(parsePanelMessage({ type: 'open', index: 0 }, m), null, 'machine mode has no findings to open');
});
