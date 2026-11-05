/**
 * The one data document behind both `prism-cli dashboard --json` and the
 * web UI's /api/data, so the two can never disagree.
 */
import { collectCodewatch, type CodewatchPanel } from './codewatch.js';
import { discoverRepos, type DiscoverOptions } from './repos.js';
import { machineChecks, repoChecks, type CheckItem, type MachineDeps } from './setup.js';
import { collectUsage, type CodeburnExport, type UsagePanel } from './usage.js';

export const PAYLOAD_SCHEMA = 'prism.dashboard.v1';

export interface RepoPayload {
  name: string;
  path: string;
  codewatch: CodewatchPanel;
  setup: CheckItem[];
}

export interface DashboardPayload {
  schema: typeof PAYLOAD_SCHEMA;
  generated_at: string;
  scope: { all: boolean; root: string | null; error: string | null };
  repos: RepoPayload[];
  machine: { setup: CheckItem[] };
  usage: UsagePanel;
  security: { status: 'coming-soon'; message: string };
}

export interface PayloadOptions extends DiscoverOptions {
  trendRuns?: number;
  exporter?: CodeburnExport;
  machineDeps?: MachineDeps;
  pathEnv?: string;
}

export async function buildPayload(opts: PayloadOptions): Promise<DashboardPayload> {
  const d = discoverRepos(opts);
  const usage = await collectUsage({ exporter: opts.exporter, pathEnv: opts.pathEnv });
  return {
    schema: PAYLOAD_SCHEMA,
    generated_at: new Date().toISOString(),
    scope: { all: !!opts.all, root: d.scannedRoot, error: d.error },
    repos: d.repos.map((r) => ({
      name: r.name,
      path: r.path,
      codewatch: collectCodewatch(r.path, opts.trendRuns),
      setup: repoChecks(r.path, { pathEnv: opts.pathEnv }),
    })),
    machine: { setup: machineChecks({ pathEnv: opts.pathEnv, ...opts.machineDeps }) },
    usage,
    security: { status: 'coming-soon', message: 'Coming with prism-cli security findings.' },
  };
}
