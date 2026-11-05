/**
 * Tests for `prism-cli enable codewatch --global`.
 *
 * Every test runs under withFakeGlobal(), which points HOME and
 * GIT_CONFIG_GLOBAL at a fresh temp directory, so the real ~/.gitconfig is
 * never read or written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHAIN_FILE, globalHooksDir, globalStatus, installGlobal, isOptedOut, PREVIOUS_FILE, readGlobalHooksPath,
  repoLocalHooksPath, uninstallGlobal,
} from '../src/codewatch/globalHooks.js';
import { installHooks } from '../src/codewatch/hooks.js';
import { makeResult, writeResult } from '../src/codewatch/results.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `prism-glob-${p}-`));

function exe(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** Runs fn with HOME and GIT_CONFIG_GLOBAL in a scratch dir, restoring both after. */
function withFakeGlobal<T>(fn: (home: string, env: NodeJS.ProcessEnv) => T): T {
  const home = tmp('home');
  const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig');
  assert.ok(process.env.GIT_CONFIG_GLOBAL.startsWith(tmpdir()), 'refusing to run against a real git config');
  try {
    return fn(home, { ...process.env });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function repo(env: NodeJS.ProcessEnv): string {
  const dir = tmp('repo');
  git(dir, env, 'init', '-q', `--template=${tmp('tpl')}`);
  return dir;
}

/** Runs one of our global hook scripts as git would: cwd = the repo, args and stdin passed. */
function runHook(home: string, env: NodeJS.ProcessEnv, hook: string, cwd: string, args: string[] = [], input = '', path = '/usr/bin:/bin') {
  return spawnSync(join(globalHooksDir(home), hook), args, { cwd, input, encoding: 'utf8', env: { ...env, PATH: path } });
}

test('global install sets core.hooksPath; uninstall unsets it when nothing was set before', () => withFakeGlobal((home) => {
  assert.equal(readGlobalHooksPath(), null);
  const r = installGlobal();
  assert.ok(r.ok);
  assert.equal(readGlobalHooksPath(), globalHooksDir(home));
  assert.equal(globalStatus().state, 'installed');
  assert.ok(!existsSync(join(globalHooksDir(home), PREVIOUS_FILE)), 'nothing to save');
  // re-running is idempotent
  const again = installGlobal();
  assert.ok(again.ok && again.reinstalled);

  const u = uninstallGlobal();
  assert.equal(u.config, 'unset');
  assert.equal(readGlobalHooksPath(), null);
  assert.ok(!existsSync(globalHooksDir(home)), 'empty dir removed');
  assert.equal(globalStatus().state, 'not-installed');
}));

test('a foreign global core.hooksPath is refused without --force and left unchanged', () => withFakeGlobal((home, env) => {
  git(home, env, 'config', '--global', 'core.hooksPath', '/opt/team-hooks');
  const r = installGlobal();
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.current === '/opt/team-hooks');
  assert.equal(readGlobalHooksPath(), '/opt/team-hooks');
  assert.ok(!existsSync(globalHooksDir(home)));
  assert.equal(globalStatus().state, 'elsewhere');
}));

test('--force saves the foreign value, chains its hooks, and uninstall restores it', () => withFakeGlobal((home, env) => {
  const team = tmp('team-hooks');
  const log = join(team, 'ran.log');
  exe(team, 'pre-commit', `echo team-global >> '${log}'; exit 0`);
  git(home, env, 'config', '--global', 'core.hooksPath', team);
  const r = installGlobal({ force: true });
  assert.ok(r.ok);
  assert.equal(r.ok && r.previous, team);
  assert.equal(readFileSync(join(globalHooksDir(home), CHAIN_FILE), 'utf8').trim(), team);
  assert.equal(readGlobalHooksPath(), globalHooksDir(home));

  const dir = repo(env);
  const res = runHook(home, env, 'pre-commit', dir);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(log, 'utf8'), 'team-global\n', 'the replaced global hook still runs');

  const u = uninstallGlobal();
  assert.equal(u.config, 'restored');
  assert.equal(readGlobalHooksPath(), team);
}));

test('~ in a saved hooksPath is expanded for chaining', () => withFakeGlobal((home, env) => {
  mkdirSync(join(home, '.team'));
  git(home, env, 'config', '--global', 'core.hooksPath', '~/.team');
  const r = installGlobal({ force: true });
  assert.ok(r.ok && r.chained === join(home, '.team'));
  assert.equal(uninstallGlobal().restoredTo, '~/.team', 'restored verbatim');
}));

test('uninstall never touches repo-local hooks, and leaves a since-changed hooksPath alone', () => withFakeGlobal((home, env) => {
  installGlobal();
  const dir = repo(env);
  const local = exe(join(dir, '.git', 'hooks'), 'pre-commit', 'exit 0');
  git(home, env, 'config', '--global', 'core.hooksPath', '/somewhere/else');
  const u = uninstallGlobal();
  assert.equal(u.config, 'left-alone');
  assert.equal(readGlobalHooksPath(), '/somewhere/else');
  assert.ok(existsSync(local));
  assert.ok(u.removed.includes('pre-commit') && u.removed.includes('pre-push'));
}));

