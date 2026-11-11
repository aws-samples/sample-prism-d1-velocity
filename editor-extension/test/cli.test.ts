import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecFileOptions } from 'node:child_process';
import { CliError, cliEnv, configuredCliPath, currentBranch, dashboardArgs, findOnPath, isResultId, reportArgs, resolveCli, runCli, runFile, userInstallDirs, type DirReader, type ExecFileFn } from '../src/cli';

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
  assert.deepEqual(pkg.extensionKind, ['workspace']); // runs where the repo and prism-cli are, e.g. the Remote-SSH host
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
});

const HOME = '/home/user';
const NVM = `${HOME}/.nvm/versions/node`;
/** dirs: folder -> entries; files: path -> text. */
const fakeFs = (dirs: Record<string, string[]>, files: Record<string, string> = {}): DirReader => ({
  readDir: (p) => dirs[p] ?? [],
  readText: (p) => files[p] ?? null,
});
const nvmDirs = { [NVM]: ['v18.20.8', 'v22.23.1', 'v20.20.2', 'v9.11.2', 'not-a-version'] };

test('resolveCli: setting must be absolute and executable; else PATH, absolute entries only', () => {
  const execs = new Set(['/usr/local/bin/prism-cli', '/opt/p/prism-cli']);
  const isExec = (p: string) => execs.has(p);
  const d = { platform: 'linux' as const, isExec, home: HOME, fs: fakeFs({}) };
  assert.deepEqual(resolveCli('/opt/p/prism-cli', {}, d), { ok: true, path: '/opt/p/prism-cli' });
  assert.equal(resolveCli('bin/prism-cli', { PATH: '/usr/local/bin' }, d).ok, false);
  assert.equal(resolveCli('/opt/none', { PATH: '/usr/local/bin' }, d).ok, false);
  assert.deepEqual(resolveCli(null, { PATH: '.:node_modules/.bin:/usr/local/bin' }, { ...d, isExec: (p) => p === 'prism-cli' || p === 'node_modules/.bin/prism-cli' || isExec(p) }), { ok: true, path: '/usr/local/bin/prism-cli' });
  const miss = resolveCli(null, { PATH: '/usr/bin' }, d);
  assert.equal(miss.ok, false);
});

test('findOnPath on Windows finds only .exe (no .cmd: it needs a shell)', () => {
  const seen: string[] = [];
  findOnPath('prism-cli', 'C:\\npm;C:\\bin', 'win32', (p) => { seen.push(p); return false; });
  assert.ok(seen.every((p) => p.endsWith('prism-cli.exe')));
});

test('nvm discovery: the default alias version first, when it has prism-cli', () => {
  const fs = fakeFs(nvmDirs, { [`${HOME}/.nvm/alias/default`]: '20\n' });
  const isExec = (p: string) => p === `${NVM}/v20.20.2/bin/prism-cli` || p === `${NVM}/v22.23.1/bin/prism-cli`;
  assert.deepEqual(resolveCli(null, { PATH: '/usr/bin:/bin' }, { platform: 'linux', isExec, home: HOME, fs }), { ok: true, path: `${NVM}/v20.20.2/bin/prism-cli` });
  // An alias that names another alias (lts/* -> lts/iron -> v18.x).
  const chained = fakeFs(nvmDirs, { [`${HOME}/.nvm/alias/default`]: 'lts/*', [`${HOME}/.nvm/alias/lts/*`]: 'lts/iron', [`${HOME}/.nvm/alias/lts/iron`]: 'v18.20.8' });
  assert.equal(userInstallDirs(HOME, {}, chained)[0], `${NVM}/v18.20.8/bin`);
});

