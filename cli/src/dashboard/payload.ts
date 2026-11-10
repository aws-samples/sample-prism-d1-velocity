/**
 * The one data document behind both `prism-cli dashboard --json` and the
 * web UI's /api/data, so the two can never disagree. The overview rows are
 * sorted here, not in the page, so `--json` carries the same order.
 */
import { collectCodewatch, combineSecretScanning, type CodewatchPanel, type SecretScanning } from './codewatch.js';
import { discoverRepos, repoLabels, type DiscoverOptions } from './repos.js';
import { codewatchSetup, GLOBAL_FORCE_CMD, GLOBAL_INSTALL_CMD, machineChecks, SECURITY_RESULT_KINDS, securitySetup, type CheckItem, type CodewatchSetup, type MachineDeps, type SecuritySetup } from './setup.js';
import { buildSummary, type DashboardSummary } from './summary.js';
import { readResults } from '../codewatch/results.js';
import { globalStatus, type GlobalStatus } from '../codewatch/globalHooks.js';
import { findOnPath } from '../utils/tool-check.js';
import { homedir } from 'node:os';
import { sep } from 'node:path';

export function tildeHome(p: string, home: string): string {
  if (p === home) return '~';
  return p.startsWith(home + sep) ? '~' + p.slice(home.length) : p;
}
import { collectUsage, spendByRepo, type CodeburnExport, type RepoSpend, type UsagePanel } from './usage.js';
import { collectSecurity, type SecurityPanel } from './security.js';
import { collectAws, type AwsPanel } from './aws.js';

export const PAYLOAD_SCHEMA = 'prism.dashboard.v2';

export interface RepoPayload {
  name: string;
  /** The name, or a short parent path when another repo has the same name. */
  label: string;
  path: string;
  /** codeburn spend this month in projects at or under this repo; null when codeburn has no data. */
  spend: RepoSpend | null;
  /** Codewatch results, Security Agent results, or codeburn spend this month. */
  active: boolean;
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
  label: string;
  path: string;
  /** See RepoPayload.active; active repos are listed first. */
  active: boolean;
  current: boolean;
  status: CodewatchSetup['status'];
  reviewer: string | null;
  detail: string;
  fix: string;
  /** Global hooks cover this repo. */
  global: boolean;
  /** Security Agent row for this repo. */
  security: SecuritySetup;
  /**
   * Shown inside the one collapsed "other repos: not set up" line: not the
   * current repo, no activity, codewatch missing or opted out, and no
   * Security Agent marker.
   */
  collapsed: boolean;
}

