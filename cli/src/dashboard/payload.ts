/**
 * The one data document behind both `prism-cli dashboard --json` and the
 * web UI's /api/data, so the two can never disagree. The overview rows are
 * sorted here, not in the page, so `--json` carries the same order.
 */
import { collectCodewatch, combineSecretScanning, type CodewatchPanel, type SecretScanning } from './codewatch.js';
import { discoverRepos, type DiscoverOptions } from './repos.js';
import { codewatchSetup, GLOBAL_FORCE_CMD, GLOBAL_INSTALL_CMD, machineChecks, securitySetup, type CheckItem, type CodewatchSetup, type MachineDeps, type SecuritySetup } from './setup.js';
import { globalStatus, type GlobalStatus } from '../codewatch/globalHooks.js';
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
  /** Security Agent, from the enable security marker. */
  security: SecuritySetup;
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
  /** Global hooks cover this repo. */
  global: boolean;
  /** Security Agent row for this repo. */
  security: SecuritySetup;
  /** Shown inside the collapsed "repos without codewatch" group: missing or opted out, and not the current repo. */
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
  /** Report id of the newest review, linked from the Last run cell. */
  lastReviewId: string | null;
  /** Reviewer of the last review, else the one that would run now. */
  reviewer: string | null;
  unscannedCommits: number;
  /** Commits here were made while gitleaks was missing. */
  gitleaksWarning: boolean;
}

/** A next step the page suggests. Read-only: the page shows the command, it never runs it. */
export interface Suggestion {
  id: 'codewatch-global';
  /** info: a suggestion. warn: a foreign global core.hooksPath is in the way. */
  style: 'info' | 'warn';
  command: string;
  reason: string;
  /** Repos without codewatch (status missing; opted-out repos are not counted). */
  missing: number;
  /** The foreign global core.hooksPath, for the warn variant. */
  currentHooksPath: string | null;
}

/** Minimum missing repos before the global install is suggested; one repo is served by its own fix line. */
export const SUGGEST_GLOBAL_MIN_MISSING = 2;

export function globalSuggestion(g: GlobalStatus, missing: number): Suggestion | null {
  if (g.state === 'installed' || missing < SUGGEST_GLOBAL_MIN_MISSING) return null;
  if (g.state === 'elsewhere') {
    return {
      id: 'codewatch-global', style: 'warn', command: GLOBAL_FORCE_CMD, missing, currentHooksPath: g.hooksPath,
      reason: `${missing} repos don't have codewatch. Your global core.hooksPath is set to ${g.hooksPath}, so --global alone would refuse; --force saves that value and still runs its hooks after codewatch.`,
    };
  }
  return {
    id: 'codewatch-global', style: 'info', command: GLOBAL_INSTALL_CMD, missing, currentHooksPath: null,
    reason: `${missing} repos don't have codewatch. Cover all of them at once.`,
  };
}

export interface DashboardPayload {
  /** repos: every repo found. codewatch: repos with both codewatch hooks installed. */
  schema: typeof PAYLOAD_SCHEMA;
  generated_at: string;
  scope: { root: string; /** root with the home directory shown as ~ */ root_display: string; current_repo: string | null; scan_ms: number; truncated: boolean; error: string | null };
  repos: RepoPayload[];
  overview: { counts: { repos: number; codewatch: number }; setup: SetupRow[]; codewatch: CodewatchRow[] };
  machine: { setup: CheckItem[]; secretScanning: SecretScanning; globalHooks: GlobalStatus };
  suggestions: Suggestion[];
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

const STATUS_ORDER: Record<SetupRow['status'], number> = { ok: 0, warn: 1, missing: 2, 'opted-out': 3 };

/** The current repo first, then installed, bypassed (warn), missing and opted-out repos, each by name. */
export function sortSetupRows(rows: SetupRow[]): SetupRow[] {
  return [...rows].sort((a, b) =>
    Number(b.current) - Number(a.current) || STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byName(a, b));
}

/** Most high findings first, then medium, then low, then by name. */
export function sortCodewatchRows(rows: CodewatchRow[]): CodewatchRow[] {
  return [...rows].sort((a, b) => b.high - a.high || b.medium - a.medium || b.low - a.low || byName(a, b));
}

export async function buildPayload(opts: PayloadOptions): Promise<DashboardPayload> {
  const d = discoverRepos(opts);
  const usage = await collectUsage({ exporter: opts.exporter, pathEnv: opts.pathEnv });
  const gitleaksAvailable = findOnPath('gitleaks', opts.pathEnv) !== null;
  const g = globalStatus(opts.home || homedir());
  const repos: RepoPayload[] = d.repos.map((r) => ({
    name: r.name,
    path: r.path,
    current: r.current,
    hasPrism: r.hasPrism,
    codewatch: collectCodewatch(r.path, opts.trendRuns, gitleaksAvailable),
    setup: codewatchSetup(r.path, { pathEnv: opts.pathEnv, global: g }),
    security: securitySetup(r.path),
  }));
  const setupRows = sortSetupRows(repos.map((r) => ({
    name: r.name, path: r.path, current: r.current, status: r.setup.status, reviewer: r.setup.reviewer, detail: r.setup.detail, fix: r.setup.fix,
    global: r.setup.global,
    security: r.security,
    // Bypassed repos (warn) need attention, so they stay visible.
    collapsed: !r.current && (r.setup.status === 'missing' || r.setup.status === 'opted-out'),
  })));
  // The summary lists only repos where codewatch is installed or has left
  // results; the rest have nothing to summarize and appear in the setup list.
  const active = repos.filter((r) => r.setup.status === 'ok' || r.codewatch.hasResults);
  const cwRows = sortCodewatchRows(active.map((r) => ({
    name: r.name, path: r.path, current: r.current,
    high: r.codewatch.bySeverity.high, medium: r.codewatch.bySeverity.medium, low: r.codewatch.bySeverity.low,
    lastRunAt: r.codewatch.lastRunAt,
    lastReviewId: r.codewatch.lastReviewId,
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
      setup: machineChecks({ pathEnv: opts.pathEnv, global: g, ...opts.machineDeps }),
      globalHooks: g,
      secretScanning: combineSecretScanning(repos.map((r) => r.codewatch.secretScanning), gitleaksAvailable),
    },
    suggestions: [globalSuggestion(g, setupRows.filter((r) => r.status === 'missing').length)].filter((x): x is Suggestion => x !== null),
    usage,
    security: { status: 'coming-soon', message: 'Coming with prism-cli security findings.' },
  };
}
