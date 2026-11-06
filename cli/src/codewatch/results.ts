/**
 * Codewatch result schema and writer (local git-hook gate runs).
 *
 * Every local gate run (the pre-commit secret scan, the pre-push review, and a
 * detected skip of either) is written as one JSON file under `.prism/results/`.
 * The schema lives here, not in the hook code, so `prism-cli dashboard` and CI
 * can read the same files without re-deriving the shape.
 *
 * Results are local developer evidence, never committed: the installer adds
 * `.prism/results/` to .gitignore.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { appendFileSync, existsSync as fileExists } from 'node:fs';
import { run } from '../utils/exec.js';

export const RESULT_SCHEMA_VERSION = 1;
export const RESULTS_DIR = '.prism/results';

/** Pre-commit ran with no gitleaks on PATH: the commit was allowed but not secret-scanned. */
export const REASON_GITLEAKS_MISSING = 'gitleaks-missing';

export type Severity = 'high' | 'medium' | 'low';
export type FindingCategory = 'quality' | 'security';

export interface Finding {
  severity: Severity;
  category: FindingCategory;
  /** Rule that fired: a gitleaks RuleID, or the review rule the reviewer named. */
  rule: string;
  file: string;
  line: number | null;
  message: string;
  /** security-review only: the Security Agent risk level (CRITICAL ... UNKNOWN), finding title, CWE and id. */
  risk_level?: string;
  title?: string;
  cwe?: string | null;
  finding_id?: string;
  /** security-review only: the path exactly as the service reported it (file is repo-relative). */
  raw_file?: string;
}

/** `secrets` = gitleaks; `review` = the reviewer (kiro-cli / Claude Code); `security-review` = an AWS Security Agent code review job. */
export type ResultKind = 'secrets' | 'review' | 'security-review';

/** security-review only: the job behind the result. */
export interface SecurityReviewInfo {
  job_id: string;
  code_review_id: string;
  agent_space_id: string;
  region: string;
  /** The AWS account the job ran in, so `security findings` only completes its own account's pending records. */
  account?: string;
  /** diff: the branch diff base...tip. full: the whole repo at tip. unknown: fetched later by `security findings`. */
  scope: 'diff' | 'full' | 'unknown';
  job_status: string;
  /** Findings per Security Agent risk level. */
  counts: Record<string, number>;
  /** The service's job timestamps, and updatedAt - createdAt (queue plus run time), when it reported them. */
  service_created_at?: string | null;
  service_updated_at?: string | null;
  service_duration_s?: number | null;
  /** Our wall time from starting the job to seeing it finish (code-review only; includes polling). */
  wall_s?: number | null;
}
export type ResultHook = 'pre-commit' | 'pre-push' | 'ci' | 'manual';
/**
 * ok        ran, nothing found
 * findings  ran, found something
 * error     could not produce a verdict (tool missing, crashed, unparseable output)
 * skipped   did not run: no changes to review, or the hook was bypassed (`--no-verify`)
 * pending   security-review only: the job was started and has no verdict yet.
 *           finished_at equals started_at until the record is completed in place.
 */
export type ResultStatus = 'ok' | 'findings' | 'error' | 'skipped' | 'pending';

export interface PrismResult {
  schema_version: typeof RESULT_SCHEMA_VERSION;
  kind: ResultKind;
  hook: ResultHook;
  status: ResultStatus;
  /** Tool that produced the verdict: 'gitleaks', 'kiro', 'claude', or 'none'. */
  tool: string;
  tool_version: string | null;
  /** Model the reviewer reported, or the one requested if it reported none. null when unknown. */
  model: string | null;
  /** Commit reviewed. null for pre-commit, where the commit does not exist yet. */
  commit: string | null;
  /**
   * Tree object of the change. For pre-commit this is the staged tree, which
   * equals the tree of the commit that follows -- how a later pre-push links a
   * pushed commit back to its secret scan, and so detects `--no-verify`.
   */
  tree: string | null;
  branch: string | null;
  upstream: string | null;
  /** Base commit of the reviewed range (pre-push). */
  base: string | null;
  started_at: string;
  finished_at: string;
  findings: Finding[];
  summary: string | null;
  score: number | null;
  /**
   * Why the run errored or was skipped. Free text, except these codes, which
   * consumers (the dashboard, CI) match on exactly: see REASON_*.
   */
  reason: string | null;
  /** Present on kind security-review. */
  security?: SecurityReviewInfo;
}

