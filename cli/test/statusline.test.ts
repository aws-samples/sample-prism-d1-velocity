/**
 * Tests for `prism-cli statusline`: fixture status JSON on stdin, the two
 * cached files present / missing / stale, COLUMNS truncation, NO_COLOR,
 * control-character stripping, bad stdin, and the timing budget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findRepo, readBranch, readReview, runStatusline, stripControl, USAGE_HINT, USAGE_SCHEMA, USAGE_TTL_MS, visibleWidth, RESULTS_SUBDIR,
} from '../src/statusline/statusline.js';
import { USAGE_CACHE_SCHEMA, USAGE_TTL_MS as CACHE_TTL } from '../src/dashboard/usage-cache.js';
import { localDate } from '../src/dashboard/usage.js';
import { RESULTS_DIR } from '../src/codewatch/results.js';

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-11-12T15:00:00');
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function usageCache(home: string, savedAt: number, day = localDate(NOW), today = 34.08, month = 480.2) {
  mkdirSync(join(home, '.prism', 'cache'), { recursive: true });
  writeFileSync(join(home, '.prism', 'cache', 'usage.json'), JSON.stringify({
    schema: USAGE_CACHE_SCHEMA, savedAt, day,
    panel: { status: 'ok', currency: 'USD', today: { cost: today, calls: 3 }, month: { cost: month, calls: 9, sessions: 2 } },
  }));
}

/** A repo dir with .git/HEAD on `branch` and review result files. */
function repo(name: string, branch = 'main'): string {
  const dir = join(tmp('prism-sl-'), name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  mkdirSync(join(dir, RESULTS_SUBDIR), { recursive: true });
  return dir;
}

let seq = 0;
function review(dir: string, at: string, findings: { severity: string; message?: string }[], branch = 'main', status = findings.length ? 'findings' : 'ok') {
  const stamp = at.replace(/[-:]/g, '').replace('.', '');
  const name = `${String(++seq).padStart(12, '0')}-${stamp}-pre-push-review.json`;
  writeFileSync(join(dir, RESULTS_SUBDIR, name), JSON.stringify({
    schema_version: 1, kind: 'review', hook: 'pre-push', status, tool: 'kiro', branch, started_at: at, finished_at: at,
    findings: findings.map((f) => ({ category: 'security', rule: 'r', file: 'a.ts', line: 1, message: 'x', ...f })),
  }));
  return join(dir, RESULTS_SUBDIR, name);
}

const STATUS = (cwd: string) => JSON.stringify({
  session_id: 's1', workspace: { current_dir: cwd }, model: { display_name: 'Opus' },
  cost: { total_cost_usd: 1.2, total_lines_added: 156, total_lines_removed: 23 },
  context_window: { used_percentage: 42 }, prompt_cache: { hit_ratio: 0.91 },
});

function run(stdin: string, opts: { home?: string; env?: NodeJS.ProcessEnv; session?: boolean; json?: boolean } = {}): string {
  let out = '';
  runStatusline({ session: opts.session, json: opts.json }, {
    stdin, env: opts.env ?? { NO_COLOR: '1' }, home: opts.home ?? tmp('prism-sl-home-'), now: NOW, write: (s) => { out += s; },
  });
  return out;
}

test('constants match the dashboard cache and results modules', () => {
  assert.equal(USAGE_SCHEMA, USAGE_CACHE_SCHEMA);
  assert.equal(USAGE_TTL_MS, CACHE_TTL);
  assert.equal(RESULTS_SUBDIR, RESULTS_DIR);
});

test('fixture stdin with both caches: the two rows', () => {
  const home = tmp('prism-sl-home-');
  usageCache(home, NOW.getTime() - 60_000);
  const dir = repo('codewatch-demo');
  review(dir, '2026-11-12T10:00:00.000Z', [{ severity: 'low' }]);
  review(dir, '2026-11-12T12:00:00.000Z', [{ severity: 'high' }, { severity: 'high' }, { severity: 'medium' }]);
  const out = run(STATUS(join(dir, 'src')), { home });
  assert.equal(out, 'PRISM codewatch-demo · 2 high 1 med · today $34.08 · month $480\nsession $1.20 · +156/−23 · ctx 42% · cache 91% · Opus\n');
});

test('--no-session prints the PRISM row only', () => {
  const out = run(STATUS(tmp('prism-sl-nogit-')), { session: false });
  assert.equal(out.split('\n').filter(Boolean).length, 1);
  assert.match(out, /^PRISM · usage: run prism-cli dashboard\n$/);
});

test('missing usage cache: the hint instead of spend; missing results: no findings segment', () => {
  const dir = repo('r');
  const out = run(STATUS(dir), { session: false });
  assert.equal(out, `PRISM r · ${USAGE_HINT}\n`);
});

test('stale usage cache: values kept, hint added; earlier-day stale cache counts as missing', () => {
  const home = tmp('prism-sl-home-');
  usageCache(home, NOW.getTime() - USAGE_TTL_MS - 1);
  assert.equal(run(STATUS(tmp('x-')), { home, session: false }), `PRISM · today $34.08 · month $480 · ${USAGE_HINT}\n`);
  usageCache(home, NOW.getTime() - 86_400_000, '2026-11-11');
  assert.equal(run(STATUS(tmp('x-')), { home, session: false }), `PRISM · ${USAGE_HINT}\n`);
  // A wrong schema or a failed panel is never shown.
  writeFileSync(join(home, '.prism', 'cache', 'usage.json'), JSON.stringify({ schema: 'other', savedAt: NOW.getTime(), day: localDate(NOW), panel: { status: 'ok' } }));
  assert.equal(run(STATUS(tmp('x-')), { home, session: false }), `PRISM · ${USAGE_HINT}\n`);
});

test('review states: clean, failed, skipped, and another branch', () => {
  const dir = repo('r', 'feat/x');
  review(dir, '2026-11-12T10:00:00.000Z', [{ severity: 'medium' }], 'main');
  assert.match(run(STATUS(dir), { session: false }), /^PRISM r · 1 med \(main\) · /);
  review(dir, '2026-11-12T11:00:00.000Z', [], 'feat/x');
  assert.match(run(STATUS(dir), { session: false }), /^PRISM r · clean · /);
  review(dir, '2026-11-12T12:00:00.000Z', [], 'feat/x', 'error');
  assert.match(run(STATUS(dir), { session: false }), /^PRISM r · review failed · /);
  review(dir, '2026-11-12T13:00:00.000Z', [], 'feat/x', 'skipped');
  assert.match(run(STATUS(dir), { session: false }), /^PRISM r · review skipped · /);
});

test('worktree .git file: branch read from the gitdir HEAD, no git process', () => {
  const main = repo('main-clone');
  const gd = join(main, '.git', 'worktrees', 'wt');
  mkdirSync(gd, { recursive: true });
  writeFileSync(join(gd, 'HEAD'), 'ref: refs/heads/feat/wt\n');
  const wt = join(tmp('prism-sl-wt-'), 'wt');
  mkdirSync(wt);
  writeFileSync(join(wt, '.git'), `gitdir: ${gd}\n`);
  const ref = findRepo(join(wt))!;
  assert.equal(ref.top, wt);
  assert.equal(readBranch(ref.gitPath), 'feat/wt');
  writeFileSync(join(main, '.git', 'HEAD'), 'abcdef0123456789\n');
  assert.equal(readBranch(join(main, '.git')), null, 'detached HEAD');
});

test('COLUMNS: segments drop lowest priority first, the PRISM segment never', () => {
  const home = tmp('prism-sl-home-');
  usageCache(home, NOW.getTime());
  const dir = repo('codewatch-demo');
  review(dir, '2026-11-12T12:00:00.000Z', [{ severity: 'high' }]);
  const at = (cols: number) => run(STATUS(dir), { home, env: { NO_COLOR: '1', COLUMNS: String(cols) } }).split('\n');
  assert.deepEqual(at(50).slice(0, 2), ['PRISM codewatch-demo · 1 high · today $34.08', 'session $1.20 · +156/−23 · ctx 42% · cache 91%']);
  assert.deepEqual(at(30).slice(0, 2), ['PRISM codewatch-demo · 1 high', 'session $1.20 · +156/−23']);
  assert.deepEqual(at(5).slice(0, 2), ['PRISM codewatch-demo', 'session $1.20']);
  for (const cols of [30, 50, 80]) for (const l of at(cols)) assert.ok(visibleWidth(l) <= cols, `${cols}: ${l}`);
});

test('colour: red high, amber medium, OSC 8 link to the result file; NO_COLOR turns both off', () => {
  const home = tmp('prism-sl-home-');
  const dir = repo('r');
  const file = review(dir, '2026-11-12T12:00:00.000Z', [{ severity: 'high' }, { severity: 'medium' }]);
  const colored = run(STATUS(dir), { home, env: {} });
  assert.match(colored, /\u001b\[31m1 high\u001b\[0m \u001b\[33m1 med\u001b\[0m/);
  assert.ok(colored.includes(`\u001b]8;;file://${file}\u0007`), 'OSC 8 link');
  const plain = run(STATUS(dir), { home, env: { NO_COLOR: '1' } });
  assert.doesNotMatch(plain, /\u001b/);
  assert.match(run(STATUS(dir), { home, env: { NO_COLOR: '' } }), /\u001b\[/, 'an empty NO_COLOR does not disable colour');
});

test('control characters from result files and stdin are stripped', () => {
  assert.equal(stripControl('a\u001b[2Jb\u0007c\r\n\u009bd\u202ee'), 'a[2Jbcde');
  const dir = repo('r', 'evil');
  review(dir, '2026-11-12T12:00:00.000Z', [{ severity: 'low' }], 'other\u001b]0;pwned\u0007\u001b[2J', 'findings\u001b[31m');
  const status = JSON.parse(STATUS(dir));
  status.model.display_name = 'Op\u001b[2Jus\u0007';
  const out = run(JSON.stringify(status));
  assert.doesNotMatch(out, /\u001b|\u0007/);
  assert.match(out, /\(other\]0;pwned\[2J\)/);
  assert.match(out, /Op\[2Jus/);
});

test('bad or empty stdin prints a minimal line, never throws', () => {
  for (const s of ['', '   ', 'not json', '[]', 'null', '{"workspace": 5}'.slice(0, 5)]) assert.equal(run(s), 'PRISM\n', JSON.stringify(s));
  // Wrong field types are ignored, not fatal.
  assert.match(run(JSON.stringify({ workspace: { current_dir: 7 }, cost: { total_cost_usd: 'x' }, context_window: { used_percentage: null } })), /^PRISM · usage/);
  // A relative current_dir is not walked.
  assert.equal(run(JSON.stringify({ workspace: { current_dir: 'relative/dir' } }), { session: false }), `PRISM · ${USAGE_HINT}\n`);
});

test('--json shows the model and the files it read', () => {
  const dir = repo('r');
  review(dir, '2026-11-12T12:00:00.000Z', [{ severity: 'high' }]);
  const j = JSON.parse(run(STATUS(dir), { json: true }));
  assert.equal(j.repo, 'r');
  assert.equal(j.review.high, 1);
  assert.equal(j.usage.state, 'missing');
  assert.equal(j.rows[0].line, `PRISM r · 1 high · ${USAGE_HINT}`);
  assert.equal(JSON.parse(run('nope', { json: true })).input, 'missing or not JSON');
});

test('newest review is chosen by the timestamp in the file name, not the listing order', () => {
  const dir = repo('r');
  review(dir, '2026-11-12T12:00:00.000Z', [{ severity: 'high' }]);
  // Lower sequence prefix, later timestamp.
  writeFileSync(join(dir, RESULTS_SUBDIR, `000000000000-20261112T130000000Z-pre-push-review.json`), JSON.stringify({ kind: 'review', status: 'ok', branch: 'main', findings: [] }));
  assert.equal(readReview(dir, 'main')!.status, 'ok');
});

test('at most MAX_REVIEWS_PARSED files are parsed: an old review of this branch falls back to the newest', () => {
  const dir = repo('r', 'old');
  review(dir, '2026-11-01T00:00:00.000Z', [{ severity: 'high' }], 'old');
  for (let i = 0; i < 25; i++) review(dir, `2026-11-12T10:00:00.${String(i).padStart(3, '0')}Z`, [], 'other');
  const r = readReview(dir, 'old')!;
  assert.equal(r.otherBranch, true);
  assert.equal(r.branch, 'other');
});

test('timing: in-process work stays far under the 50 ms budget', () => {
  const home = tmp('prism-sl-home-');
  usageCache(home, NOW.getTime());
  const dir = repo('r');
  for (let i = 0; i < 200; i++) review(dir, `2026-11-12T${String(i % 24).padStart(2, '0')}:00:00.${String(i).padStart(3, '0')}Z`, [{ severity: 'low' }]);
  const ms: number[] = [];
  for (let i = 0; i < 30; i++) { const t = performance.now(); run(STATUS(dir), { home }); ms.push(performance.now() - t); }
  ms.sort((a, b) => a - b);
  // Slack for slow CI machines: the measured p50 is about 1 ms here.
  assert.ok(ms[15] < 25, `p50 ${ms[15].toFixed(1)} ms`);
});

test('the CLI entry: the fast path answers, bad stdin exits 0', () => {
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(CLI_DIR, 'bin', 'prism-cli.ts'), 'statusline'], { input: 'garbage', encoding: 'utf8', cwd: CLI_DIR });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'PRISM\n');
});
