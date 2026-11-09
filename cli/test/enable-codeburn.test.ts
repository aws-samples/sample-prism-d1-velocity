import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunResult } from '../src/utils/exec.js';
import { codeburnVersionOk, enableCodeburn, INSTALL_CMD, runEnableCodeburn, type CodeburnDeps } from '../src/commands/enable/codeburn.js';
import alias, { DEPRECATION } from '../src/commands/bootstrapper/setup-otel-sync.js';
import { machineChecks } from '../src/dashboard/setup.js';
import { crontabLines } from '../src/utils/otel-sync-schedule.js';

const URL = 'https://otel.example.com';
const CB = '/fake/bin/codeburn';

/** A fake machine: codeburn presence, its sync config, the schedule, and a log of every command. */
function fakeMachine(o: { installed?: boolean; installWorks?: boolean; syncUrl?: string; schedule?: boolean; tty?: boolean; answers?: string[]; version?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-cb-home-'));
  if (o.syncUrl) {
    mkdirSync(join(home, '.config', 'codeburn'), { recursive: true });
    writeFileSync(join(home, '.config', 'codeburn', 'sync.json'), JSON.stringify({ baseUrl: o.syncUrl }));
  }
  const state = { installed: o.installed ?? true, schedule: o.schedule ?? false };
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const answers = [...(o.answers ?? [])];
  const scheduleCalls: string[] = [];
  const deps: CodeburnDeps = {
    run: (file, args): RunResult => {
      calls.push(`run ${file} ${args.join(' ')}`);
      if (args[0] === '--version') return { ok: true, stdout: o.version ?? 'codeburn 0.9.24', stderr: '' };
      if (args.join(' ') === 'sync status') return { ok: true, stdout: `endpoint: ${URL}\nauth: ok`, stderr: '' };
      return { ok: true, stdout: 'pushed 3 records', stderr: '' };
    },
    runInteractive: (file, args) => {
      calls.push(`interactive ${file} ${args.join(' ')}`);
      if (file === 'npm') {
        if (o.installWorks === false) return false;
        state.installed = true;
      }
      return true;
    },
    findCodeburn: () => (state.installed ? CB : null),
    home,
    isTTY: o.tty ?? true,
    ask: async (q) => { asked.push(q); return answers.shift() ?? ''; },
    log: (l = '') => out.push(l),
    error: (l) => err.push(l),
    scheduleExists: () => state.schedule,
    schedulerName: () => 'crontab',
    installSchedule: (path, hours) => { scheduleCalls.push(`install ${path} ${hours}`); state.schedule = true; return true; },
    removeSchedule: () => { scheduleCalls.push('remove'); state.schedule = false; },
  };
  return { deps, calls, out, err, asked, scheduleCalls, home, text: () => out.join('\n') };
}

test('codeburn version gate compares numerically', () => {
  assert.equal(codeburnVersionOk('0.9.16'), true);
  assert.equal(codeburnVersionOk('0.9.24'), true);
  assert.equal(codeburnVersionOk('0.10.0'), true);
  assert.equal(codeburnVersionOk('1.0.0'), true);
  assert.equal(codeburnVersionOk('1.9.5'), true, 'the old check rejected any x.9.<16');
  assert.equal(codeburnVersionOk('0.9.15'), false);
  assert.equal(codeburnVersionOk('0.8.99'), false);
});

test('enable codeburn: fresh setup runs sync setup, backfill, schedule and status', async () => {
  const m = fakeMachine();
  assert.equal(await enableCodeburn({ url: URL }, m.deps), 0);
  assert.deepEqual(m.calls, [
    `run ${CB} --version`,
    `interactive ${CB} sync setup ${URL}`,
    `run ${CB} sync push --since 30d --attribution`,
    `run ${CB} sync status`,
  ]);
  assert.deepEqual(m.scheduleCalls, [`install ${CB} 12`]);
  assert.match(m.text(), /codeburn sync push --since 7d --attribution/);
  assert.match(m.text(), /auth: ok/);
  assert.deepEqual(m.asked, []);
});

test('enable codeburn: second run reports what is already done and does not set up or backfill again', async () => {
  const m = fakeMachine({ syncUrl: URL, schedule: true });
  assert.equal(await enableCodeburn({}, m.deps), 0, 'the URL comes from the existing sync config');
  assert.ok(!m.calls.some((c) => c.includes('sync setup')), 'no sync setup');
  assert.ok(!m.calls.some((c) => c.includes('--since 30d')), 'no backfill');
  assert.deepEqual(m.scheduleCalls, ['remove', `install ${CB} 12`], 'schedule refreshed in place');
  assert.match(m.text(), /already configured for https:\/\/otel\.example\.com/);
  assert.match(m.text(), /already installed/);
  assert.match(m.text(), /already set up; nothing new to do/);
  assert.deepEqual(m.asked, []);
});

test('enable codeburn: missing codeburn is installed after a yes, with the exact npm command shown', async () => {
  const m = fakeMachine({ installed: false, answers: ['y'] });
  assert.equal(await enableCodeburn({ url: URL }, m.deps), 0);
  assert.equal(INSTALL_CMD, 'npm install -g codeburn');
  assert.match(m.asked[0], /npm install -g codeburn/);
  assert.equal(m.calls[0], 'interactive npm install -g codeburn');
  assert.match(m.text(), /Running: npm install -g codeburn/);
});

test('enable codeburn: --yes installs without asking; a no or no terminal refuses with the command', async () => {
  const y = fakeMachine({ installed: false });
  assert.equal(await enableCodeburn({ url: URL, yes: true }, y.deps), 0);
  assert.deepEqual(y.asked, []);
  assert.equal(y.calls[0], 'interactive npm install -g codeburn');

  const no = fakeMachine({ installed: false, answers: ['n'] });
  assert.equal(await enableCodeburn({ url: URL }, no.deps), 1);
  assert.ok(!no.calls.some((c) => c.startsWith('interactive npm')));
  assert.match(no.err.join('\n'), /npm install -g codeburn/);

  const ci = fakeMachine({ installed: false, tty: false });
  assert.equal(await enableCodeburn({ url: URL }, ci.deps), 1);
  assert.deepEqual(ci.calls, []);
  assert.match(ci.err.join('\n'), /--yes/);
});

test('enable codeburn: a failed npm install stops with a hint', async () => {
  const m = fakeMachine({ installed: false, installWorks: false });
  assert.equal(await enableCodeburn({ url: URL, yes: true }, m.deps), 1);
  assert.match(m.err.join('\n'), /failed\. Run it yourself/);
  assert.deepEqual(m.scheduleCalls, []);
});

test('enable codeburn: --dry-run prints the plan and changes nothing', async () => {
  const m = fakeMachine({ installed: false });
  assert.equal(await enableCodeburn({ url: URL, dryRun: true }, m.deps), 0);
  assert.deepEqual(m.calls, [], 'no command runs');
  assert.deepEqual(m.scheduleCalls, []);
  assert.deepEqual(m.asked, []);
  const t = m.text();
  assert.match(t, /would run: npm install -g codeburn/);
  assert.match(t, new RegExp(`would run: codeburn sync setup ${URL}`));
  assert.match(t, /would run: codeburn sync push --since 30d --attribution/);
  assert.match(t, /would install a crontab schedule: codeburn sync push --since 7d --attribution, every 12h/);
  assert.match(t, /would run: codeburn sync status/);
});

test('enable codeburn: bad input fails before any change', async () => {
  const badUrl = fakeMachine();
  assert.equal(await enableCodeburn({ url: 'not a url' }, badUrl.deps), 1);
  assert.ok(!badUrl.calls.some((c) => c.includes('sync')));

  const badInterval = fakeMachine();
  assert.equal(await enableCodeburn({ url: URL, interval: '0' }, badInterval.deps), 1);
  assert.deepEqual(badInterval.calls, []);

  const old = fakeMachine({ version: 'codeburn 0.9.10' });
  assert.equal(await enableCodeburn({ url: URL }, old.deps), 1);
  assert.match(old.err.join('\n'), /0\.9\.16 required/);
});

test('enable codeburn: a different configured endpoint is kept unless confirmed', async () => {
  const keep = fakeMachine({ syncUrl: 'https://old.example.com', schedule: true, answers: ['n'] });
  assert.equal(await enableCodeburn({ url: URL }, keep.deps), 0);
  assert.ok(!keep.calls.some((c) => c.includes('sync setup')));

  const change = fakeMachine({ syncUrl: 'https://old.example.com', schedule: true });
  assert.equal(await enableCodeburn({ url: URL, yes: true }, change.deps), 0);
  assert.ok(change.calls.includes(`interactive ${CB} sync setup ${URL}`));
});

test('enable codeburn --status reports codeburn, sync, schedule and codeburn sync status', async () => {
  const m = fakeMachine({ syncUrl: URL, schedule: true });
  assert.equal(await enableCodeburn({ status: true }, m.deps), 0);
  const t = m.text();
  assert.match(t, /codeburn found/);
  assert.match(t, /sync configured: https:\/\/otel\.example\.com/);
  assert.match(t, /crontab schedule active/);
  assert.match(t, /codeburn sync status:/);
});

test('enable codeburn --status and --dry-run: an unreadable crontab is reported with its error, not as a missing schedule', async () => {
  const PAM = 'You (alice) are not allowed to access to (crontab) because of pam configuration.';
  const unreadable = () => crontabLines({ ok: false, stdout: '', stderr: PAM }).length > 0;
  for (const opts of [{ status: true }, { url: URL, dryRun: true }]) {
    const m = fakeMachine({ syncUrl: URL });
    m.deps.scheduleExists = unreadable;
    assert.equal(await enableCodeburn(opts, m.deps), 0);
    const t = m.text();
    assert.match(t, /cannot read your crontab \(crontab -l: You \(alice\) are not allowed/, JSON.stringify(opts));
    assert.doesNotMatch(t, /no crontab schedule found|would install a crontab schedule/, JSON.stringify(opts));
    assert.deepEqual(m.scheduleCalls, []);
  }
});

test('enable codeburn: an unexpected error is one line and exit 1, not a stack', async () => {
  const m = fakeMachine();
  m.deps.installSchedule = () => { throw new Error('Failed to install crontab: boom'); };
  const errors: string[] = [];
  let code = 0;
  await runEnableCodeburn({ url: URL }, { deps: () => m.deps, error: (l) => errors.push(l), exit: (c) => { code = c; }, env: {} });
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /boom/);
});

test('bootstrapper setup-otel-sync is a deprecated alias that delegates', async () => {
  const m = fakeMachine();
  // The notice goes to stdout, so it stays ahead of the plan when output is piped.
  const warned: string[] = [];
  const saved = console.log;
  console.log = (l: string) => { warned.push(l); };
  try {
    await alias.action({ url: URL }, { deps: () => m.deps, exit: () => assert.fail('no exit expected') });
  } finally {
    console.log = saved;
  }
  assert.match(DEPRECATION[0], /use "prism-cli enable codeburn"/);
  assert.equal(warned[0], DEPRECATION[0]);
  assert.ok(m.calls.includes(`interactive ${CB} sync setup ${URL}`));
  assert.match(alias.description, /^\[deprecated\]/);
});

test('dashboard setup checklist points codeburn fixes at enable codeburn', () => {
  const items = machineChecks({ pathEnv: mkdtempSync(join(tmpdir(), 'prism-none-')), home: mkdtempSync(join(tmpdir(), 'prism-h-')), env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', global: { state: 'not-installed', hooksPath: null, dir: '' } });
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(by.codeburn.fix, 'prism-cli enable codeburn');
  assert.equal(by['codeburn-sync'].fix, 'prism-cli enable codeburn');
});

test('crontabLines: only "no crontab for" is empty; an unreadable crontab throws instead of being overwritten', () => {
  assert.deepEqual(crontabLines({ ok: true, stdout: '0 1 * * * backup\n# x', stderr: '' }), ['0 1 * * * backup', '# x']);
  assert.deepEqual(crontabLines({ ok: false, stdout: '', stderr: 'no crontab for alice' }), []);
  assert.throws(
    () => crontabLines({ ok: false, stdout: '', stderr: 'You (alice) are not allowed to access to (crontab) because of pam configuration.' }),
    /cannot read your crontab \(crontab -l: You \(alice\) are not allowed.*\); it was not changed/,
  );
  assert.throws(() => crontabLines({ ok: false, stdout: '', stderr: '' }), /crontab -l: unknown error/);
});
