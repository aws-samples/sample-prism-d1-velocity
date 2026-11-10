/**
 * Detection of the scheduled `codeburn sync push` installed by
 * `enable codeburn` (formerly `bootstrapper setup-otel-sync`). Shared so the
 * dashboard's setup checklist, `enable codeburn --status` and `export otel`
 * agree on what "installed" means and on what a sync push runs.
 *
 * Read-only: nothing here installs or removes a schedule.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { run, type RunResult } from './exec.js';

/** The command that installs codeburn and its scheduled sync. Fix hints point here. */
export const ENABLE_CODEBURN_CMD = 'prism-cli enable codeburn';

/** npm package and global install argv for codeburn (github.com/getagentseal/codeburn). */
export const CODEBURN_NPM_PACKAGE = 'codeburn';
export const CODEBURN_INSTALL_ARGS = ['install', '-g', CODEBURN_NPM_PACKAGE];

/** Window the recurring sync pushes on every run, and the `export otel` default. */
export const SYNC_SINCE = '7d';

/**
 * The argv of a sync push, shared by every schedule platform and `export otel`.
 *
 * This is the single source of truth on purpose. It previously existed only as
 * a Linux helper, and the Windows branch open-coded its own command string
 * that omitted --attribution. That silently reduced Windows machines to usage
 * telemetry with no commit attribution, so those developers counted toward the
 * Attribution Coverage denominator (CI sees their commits) while contributing
 * nothing to the numerator -- indistinguishable on the dashboard from someone
 * who never onboarded. Any new caller must use this.
 */
export function syncArgs(since: string): string[] {
  return ['sync', 'push', '--since', since, '--attribution'];
}

export const CRON_MARKER = '# prism-otel-sync';
export const PLIST_LABEL = 'com.prism.otel-sync';
export const SCHTASK_NAME = 'PrismOtelSync';

export function otelLogDir(home = homedir()): string {
  return join(home, '.prism', 'logs');
}

export function otelLogFile(home = homedir()): string {
  return join(otelLogDir(home), 'otel-sync.log');
}

export function codeburnSyncConfigPath(home = homedir()): string {
  return join(home, '.config', 'codeburn', 'sync.json');
}

export function linuxCrontabAvailable(): boolean {
  return run('which', ['crontab']).ok;
}

/** What `crontab -l` prints (on stderr, exit 1) when the user has no crontab yet. */
const NO_CRONTAB = /no crontab for/i;

/**
 * The current crontab lines from a `crontab -l` result. `crontab -l` exits
 * non-zero both when the user has no crontab and when it cannot read it (PAM
 * denial, permissions). Only the first is an empty crontab; treating the second
 * as empty and writing would replace the user's cron jobs, so it throws.
 */
export function crontabLines(r: RunResult): string[] {
  if (r.ok) return r.stdout.split('\n');
  if (NO_CRONTAB.test(r.stderr)) return [];
  const reason = r.stderr.split('\n').map((l) => l.trim()).find(Boolean) || 'unknown error';
  throw new Error(`cannot read your crontab (crontab -l: ${reason}); it was not changed, so your existing cron jobs are kept. Fix crontab access, or run "prism-cli export otel" yourself.`);
}

/** The crontab entry only. Throws (via crontabLines) when the crontab cannot be read, rather than calling the schedule missing. */
export function linuxCronScheduleExists(): boolean {
  if (!linuxCrontabAvailable()) return false;
  return crontabLines(run('crontab', ['-l'])).some((l) => l.includes(CRON_MARKER));
}

/**
 * The systemd user timer `enable codeburn --schedule systemd` installs, the
 * Linux schedule for machines whose crontab cannot be read (a PAM denial).
 */
export const SYSTEMD_UNIT = 'prism-otel-sync';
export const SYSTEMD_SCHEDULER_NAME = 'systemd user timer';

// shortcut: ignores $XDG_CONFIG_HOME, which systemd honours; add it if someone relocates their config dir.
export function systemdUserDir(home = homedir()): string {
  return join(home, '.config', 'systemd', 'user');
}

export function systemdTimerPath(home = homedir()): string {
  return join(systemdUserDir(home), `${SYSTEMD_UNIT}.timer`);
}

export function systemdServicePath(home = homedir()): string {
  return join(systemdUserDir(home), `${SYSTEMD_UNIT}.service`);
}

/** The timer unit file is present. A file check only: nothing is run. */
export function systemdTimerExists(home = homedir()): boolean {
  return existsSync(systemdTimerPath(home));
}

/** `systemctl --user` reaches a user manager on this machine. */
export function systemdUserAvailable(): boolean {
  return platform() === 'linux' && run('systemctl', ['--user', 'show-environment']).ok;
}

/** The systemd timer, else the crontab entry: an unreadable crontab does not hide an installed timer. */
export function linuxScheduleExists(): boolean {
  return systemdTimerExists() || linuxCronScheduleExists();
}

export function darwinPlistPath(home = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
}

export function darwinScheduleExists(): boolean {
  return existsSync(darwinPlistPath());
}

export function windowsScheduleExists(): boolean {
  return run('schtasks', ['/query', '/tn', SCHTASK_NAME, '/fo', 'CSV']).ok;
}

export function scheduleExists(): boolean {
  switch (platform()) {
    case 'darwin': return darwinScheduleExists();
    case 'win32': return windowsScheduleExists();
    default: return linuxScheduleExists();
  }
}

export function schedulerName(): string {
  switch (platform()) {
    case 'darwin': return 'LaunchAgent';
    case 'win32': return 'Scheduled Task';
    default: return systemdTimerExists() ? SYSTEMD_SCHEDULER_NAME : 'crontab';
  }
}

export interface LastSync {
  /** mtime of the sync log: when the scheduled job last wrote output. */
  at: string;
  /** Last non-empty log line, trimmed. */
  lastLine: string | null;
}

/** When the scheduled sync last ran, from ~/.prism/logs/otel-sync.log. null if it never wrote. */
export function lastSync(home = homedir()): LastSync | null {
  const f = otelLogFile(home);
  try {
    const st = statSync(f);
    const lines = readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    return { at: st.mtime.toISOString(), lastLine: lines.length ? lines[lines.length - 1].slice(0, 200) : null };
  } catch {
    return null;
  }
}
