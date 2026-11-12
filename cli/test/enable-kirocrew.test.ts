import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunResult } from '../src/utils/exec.js';
import {
  enableKirocrew, grantsLine, makePlan, parseCronList, parseJsonAfterLogs, planArgs, stageApp, targetDir, toAppInfo, type KirocrewDeps,
} from '../src/commands/enable/kirocrew.js';
import { findKirocrew, installedAppVersion, kirocrewAppState } from '../src/utils/kirocrew.js';
import { appOutdated, buildReport, kirocrewVersionLine, printReport } from '../src/commands/_top/version.js';
import { kirocrewAppCheck, machineChecks } from '../src/dashboard/setup.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** A fake bundle: the app plus the files the copy must leave out. */
function bundle(version = '0.2.2'): string {
  const d = tmp('prism-kc-bundle-');
  writeFileSync(join(d, 'app.json'), JSON.stringify({ name: 'prism', version, crons: [{ name: 'prism-daily-digest' }] }));
  mkdirSync(join(d, 'scripts', '__pycache__'), { recursive: true });
  writeFileSync(join(d, 'scripts', 'digest.py'), '# digest\n');
  writeFileSync(join(d, 'scripts', '__pycache__', 'digest.pyc'), 'x');
  for (const ex of ['tests', 'data', '.pytest_cache']) {
    mkdirSync(join(d, ex));
    writeFileSync(join(d, ex, 'f'), 'x');
  }
  return d;
}

/** A folder holding an executable `kirocrew` (never run: deps.run is faked). */
function kcBin(): string {
  const d = tmp('prism-kc-bin-');
  writeFileSync(join(d, 'kirocrew'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(d, 'kirocrew'), 0o755);
  return d;
}

const LOGS = '20:39:07 WARNING kiro_crew.config.loader: 2 stored config value(s) still hold a superseded default\n';

function infoJson(o: { version: string; source: string; enabled?: boolean; grants?: string[] }): string {
  return LOGS + JSON.stringify({
    name: 'prism', version: o.version, enabled: o.enabled ?? true, source: o.source,
    approvedGrantsStored: !!o.grants, approvedGrants: { api: o.grants ?? [], events: [] },
    manifest: { version: o.version, permissions: { api: ['/api/apps/prism/*'] } },
  }, null, 2);
}

interface Fake {
  installed?: { version: string; source?: string; enabled?: boolean; grants?: string[] };
  fail?: string;
  enableErr?: string;
  cron?: string;
  tty?: boolean;
  answers?: string[];
  kirocrew?: boolean;
}

function machine(f: Fake = {}) {
  const home = tmp('prism-kc-home-');
  const calls: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(f.answers ?? [])];
  const deps: KirocrewDeps = {
    home,
    pathEnv: f.kirocrew === false ? '' : kcBin(),
    bundleDir: bundle(),
    ownPackageDir: home,
    ownVersion: '1.9.0',
    run: (file, args): RunResult => {
      calls.push(args);
      const cmd = args.slice(0, 2).join(' ');
      if (f.fail && args.join(' ').startsWith(f.fail)) return { ok: false, stdout: '', stderr: `${LOGS}gateway is not running` };
      if (cmd === 'app info') {
        if (!f.installed) return { ok: false, stdout: '', stderr: `${LOGS}App 'prism' is not installed.` };
        return { ok: true, stdout: infoJson({ ...f.installed, source: f.installed.source ?? '/elsewhere/kirocrew-app' }), stderr: '' };
      }
      if (cmd === 'app enable' && f.enableErr) return { ok: false, stdout: '', stderr: f.enableErr };
      if (cmd === 'cron list') return { ok: true, stdout: f.cron ?? '', stderr: '' };
      return { ok: true, stdout: '', stderr: '' };
    },
    isTTY: f.tty ?? false,
    ask: async () => answers.shift() ?? '',
    log: (l = '') => out.push(l),
    error: (l) => err.push(l),
  };
  return { deps, home, calls, out, err, text: () => [...out, ...err].join('\n') };
}

