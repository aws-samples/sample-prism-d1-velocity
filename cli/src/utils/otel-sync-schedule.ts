/**
 * Detection of the scheduled `codeburn sync push` installed by
 * `bootstrapper setup-otel-sync`. Shared so the dashboard's setup checklist
 * and setup-otel-sync's own --status agree on what "installed" means.
 *
 * Read-only: nothing here installs or removes a schedule.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { run } from './exec.js';

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

export function linuxScheduleExists(): boolean {
  if (!linuxCrontabAvailable()) return false;
  const result = run('crontab', ['-l']);
  return result.ok && result.stdout.includes(CRON_MARKER);
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
    default: return 'crontab';
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
