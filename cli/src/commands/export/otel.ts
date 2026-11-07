/**
 * `prism-cli export otel`: push codeburn's unsent telemetry to the configured
 * PRISM OTEL collector now, with the same argv the schedule runs.
 *
 * Output is codeburn's own, streamed, and the exit code is codeburn's.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { runStreaming } from '../../utils/exec.js';
import { codeburnSyncConfigPath, ENABLE_CODEBURN_CMD, SYNC_SINCE, syncArgs } from '../../utils/otel-sync-schedule.js';
import { getCodeburnPath } from '../enable/codeburn.js';
import { runGuarded } from '../enable/security.js';

export interface ExportOtelDeps {
  findCodeburn: () => string | null;
  home: string;
  stream: (file: string, args: string[]) => number;
  log: (line: string) => void;
  error: (line: string) => void;
}

export function defaultDeps(): ExportOtelDeps {
  return {
    findCodeburn: getCodeburnPath,
    home: homedir(),
    stream: runStreaming,
    log: (l) => console.log(l),
    error: (l) => console.error(l),
  };
}

export async function exportOtel(opts: { since?: string }, d: ExportOtelDeps): Promise<number> {
  const cb = d.findCodeburn();
  if (!cb) {
    d.error('Error: codeburn is not installed.');
    d.error(`  Run "${ENABLE_CODEBURN_CMD}" to install it and set up the sync.`);
    return 1;
  }
  if (!existsSync(codeburnSyncConfigPath(d.home))) {
    d.error('Error: codeburn sync is not set up (no endpoint configured).');
    d.error(`  Run "${ENABLE_CODEBURN_CMD} --url <OtelCollectorUrl>" first.`);
    return 1;
  }
  const since = opts.since || SYNC_SINCE;
  const args = syncArgs(since);
  d.log(`Running: codeburn ${args.join(' ')}`);
  const code = d.stream(cb, args);
  if (code !== 0) d.error(`codeburn sync push exited with ${code}. Check "codeburn sync status", or re-run "${ENABLE_CODEBURN_CMD}".`);
  return code;
}

/** Test seams, as in enable codeburn. */
export interface ExportOtelHooks {
  deps?: () => ExportOtelDeps;
  error?: (line: string) => void;
  exit?: (code: number) => void;
  env?: NodeJS.ProcessEnv;
}

export async function runExportOtel(opts: { since?: string }, hooks: ExportOtelHooks = {}): Promise<void> {
  await runGuarded(() => exportOtel(opts, (hooks.deps ?? defaultDeps)()), hooks);
}

export default {
  description: 'Push AI usage and commit attribution to the PRISM OTEL collector now (codeburn sync push, as the schedule runs it)',
  options: [
    { flags: '--since <window>', description: `Time window passed to codeburn: today, 7d, 30d, month, all (default: ${SYNC_SINCE}, as the schedule)` },
  ],
  action: runExportOtel,
};
