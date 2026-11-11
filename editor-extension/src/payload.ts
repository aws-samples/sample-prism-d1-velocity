/**
 * The part of `prism-cli dashboard --json` (schema prism.dashboard.v2,
 * cli/src/dashboard/payload.ts) this extension reads, and the choice of this
 * repo's latest review. No vscode import, so it is unit-tested directly.
 */

export const PAYLOAD_SCHEMA = 'prism.dashboard.v2';

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  severity: Severity;
  category: string;
  rule: string;
  file: string;
  line: number | null;
  message: string;
  branch: string | null;
  started_at: string;
}

export interface ScanRow {
  id: string;
  started_at: string;
  branch: string | null;
  tool: string;
  status: string;
  high: number;
  medium: number;
  low: number;
  reason: string | null;
}

export interface CheckItem {
  id: string;
  label: string;
  status: 'ok' | 'info' | 'warn' | 'missing';
  detail: string;
  fix: string;
  help?: { text: string };
}

export interface RepoPayload {
  name: string;
  label: string;
  path: string;
  current: boolean;
  spend: { cost: number; sessions: number } | null;
  codewatch: {
    hasResults: boolean;
    findings: Finding[];
    findingsTruncated: boolean;
    /** Newest pre-push reviews first. */
    scans: ScanRow[];
  };
  setup: { status: 'ok' | 'warn' | 'missing' | 'opted-out'; reviewer: string | null; detail: string; fix: string };
  security: { status: string; detail: string; fix: string };
}

export interface DashboardPayload {
  schema: string;
  generated_at: string;
  repos: RepoPayload[];
  machine: { setup: CheckItem[]; codeburnSync: { mode: string } };
  summary: {
    spend: { status: string; currency: string; today: number | null; month: number | null; message: string | null; updatedAt?: string | null };
    warnings: { count: number; first: string | null };
  };
}

export class PayloadError extends Error {}

/** Parses and shape-checks the CLI's stdout. Throws PayloadError with a message fit for the status bar tooltip. */
export function parsePayload(text: string): DashboardPayload {
  let p: unknown;
  try { p = JSON.parse(text); } catch { throw new PayloadError('prism-cli printed something that is not JSON'); }
  const o = p as Partial<DashboardPayload> | null;
  if (!o || typeof o !== 'object') throw new PayloadError('prism-cli output is not an object');
  if (o.schema !== PAYLOAD_SCHEMA) {
    throw new PayloadError(`prism-cli output has schema ${JSON.stringify(o.schema)}; this extension reads ${PAYLOAD_SCHEMA}. Update prism-cli: npm i -g @prism-d1/cli`);
  }
  if (!Array.isArray(o.repos) || !o.machine || !Array.isArray(o.machine.setup) || !o.summary || !o.summary.spend || !o.summary.warnings) {
    throw new PayloadError('prism-cli output is missing repos, machine or summary');
  }
  return o as DashboardPayload;
}

/** The latest pre-push review shown for this repo. */
export interface SelectedReview extends ScanRow {
  /** The review is of the checked-out branch, so its line numbers apply to these files. */
  onBranch: boolean;
}

export interface RepoView {
  repo: RepoPayload | null;
  review: SelectedReview | null;
  /** Findings of `review`, most severe first. */
  findings: Finding[];
}

/** The repo is the payload's current one (the CLI ran with cwd = repo root), else the one with that path. */
export function selectRepo(p: DashboardPayload, repoRoot: string): RepoPayload | null {
  return p.repos.find((r) => r.current) ?? p.repos.find((r) => r.path === repoRoot) ?? null;
}

/**
 * The newest review of the checked-out branch, else the newest review in the
 * repo (marked onBranch false: its lines may not match these files, so it
 * gets no Problems markers).
 */
export function repoView(p: DashboardPayload, repoRoot: string, branch: string | null): RepoView {
  const repo = selectRepo(p, repoRoot);
  if (!repo) return { repo: null, review: null, findings: [] };
  const scans = repo.codewatch.scans || [];
  const mine = branch ? scans.find((s) => s.branch === branch) : undefined;
  const pick = mine ?? scans[0];
  if (!pick) return { repo, review: null, findings: [] };
  const findings = (repo.codewatch.findings || []).filter((f) => f.branch === pick.branch && f.started_at === pick.started_at);
  return { repo, review: { ...pick, onBranch: !!mine }, findings };
}

/** True when codewatch neither runs here nor has left results: the status bar offers Enable. */
export function codewatchOff(repo: RepoPayload | null): boolean {
  if (!repo) return true;
  return (repo.setup.status === 'missing' || repo.setup.status === 'opted-out') && !repo.codewatch.hasResults;
}
