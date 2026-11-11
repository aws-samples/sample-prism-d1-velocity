/**
 * Tests for `prism-cli enable codewatch`: reviewer detection and resolution,
 * adapter output parsing (recorded fixtures, no live model calls), the result
 * writer, hook install/uninstall, and the pre-push gate always exiting 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADAPTERS, detectReviewers, resolveReviewer, extractReviewJson } from '../src/codewatch/reviewers/index.js';
import { gitleaksInstallHint, parseGitleaksReport, runPreCommit } from '../src/codewatch/gitleaks.js';
import { makeResult, readResults, resultFileName, writeResult, RESULTS_DIR, REASON_GITLEAKS_MISSING } from '../src/codewatch/results.js';
import { runPrePush, parsePushInput } from '../src/codewatch/prepush.js';
import { installHooks, uninstallHooks, retireLegacyCommitMsgHook, ensureResultsIgnored, PRE_PUSH_SCRIPT, PRE_COMMIT_SCRIPT } from '../src/codewatch/hooks.js';
import { writeEvalConfig, readPrismConfig } from '../src/codewatch/config.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'review');
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8');

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `prism-sec-${prefix}-`));
}

/** Writes an executable shell script. */
function exe(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Repo on branch `work` with an upstream `origin/work` one commit behind,
 * set up without any network push. Template dir is emptied so a global
 * init.templateDir cannot inject hooks into the fixture.
 */
function makeRepo(): { dir: string; head: string; base: string } {
  const dir = tmp('repo');
  const tpl = tmp('tpl');
  git(dir, 'init', '-q', '-b', 'work', `--template=${tpl}`);
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'tester');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init', '--no-verify');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'remote', 'add', 'origin', '/nonexistent');
  git(dir, 'update-ref', 'refs/remotes/origin/work', base);
  git(dir, 'branch', '-q', '--set-upstream-to=origin/work');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'feat', '--no-verify');
  return { dir, head: git(dir, 'rev-parse', 'HEAD'), base };
}

/** runPrePush shells out to git relative to cwd, like a real hook. */
function inDir<T>(dir: string, fn: () => T): T {
  const prev = process.cwd();
  process.chdir(dir);
  try { return fn(); } finally { process.chdir(prev); }
}

function pushLine(r: { head: string; base: string }): string {
  return `refs/heads/work ${r.head} refs/heads/work ${r.base}\n`;
}

// ---------------------------------------------------------------- detection

test('detectReviewers finds only executables on PATH', () => {
  const a = tmp('patha');
  const b = tmp('pathb');
  exe(a, 'claude', 'exit 0');
  writeFileSync(join(b, 'kiro-cli'), 'not executable');
  assert.deepEqual(detectReviewers(`${a}:${b}`), ['claude']);
  exe(b, 'kiro-cli', 'exit 0');
  assert.deepEqual(detectReviewers(`${a}:${b}`), ['kiro', 'claude']);
  assert.deepEqual(detectReviewers(''), []);
});

test('resolveReviewer: git config overrides team config', () => {
  const c = resolveReviewer({ gitConfigValue: 'claude', prismConfigValue: 'kiro', available: ['kiro', 'claude'] });
  assert.deepEqual([c.id, c.source], ['claude', 'git-config']);
});

test('resolveReviewer: team config used when no override', () => {
  const c = resolveReviewer({ gitConfigValue: null, prismConfigValue: 'kiro', available: ['kiro', 'claude'] });
  assert.deepEqual([c.id, c.source], ['kiro', 'prism-config']);
});

test('resolveReviewer: a Claude Code user on a kiro team does not need kiro-cli', () => {
  const c = resolveReviewer({ gitConfigValue: null, prismConfigValue: 'kiro', available: ['claude'] });
  assert.equal(c.id, 'claude');
  assert.equal(c.source, 'fallback');
  assert.match(c.note || '', /kiro-cli is not on PATH/);
});

test('resolveReviewer: invalid values are ignored with a note; none available gives null', () => {
  const c = resolveReviewer({ gitConfigValue: 'copilot', prismConfigValue: undefined, available: ['kiro'] });
  assert.equal(c.id, 'kiro');
  assert.match(c.note || '', /ignored git config/);
  const n = resolveReviewer({ gitConfigValue: null, prismConfigValue: 'claude', available: [] });
  assert.equal(n.id, null);
  assert.equal(n.source, 'none');
});

