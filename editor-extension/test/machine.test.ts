import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headReportArgs, lastCommit, lastCommitArgs, machineDashboardRun, mapLimit, parseLastCommit, type ExecFileFn, type LastCommit } from '../src/cli';
import { COMMIT_LOOKUP_MAX, commitLookupPaths, lastCommits, latestReviewOf, machineRepos, machineReportPlan, repoFile, ROW_FINDINGS_MAX } from '../src/machine';
import { ago, machinePanelModel, panelModel, parsePanelMessage } from '../src/panel-model';
import type { DashboardPayload } from '../src/payload';
import { codewatchOff, repoView } from '../src/payload';
import { OPEN_REPO_HINT, statusView } from '../src/status';
import { finding, HOME, machinePayload, payload, repo, ROOT } from './fixtures';

const t = (iso: string) => `T(${iso})`;

test('machine mode argv: no --root, run from the home folder, --fresh only when asked', () => {
  assert.deepEqual(machineDashboardRun(false, HOME), { args: ['dashboard', '--json'], cwd: HOME });
  assert.deepEqual(machineDashboardRun(true, HOME), { args: ['dashboard', '--json', '--fresh'], cwd: HOME });
  assert.ok(!machineDashboardRun(false).args.includes('--root'));
});

test('machine mode status: spend today and warnings, no review counts', () => {
  const v = statusView({ kind: 'machine', payload: machinePayload(), repos: [] }, t);
  assert.equal(v.text, '$(shield) PRISM: $34.08 today | 1 warning');
  assert.equal(v.command, 'prism.openPanel');
  assert.equal(v.tint, null);
  const none = statusView({ kind: 'machine', payload: machinePayload({ summary: { spend: { status: 'not-installed', currency: 'USD', today: null, month: null, message: 'codeburn is not installed' }, warnings: { count: 0, first: null }, review: null } }), repos: [] }, t);
  assert.equal(none.text, '$(shield) PRISM');
  assert.match(none.tooltip, /Spend: codeburn is not installed/);
  assert.match(none.tooltip, /No pre-push review recorded in any repo yet/);
});

test('machine mode tooltip: month spend, latest review, repos with codewatch, open-a-repo line', () => {
  const tip = statusView({ kind: 'machine', payload: machinePayload(), repos: [] }, t).tooltip;
  assert.match(tip, /Spend this month: \$480\.14/);
  assert.match(tip, /Latest review: app, T\(2026-11-11T10:00:00\.000Z\) \(2 high, 1 medium, 0 low\)/);
  assert.match(tip, /Repos with codewatch: 2 of 3/);
  assert.ok(tip.includes(OPEN_REPO_HINT));
  assert.equal(OPEN_REPO_HINT, 'Open a repository folder to see its findings.');
});

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const commit = (at: string, sha = 'abc1234', subject = 'Fix it'): LastCommit => ({ at, sha, subject });
const fileOf = (repoPath: string, f: unknown) => (f === 'src/a.ts' ? `${repoPath}/src/a.ts` : null);

function built(p: DashboardPayload = machinePayload(), commits = new Map<string, LastCommit | null>([[`${HOME}/src/app`, commit('2026-11-12T09:00:00.000Z')]])) {
  return machinePanelModel(p, machineRepos(p, commits), fileOf, t, NOW);
}

