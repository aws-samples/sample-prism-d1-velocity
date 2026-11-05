/**
 * The one data document behind both `prism-cli dashboard --json` and the
 * web UI's /api/data, so the two can never disagree. The overview rows are
 * sorted here, not in the page, so `--json` carries the same order.
 */
import { collectCodewatch, combineSecretScanning, type CodewatchPanel, type SecretScanning } from './codewatch.js';
import { discoverRepos, type DiscoverOptions } from './repos.js';
import { codewatchSetup, machineChecks, type CheckItem, type CodewatchSetup, type MachineDeps } from './setup.js';
import { findOnPath } from '../utils/tool-check.js';
import { homedir } from 'node:os';
import { sep } from 'node:path';

export function tildeHome(p: string, home: string): string {
  if (p === home) return '~';
  return p.startsWith(home + sep) ? '~' + p.slice(home.length) : p;
}
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
  /** Shown inside the collapsed "repos without codewatch" group: missing, and not the current repo. */
  collapsed: boolean;
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
  /** repos: every repo found. codewatch: repos with both codewatch hooks installed. */
  schema: typeof PAYLOAD_SCHEMA;
  generated_at: string;
  scope: { root: string; /** root with the home directory shown as ~ */ root_display: string; current_repo: string | null; scan_ms: number; truncated: boolean; error: string | null };
  repos: RepoPayload[];
  overview: { counts: { repos: number; codewatch: number }; setup: SetupRow[]; codewatch: CodewatchRow[] };
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

/** The current repo first, then installed repos, then missing ones, each by name. */
export function sortSetupRows(rows: SetupRow[]): SetupRow[] {
  return [...rows].sort((a, b) =>
    Number(b.current) - Number(a.current) || (a.status === 'ok' ? 0 : 1) - (b.status === 'ok' ? 0 : 1) || byName(a, b));
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
    collapsed: !r.current && r.setup.status !== 'ok',
  })));
  // The summary lists only repos where codewatch is installed or has left
  // results; the rest have nothing to summarize and appear in the setup list.
  const active = repos.filter((r) => r.setup.status === 'ok' || r.codewatch.hasResults);
  const cwRows = sortCodewatchRows(active.map((r) => ({
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
    scope: { root: d.scannedRoot, root_display: tildeHome(d.scannedRoot, opts.home || homedir()), current_repo: d.currentRepo, scan_ms: d.scanMs, truncated: d.truncated, error: d.error },
    repos,
    overview: { counts: { repos: repos.length, codewatch: setupRows.filter((r) => r.status === 'ok').length }, setup: setupRows, codewatch: cwRows },
    machine: {
      setup: machineChecks({ pathEnv: opts.pathEnv, ...opts.machineDeps }),
      secretScanning: combineSecretScanning(repos.map((r) => r.codewatch.secretScanning), gitleaksAvailable),
    },
    usage,
    security: { status: 'coming-soon', message: 'Coming with prism-cli security findings.' },
  };
}
