import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machineDashboardRun } from '../src/cli';
import { OPEN_REPO_HINT, statusView } from '../src/status';
import { HOME, machinePayload } from './fixtures';

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