test('global pre-push chains the repo hook with the same args and stdin, and passes its exit code', () => withFakeGlobal((home, env) => {
  installGlobal();
  const dir = repo(env);
  const out = join(dir, 'seen');
  exe(join(dir, '.git', 'hooks'), 'pre-push', `printf '%s|%s\\n' "$1" "$2" > '${out}'; cat >> '${out}'; exit 3`);
  const input = 'refs/heads/a 1111 refs/heads/a 0000\nrefs/heads/b 2222 refs/heads/b 0000';
  const r = runHook(home, env, 'pre-push', dir, ['origin', 'git@example.com:x.git'], input + '\n');
  assert.equal(r.status, 3, 'team hook exit code passes through');
  assert.equal(readFileSync(out, 'utf8'), `origin|git@example.com:x.git\n${input}\n`);
  assert.match(r.stderr, /local review skipped \(report only\)/, 'codewatch part reports and continues');
}));

test('global pre-push exits 0 without a repo hook, even when the review fails', () => withFakeGlobal((home, env) => {
  installGlobal();
  const dir = repo(env);
  const bin = tmp('bin');
  exe(bin, 'prism-cli', 'cat >/dev/null; exit 1');
  const r = runHook(home, env, 'pre-push', dir, ['origin', 'u'], 'x y z w\n', `${bin}:/usr/bin:/bin`);
  assert.equal(r.status, 0, r.stderr);
}));

test('global pre-commit: a secret blocks before the repo hook; a clean scan runs it and keeps its code', () => withFakeGlobal((home, env) => {
  installGlobal();
  const dir = repo(env);
  const ran = join(dir, 'ran');
  exe(join(dir, '.git', 'hooks'), 'pre-commit', `echo local >> '${ran}'; exit 5`);
  const bin = tmp('bin');
  exe(bin, 'gitleaks', 'exit 1');
  const blocked = runHook(home, env, 'pre-commit', dir, [], '', `${bin}:/usr/bin:/bin`);
  assert.equal(blocked.status, 1);
  assert.ok(!existsSync(ran), 'repo hook not run once the commit is blocked');
  exe(bin, 'gitleaks', 'exit 0');
  const clean = runHook(home, env, 'pre-commit', dir, [], '', `${bin}:/usr/bin:/bin`);
  assert.equal(clean.status, 5, 'repo hook exit code passes through');
  assert.equal(readFileSync(ran, 'utf8'), 'local\n');
}));

test('a per-repo codewatch hook is not run twice; the team hook it backed up still runs', () => withFakeGlobal((home, env) => {
  installGlobal();
  const dir = repo(env);
  const ran = join(dir, 'ran');
  const hooks = join(dir, '.git', 'hooks');
  exe(hooks, 'pre-commit', `echo team >> '${ran}'`);
  installHooks(hooks); // moves the team hook to pre-commit.pre-prism and installs ours
  const r = runHook(home, env, 'pre-commit', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(ran, 'utf8'), 'team\n', 'backup ran exactly once; our per-repo hook did not');
}));

test('opt-out skips codewatch but still runs the repo hook', () => withFakeGlobal((home, env) => {
  installGlobal();
  const dir = repo(env);
  git(dir, env, 'config', 'prism.codewatch', 'false');
  assert.equal(isOptedOut(dir), true);
  const calls = join(dir, 'calls');
  const bin = tmp('bin');
  exe(bin, 'prism-cli', `echo "$*" >> '${calls}'; exit 0`);
  exe(bin, 'gitleaks', `echo gitleaks >> '${calls}'; exit 1`);
  const ran = join(dir, 'ran');
  exe(join(dir, '.git', 'hooks'), 'pre-commit', `echo local >> '${ran}'`);
  const r = runHook(home, env, 'pre-commit', dir, [], '', `${bin}:/usr/bin:/bin`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(calls), 'neither prism-cli nor gitleaks was called');
  assert.equal(readFileSync(ran, 'utf8'), 'local\n');
}));

test("a repo's own core.hooksPath (husky style) is detected", () => withFakeGlobal((_home, env) => {
  const dir = repo(env);
  assert.equal(repoLocalHooksPath(dir), null);
  git(dir, env, 'config', 'core.hooksPath', '.husky');
  assert.equal(repoLocalHooksPath(dir), '.husky');
}));

test('a result written into a repo without .prism/ keeps the working tree clean', () => withFakeGlobal((_home, env) => {
  const dir = repo(env);
  writeResult(dir, makeResult({ kind: 'secrets', hook: 'pre-commit', status: 'ok', tool: 'gitleaks', started_at: '2026-11-05T00:00:00.000Z', finished_at: '' }));
  assert.equal(git(dir, env, 'status', '--porcelain'), '', 'results are excluded via .git/info/exclude');
  assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /\/\.prism\/results\//);
  // a second write does not append again
  writeResult(dir, makeResult({ kind: 'secrets', hook: 'pre-commit', status: 'ok', tool: 'gitleaks', started_at: '2026-11-05T00:00:01.000Z', finished_at: '' }));
  assert.equal(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8').match(/\.prism\/results/g)?.length, 1);
}));