test('machine panel model: spend cards, top lists by name only, machine checklist, repo rows', () => {
  const { model: m, targets } = built();
  assert.equal(m.mode, 'machine');
  assert.deepEqual(m.cards.map((c) => [c.title, c.value, c.detail]), [
    ['AI spend today', '$34.08', '79 calls · 1 session'],
    ['AI spend this month', '$480.14', '1301 calls · 453 sessions · 2026-11-01 to 2026-11-12'],
    ['Setup warnings', '1', 'gitleaks available: not on PATH'],
  ]);
  assert.deepEqual(m.topModels, [{ name: 'Model A', value: '$478.64 · 1240 calls' }]);
  assert.deepEqual(m.topProjects.map((p) => p.name), ['app', 'lib'], 'a project is never shown by its full path');
  assert.deepEqual(m.checklist.map((c) => [c.key, c.group]), [['m:codeburn', 'This machine'], ['m:gitleaks', 'This machine']]);
  assert.deepEqual(m.repos.map((r) => [r.name, r.review, r.status, r.tone, r.commit, r.hasReport]), [
    ['app', '2 high · 1 med · 0 low', 'ok', 'error', 'abc1234 · 3 h ago · Fix it', true],
    ['lib', 'no review yet', 'warn', 'none', 'last commit: unknown', false],
  ]);
  assert.ok(!JSON.stringify(m).includes(HOME), 'the posted model carries no paths');
  assert.deepEqual(targets.map((x) => x.path), [`${HOME}/src/app`, `${HOME}/src/lib`]);
  // Newest review first: the feature-branch finding (11-11) leads.
  assert.deepEqual(m.repos[0].findings.map((f) => [f.severity, f.location, f.branch, f.openable]), [
    ['medium', 'src/a.ts:12', 'feature', true], ['high', 'src/b.ts:3', 'main', false], ['medium', 'src/a.ts:12', 'main', true],
  ]);
  assert.deepEqual(targets[0].files[0], { path: `${HOME}/src/app/src/a.ts`, line: 11 });
  assert.equal(m.repos[0].more, '');
});

test('machine panel model: usage not available is one spend card', () => {
  const p = machinePayload();
  p.usage = { ...p.usage!, status: 'not-installed', message: 'codeburn is not installed', today: null, month: null, topModels: [], topProjects: [] };
  assert.deepEqual(built(p).model.cards.map((c) => [c.title, c.value]), [['AI spend', 'not-installed'], ['Setup warnings', '1']]);
});

test('repo rows sort by last commit time, newest first; no commit time falls back to the last review time', () => {
  const p = machinePayload();
  const row = (name: string, lastRunAt: string | null) => ({ name, label: name, path: `${HOME}/src/${name}`, high: 0, medium: 0, low: 0, lastRunAt, reviewer: 'kiro' });
  p.overview!.codewatch = [row('a', '2026-11-01T00:00:00Z'), row('b', '2026-11-10T00:00:00Z'), row('c', null), row('d', '2026-11-05T00:00:00Z')];
  const commits = new Map<string, LastCommit | null>([
    [`${HOME}/src/a`, commit('2026-11-12T00:00:00Z')], // committed last, reviewed first
    [`${HOME}/src/b`, null], // git failed: sorts by its review (11-10)
    [`${HOME}/src/d`, commit('2026-11-08T00:00:00Z')],
  ]);
  const rows = machineRepos(p, commits);
  assert.deepEqual(rows.map((r) => r.row.name), ['a', 'b', 'd', 'c']);
  assert.equal(rows[1].commit, null);
  assert.equal(built(p, commits).model.repos[1].commit, 'last commit: unknown');
});

test('git lookup: only repos with results, newest review first, at most 30, 4 at a time', async () => {
  const many = Array.from({ length: 40 }, (_, i) => repo({ name: `r${i}`, path: `${HOME}/r${i}`, current: false,
    codewatch: { ...repo().codewatch, hasResults: i !== 0, lastRunAt: `2026-11-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z` } }));
  const paths = commitLookupPaths(payload({ repos: many }));
  assert.equal(paths.length, COMMIT_LOOKUP_MAX);
  assert.ok(!paths.includes(`${HOME}/r0`), 'a repo without results is not looked up');
  assert.equal(paths[0], `${HOME}/r27`, 'newest review first');
  let active = 0, peak = 0;
  const got = await lastCommits(paths, async (p) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 2)); active--; return p.endsWith('r27') ? null : commit('2026-11-12T00:00:00Z'); });
  assert.equal(peak, 4);
  assert.equal(got.size, 30);
  assert.equal(got.get(`${HOME}/r27`), null);
  assert.deepEqual(await mapLimit([3, 1, 2], 2, async (n) => n * 2), [6, 2, 4], 'results keep input order');
});

