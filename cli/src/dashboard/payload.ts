/**
 * The one data document behind both `prism-cli dashboard --json` and the
 * web UI's /api/data, so the two can never disagree. The overview rows are
 * sorted here, not in the page, so `--json` carries the same order.
 */
import { collectCodewatch, combineSecretScanning, type CodewatchPanel, type SecretScanning } from './codewatch.js';
import { discoverRepos, type DiscoverOptions } from './repos.js';
import { codewatchSetup, machineChecks, type CheckItem, type CodewatchSetup, type MachineDeps } from './setup.js';
import { findOnPath } from '../utils/tool-check.js';
import { collectUsage, type CodeburnExport, type UsagePanel } from './usage.js';

export const PAYLOAD_SCHEMA = 'prism.dashboard.v2';

export interface RepoPayload {
  name: string;
  path: string;
  current: boolean;
  hasPrism: boolean;
  codewatch: CodewatchPanel;
  setup: CodewatchSetup;
}

/** One row of the setup table. */
export interface SetupRow {
  name: string;
  path: string;
  current: boolean;
  status: CodewatchSetup['status'];
  reviewer: string | null;
  detail: string;
  fix: string;
}

/** One row of the codewatch summary table. */
export interface CodewatchRow {
  name: string;
  path: string;
  current: boolean;
  high: number;
  medium: number;
  low: number;
  lastRunAt: string | null;
  /** Reviewer of the last review, else the one that would run now. */
  reviewer: string | null;
  unscannedCommits: number;
  /** Commits here were made while gitleaks was missing. */
  gitleaksWarning: boolean;
}

export interface DashboardPayload {
  schema: typeof PAYLOAD_SCHEMA;
  generated_at: string;
  scope: { root: string; current_repo: string | null; scan_ms: number; truncated: boolean; error: string | null };
  repos: RepoPayload[];
  overview: { setup: SetupRow[]; codewatch: CodewatchRow[] };
  machine: { setup: CheckItem[]; secretScanning: SecretScanning };
  usage: UsagePanel;
  security: { status: 'coming-soon'; message: string };
}

export interface PayloadOptions extends DiscoverOptions {
  trendRuns?: number;
  exporter?: CodeburnExport;
  machineDeps?: MachineDeps;
  pathEnv?: string;
}

const byName = (a: { name: string; path: string }, b: { name: string; path: string }) =>
  a.name.localeCompare(b.name) || a.path.localeCompare(b.path);

/** Missing codewatch first, then the current repo, then by name. */
export function sortSetupRows(rows: SetupRow[]): SetupRow[] {
  return [...rows].sort((a, b) =>
    (a.status === 'missing' ? 0 : 1) - (b.status === 'missing' ? 0 : 1) || Number(b.current) - Number(a.current) || byName(a, b));
}

/** Most high findings first, then medium, then low, then by name. */
export function sortCodewatchRows(rows: CodewatchRow[]): CodewatchRow[] {
  return [...rows].sort((a, b) => b.high - a.high || b.medium - a.medium || b.low - a.low || byName(a, b));
}

export async function buildPayload(opts: PayloadOptions): Promise<DashboardPayload> {
  const d = discoverRepos(opts);
  const usage = await collectUsage({ exporter: opts.exporter, pathEnv: opts.pathEnv });
  const gitleaksAvailable = findOnPath('gitleaks', opts.pathEnv) !== null;
  const repos: RepoPayload[] = d.repos.map((r) => ({
    name: r.name,
    path: r.path,
    current: r.current,
    hasPrism: r.hasPrism,
    codewatch: collectCodewatch(r.path, opts.trendRuns, gitleaksAvailable),
    setup: codewatchSetup(r.path, { pathEnv: opts.pathEnv }),
  }));
  const setupRows = sortSetupRows(repos.map((r) => ({
    name: r.name, path: r.path, current: r.current, status: r.setup.status, reviewer: r.setup.reviewer, detail: r.setup.detail, fix: r.setup.fix,
  })));
  const cwRows = sortCodewatchRows(repos.map((r) => ({
    name: r.name, path: r.path, current: r.current,
    high: r.codewatch.bySeverity.high, medium: r.codewatch.bySeverity.medium, low: r.codewatch.bySeverity.low,
    lastRunAt: r.codewatch.lastRunAt,
    reviewer: r.codewatch.lastReviewer ?? r.setup.reviewer,
    unscannedCommits: r.codewatch.secretScanning.unscannedCommits,
    gitleaksWarning: r.codewatch.secretScanning.unscannedCommits > 0,
  })));
  return {
    schema: PAYLOAD_SCHEMA,
    generated_at: new Date().toISOString(),
    scope: { root: d.scannedRoot, current_repo: d.currentRepo, scan_ms: d.scanMs, truncated: d.truncated, error: d.error },
    repos,
    overview: { setup: setupRows, codewatch: cwRows },
    machine: {
      setup: machineChecks({ pathEnv: opts.pathEnv, ...opts.machineDeps }),
      secretScanning: combineSecretScanning(repos.map((r) => r.codewatch.secretScanning), gitleaksAvailable),
    },
    usage,
    security: { status: 'coming-soon', message: 'Coming with prism-cli security findings.' },
  };
}