const writes = (calls: string[][]) => calls.filter((a) => !['app info', 'cron list'].includes(a.slice(0, 2).join(' ')));

test('kirocrew missing: says so with the install docs, exits 1, changes nothing', async () => {
  const m = machine({ kirocrew: false });
  assert.equal(await enableKirocrew({ yes: true }, m.deps), 1);
  assert.match(m.text(), /Kiro Crew is not installed/);
  assert.match(m.text(), /github\.com\/kirodotdev\/KiroCrew/);
  assert.deepEqual(m.calls, []);
  assert.equal(existsSync(targetDir(m.home)), false);
});

test('kirocrew in ~/.local/bin is found when PATH lacks it', () => {
  const home = tmp('prism-kc-home-');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'kirocrew'), '#!/bin/sh\n');
  chmodSync(join(home, '.local', 'bin', 'kirocrew'), 0o755);
  assert.equal(findKirocrew('', home), join(home, '.local', 'bin', 'kirocrew'));
  assert.equal(findKirocrew('', tmp('prism-kc-empty-')), null);
});

test('not installed: copies the bundle without tests, data or caches, installs, then enables', async () => {
  const m = machine();
  assert.equal(await enableKirocrew({ yes: true }, m.deps), 0);
  const t = targetDir(m.home);
  assert.deepEqual(writes(m.calls), [['app', 'install', t], ['app', 'enable', 'prism']]);
  assert.ok(existsSync(join(t, 'app.json')) && existsSync(join(t, 'scripts', 'digest.py')));
  for (const ex of ['tests', 'data', '.pytest_cache', 'scripts/__pycache__']) assert.equal(existsSync(join(t, ex)), false, ex);
  assert.equal(existsSync(`${t}.prev`), false);
  assert.match(m.text(), /Plan: {6}install prism 0\.2\.2/);
  assert.match(m.text(), /Trust the app and approve \/api\/apps\/prism\/\* under Apps -> PRISM/);
  assert.match(m.text(), /PRISM entry appears in the sidebar/);
});

test('older installed: update --source the target, no enable; previous copy removed after success', async () => {
  const m = machine();
  const t = targetDir(m.home);
  mkdirSync(t, { recursive: true });
  writeFileSync(join(t, 'old'), 'x');
  m.deps.run = ((orig) => (f, a, ms) => (a[1] === 'info' ? { ok: true, stdout: infoJson({ version: '0.2.1', source: t }), stderr: '' } : orig(f, a, ms)))(m.deps.run);
  assert.equal(await enableKirocrew({ yes: true }, m.deps), 0);
  assert.deepEqual(writes(m.calls), [['app', 'update', 'prism', '--source', t]]);
  assert.match(m.text(), /update 0\.2\.1 -> 0\.2\.2/);
  assert.equal(existsSync(join(t, 'old')), false);
  assert.equal(existsSync(`${t}.prev`), false);
});

test('current: same version from the target folder runs nothing', async () => {
  const m = machine();
  const t = targetDir(m.home);
  m.deps.run = ((orig) => (f, a, ms) => (a[1] === 'info' ? { ok: true, stdout: infoJson({ version: '0.2.2', source: t }), stderr: '' } : orig(f, a, ms)))(m.deps.run);
  assert.equal(await enableKirocrew({}, m.deps), 0);
  assert.deepEqual(writes(m.calls), []);
  assert.match(m.text(), /already current \(0\.2\.2\)/);
  assert.equal(existsSync(t), false);
});

test('source move: same version from a worktree is updated from the target folder', async () => {
  const m = machine({ installed: { version: '0.2.2', source: '/work/tree/kirocrew-app' } });
  assert.equal(await enableKirocrew({ yes: true }, m.deps), 0);
  assert.deepEqual(writes(m.calls), [['app', 'update', 'prism', '--source', targetDir(m.home)]]);
  assert.match(m.text(), /installed from another folder/);
});