// ---------------------------------------------------------------- adapters

test('kiro adapter parses recorded kiro-cli output into the schema', () => {
  const r = ADAPTERS.kiro.parse(fixture('kiro-output.txt'));
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.severity, 'high');
  assert.equal(f.category, 'security');
  assert.equal(f.file, 'src/lookup.ts');
  assert.equal(f.line, 4);
  assert.match(f.rule, /command injection/);
  assert.equal(r.score, 0.4);
  assert.equal(r.model, null);
});

test('kiro adapter extracts JSON from ANSI, status lines and code fences', () => {
  const r = ADAPTERS.kiro.parse(fixture('kiro-output-noisy.txt'));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].line, 4);
});

test('kiro adapter rejects output with no review JSON', () => {
  assert.throws(() => ADAPTERS.kiro.parse('I could not read the file {oops}'), /findings/);
});

test('kiro invocation trusts only fs_read and points at the rules file', () => {
  const inv = ADAPTERS.kiro.invocation({ repoRoot: '/r', rulesPath: '.prism/review/rules.md', rulesText: 'R', diffPath: '/t/d.diff', diff: 'D' });
  assert.ok(inv.args.includes('--no-interactive'));
  assert.ok(inv.args.includes('--trust-tools=fs_read'));
  assert.ok(!inv.args.includes('--trust-all-tools'));
  assert.match(inv.args[inv.args.length - 1], /\.prism\/review\/rules\.md.*\/t\/d\.diff/s);
});

test('claude adapter parses the JSON envelope, normalises fields, picks the main model', () => {
  const r = ADAPTERS.claude.parse(fixture('claude-success.json'));
  assert.equal(r.model, 'claude-sonnet-4-5-20250929');
  assert.equal(r.findings.length, 2);
  assert.deepEqual(r.findings[0], {
    severity: 'high', category: 'security', rule: 'Command injection via string concatenation',
    file: 'src/lookup.ts', line: 4, message: 'user is concatenated into an execSync shell command.',
  });
  // category maintainability -> quality; missing rule falls back to the category
  assert.equal(r.findings[1].category, 'quality');
  assert.equal(r.findings[1].rule, 'maintainability');
  assert.equal(r.findings[1].severity, 'low');
});

test('claude adapter surfaces a recorded is_error envelope as an error', () => {
  assert.throws(() => ADAPTERS.claude.parse(fixture('claude-error.json')), /Could not load credentials/);
  assert.throws(() => ADAPTERS.claude.parse('not json'), /not JSON/);
});

test('claude invocation is headless JSON with read-only tools and inline rules', () => {
  const inv = ADAPTERS.claude.invocation({ repoRoot: '/r', rulesPath: 'x', rulesText: 'RULE-TEXT', diffPath: '/t/d', diff: 'DIFF-TEXT' });
  const a = inv.args;
  assert.equal(a[0], '-p');
  assert.equal(a[a.indexOf('--output-format') + 1], 'json');
  assert.equal(a[a.indexOf('--allowed-tools') + 1], 'Read,Grep,Glob');
  const denied = a[a.indexOf('--disallowed-tools') + 1].split(',');
  for (const t of ['Bash', 'Edit', 'Write']) assert.ok(denied.includes(t), t);
  assert.match(inv.input || '', /RULE-TEXT[\s\S]*DIFF-TEXT/);
});

test('extractReviewJson prefers the last valid review object', () => {
  const o = extractReviewJson('example {"findings":[1]} then {"x": "}"} final {"findings":[],"score":1}');
  assert.equal(o.score, 1);
});

// ---------------------------------------------------------------- gitleaks + results

test('parseGitleaksReport maps findings and never carries the secret', () => {
  const findings = parseGitleaksReport(fixture('gitleaks-report.json'));
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((f) => [f.rule, f.file, f.line, f.severity, f.category]), [
    ['aws-access-token', 'src/aws.ts', 2, 'high', 'security'],
    ['generic-api-key', 'src/aws.ts', 3, 'high', 'security'],
  ]);
  assert.ok(!JSON.stringify(findings).includes('REDACTED'), 'Match/Secret fields must not be projected');
});