export type ResultInit = Omit<PrismResult, 'schema_version' | 'tool_version' | 'model' | 'commit' | 'tree' | 'branch' | 'upstream' | 'base' | 'summary' | 'score' | 'reason' | 'findings'>
  & Partial<Pick<PrismResult, 'tool_version' | 'model' | 'commit' | 'tree' | 'branch' | 'upstream' | 'base' | 'summary' | 'score' | 'reason' | 'findings'>>;

export function makeResult(init: ResultInit): PrismResult {
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    tool_version: null,
    model: null,
    commit: null,
    tree: null,
    branch: null,
    upstream: null,
    base: null,
    summary: null,
    score: null,
    reason: null,
    findings: [],
    ...init,
  };
}

/** Keeps only characters safe in a file name, so no value can escape the results dir. */
function safePart(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'x';
}

/** `20261104T202000123Z` -- sortable, colon-free. */
export function compactTimestamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace('.', '');
}

/**
 * `<commit12>-<time>-<hook>-<kind>.json`, or `tree-<tree12>-...` when there is
 * no commit yet (pre-commit).
 */
export function resultFileName(r: PrismResult): string {
  const id = r.commit ? safePart(r.commit.slice(0, 12)) : r.tree ? `tree-${safePart(r.tree.slice(0, 12))}` : 'nocommit';
  return `${id}-${compactTimestamp(r.started_at)}-${safePart(r.hook)}-${safePart(r.kind)}.json`;
}

/**
 * Writes a result atomically (temp file + rename), so a dashboard reading the
 * directory never sees a half-written file. Returns the absolute path.
 */
/**
 * Makes sure `.prism/results/` is ignored in this clone. Under the global
 * hooks a repo may never have had codewatch installed, so it has no .gitignore
 * entry; `.git/info/exclude` is local to the clone and keeps the working tree
 * clean without touching any tracked file. Outside a git repo it does nothing.
 */
export function ensureResultsExcluded(repoRoot: string): boolean {
  const probe = run('git', ['-C', repoRoot, 'check-ignore', '-q', `${RESULTS_DIR}/probe.json`]);
  if (probe.ok) return false;
  const p = run('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
  if (!p.ok || !p.stdout) return false;
  mkdirSync(dirname(p.stdout), { recursive: true });
  const prefix = fileExists(p.stdout) && !readFileSync(p.stdout, 'utf8').endsWith('\n') ? '\n' : '';
  appendFileSync(p.stdout, `${prefix}# prism-cli codewatch results (local)\n/${RESULTS_DIR}/\n`);
  return true;
}

/**
 * `id` (a ResultEntry id) rewrites that existing file in place instead of
 * naming a new one: how a pending security-review record is completed.
 */
export function writeResult(repoRoot: string, r: PrismResult, id?: string): string {
  if (id !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error(`invalid result id: ${id}`);
  const dir = resolve(repoRoot, RESULTS_DIR);
  if (!fileExists(dir)) {
    try { ensureResultsExcluded(repoRoot); } catch { /* never fail a write over this */ }
  }
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, id !== undefined ? `${id}.json` : resultFileName(r));
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, dest);
  return dest;
}

export interface ResultEntry {
  /** File name without `.json`: the result's stable id (used by report links). */
  id: string;
  result: PrismResult;
}

/** Every parseable result with its id. Ids come from the directory listing, never from input. */
export function readResultEntries(repoRoot: string): ResultEntry[] {
  const dir = resolve(repoRoot, RESULTS_DIR);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: ResultEntry[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (r && r.schema_version === RESULT_SCHEMA_VERSION) out.push({ id: f.slice(0, -'.json'.length), result: r });
    } catch { /* skip */ }
  }
  return out;
}

/** Reads every parseable result file. Unparseable files are ignored, not fatal. */
export function readResults(repoRoot: string): PrismResult[] {
  return readResultEntries(repoRoot).map((e) => e.result);
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}