test('plan per state, and the argv for each', () => {
  const home = '/h';
  const t = targetDir(home);
  const info = (version: string, source: string) => toAppInfo({ version, source });
  assert.equal(makePlan(null, '0.2.2', home).action, 'install');
  assert.equal(makePlan(info('0.2.1', t), '0.2.2', home).action, 'update');
  assert.equal(makePlan(info('0.2.1', '/w'), '0.2.2', home).sourceMoves, true);
  assert.equal(makePlan(info('0.2.2', t), '0.2.2', home).action, 'current');
  assert.equal(makePlan(info('0.2.2', '/w'), '0.2.2', home).action, 'move');
  assert.equal(makePlan(info('0.3.0', t), '0.2.2', home).action, 'newer');
  assert.deepEqual(planArgs(makePlan(null, '0.2.2', home)), ['app', 'install', t]);
  assert.deepEqual(planArgs(makePlan(info('0.2.2', '/w'), '0.2.2', home)), ['app', 'update', 'prism', '--source', t]);
  assert.equal(planArgs(makePlan(info('0.2.2', t), '0.2.2', home)), null);
});

test('--dry-run: plan only, no copy, no kirocrew write', async () => {
  const m = machine({ installed: { version: '0.2.1' } });
  assert.equal(await enableKirocrew({ dryRun: true }, m.deps), 0);
  assert.deepEqual(writes(m.calls), []);
  assert.equal(existsSync(targetDir(m.home)), false);
  assert.match(m.text(), /would run: kirocrew app update prism --source ~\/\.prism\/kirocrew-app/);
});

test('no terminal and no --yes: refuses, changes nothing; a TTY "n" also changes nothing', async () => {
  const m = machine();
  assert.equal(await enableKirocrew({}, m.deps), 1);
  assert.match(m.text(), /Re-run with --yes/);
  const n = machine({ tty: true, answers: ['n'] });
  assert.equal(await enableKirocrew({}, n.deps), 1);
  for (const x of [m, n]) {
    assert.deepEqual(writes(x.calls), []);
    assert.equal(existsSync(targetDir(x.home)), false);
  }
});

test('kirocrew update fails: the previous copy is put back, exit 1', async () => {
  const m = machine({ installed: { version: '0.2.1' }, fail: 'app update' });
  const t = targetDir(m.home);
  mkdirSync(t, { recursive: true });
  writeFileSync(join(t, 'mine'), 'keep');
  assert.equal(await enableKirocrew({ yes: true }, m.deps), 1);
  assert.equal(readFileSync(join(t, 'mine'), 'utf8'), 'keep');
  assert.equal(existsSync(join(t, 'app.json')), false);
  assert.equal(existsSync(`${t}.prev`), false);
  assert.match(m.text(), /gateway is not running/);
});

test('stageApp: rename into place, keep .prev until commit, restore puts it back', () => {
  const b = bundle();
  const t = join(tmp('prism-kc-stage-'), 'app');
  mkdirSync(t);
  writeFileSync(join(t, 'old'), '1');
  const s = stageApp(b, t);
  assert.ok(existsSync(join(t, 'app.json')));
  assert.ok(existsSync(join(`${t}.prev`, 'old')));
  s.restore();
  assert.ok(existsSync(join(t, 'old')));
  assert.equal(existsSync(join(t, 'app.json')), false);
  stageApp(b, t).commit();
  assert.equal(existsSync(`${t}.prev`), false);
  assert.ok(existsSync(join(t, 'app.json')));
});

test('enable refused for trust is expected, not a failure', async () => {
  const m = machine({ enableErr: `${LOGS}app_execution_denied: trust this app first` });
  assert.equal(await enableKirocrew({ yes: true }, m.deps), 0);
  assert.match(m.text(), /refused until you trust the app\. That is expected/);
});