test('writeResult writes an atomic, private, schema-tagged file named by commit and time', () => {
  const dir = tmp('res');
  const r = makeResult({ kind: 'review', hook: 'pre-push', status: 'ok', tool: 'kiro', commit: 'abcdef1234567890', started_at: '2026-11-04T20:20:00.123Z', finished_at: '2026-11-04T20:21:00.000Z' });
  const p = writeResult(dir, r);
  assert.equal(p, join(dir, RESULTS_DIR, 'abcdef123456-20261104T202000123Z-pre-push-review.json'));
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(dir, RESULTS_DIR)), ['abcdef123456-20261104T202000123Z-pre-push-review.json']);
  const back = readResults(dir);
  assert.equal(back.length, 1);
  assert.equal(back[0].schema_version, 1);
  assert.equal(back[0].tool, 'kiro');
});

test('resultFileName cannot escape the results directory', () => {
  const r = makeResult({ kind: 'secrets', hook: 'pre-commit', status: 'ok', tool: 'gitleaks', tree: '../../etc/passwd', started_at: '2026-01-01T00:00:00.000Z', finished_at: '' });
  const name = resultFileName(r);
  assert.ok(!name.includes('/') && !name.includes('..'), name);
  assert.match(name, /^tree-/);
});

test('readResults ignores unparseable and foreign files', () => {
  const dir = tmp('res2');
  mkdirSync(join(dir, RESULTS_DIR), { recursive: true });
  writeFileSync(join(dir, RESULTS_DIR, 'bad.json'), '{');
  writeFileSync(join(dir, RESULTS_DIR, 'other.json'), '{"schema_version":99}');
  assert.deepEqual(readResults(dir), []);
});

test('pre-commit allows the commit and records skipped/gitleaks-missing when gitleaks is absent', () => {
  const repo = makeRepo();
  writeFileSync(join(repo.dir, 'src', 'b.ts'), 'export const b = 2;\n');
  git(repo.dir, 'add', '.');
  const staged = git(repo.dir, 'write-tree');
  const out = inDir(repo.dir, () => runPreCommit(repo.dir, join(tmp('nogl'), 'gitleaks')));
  assert.equal(out.exitCode, 0, 'a missing gitleaks must not block the commit');
  assert.equal(out.result.status, 'skipped');
  assert.equal(out.result.reason, REASON_GITLEAKS_MISSING);
  assert.equal(out.result.tree, staged);
  assert.equal(out.result.branch, 'work');
  const saved = readResults(repo.dir);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].reason, 'gitleaks-missing');
  assert.ok(out.resultPath && out.resultPath.includes('-pre-commit-secrets.json'));
});

test('pre-push does not re-report a commit already recorded as gitleaks-missing', () => {
  const repo = makeRepo();
  const tree = git(repo.dir, 'rev-parse', `${repo.head}^{tree}`);
  writeResult(repo.dir, makeResult({ kind: 'secrets', hook: 'pre-commit', status: 'skipped', reason: REASON_GITLEAKS_MISSING, tool: 'gitleaks', tree, started_at: new Date().toISOString(), finished_at: '' }));
  inDir(repo.dir, () => runPrePush({ repoRoot: repo.dir, stdin: pushLine(repo), remote: 'origin', pathEnv: tmp('empty'), log: () => {} }));
  const skipped = readResults(repo.dir).filter((r) => r.status === 'skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].hook, 'pre-commit');
});

test('gitleaks install hint is per platform and never pipes curl into a shell', () => {
  assert.match(gitleaksInstallHint('darwin'), /^brew install gitleaks/);
  assert.match(gitleaksInstallHint('win32'), /^scoop install gitleaks/);
  assert.match(gitleaksInstallHint('linux'), /github\.com\/gitleaks\/gitleaks\/releases/);
  assert.match(gitleaksInstallHint('linux'), /go install github\.com\/zricethezav\/gitleaks\/v8@latest/);
  for (const p of ['darwin', 'win32', 'linux'] as const) assert.doesNotMatch(gitleaksInstallHint(p), /curl|\|\s*(ba|z)?sh/);
});

test('enable codewatch prints the shared install hint when gitleaks is missing', () => {
  const repo = makeRepo();
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'prism-cli.ts');
  const bin = tmp('nogl-bin');
  exe(bin, 'claude', 'exit 0');
  // tsx resolved from the CLI package, not from the throwaway repo the command runs in.
  const tsx = import.meta.resolve('tsx');
  const r = spawnSync(process.execPath, ['--import', tsx, cli, 'enable', 'codewatch', '--reviewer', 'claude'],
    { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`Install it: ${gitleaksInstallHint()}`), r.stdout);
  assert.ok(!r.stdout.includes('#installing'), 'generic docs link is gone');
});