test('git log argv, output parsing, failure is null', async () => {
  assert.deepEqual(lastCommitArgs('/w/r'), ['-C', '/w/r', 'log', '-1', '--format=%cI%x00%h%x00%s']);
  assert.deepEqual(parseLastCommit('2026-11-12T09:00:00+00:00\0abc1234\0Fix: a\0b\n'), { at: '2026-11-12T09:00:00+00:00', sha: 'abc1234', subject: 'Fix: a' });
  assert.equal(parseLastCommit(''), null);
  assert.equal(parseLastCommit('not a date\0abc\0x'), null);
  const calls: { file: string; args: string[]; shell: unknown }[] = [];
  const ok: ExecFileFn = (file, args, opts, cb) => { calls.push({ file, args, shell: opts.shell }); cb(null, '2026-11-12T09:00:00Z\0abc\0s', ''); };
  assert.equal((await lastCommit('/w/r', ok))?.sha, 'abc');
  assert.deepEqual(calls[0], { file: 'git', args: lastCommitArgs('/w/r'), shell: false });
  const fail: ExecFileFn = (_f, _a, _o, cb) => cb(Object.assign(new Error('x'), { code: 128 }), '', 'fatal: not a git repository');
  assert.equal(await lastCommit('/w/r', fail), null);
});

test('findings list per repo is capped at 20 with an N more line', () => {
  const p = machinePayload();
  p.repos[0].codewatch.findings = Array.from({ length: 27 }, (_, i) => finding({ started_at: `2026-11-${String(1 + i).padStart(2, '0')}T00:00:00Z`, message: `m${i}` }));
  const { model } = built(p);
  assert.equal(model.repos[0].findings.length, ROW_FINDINGS_MAX);
  assert.equal(model.repos[0].findings[0].message, 'm26', 'newest review first');
  assert.equal(model.repos[0].more, '7 more findings not listed; open the report for all of them.');
});

test('Open report: --commit HEAD first, --id of the latest review as the fallback, with its branch and commit', () => {
  const r = repo({ path: `${HOME}/src/app`, codewatch: { ...repo().codewatch, lastReviewId: 'abc-20261111T100000000Z-pre-push-review',
    latestByBranch: [{ branch: 'feature', review: { commit: 'feedfacecafe0123', started_at: '2026-11-11T10:00:00.000Z' } }] } });
  const latest = latestReviewOf(r);
  assert.deepEqual(latest, { id: 'abc-20261111T100000000Z-pre-push-review', branch: 'feature', commit: 'feedfacecafe0123' });
  const plan = machineReportPlan(`${HOME}/src/app`, 'app', commit('2026-11-12T00:00:00Z', 'abc1234'), latest);
  assert.deepEqual(plan.primary('/tmp/o.html'), ['codewatch', 'report', '--repo', `${HOME}/src/app`, '--commit', 'HEAD', '--format', 'html', '--output', '/tmp/o.html']);
  assert.deepEqual(plan.primary('/x'), headReportArgs(`${HOME}/src/app`, '/x'));
  assert.deepEqual(plan.fallback?.args('/tmp/o.html'), ['codewatch', 'report', '--repo', `${HOME}/src/app`, '--id', 'abc-20261111T100000000Z-pre-push-review', '--format', 'html', '--output', '/tmp/o.html']);
  assert.equal(plan.fallback?.message, 'PRISM: no review in app covers its last commit abc1234. Showing the latest review instead: branch feature, commit feedfacecafe.');
  assert.equal(machineReportPlan('/r', 'r', null, null).fallback, null);
  assert.equal(machineReportPlan('/r', 'r', null, { id: '--output=/etc/x', branch: null, commit: null }).fallback, null, 'an option-looking id is refused');
});

