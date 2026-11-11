import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecFileOptions } from 'node:child_process';
import { CliError, configuredCliPath, currentBranch, dashboardArgs, findOnPath, isResultId, reportArgs, resolveCli, runFile, type ExecFileFn } from '../src/cli';

test('dashboard argv: --json, scan rooted at the repo, --fresh only when asked', () => {
  assert.deepEqual(dashboardArgs('/w/my repo; rm -rf ~', false), ['dashboard', '--json', '--root', '/w/my repo; rm -rf ~']);
  assert.deepEqual(dashboardArgs('/w/r', true), ['dashboard', '--json', '--root', '/w/r', '--fresh']);
});

test('report argv and result id validation', () => {
  assert.deepEqual(reportArgs('/w/r', 'abc-20261111T1Z-pre-push-review', '/tmp/x/report.html'),
    ['codewatch', 'report', '--repo', '/w/r', '--id', 'abc-20261111T1Z-pre-push-review', '--format', 'html', '--output', '/tmp/x/report.html']);
  for (const bad of ['--format', '-x', '../x', 'a b', 'a;b', '', 7]) assert.equal(isResultId(bad), false, String(bad));
  assert.throws(() => reportArgs('/w/r', '--output=/etc/x', '/tmp/o'));
});

test('runFile: execFile with an argv array, shell false, cwd, timeout and max buffer', async () => {
  const calls: { file: string; args: string[]; opts: ExecFileOptions }[] = [];
  const exec: ExecFileFn = (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, '{"ok":1}', ''); };
  assert.equal(await runFile('/bin/prism-cli', ['dashboard', '--json'], '/w/r', 5000, exec), '{"ok":1}');
  assert.equal(calls[0].file, '/bin/prism-cli');
  assert.deepEqual(calls[0].args, ['dashboard', '--json']);
  assert.equal(calls[0].opts.shell, false);
  assert.equal(calls[0].opts.cwd, '/w/r');
  assert.equal(calls[0].opts.timeout, 5000);
  assert.ok((calls[0].opts.maxBuffer ?? 0) >= 1024 * 1024);
});

test('runFile errors: not found, timeout, stderr last line', async () => {
  const fail = (err: object, stderr = ''): ExecFileFn => (_f, _a, _o, cb) => cb(Object.assign(new Error('x'), err), '', stderr);
  await assert.rejects(runFile('p', ['a'], '/', 1, fail({ code: 'ENOENT' })), (e: unknown) => e instanceof CliError && e.notFound);
  await assert.rejects(runFile('p', ['dashboard'], '/', 2000, fail({ killed: true })), /dashboard timed out after 2 s/);
  await assert.rejects(runFile('p', ['a'], '/', 1, fail({ code: 1 }, 'warn\nError: bad thing\n')), /: Error: bad thing$/);
});

test('currentBranch: detached HEAD and git failure are null', async () => {
  const out = (s: string): ExecFileFn => (_f, _a, _o, cb) => cb(null, s, '');
  assert.equal(await currentBranch('/r', out('main\n')), 'main');
  assert.equal(await currentBranch('/r', out('HEAD\n')), null);
  assert.equal(await currentBranch('/r', (_f, _a, _o, cb) => cb(new Error('no git'), '', '')), null);
});

test('prism.cliPath: only the user (machine) value counts, never a workspace value', () => {
  assert.equal(configuredCliPath({ globalValue: '/opt/prism-cli' }), '/opt/prism-cli');
  assert.equal(configuredCliPath({ globalValue: '  ' }), null);
  assert.equal(configuredCliPath({ workspaceValue: '/evil', workspaceFolderValue: '/evil' } as { globalValue?: unknown }), null);
  assert.equal(configuredCliPath(undefined), null);
});

test('package.json: cliPath is machine-scoped, untrusted workspaces unsupported, no telemetry or remote deps', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.equal(pkg.contributes.configuration.properties['prism.cliPath'].scope, 'machine');
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, false);
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
});

test('resolveCli: setting must be absolute and executable; else PATH, absolute entries only', () => {
  const execs = new Set(['/usr/local/bin/prism-cli', '/opt/p/prism-cli']);
  const isExec = (p: string) => execs.has(p);
  assert.deepEqual(resolveCli('/opt/p/prism-cli', '', 'linux', isExec), { ok: true, path: '/opt/p/prism-cli' });
  assert.equal(resolveCli('bin/prism-cli', '/usr/local/bin', 'linux', isExec).ok, false);
  assert.equal(resolveCli('/opt/none', '/usr/local/bin', 'linux', isExec).ok, false);
  assert.deepEqual(resolveCli(null, '.:node_modules/.bin:/usr/local/bin', 'linux', (p) => p === 'prism-cli' || p === 'node_modules/.bin/prism-cli' || isExec(p)), { ok: true, path: '/usr/local/bin/prism-cli' });
  assert.deepEqual(resolveCli(null, '/usr/bin', 'linux', isExec), { ok: false, reason: 'prism-cli is not on PATH' });
});

test('findOnPath on Windows finds only .exe (no .cmd: it needs a shell)', () => {
  const seen: string[] = [];
  findOnPath('prism-cli', 'C:\\npm;C:\\bin', 'win32', (p) => { seen.push(p); return false; });
  assert.ok(seen.every((p) => p.endsWith('prism-cli.exe')));
});