// ---------------------------------------------------------------- pre-push always exits 0

test('parsePushInput skips deletions and malformed lines', () => {
  const z = '0'.repeat(40);
  const refs = parsePushInput(`refs/heads/a ${'1'.repeat(40)} refs/heads/a ${z}\n(delete) ${z} refs/heads/b ${'2'.repeat(40)}\ngarbage\n\n`);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].localRef, 'refs/heads/a');
});

test('pre-push exits 0 and records an error when no reviewer is installed', () => {
  const repo = makeRepo();
  const logs: string[] = [];
  const code = inDir(repo.dir, () => runPrePush({ repoRoot: repo.dir, stdin: pushLine(repo), remote: 'origin', pathEnv: tmp('empty'), log: (l) => logs.push(l) }));
  assert.equal(code, 0);
  const review = readResults(repo.dir).find((r) => r.kind === 'review');
  assert.ok(review);
  assert.equal(review.status, 'error');
  assert.equal(review.tool, 'none');
  assert.match(logs.join('\n'), /Push continues/);
});

test('pre-push exits 0 when the reviewer crashes or prints garbage', () => {
  const repo = makeRepo();
  const bin = tmp('bin');
  // Reads its stdin first: a child that exits before the prompt is written fails with EPIPE instead, depending on timing.
  exe(bin, 'claude', 'cat >/dev/null; echo "segfault-ish nonsense"; exit 3');
  writeEvalConfig(repo.dir, { reviewer: 'claude' });
  const code = inDir(repo.dir, () => runPrePush({ repoRoot: repo.dir, stdin: pushLine(repo), remote: 'origin', pathEnv: bin, log: () => {} }));
  assert.equal(code, 0);
  const review = readResults(repo.dir).find((r) => r.kind === 'review');
  assert.equal(review?.status, 'error');
  assert.equal(review?.tool, 'claude');
  assert.match(review?.reason || '', /exit 3/);
});

test('pre-push exits 0 with findings, records commit/branch/upstream, and flags unscanned commits', () => {
  const repo = makeRepo();
  const bin = tmp('bin');
  const fx = join(FIX, 'kiro-output.txt');
  exe(bin, 'kiro-cli', `if [ "$1" = "--version" ]; then echo "kiro-cli 9.9.9"; exit 0; fi\ncat '${fx}'`);
  writeEvalConfig(repo.dir, { reviewer: 'kiro' });
  const code = inDir(repo.dir, () => runPrePush({ repoRoot: repo.dir, stdin: pushLine(repo), remote: 'origin', pathEnv: bin, log: () => {} }));
  assert.equal(code, 0);
  const all = readResults(repo.dir);
  const review = all.find((r) => r.kind === 'review');
  assert.equal(review?.status, 'findings');
  assert.equal(review?.tool, 'kiro');
  assert.equal(review?.tool_version, 'kiro-cli 9.9.9');
  assert.equal(review?.commit, repo.head);
  assert.equal(review?.branch, 'work');
  assert.equal(review?.upstream, 'origin/work');
  assert.equal(review?.base, repo.base);
  assert.equal(review?.findings[0].line, 4);
  // the 'feat' commit was made with --no-verify, so it has no pre-commit scan
  const skipped = all.filter((r) => r.kind === 'secrets' && r.status === 'skipped');
  assert.deepEqual(skipped.map((r) => r.commit), [repo.head]);
});