test('app info JSON is parsed after leading log lines', () => {
  const j = parseJsonAfterLogs(`${LOGS}{log-ish line\n${JSON.stringify({ version: '0.2.1' }, null, 2)}`);
  assert.equal(j.version, '0.2.1');
  assert.throws(() => parseJsonAfterLogs(LOGS), /no JSON/);
});

test('--status: versions, source, enabled, grants and the digest cron; read-only', async () => {
  const cron = '  ✅ 5a0dc730  Heartbeat: Bot  (Every hour)  x\n  ✅ ea72feda  prism/prism-daily-digest  (At 09:00 AM)  PRISM daily digest\n';
  const m = machine({ installed: { version: '0.2.1', source: '/work/tree/kirocrew-app', grants: ['/api/apps/prism/*'] }, cron });
  assert.equal(await enableKirocrew({ status: true }, m.deps), 0);
  const t = m.text();
  assert.match(t, /Installed: {3}prism 0\.2\.1/);
  assert.match(t, /Bundled: {5}0\.2\.2/);
  assert.match(t, /Source: {6}\/work\/tree\/kirocrew-app \(not ~\/\.prism\/kirocrew-app/);
  assert.match(t, /Enabled: {5}yes/);
  assert.match(t, /API grants: {2}approved: \/api\/apps\/prism\/\*/);
  assert.match(t, /Digest cron: present \(prism\/prism-daily-digest\)/);
  assert.match(t, /→ prism-cli enable kirocrew/);
  assert.deepEqual(writes(m.calls), []);
});

test('grants and cron parsing', () => {
  assert.match(grantsLine(toAppInfo({ manifest: { permissions: { api: ['/a/*'] } } })), /^not approved: \/a\/\*/);
  assert.match(grantsLine(toAppInfo({ approvedGrantsStored: true, approvedGrants: { api: ['/a/*'] }, manifest: { permissions: { api: ['/a/*', '/b'] } } })), /partly approved; waiting: \/b/);
  assert.match(parseCronList('', 'prism/prism-daily-digest'), /^not found/);
  assert.match(parseCronList('  ⏸ ea72feda  prism/prism-daily-digest  (At 09:00 AM)', 'prism/prism-daily-digest'), /not active/);
  assert.match(parseCronList('  ✅ x  prism/prism-daily-digest-old  y', 'prism/prism-daily-digest'), /^not found/);
});

test('--uninstall keeps data; --purge-data passes through with a warning; the folder is removed', async () => {
  for (const purge of [false, true]) {
    const m = machine({ installed: { version: '0.2.1' } });
    const t = targetDir(m.home);
    mkdirSync(t, { recursive: true });
    assert.equal(await enableKirocrew({ uninstall: true, yes: true, purgeData: purge }, m.deps), 0);
    assert.deepEqual(writes(m.calls), [['app', 'uninstall', 'prism', ...(purge ? ['--purge-data'] : [])]]);
    assert.equal(existsSync(t), false);
    if (purge) assert.match(m.text(), /permanently deletes the app's data[\s\S]*cannot be undone/);
    else assert.match(m.text(), /keeps the app's data/);
  }
});

test('--uninstall without --yes on no terminal changes nothing; --purge-data alone is refused', async () => {
  const m = machine({ installed: { version: '0.2.1' } });
  assert.equal(await enableKirocrew({ uninstall: true }, m.deps), 1);
  assert.deepEqual(writes(m.calls), []);
  assert.equal(await enableKirocrew({ purgeData: true }, machine().deps), 1);
});

test('version line only for an older installed app', () => {
  assert.equal(kirocrewVersionLine({ installed: '0.2.1', bundled: '0.2.2' }), 'Kiro Crew app prism 0.2.1 installed, 0.2.2 bundled: run prism-cli enable kirocrew');
  for (const s of [null, { installed: null, bundled: '0.2.2' }, { installed: '0.2.2', bundled: '0.2.2' }, { installed: '0.2.1', bundled: null }]) {
    assert.equal(kirocrewVersionLine(s), null);
  }
  const r = buildReport({ offline: true }, { ownPackageDir: tmp('x-'), pathEnv: '', npmLatest: () => ({ version: null }), kirocrewApp: () => ({ installed: '0.2.1', bundled: '0.2.2' }) });
  const lines: string[] = [];
  printReport(r, (l) => lines.push(l));
  assert.ok(lines.includes('Kiro Crew app prism 0.2.1 installed, 0.2.2 bundled: run prism-cli enable kirocrew'));
  const broken = buildReport({ offline: true }, { ownPackageDir: tmp('x-'), pathEnv: '', npmLatest: () => ({ version: null }), kirocrewApp: () => { throw new Error('boom'); } });
  assert.equal(broken.kirocrewApp, null);
});

test('installed version is read from Kiro Crew\'s record without running kirocrew', () => {
  const home = tmp('prism-kc-home-');
  assert.equal(installedAppVersion(home, {}), null);
  mkdirSync(join(home, '.kiro', 'crew', 'apps', 'prism'), { recursive: true });
  writeFileSync(join(home, '.kiro', 'crew', 'apps', 'prism', 'installed.json'), JSON.stringify({ version: '0.2.1' }));
  assert.equal(installedAppVersion(home, {}), '0.2.1');
  assert.equal(installedAppVersion('/nowhere', { KIROCREW_HOME: join(home, '.kiro', 'crew') }), '0.2.1');
  assert.deepEqual(kirocrewAppState({ pathEnv: kcBin(), home, env: {}, bundleDir: bundle() }), { installed: '0.2.1', bundled: '0.2.2' });
  assert.equal(kirocrewAppState({ pathEnv: '', home, env: {}, bundleDir: bundle() }), null);
  assert.equal(appOutdated({ installed: '0.2.1', bundled: '0.2.2' }), true);
});

test('Setup tab: Kiro Crew app row is info in every state, copy-only fix when there is something to do, absent without kirocrew', () => {
  const none = kirocrewAppCheck({ installed: null, bundled: '0.2.2' });
  const old = kirocrewAppCheck({ installed: '0.2.1', bundled: '0.2.2' });
  const cur = kirocrewAppCheck({ installed: '0.2.2', bundled: '0.2.2' });
  for (const i of [none, old, cur]) assert.equal(i.status, 'info');
  assert.equal(none.fix, 'prism-cli enable kirocrew');
  assert.equal(old.fix, 'prism-cli enable kirocrew');
  assert.match(old.detail, /outdated: 0\.2\.1 installed, 0\.2\.2 bundled/);
  assert.equal(cur.fix, '');
  assert.match(cur.detail, /current/);
  const home = tmp('prism-kc-home-');
  assert.equal(machineChecks({ pathEnv: '', home, kirocrewApp: () => null }).some((i) => i.id === 'kirocrew-app'), false);
  assert.ok(machineChecks({ pathEnv: '', home, kirocrewApp: () => ({ installed: null, bundled: '0.2.2' }) }).some((i) => i.id === 'kirocrew-app'));
});

test('bundle: the build copies kirocrew-app without tests, data or caches', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..');
  const build: string = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8')).scripts.build;
  assert.match(build, /cp -r \.\.\/kirocrew-app dist\/assets\/kirocrew-app/);
  assert.match(build, /rm -rf dist\/assets\/kirocrew-app\/tests dist\/assets\/kirocrew-app\/data/);
  assert.match(build, /__pycache__ -o -name \.pytest_cache/);
  const built = join(cli, 'dist', 'assets', 'kirocrew-app');
  if (existsSync(built)) {
    assert.ok(existsSync(join(built, 'app.json')));
    for (const ex of ['tests', 'data', 'scripts/__pycache__']) assert.equal(existsSync(join(built, ex)), false, ex);
    const bundled = JSON.parse(readFileSync(join(built, 'app.json'), 'utf8')).version;
    assert.equal(bundled, JSON.parse(readFileSync(join(cli, '..', 'kirocrew-app', 'app.json'), 'utf8')).version);
  }
});
