import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunResult } from '../src/utils/exec.js';
import { codeburnVersionOk, enableCodeburn, INSTALL_CMD, runEnableCodeburn, systemdInstallSchedule, systemdRemoveSchedule, systemdUnits, type CodeburnDeps } from '../src/commands/enable/codeburn.js';
import alias, { DEPRECATION } from '../src/commands/bootstrapper/setup-otel-sync.js';
import { machineChecks } from '../src/dashboard/setup.js';
import { crontabLines, systemdTimerExists } from '../src/utils/otel-sync-schedule.js';
import { readSavedMode, writeSyncMode } from '../src/utils/sync-mode.js';

const URL = 'https://otel.example.com';
/** A home whose codeburn sync endpoint is configured, so the checklist shows the self-fix states. */
function syncedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'prism-h-'));
  mkdirSync(join(home, '.config', 'codeburn'), { recursive: true });
  writeFileSync(join(home, '.config', 'codeburn', 'sync.json'), JSON.stringify({ baseUrl: URL }));
  return home;
}
const CB = '/fake/bin/codeburn';

/** A fake machine: codeburn presence, its sync config, the schedule, and a log of every command. */
function fakeMachine(o: { installed?: boolean; installWorks?: boolean; syncUrl?: string; schedule?: boolean; tty?: boolean; answers?: string[]; version?: string; linux?: boolean; systemdAvailable?: boolean; timer?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-cb-home-'));
  if (o.syncUrl) {
    mkdirSync(join(home, '.config', 'codeburn'), { recursive: true });
    writeFileSync(join(home, '.config', 'codeburn', 'sync.json'), JSON.stringify({ baseUrl: o.syncUrl }));
  }
  const state = { installed: o.installed ?? true, schedule: o.schedule ?? false, timer: o.timer ?? false };
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
      if (file === 'systemctl') return { ok: state.timer, stdout: state.timer ? 'active' : '', stderr: state.timer ? '' : 'inactive' };
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
    linux: o.linux ?? true,
    systemd: {
      available: () => o.systemdAvailable ?? false,
      exists: () => state.timer,
      install: (path, hours) => { scheduleCalls.push(`systemd install ${path} ${hours}`); state.timer = true; },
      remove: () => { scheduleCalls.push('systemd remove'); state.timer = false; },
    },
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

test('enable codeburn: an unreadable crontab stops the install with its error before the backfill uploads anything', async () => {
  const PAM = 'You (alice) are not allowed to access to (crontab) because of pam configuration.';
  const m = fakeMachine({ syncUrl: URL });
  m.deps.scheduleExists = () => crontabLines({ ok: false, stdout: '', stderr: PAM }).some((l) => l.includes('prism'));
  assert.equal(await enableCodeburn({}, m.deps), 1);
  assert.match(m.err.join('\n'), /^Error: cannot read your crontab \(crontab -l: You \(alice\) are not allowed/);
  assert.ok(!m.calls.some((c) => c.includes('sync push')), `no backfill: ${m.calls.join('; ')}`);
  assert.deepEqual(m.scheduleCalls, []);
});

test('enable codeburn: no crontab yet still installs normally, backfill and schedule', async () => {
  const m = fakeMachine({ syncUrl: URL });
  m.deps.scheduleExists = () => crontabLines({ ok: false, stdout: '', stderr: 'no crontab for alice' }).some((l) => l.includes('prism'));
  assert.equal(await enableCodeburn({}, m.deps), 0);
  assert.ok(m.calls.includes(`run ${CB} sync push --since 30d --attribution`), m.calls.join('; '));
  assert.deepEqual(m.scheduleCalls, [`install ${CB} 12`]);
  assert.deepEqual(m.err, []);
});

test('dashboard setup checklist: an unreadable crontab is its own state with the read error, not "no entry"', () => {
  const PAM = 'You (alice) are not allowed to access to (crontab) because of pam configuration.';
  const items = machineChecks({ pathEnv: mkdtempSync(join(tmpdir(), 'prism-none-')), home: syncedHome(), env: {},
    scheduleExists: () => crontabLines({ ok: false, stdout: '', stderr: PAM }).length > 0, schedulerName: () => 'crontab', global: { state: 'not-installed', hooksPath: null, dir: '' } });
  const sync = items.find((i) => i.id === 'codeburn-sync')!;
  assert.equal(sync.status, 'warn');
  assert.match(sync.detail, /^cannot read your crontab \(crontab -l: You \(alice\) are not allowed/);
  assert.doesNotMatch(sync.detail, /no crontab entry/);
  assert.ok(sync.fix);
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
  const items = machineChecks({ pathEnv: mkdtempSync(join(tmpdir(), 'prism-none-')), home: syncedHome(), env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', global: { state: 'not-installed', hooksPath: null, dir: '' } });
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

// ---------------------------------------------------------------- systemd user timer (unreadable crontab)

const PAM_ERR = 'You (alice) are not allowed to access to (crontab) because of pam configuration.';
/** A crontab that cannot be read; any call to it is recorded so a test can prove it was not touched. */
function pamCrontab(m: ReturnType<typeof fakeMachine>) {
  m.deps.scheduleExists = () => { m.scheduleCalls.push('crontab read'); return crontabLines({ ok: false, stdout: '', stderr: PAM_ERR }).length > 0; };
}

test('enable codeburn: unreadable crontab + systemctl --user offers a systemd timer, asks, and never touches the crontab', async () => {
  const m = fakeMachine({ syncUrl: URL, systemdAvailable: true, answers: ['y'] });
  pamCrontab(m);
  assert.equal(await enableCodeburn({}, m.deps), 0);
  assert.match(m.asked[0], /Install a systemd user timer \(prism-otel-sync\.timer\) instead\? \[y\/N\]/);
  assert.deepEqual(m.scheduleCalls, ['crontab read', `systemd install ${CB} 12`], 'the crontab is only probed, never written or removed');
  assert.ok(m.calls.includes(`run ${CB} sync push --since 30d --attribution`), 'backfill after the yes');
  assert.match(m.text(), /systemd user timer schedule installed \(every 12h\)/);
  assert.match(m.text(), /Your crontab is not touched/);
});

test('enable codeburn: declining the systemd timer exits 1 before the backfill; no terminal points at --schedule systemd', async () => {
  const no = fakeMachine({ syncUrl: URL, systemdAvailable: true, answers: ['n'] });
  pamCrontab(no);
  assert.equal(await enableCodeburn({}, no.deps), 1);
  assert.ok(!no.calls.some((c) => c.includes('sync push')));
  assert.deepEqual(no.scheduleCalls, ['crontab read']);
  assert.match(no.err.join('\n'), /--schedule systemd/);

  const ci = fakeMachine({ syncUrl: URL, systemdAvailable: true, tty: false });
  pamCrontab(ci);
  assert.equal(await enableCodeburn({}, ci.deps), 1);
  assert.deepEqual(ci.asked, []);
  assert.match(ci.err.join('\n'), /Re-run with: prism-cli enable codeburn --schedule systemd/);

  const yes = fakeMachine({ syncUrl: URL, systemdAvailable: true, tty: false });
  pamCrontab(yes);
  assert.equal(await enableCodeburn({ yes: true }, yes.deps), 0, '--yes accepts the offer');
  assert.deepEqual(yes.scheduleCalls, ['crontab read', `systemd install ${CB} 12`]);
});

test('enable codeburn --schedule: systemd skips the question and the crontab; cron keeps the crontab path; bad values fail', async () => {
  const sd = fakeMachine({ syncUrl: URL, systemdAvailable: true });
  pamCrontab(sd);
  assert.equal(await enableCodeburn({ schedule: 'systemd', interval: '6' }, sd.deps), 0);
  assert.deepEqual(sd.asked, []);
  assert.deepEqual(sd.scheduleCalls, [`systemd install ${CB} 6`], 'crontab not even read');

  const cron = fakeMachine({ syncUrl: URL, systemdAvailable: true });
  pamCrontab(cron);
  assert.equal(await enableCodeburn({ schedule: 'cron' }, cron.deps), 1, 'explicit cron with an unreadable crontab is the 1.4.3 error');
  assert.match(cron.err.join('\n'), /cannot read your crontab/);

  const noSd = fakeMachine({ systemdAvailable: false });
  assert.equal(await enableCodeburn({ schedule: 'systemd', url: URL }, noSd.deps), 1);
  assert.match(noSd.err.join('\n'), /systemctl --user" is not available/);
  const bad = fakeMachine();
  assert.equal(await enableCodeburn({ schedule: 'at', url: URL }, bad.deps), 1);
  assert.match(bad.err.join('\n'), /must be systemd or cron/);
  const mac = fakeMachine({ linux: false });
  assert.equal(await enableCodeburn({ schedule: 'cron', url: URL }, mac.deps), 1);
  assert.match(mac.err.join('\n'), /Linux only/);
  assert.deepEqual([noSd.calls, bad.calls, mac.calls], [[], [], []], 'rejected before any command');
});

test('enable codeburn: --dry-run with an unreadable crontab plans the systemd timer and changes nothing', async () => {
  const m = fakeMachine({ syncUrl: URL, systemdAvailable: true });
  pamCrontab(m);
  assert.equal(await enableCodeburn({ dryRun: true }, m.deps), 0);
  assert.deepEqual(m.calls, [`run ${CB} --version`], 'only the read-only version check');
  assert.deepEqual(m.asked, []);
  assert.deepEqual(m.scheduleCalls, ['crontab read']);
  assert.match(m.text(), /would ask to install a systemd user timer instead/);
  assert.match(m.text(), /would install a systemd user timer schedule/);
});

test('enable codeburn --status and --remove handle the systemd timer next to an unreadable crontab', async () => {
  const st = fakeMachine({ syncUrl: URL, systemdAvailable: true, timer: true });
  pamCrontab(st);
  assert.equal(await enableCodeburn({ status: true }, st.deps), 0);
  assert.match(st.text(), /✓ systemd user timer schedule active \(prism-otel-sync\.timer\)/);
  assert.match(st.text(), /crontab not used: cannot read your crontab/);

  const hint = fakeMachine({ syncUrl: URL, systemdAvailable: true });
  pamCrontab(hint);
  await enableCodeburn({ status: true }, hint.deps);
  assert.match(hint.text(), /schedule it with a systemd user timer instead: prism-cli enable codeburn --schedule systemd/);

  const rm = fakeMachine({ systemdAvailable: true, timer: true });
  pamCrontab(rm);
  assert.equal(await enableCodeburn({ remove: true }, rm.deps), 0);
  assert.deepEqual(rm.scheduleCalls, ['systemd remove', 'crontab read'], 'timer removed; crontab only probed');
  assert.match(rm.text(), /systemd user timer schedule removed/);
  assert.match(rm.text(), /⚠ cannot read your crontab/);

  const only = fakeMachine({ systemdAvailable: true, timer: true, schedule: true });
  assert.equal(await enableCodeburn({ remove: true, schedule: 'systemd' }, only.deps), 0);
  assert.deepEqual(only.scheduleCalls, ['systemd remove'], '--schedule systemd leaves the crontab entry alone');

  const both = fakeMachine({ systemdAvailable: true, timer: true, schedule: true });
  assert.equal(await enableCodeburn({ remove: true }, both.deps), 0);
  assert.deepEqual(both.scheduleCalls, ['systemd remove', 'remove']);

  const nothing = fakeMachine({ systemdAvailable: true });
  pamCrontab(nothing);
  assert.equal(await enableCodeburn({ remove: true }, nothing.deps), 1, 'nothing removable and the crontab unreadable');
  assert.match(nothing.err.join('\n'), /cannot read your crontab/);
});

test('systemd units: quoted ExecStart, log append, same hours as the cron entry; install and remove use only systemctl --user', () => {
  const u = systemdUnits('/opt/my tools/codeburn%x', 12, '/home/a/.prism/logs/otel-sync.log');
  assert.match(u.service, /^ExecStart="\/opt\/my tools\/codeburn%%x" "sync" "push" "--since" "7d" "--attribution"$/m);
  assert.match(u.service, /^StandardOutput=append:\/home\/a\/\.prism\/logs\/otel-sync\.log$/m);
  assert.match(u.service, /^Type=oneshot$/m);
  assert.match(u.timer, /^OnCalendar=\*-\*-\* 00\/12:00:00$/m);
  assert.match(u.timer, /^Persistent=true$/m);
  assert.match(u.timer, /^WantedBy=timers\.target$/m);

  const home = mkdtempSync(join(tmpdir(), 'prism-sd-'));
  const ran: string[] = [];
  const fakeRun = (file: string, args: string[]): RunResult => { ran.push(`${file} ${args.join(' ')}`); return { ok: true, stdout: '', stderr: '' }; };
  systemdInstallSchedule(CB, 8, home, fakeRun);
  assert.ok(systemdTimerExists(home));
  assert.match(readFileSync(join(home, '.config', 'systemd', 'user', 'prism-otel-sync.service'), 'utf8'), /ExecStart="\/fake\/bin\/codeburn" "sync" "push"/);
  assert.deepEqual(ran, ['systemctl --user daemon-reload', 'systemctl --user enable --now prism-otel-sync.timer']);
  systemdRemoveSchedule(home, fakeRun);
  assert.equal(systemdTimerExists(home), false);
  assert.ok(!existsSync(join(home, '.config', 'systemd', 'user', 'prism-otel-sync.service')));
  assert.deepEqual(ran.slice(2), ['systemctl --user disable --now prism-otel-sync.timer', 'systemctl --user daemon-reload']);
  assert.ok(ran.every((c) => !c.startsWith('crontab')));

  const failing = (file: string, args: string[]): RunResult => ({ ok: args[1] !== 'enable', stdout: '', stderr: 'Failed to connect to bus' });
  assert.throws(() => systemdInstallSchedule(CB, 8, mkdtempSync(join(tmpdir(), 'prism-sd2-')), failing), /systemctl --user enable --now prism-otel-sync\.timer\): Failed to connect to bus/);
});

test('dashboard setup checklist: an unreadable crontab with systemctl --user points at --schedule systemd', () => {
  const items = machineChecks({ pathEnv: mkdtempSync(join(tmpdir(), 'prism-none-')), home: syncedHome(), env: {},
    scheduleExists: () => crontabLines({ ok: false, stdout: '', stderr: PAM_ERR }).length > 0, schedulerName: () => 'crontab', systemdAvailable: () => true,
    global: { state: 'not-installed', hooksPath: null, dir: '' } });
  const sync = items.find((i) => i.id === 'codeburn-sync')!;
  assert.equal(sync.status, 'warn');
  assert.match(sync.fix, /^prism-cli enable codeburn --schedule systemd \(a systemd user timer; your crontab is not touched\)$/);
  const withTimer = machineChecks({ pathEnv: mkdtempSync(join(tmpdir(), 'prism-none-')), home: syncedHome(), env: {},
    scheduleExists: () => true, schedulerName: () => 'systemd user timer', global: { state: 'not-installed', hooksPath: null, dir: '' } });
  assert.match(withTimer.find((i) => i.id === 'codeburn-sync')!.detail, /^systemd user timer entry installed/);
});

// ---------------------------------------------------------------- sync modes (~/.prism/codeburn.json)

const syncSetup = (m: ReturnType<typeof fakeMachine>) => m.calls.some((c) => c.includes(' sync setup '));

test('sync mode prompt on a TTY: 1 is local only, saved, with no endpoint and no schedule', async () => {
  const m = fakeMachine({ answers: ['1'] });
  assert.equal(await enableCodeburn({}, m.deps), 0);
  assert.match(m.text(), /Where should your usage go\?\n {4}1\) just me, keep it on this machine\n {4}2\) my team's PRISM \(I have the collector URL from my platform team\)\n {4}3\) I'm the platform team setting up PRISM/);
  assert.equal(readSavedMode(m.home), 'local');
  assert.match(m.text(), /Local only: codeburn usage stays on this machine\. No sync endpoint is set up and no schedule is installed\./);
  assert.match(m.text(), /ask your platform team for the collector URL/);
  assert.equal(syncSetup(m), false);
  assert.deepEqual(m.scheduleCalls, []);
});

test('sync mode prompt: an empty answer is local; 2 asks for the URL and syncs as team; a bad answer exits 1', async () => {
  const empty = fakeMachine({ answers: [''] });
  assert.equal(await enableCodeburn({}, empty.deps), 0);
  assert.equal(readSavedMode(empty.home), 'local');

  const team = fakeMachine({ answers: ['2', URL] });
  assert.equal(await enableCodeburn({}, team.deps), 0);
  assert.match(team.asked[1], /Collector URL \(from your platform team/);
  assert.ok(syncSetup(team));
  assert.equal(readSavedMode(team.home), 'team');

  const bad = fakeMachine({ answers: ['7'] });
  assert.equal(await enableCodeburn({}, bad.deps), 1);
  assert.match(bad.err.join('\n'), /"7" is not 1, 2 or 3/);
  assert.equal(readSavedMode(bad.home), null);
});

test('sync mode 3 / --admin prints the platform-team steps and helpers, makes no AWS call and installs nothing', async () => {
  for (const [opts, answers] of [[{}, ['3']], [{ admin: true }, []]] as const) {
    const m = fakeMachine({ answers: [...answers] });
    assert.equal(await enableCodeburn(opts, m.deps), 0);
    const t = m.text();
    assert.match(t, /1\. Deploy the PRISM stack[\s\S]*2\. Note the stack outputs OtelCollectorUrl and OtelUserPoolId[\s\S]*3\. Add each developer[\s\S]*4\. Share the collector URL/);
    assert.match(t, /prism-cli team info/);
    assert.match(t, /prism-cli team add-developer <email>/);
    assert.match(t, /Platform team guide: https:\/\/github\.com\/aws-samples\/sample-prism-d1-velocity\/blob\/main\/USER_GUIDE\.md#administrator-setup/);
    assert.ok(!m.calls.some((c) => /\baws\b/.test(c)), 'no AWS call');
    assert.equal(syncSetup(m), false);
    assert.deepEqual(m.scheduleCalls, []);
    assert.equal(readSavedMode(m.home), 'admin');
  }
});

test('no TTY and no flag: local, without a question', async () => {
  const m = fakeMachine({ tty: false });
  assert.equal(await enableCodeburn({}, m.deps), 0);
  assert.deepEqual(m.asked, []);
  assert.equal(readSavedMode(m.home), 'local');
  assert.match(m.text(), /No terminal and no --local, --url or --admin: local only\./);
});

test('flags pick the mode without a question; two mode flags are refused', async () => {
  const local = fakeMachine();
  assert.equal(await enableCodeburn({ local: true }, local.deps), 0);
  assert.deepEqual(local.asked, []);
  const team = fakeMachine();
  assert.equal(await enableCodeburn({ url: URL }, team.deps), 0);
  assert.deepEqual(team.asked, []);
  assert.equal(readSavedMode(team.home), 'team');
  const both = fakeMachine();
  assert.equal(await enableCodeburn({ local: true, url: URL }, both.deps), 1);
  assert.match(both.err.join('\n'), /--local and --url choose different sync modes/);
  const dry = fakeMachine();
  assert.equal(await enableCodeburn({ local: true, dryRun: true }, dry.deps), 0);
  assert.equal(readSavedMode(dry.home), null, 'a dry run saves nothing');
});

test('migration: no mode saved but an endpoint configured is team; no question, no "local only"', async () => {
  const m = fakeMachine({ syncUrl: URL, schedule: true });
  assert.equal(await enableCodeburn({}, m.deps), 0);
  assert.deepEqual(m.asked, []);
  assert.match(m.text(), /Sync mode: team \(no mode saved; a codeburn sync endpoint is configured, so team/);
  assert.doesNotMatch(m.text(), /local only/i);
  assert.equal(readSavedMode(m.home), 'team');
  const s = fakeMachine({ syncUrl: URL });
  assert.equal(await enableCodeburn({ status: true }, s.deps), 0);
  assert.match(s.text(), /Sync mode: team \(no mode saved; a codeburn sync endpoint is configured, so team\)/);
  assert.equal(readSavedMode(s.home), null, '--status changes nothing');
});

test('--status shows a saved mode; a fresh machine is local by default', async () => {
  const fresh = fakeMachine();
  assert.equal(await enableCodeburn({ status: true }, fresh.deps), 0);
  assert.match(fresh.text(), /Sync mode: local \(no mode saved and no sync endpoint, so local\)/);
  assert.match(fresh.text(), /no sync endpoint \(usage stays on this machine\)/);
  writeSyncMode(fresh.home, 'admin');
  const again = fakeMachine();
  again.deps.home = fresh.home;
  assert.equal(await enableCodeburn({ status: true }, again.deps), 0);
  assert.match(again.text(), /Sync mode: admin \(saved in ~\/\.prism\/codeburn\.json\)/);
});

test('moving to local leaves the endpoint and schedule in place and says so; --local --remove removes the schedule', async () => {
  const keep = fakeMachine({ syncUrl: URL, schedule: true });
  assert.equal(await enableCodeburn({ local: true }, keep.deps), 0);
  assert.deepEqual(keep.scheduleCalls, []);
  assert.equal(readSavedMode(keep.home), 'local');
  assert.match(keep.text(), /Sync mode is local, but the crontab schedule is still installed and still pushes usage\.\n {4}Remove it: prism-cli enable codeburn --local --remove/);
  assert.match(keep.text(), /Left in place: codeburn's sync config for https:\/\/otel\.example\.com/);
  assert.doesNotMatch(keep.text(), /stays on this machine\. No sync endpoint/);

  const rm = fakeMachine({ syncUrl: URL, schedule: true });
  assert.equal(await enableCodeburn({ local: true, remove: true }, rm.deps), 0);
  assert.deepEqual(rm.scheduleCalls, ['remove']);
  const noCb = fakeMachine({ syncUrl: URL, schedule: true, installed: false, tty: false });
  assert.equal(await enableCodeburn({ local: true, remove: true }, noCb.deps), 1, 'codeburn missing and no terminal to confirm its install');
  assert.deepEqual(noCb.scheduleCalls, ['remove'], 'the schedule is removed before codeburn is needed');
  assert.match(rm.text(), /Local only: codeburn usage stays on this machine/);
  assert.match(rm.text(), /Left in place: codeburn's sync config/);
});

test('team mode with no URL and no terminal says to ask the platform team', async () => {
  const m = fakeMachine({ tty: false });
  writeSyncMode(m.home, 'team');
  assert.equal(await enableCodeburn({}, m.deps), 1);
  assert.match(m.err.join('\n'), /the collector URL is required\. Ask your platform team for it, then run prism-cli enable codeburn --url <collector URL>\./);
});