test('pre-push does not flag a commit whose staged tree was scanned at pre-commit', () => {
  const repo = makeRepo();
  const tree = git(repo.dir, 'rev-parse', `${repo.head}^{tree}`);
  writeResult(repo.dir, makeResult({ kind: 'secrets', hook: 'pre-commit', status: 'ok', tool: 'gitleaks', tree, started_at: new Date().toISOString(), finished_at: '' }));
  inDir(repo.dir, () => runPrePush({ repoRoot: repo.dir, stdin: pushLine(repo), remote: 'origin', pathEnv: tmp('empty'), log: () => {} }));
  assert.equal(readResults(repo.dir).filter((r) => r.status === 'skipped').length, 0);
});

test('pre-push exits 0 on empty or malformed input and outside a repo', () => {
  assert.equal(runPrePush({ repoRoot: tmp('x'), stdin: '', remote: null, log: () => {} }), 0);
  assert.equal(runPrePush({ repoRoot: tmp('x'), stdin: 'a b c d\n', remote: null, log: () => {} }), 0);
});

test('pre-push hook script exits 0 when prism-cli fails or is missing', () => {
  const dir = tmp('hook');
  const hook = exe(dir, 'pre-push', PRE_PUSH_SCRIPT.replace(/^#!\/bin\/sh\n/, ''));
  const failing = tmp('failbin');
  exe(failing, 'prism-cli', 'cat >/dev/null; exit 1');
  const sysPath = '/usr/bin:/bin';
  for (const PATH of [`${failing}:${sysPath}`, sysPath]) {
    const r = spawnSync(hook, ['origin', 'url'], { input: 'refs/heads/a 1 refs/heads/a 2\n', encoding: 'utf8', env: { PATH } });
    assert.equal(r.status, 0, `PATH=${PATH}: ${r.stderr}`);
  }
});

test('pre-commit hook script blocks when gitleaks (no prism-cli) reports a leak', () => {
  const dir = tmp('hook2');
  const hook = exe(dir, 'pre-commit', PRE_COMMIT_SCRIPT.replace(/^#!\/bin\/sh\n/, ''));
  const bin = tmp('glbin');
  // An older prism-cli without "codewatch pre-commit" must not block the commit.
  exe(bin, 'prism-cli', 'echo "error: unknown command" >&2; exit 1');
  exe(bin, 'gitleaks', 'exit 1');
  const blocked = spawnSync(hook, [], { encoding: 'utf8', cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin` } });
  assert.equal(blocked.status, 1);
  exe(bin, 'gitleaks', 'exit 0');
  const clean = spawnSync(hook, [], { encoding: 'utf8', cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin` } });
  assert.equal(clean.status, 0);
});

test('per-repo hooks honour git config prism.codewatch false, set in the repo or --global', () => {
  const repo = makeRepo();
  const hooks = join(repo.dir, '.git', 'hooks');
  installHooks(hooks);
  const calls = join(tmp('calls'), 'calls');
  const bin = tmp('optbin');
  exe(bin, 'prism-cli', `echo "$*" >> '${calls}'; cat >/dev/null; exit 1`);
  exe(bin, 'gitleaks', `echo gitleaks >> '${calls}'; exit 1`);
  const globalCfg = join(tmp('gcfg'), 'gitconfig');
  writeFileSync(globalCfg, '');
  const env = { PATH: `${bin}:/usr/bin:/bin`, GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1' };
  const runHook = (hook: string) => spawnSync(join(hooks, hook), ['origin'], { cwd: repo.dir, encoding: 'utf8', input: pushLine(repo), env });

  assert.equal(runHook('pre-commit').status, 1, 'not opted out: the leak blocks');

  git(repo.dir, 'config', 'prism.codewatch', 'false');
  rmSync(calls, { force: true });
  assert.equal(runHook('pre-commit').status, 0);
  assert.equal(runHook('pre-push').status, 0);
  assert.ok(!existsSync(calls), 'repo opt-out: neither prism-cli nor gitleaks ran');

  git(repo.dir, 'config', '--unset', 'prism.codewatch');
  spawnSync('git', ['config', '--global', 'prism.codewatch', 'false'], { env });
  assert.equal(runHook('pre-commit').status, 0);
  assert.ok(!existsSync(calls), 'global opt-out applies to per-repo hooks too');

  git(repo.dir, 'config', 'prism.codewatch', 'true');
  assert.equal(runHook('pre-commit').status, 1, 'the repo value wins over --global');
});

// ---------------------------------------------------------------- install / uninstall

test('installHooks backs up and chains a foreign hook; uninstall restores it', () => {
  const hooks = tmp('hooks');
  exe(hooks, 'pre-commit', 'echo team-hook');
  installHooks(hooks);
  assert.match(readFileSync(join(hooks, 'pre-commit'), 'utf8'), /prism-cli enable codewatch/);
  assert.equal(readFileSync(join(hooks, 'pre-commit.pre-prism'), 'utf8'), '#!/bin/sh\necho team-hook\n');
  // reinstall must not back up our own hook over the original
  installHooks(hooks);
  assert.equal(readFileSync(join(hooks, 'pre-commit.pre-prism'), 'utf8'), '#!/bin/sh\necho team-hook\n');
  uninstallHooks(hooks);
  assert.equal(readFileSync(join(hooks, 'pre-commit'), 'utf8'), '#!/bin/sh\necho team-hook\n');
  assert.ok(!existsSync(join(hooks, 'pre-commit.pre-prism')));
  assert.ok(!existsSync(join(hooks, 'pre-push')));
});

test('hooks written before the rename are replaced in place, not backed up and chained', () => {
  const hooks = tmp('hooks-old');
  const old = '# prism-cli enable security -- pre-commit secret scan\nexec prism-cli git pre-commit';
  exe(hooks, 'pre-commit', old);
  exe(hooks, 'pre-push', '# prism-cli enable security -- pre-push\nprism-cli git pre-push || true');
  installHooks(hooks);
  assert.ok(!existsSync(join(hooks, 'pre-commit.pre-prism')), 'old-name hook must not become a chained backup');
  assert.ok(!existsSync(join(hooks, 'pre-push.pre-prism')));
  const now = readFileSync(join(hooks, 'pre-commit'), 'utf8');
  assert.match(now, /prism-cli codewatch pre-commit/);
  assert.doesNotMatch(now, /prism-cli git pre-commit/);
  // and uninstall removes an old-name hook outright
  exe(hooks, 'pre-push', '# prism-cli enable security -- pre-push\nprism-cli git pre-push || true');
  uninstallHooks(hooks);
  assert.ok(!existsSync(join(hooks, 'pre-push')));
  assert.ok(!existsSync(join(hooks, 'pre-commit')));
});

test('uninstallHooks leaves a hook it did not install', () => {
  const hooks = tmp('hooks2');
  exe(hooks, 'pre-push', 'echo theirs');
  const changes = uninstallHooks(hooks);
  assert.ok(existsSync(join(hooks, 'pre-push')));
  assert.match(changes.find((c) => c.hook === 'pre-push')!.action, /left alone/);
});

test('retireLegacyCommitMsgHook removes only the PRISM trailer hook and restores its backup', () => {
  const hooks = tmp('hooks3');
  exe(hooks, 'prepare-commit-msg', '# adds AI-Origin trailers');
  exe(hooks, 'prepare-commit-msg.pre-prism', 'echo original');
  assert.ok(retireLegacyCommitMsgHook(hooks));
  assert.match(readFileSync(join(hooks, 'prepare-commit-msg'), 'utf8'), /echo original/);
  assert.equal(retireLegacyCommitMsgHook(hooks), null, 'a non-PRISM hook is not touched');
});

test('ensureResultsIgnored is idempotent and config merge keeps other keys', () => {
  const dir = tmp('gi');
  writeFileSync(join(dir, '.gitignore'), 'node_modules');
  assert.equal(ensureResultsIgnored(dir), true);
  assert.equal(ensureResultsIgnored(dir), false);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules\n# prism-cli local gate results (per developer, not shared)\n.prism/results/\n');
  mkdirSync(join(dir, '.prism'));
  writeFileSync(join(dir, '.prism', 'config.json'), '{"team_id":"t1"}');
  writeEvalConfig(dir, { reviewer: 'kiro' });
  assert.deepEqual(readPrismConfig(dir), { team_id: 't1', eval: { reviewer: 'kiro' } });
  rmSync(dir, { recursive: true, force: true });
});
