/**
 * Tests for the dashboard's per-commit view (src/dashboard/commits.ts), against
 * a real git history: range expansion, tree matching, blame attribution and
 * its fallback, re-review dedupe, the row cap and no-verify detection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Blamer, collectCommits, expandRange, readLog } from '../src/dashboard/commits.js';
import { makeResult, REASON_GITLEAKS_MISSING, type Finding, type PrismResult } from '../src/codewatch/results.js';

process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'prism-commits-gcfg-')), 'gitconfig');
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `prism-commits-${p}-`));

let clock = 0;
function git(cwd: string, ...args: string[]): string {
  const date = `2026-11-0${1 + Math.floor(clock / 10)}T10:${String(clock % 60).padStart(2, '0')}:00Z`;
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(dir: string, files: Record<string, string>, msg: string): string {
  clock++;
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * base: lib.ts (3 lines). Then one push of three commits:
 *   c2 adds a.ts with a bad line 3, c3 adds b.ts with a bad line 1, c4 only touches README.
 */
function history() {
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'work', `--template=${tmp('tpl')}`);
  const base = commit(dir, { 'lib.ts': 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n' }, 'base: lib');
  const c2 = commit(dir, { 'a.ts': 'const ok = 1;\nconst fine = 2;\nexec("grep " + user);\n' }, 'c2: add a.ts');
  const c3 = commit(dir, { 'b.ts': 'const key = "AKIA";\n' }, 'c3: add b.ts');
  const c4 = commit(dir, { 'README.md': '# readme\n' }, 'c4: readme');
  return { dir, base, c2, c3, c4 };
}

const f = (severity: Finding['severity'], file: string, line: number | null, rule = 'r'): Finding =>
  ({ severity, category: 'security', rule, file, line, message: `${file}:${line}` });

function review(tip: string, base: string, findings: Finding[], at: string, extra: Partial<PrismResult> = {}): PrismResult {
  return makeResult({ kind: 'review', hook: 'pre-push', status: findings.length ? 'findings' : 'ok', tool: 'kiro', model: 'm1',
    commit: tip, base, branch: 'work', upstream: 'origin/work', started_at: at, finished_at: at, findings, ...extra });
}

test('expandRange matches git rev-list base..tip, including through a merge', () => {
  const h = history();
  const log = readLog(h.dir);
  const want = git(h.dir, 'rev-list', `${h.base}..${h.c4}`).split('\n').sort();
  assert.deepEqual(expandRange(log, h.base, h.c4).sort(), want);
  assert.deepEqual(expandRange(log, null, h.c4), [h.c4], 'no base: the tip only');
  // a side branch merged in
  git(h.dir, 'checkout', '-q', '-b', 'side', h.base);
  const s1 = commit(h.dir, { 'side.ts': 'x\n' }, 'side');
  git(h.dir, 'checkout', '-q', 'work');
  clock++;
  git(h.dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const m = git(h.dir, 'rev-parse', 'HEAD');
  const log2 = readLog(h.dir);
  const want2 = git(h.dir, 'rev-list', `${h.c4}..${m}`).split('\n').sort();
  assert.deepEqual(expandRange(log2, h.c4, m).sort(), want2);
  assert.ok(want2.includes(s1));
});

test('findings land on the commit that introduced their line (blame), once per location', () => {
  const h = history();
  const blamer = new Blamer(h.dir);
  const p = collectCommits(h.dir, [review(h.c4, h.base, [f('high', 'a.ts', 3), f('medium', 'b.ts', 1), f('low', 'a.ts', 3, 'dup-location')], '2026-11-05T00:00:00Z')], { blamer });
  const by = Object.fromEntries(p.rows.map((r) => [r.sha, r]));
  assert.deepEqual([by[h.c2].review.high, by[h.c2].review.low, by[h.c2].review.state], [1, 1, 'findings']);
  assert.deepEqual(by[h.c2].findings.map((x) => x.attributed), ['blame', 'blame']);
  assert.deepEqual([by[h.c3].review.medium, by[h.c3].review.state], [1, 'findings']);
  assert.equal(by[h.c4].review.state, 'clean', 'reviewed, no attributed findings');
  assert.equal(by[h.c4].review.tool, 'kiro');
  assert.equal(by[h.c4].review.model, 'm1');
  assert.equal(p.rows.length, 3, 'only the pushed range');
  assert.equal(blamer.calls, 2, 'the repeated location is blamed once');
  assert.deepEqual(p.rows.map((r) => r.subject), ['c4: readme', 'c3: add b.ts', 'c2: add a.ts'], 'newest first');
});

test('blame fallback: an out-of-range line or a line from before the push stays on the tip', () => {
  const h = history();
  const p = collectCommits(h.dir, [review(h.c4, h.base, [f('high', 'a.ts', 999), f('low', 'lib.ts', 2), f('low', 'gone.ts', 1), f('low', 'a.ts', null)], '2026-11-05T00:00:00Z')]);
  const tip = p.rows.find((r) => r.sha === h.c4)!;
  assert.equal(tip.findings.length, 4);
  assert.ok(tip.findings.every((x) => x.attributed === 'tip' && x.inPushOf === h.c4));
  assert.equal(tip.review.high, 1);
  assert.equal(p.rows.find((r) => r.sha === h.c2)!.review.state, 'clean');
});

test('re-review: the newest review of a commit wins and the count is shown', () => {
  const h = history();
  const older = review(h.c4, h.base, [f('high', 'a.ts', 3)], '2026-11-05T00:00:00Z');
  const newer = review(h.c4, h.c2, [f('low', 'b.ts', 1)], '2026-11-05T01:00:00Z', { model: 'm2' });
  const p = collectCommits(h.dir, [newer, older]); // order on disk must not matter
  const by = Object.fromEntries(p.rows.map((r) => [r.sha, r]));
  assert.equal(by[h.c3].review.reviewCount, 2);
  assert.deepEqual([by[h.c3].review.low, by[h.c3].review.model], [1, 'm2']);
  assert.equal(by[h.c2].review.reviewCount, 1, 'c2 was only in the first push');
  assert.equal(by[h.c2].review.high, 1);
});

test('secret scan per commit: tree match, gitleaks missing, no-verify, flagged', () => {
  const h = history();
  const tree = (c: string) => git(h.dir, 'rev-parse', `${c}^{tree}`);
  const pc = (t: string, status: PrismResult['status'], reason: string | null = null) =>
    makeResult({ kind: 'secrets', hook: 'pre-commit', tool: 'gitleaks', status, reason, tree: t, branch: 'work', started_at: '2026-11-04T00:00:00Z', finished_at: '' });
  const results = [
    pc(tree(h.c2), 'ok'),
    pc(tree(h.c3), 'skipped', REASON_GITLEAKS_MISSING),
    pc(tree(h.base), 'findings'),
    makeResult({ kind: 'secrets', hook: 'pre-push', tool: 'gitleaks', status: 'skipped', reason: 'no scan', commit: h.c4, tree: tree(h.c4), branch: 'work', started_at: '2026-11-05T00:00:00Z', finished_at: '' }),
    makeResult({ kind: 'secrets', hook: 'pre-push', tool: 'gitleaks', status: 'skipped', reason: 'no scan', commit: h.c2, tree: tree(h.c2), branch: 'work', started_at: '2026-11-05T00:00:00Z', finished_at: '' }),
  ];
  const by = Object.fromEntries(collectCommits(h.dir, results).rows.map((r) => [r.sha, r]));
  assert.equal(by[h.c2].secretScan.state, 'ok', 'a matching scan beats a no-verify record');
  assert.equal(by[h.c3].secretScan.state, 'not-scanned');
  assert.match(by[h.c3].secretScan.reason || '', /gitleaks was not installed/);
  assert.equal(by[h.c4].secretScan.state, 'no-verify');
  assert.equal(by[h.base].secretScan.state, 'flagged');
  assert.equal(by[h.c4].review.state, 'not-reviewed');
});

test('commits made in the same second keep git log order', () => {
  const dir = tmp('same');
  git(dir, 'init', '-q', '-b', 'work', `--template=${tmp('tpl')}`);
  const base = commit(dir, { 'x': '0' }, 'base');
  const saved = clock;
  const shas: string[] = [];
  for (const n of ['a', 'b', 'c']) { clock = saved; shas.push(commit(dir, { [n]: n }, n)); }
  const p = collectCommits(dir, [review(shas[2], base, [], '2026-11-05T00:00:00Z')]);
  assert.deepEqual(p.rows.map((r) => r.subject), ['c', 'b', 'a']);
});

test('cap: newest rows only, with the total kept', () => {
  const h = history();
  const p = collectCommits(h.dir, [review(h.c4, h.base, [], '2026-11-05T00:00:00Z')], { maxRows: 2 });
  assert.equal(p.total, 3);
  assert.equal(p.truncated, true);
  assert.deepEqual(p.rows.map((r) => r.sha), [h.c4, h.c3]);
});

test('a failed review marks its commits; an amended-away commit is shown as not in history', () => {
  const h = history();
  const failed = review(h.c4, h.c3, [], '2026-11-05T00:00:00Z', { status: 'error', reason: 'kiro-cli timed out' });
  const ghost = 'f'.repeat(40);
  const p = collectCommits(h.dir, [failed, review(ghost, h.base, [], '2026-11-05T02:00:00Z')]);
  const by = Object.fromEntries(p.rows.map((r) => [r.sha, r]));
  assert.equal(by[h.c4].review.state, 'failed');
  assert.equal(by[h.c4].review.reason, 'kiro-cli timed out');
  assert.equal(by[ghost].inHistory, false);
  assert.equal(by[ghost].subject, null);
});