test('nvm discovery: highest version when the default alias does not resolve or lacks prism-cli', () => {
  const isExec = (p: string) => p === `${NVM}/v18.20.8/bin/prism-cli` || p === `${NVM}/v22.23.1/bin/prism-cli`;
  for (const alias of [undefined, '20', 'v16', 'lts/missing', '../../etc/x']) {
    const fs = fakeFs(nvmDirs, alias ? { [`${HOME}/.nvm/alias/default`]: alias } : {});
    assert.deepEqual(resolveCli(null, { PATH: '/usr/bin' }, { platform: 'linux', isExec, home: HOME, fs }), { ok: true, path: `${NVM}/v22.23.1/bin/prism-cli` }, String(alias));
  }
  // Numeric semver order (v9 below v18), non-version entries ignored.
  assert.deepEqual(userInstallDirs(HOME, {}, fakeFs(nvmDirs)).slice(0, 4), ['v22.23.1', 'v20.20.2', 'v18.20.8', 'v9.11.2'].map((v) => `${NVM}/${v}/bin`));
});

test('user install search order; missing nvm dir; only absolute paths', () => {
  const env = { NVM_BIN: `${HOME}/n/bin`, VOLTA_HOME: `${HOME}/v`, NPM_CONFIG_PREFIX: `${HOME}/prefix` };
  assert.deepEqual(userInstallDirs(HOME, env, fakeFs({})), [`${HOME}/n/bin`, `${HOME}/v/bin`, `${HOME}/.local/bin`, `${HOME}/.npm-global/bin`, `${HOME}/prefix/bin`]);
  assert.deepEqual(userInstallDirs(HOME, { NVM_BIN: 'rel/bin', VOLTA_HOME: 'rel' }, fakeFs({})), [`${HOME}/.local/bin`, `${HOME}/.npm-global/bin`]);
  // $NVM_BIN wins over the nvm tree.
  const isExec = (p: string) => p === `${HOME}/n/bin/prism-cli` || p === `${NVM}/v22.23.1/bin/prism-cli`;
  assert.deepEqual(resolveCli(null, { PATH: '', ...env }, { platform: 'linux', isExec, home: HOME, fs: fakeFs(nvmDirs) }), { ok: true, path: `${HOME}/n/bin/prism-cli` });
  // Nothing anywhere: the not-found result lists every searched location.
  const r = resolveCli(null, { PATH: '/usr/bin' }, { platform: 'linux', isExec: () => false, home: HOME, fs: fakeFs({}) });
  assert.equal(r.ok, false);
  assert.deepEqual(!r.ok && r.searched, ['PATH', `${NVM}/*/bin`, `${HOME}/.volta/bin`, `${HOME}/.local/bin`, `${HOME}/.npm-global/bin`]);
});

test('spawn env: the CLI folder goes first on PATH, the rest of the env is unchanged', () => {
  const base = { PATH: '/usr/bin:/bin', HOME, LANG: 'C' };
  assert.deepEqual(cliEnv(`${NVM}/v22.23.1/bin/prism-cli`, base, 'linux'), { ...base, PATH: `${NVM}/v22.23.1/bin:/usr/bin:/bin` });
  assert.equal(cliEnv('/opt/p/prism-cli', { HOME }, 'linux').PATH, '/opt/p');
  assert.equal(base.PATH, '/usr/bin:/bin', 'input env not mutated');
});

test('runCli: argv array, shell false, PATH prepended, also for an explicit prism.cliPath', async () => {
  const explicit = resolveCli('/opt/custom/bin/prism-cli', { PATH: '/usr/bin' }, { platform: 'linux', isExec: () => true, home: HOME, fs: fakeFs({}) });
  assert.ok(explicit.ok);
  const calls: { file: string; args: string[]; opts: ExecFileOptions }[] = [];
  const exec: ExecFileFn = (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, '1.7.1\n', ''); };
  assert.equal(await runCli(explicit.ok ? explicit.path : '', ['--version'], '/w/r', 5000, exec, { PATH: '/usr/bin:/bin', HOME }), '1.7.1\n');
  assert.equal(calls[0].file, '/opt/custom/bin/prism-cli');
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal(calls[0].opts.shell, false);
  assert.deepEqual(calls[0].opts.env, { PATH: '/opt/custom/bin:/usr/bin:/bin', HOME });
});
