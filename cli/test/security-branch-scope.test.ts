/**
 * The branch code review's scope, as the CLI and the Security Agent page both
 * read it (security/review.ts diffBase and branchScope): the upstream, else the
 * remote's default branch, else none; an empty diff; uncommitted changes. Real
 * git in throwaway repos under the test's temp dir, no AWS. Plus the drawer's
 * neutral outcome for a branch review that started nothing, and the page's
 * branch card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchScope, diffBase } from '../src/security/review.js';
import { ActionRunner, ACTIONS, repoId, type ScanRepo } from '../src/dashboard/actions.js';
import { run } from '../src/utils/exec.js';

const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitRun = (a: string[]) => run('git', a);

/** A bare origin with trunk (its HEAD) and a clone; returns the clone. Branch names avoid main/master. */
function cloned(): { root: string; clone: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'prism-scope-')));
  const work = join(root, 'seed');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'trunk');
  writeFileSync(join(work, 'a.txt'), 'a\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'one');
  git(root, 'clone', '-q', '--bare', work, 'origin.git');
  git(root, 'clone', '-q', join(root, 'origin.git'), 'clone');
  return { root, clone: join(root, 'clone') };
}

test('branch scope: up to date with its upstream is empty; a new commit is not; uncommitted changes are counted, never reviewed', () => {
  const { root, clone } = cloned();
  try {
    git(clone, 'switch', '-q', '-c', 'feat/x');
    git(clone, 'push', '-q', '-u', 'origin', 'feat/x');
    let s = branchScope(gitRun, clone);
    assert.deepEqual([s.branch, s.base?.upstream, s.base?.fromUpstream, s.empty, s.dirty], ['feat/x', 'origin/feat/x', true, true, 0], 'nothing new since the upstream');
    writeFileSync(join(clone, 'a.txt'), 'changed\n');
    writeFileSync(join(clone, 'new.txt'), 'n\n');
    s = branchScope(gitRun, clone);
    assert.deepEqual([s.empty, s.dirty], [true, 2], 'two uncommitted changes, still nothing to review');
    git(clone, 'commit', '-q', '-am', 'two');
    s = branchScope(gitRun, clone);
    assert.deepEqual([s.empty, s.dirty], [false, 1], 'a commit the upstream lacks: something to review');
    assert.equal(s.base?.commit.length, 12);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('branch scope: no upstream falls back to the remote default branch; with neither there is no base (the CLI stops)', () => {
  const { root, clone } = cloned();
  try {
    git(clone, 'switch', '-q', '-c', 'local-only');
    let s = branchScope(gitRun, clone);
    assert.deepEqual([s.base?.upstream, s.base?.fromUpstream, s.empty], ['origin/trunk', false, true], 'origin/HEAD is the base');
    assert.deepEqual(diffBase(gitRun, clone), { base: git(clone, 'rev-parse', 'origin/trunk'), upstream: 'origin/trunk', fromUpstream: false }, 'the CLI resolves the same base');
    git(clone, 'remote', 'set-head', 'origin', '-d');
    s = branchScope(gitRun, clone);
    assert.equal(s.base, null);
    assert.equal(s.empty, false, 'no base is its own case, not "empty"');
    assert.equal(diffBase(gitRun, clone), null);
    git(clone, 'switch', '-q', '--detach');
    assert.equal(branchScope(gitRun, clone).branch, null, 'detached HEAD: no branch name');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runner: a branch review that exits 0 and saves no run is "nothing", not ok; a full review or a saved run is ok', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'prism-nothing-')));
  const path = join(home, 'src', 'demo');
  mkdirSync(path, { recursive: true });
  const REPO: ScanRepo = { id: repoId(path), name: 'demo', path };
  const spawn = () => {
    const c: any = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => true;
    setTimeout(() => c.emit('close', 0), 2);
    return c;
  };
  let saved: { run: string; status: 'running' } | null = null;
  const r = new ActionRunner({ execPath: '/usr/bin/node', entry: '/x.js', cwd: home, home, repos: async () => [REPO], systemdAvailable: () => false, platform: 'linux', spawn: spawn as any, awsArgs: () => [], writeGate: () => null, runWritten: () => saved });
  const done = async (action: string) => {
    assert.equal((await r.start({ action, repo: REPO.id, confirm: true })).status, 202);
    for (let i = 0; i < 200 && r.status().state !== 'done'; i++) await new Promise((x) => setTimeout(x, 5));
    return r.status();
  };
  try {
    for (const id of ['security-code-review', 'security-code-review-force']) {
      const s = await done(id);
      assert.deepEqual([s.outcome, s.exitCode, s.repoId], ['nothing', 0, REPO.id], id);
    }
    assert.equal((await done('security-code-review-full')).outcome, 'ok', 'a full review always starts a job');
    saved = { run: 'r1', status: 'running' };
    assert.equal((await done('security-code-review')).outcome, 'ok', 'a saved pending record: a job started');
    assert.ok(ACTIONS['security-code-review'].args.includes('--no-wait'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the drawer shows "nothing to review" as neutral, with the whole-repo review offered', async () => {
  const { SETUP_SCRIPT } = await import('../src/dashboard/setup-page.js');
  assert.match(SETUP_SCRIPT, /nothing \? pill\('info', 'nothing to review'\) : s\.exitCode === 0/);
  assert.match(SETUP_SCRIPT, /nothing && typeof saFullOffer === 'function' \? saFullOffer\(s\.repoId\) : null/);
});