test('repoFile: refuses absolute paths, .., paths outside the repo and symlinks out of it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-guard-'));
  try {
    const root = join(dir, 'repo');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'x');
    writeFileSync(join(dir, 'outside.ts'), 'x');
    symlinkSync(join(dir, 'outside.ts'), join(root, 'src', 'link.ts'));
    symlinkSync(join(root, 'src', 'a.ts'), join(root, 'inner.ts'));
    assert.equal(repoFile(root, 'src/a.ts'), join(root, 'src', 'a.ts'));
    assert.equal(repoFile(root, 'inner.ts'), join(root, 'inner.ts'), 'a symlink to a file inside the repo is fine');
    assert.equal(repoFile(root, 'src/link.ts'), null, 'symlink to a file outside the repo');
    assert.equal(repoFile(root, '../outside.ts'), null);
    assert.equal(repoFile(root, 'src/../src/a.ts'), null, 'any .. segment is refused');
    assert.equal(repoFile(root, join(root, 'src', 'a.ts')), null, 'absolute paths are refused');
    assert.equal(repoFile(root, 'src'), null, 'not a file');
    assert.equal(repoFile(root, 'src/missing.ts'), null);
    assert.equal(repoFile(root, 7), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('panel messages in machine mode carry only indexes, checked against the model', () => {
  const { model: m } = built();
  assert.deepEqual(parsePanelMessage({ type: 'openFolder', repoIndex: 1 }, m), { type: 'openFolder', repoIndex: 1 });
  assert.equal(parsePanelMessage({ type: 'openFolder', repoIndex: 2 }, m), null, 'no such row');
  assert.equal(parsePanelMessage({ type: 'openFolder', repoIndex: '0' }, m), null);
  assert.equal(parsePanelMessage({ type: 'openFolder', repoIndex: -1 }, m), null);
  assert.equal(parsePanelMessage({ type: 'openFolder', path: `${HOME}/src/app` }, m), null, 'a path is never accepted');
  assert.deepEqual(parsePanelMessage({ type: 'repoReport', repoIndex: 0 }, m), { type: 'repoReport', repoIndex: 0 });
  assert.equal(parsePanelMessage({ type: 'repoReport', repoIndex: 1 }, m), null, 'no review, no report');
  assert.deepEqual(parsePanelMessage({ type: 'openRepoFinding', repoIndex: 0, findingIndex: 0 }, m), { type: 'openRepoFinding', repoIndex: 0, findingIndex: 0 });
  assert.equal(parsePanelMessage({ type: 'openRepoFinding', repoIndex: 0, findingIndex: 1 }, m), null, 'file not in the checkout');
  assert.equal(parsePanelMessage({ type: 'openRepoFinding', repoIndex: 0, findingIndex: 9 }, m), null);
  assert.equal(parsePanelMessage({ type: 'openRepoFinding', repoIndex: 0, findingIndex: 1.5 }, m), null);
  assert.equal(parsePanelMessage({ type: 'openRepoFinding', repoIndex: 0, file: '/etc/passwd' }, m), null);
  assert.equal(parsePanelMessage({ type: 'open', index: 0 }, m), null, 'repo-mode findings are not in machine mode');
  const p = payload();
  const repoModel = panelModel(p, repoView(p, ROOT, 'main'), [], codewatchOff(p.repos[0]), t);
  assert.equal(parsePanelMessage({ type: 'openFolder', repoIndex: 0 }, repoModel), null, 'repo mode has no repo rows');
});

test('relative time', () => {
  assert.equal(ago('2026-11-12T11:59:40Z', NOW), 'just now');
  assert.equal(ago('2026-11-12T11:15:00Z', NOW), '45 min ago');
  assert.equal(ago('2026-11-10T12:00:00Z', NOW), '2 d ago');
  assert.equal(ago('nope', NOW), 'unknown');
});