/** One row of the codewatch summary table. */
export interface CodewatchRow {
  name: string;
  label: string;
  path: string;
  active: boolean;
  /** codeburn spend this month for this repo, or null when there is none to match. */
  spendMonth: number | null;
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
  /** Cached Security Agent code review results (security-review), per repo. */
  security: SecurityPanel;
  /** The latest cached aws check result per AWS account (repos and ~). */
  aws: AwsPanel;
  /** The one-glance summary shown at the top of the page (buildSummary). */
  summary: DashboardSummary;
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

/** The current repo first, then repos with activity, then installed, bypassed (warn), missing and opted-out repos, each by name. */
export function sortSetupRows(rows: SetupRow[]): SetupRow[] {
  return [...rows].sort((a, b) =>
    Number(b.current) - Number(a.current) || Number(b.active) - Number(a.active) || STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byName(a, b));
}

/** Repos with activity first, then most high findings, then medium, then low, then by name. */
export function sortCodewatchRows(rows: CodewatchRow[]): CodewatchRow[] {
  return [...rows].sort((a, b) => Number(b.active) - Number(a.active) || b.high - a.high || b.medium - a.medium || b.low - a.low || byName(a, b));
}

export async function buildPayload(opts: PayloadOptions): Promise<DashboardPayload> {
  const d = discoverRepos(opts);
  const usage = await collectUsage({ exporter: opts.exporter, pathEnv: opts.pathEnv });
  const gitleaksAvailable = findOnPath('gitleaks', opts.pathEnv) !== null;
  const g = globalStatus(opts.home || homedir());
  const labels = repoLabels(d.repos.map((r) => r.path));
  const spend = spendByRepo(usage.projects, d.repos.map((r) => r.path));
  // Read each repo's results once; the Security panel below reuses them.
  const results = new Map(d.repos.map((r) => [r.path, readResults(r.path)]));
  const repos: RepoPayload[] = d.repos.map((r) => {
    const codewatch = collectCodewatch(r.path, opts.trendRuns, gitleaksAvailable);
    const repoResults = results.get(r.path) || [];
    const s = spend.get(r.path) || null;
    const securityResults = repoResults.some((x) => SECURITY_RESULT_KINDS.some(([k]) => k === x.kind));
    return {
      name: r.name,
      label: labels.get(r.path) || r.name,
      path: r.path,
      spend: s,
      active: codewatch.hasResults || securityResults || (s !== null && s.cost > 0),
      current: r.current,
      hasPrism: r.hasPrism,
      codewatch,
      setup: codewatchSetup(r.path, { pathEnv: opts.pathEnv, global: g }),
      security: securitySetup(r.path, repoResults),
    };
  });
  const setupRows = sortSetupRows(repos.map((r) => ({
    name: r.name, label: r.label, path: r.path, active: r.active, current: r.current, status: r.setup.status, reviewer: r.setup.reviewer, detail: r.setup.detail, fix: r.setup.fix,
    global: r.setup.global,
    security: r.security,
    // Bypassed repos (warn), set-up repos and repos with activity stay visible.
    collapsed: !r.current && !r.active && (r.setup.status === 'missing' || r.setup.status === 'opted-out') && r.security.status === 'missing',
  })));
  // The summary lists only repos where codewatch is installed or has left
  // results; the rest have nothing to summarize and appear in the setup list.
  const withCodewatch = repos.filter((r) => r.setup.status === 'ok' || r.codewatch.hasResults);
  const cwRows = sortCodewatchRows(withCodewatch.map((r) => ({
    name: r.name, label: r.label, path: r.path, current: r.current, active: r.active, spendMonth: r.spend ? r.spend.cost : null,
    high: r.codewatch.bySeverity.high, medium: r.codewatch.bySeverity.medium, low: r.codewatch.bySeverity.low,
    lastRunAt: r.codewatch.lastRunAt,
    lastReviewId: r.codewatch.lastReviewId,
    reviewer: r.codewatch.lastReviewer ?? r.setup.reviewer,
    unscannedCommits: r.codewatch.secretScanning.unscannedCommits,
    gitleaksWarning: r.codewatch.secretScanning.unscannedCommits > 0,
  })));
  const machineSetup = machineChecks({ pathEnv: opts.pathEnv, global: g, ...opts.machineDeps });
  return {
    schema: PAYLOAD_SCHEMA,
    generated_at: new Date().toISOString(),
    scope: { root: d.scannedRoot, root_display: tildeHome(d.scannedRoot, opts.home || homedir()), current_repo: d.currentRepo, scan_ms: d.scanMs, truncated: d.truncated, error: d.error },
    repos,
    overview: { counts: { repos: repos.length, codewatch: setupRows.filter((r) => r.status === 'ok').length }, setup: setupRows, codewatch: cwRows },
    machine: {
      setup: machineSetup,
      globalHooks: g,
      secretScanning: combineSecretScanning(repos.map((r) => r.codewatch.secretScanning), gitleaksAvailable),
    },
    suggestions: [globalSuggestion(g, setupRows.filter((r) => r.status === 'missing').length)].filter((x): x is Suggestion => x !== null),
    usage,
    security: collectSecurity(repos, (p) => results.get(p) ?? readResults(p)),
    aws: collectAws([...repos.map((r) => r.path), opts.home || homedir()]),
    summary: buildSummary(repos, usage, machineSetup),
  };
}
