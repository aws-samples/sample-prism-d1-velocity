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
import { join, resolve } from 'node:path';

export const RESULT_SCHEMA_VERSION = 1;
export const RESULTS_DIR = '.prism/results';

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
}

/** `secrets` = gitleaks; `review` = the reviewer (kiro-cli / Claude Code). */
export type ResultKind = 'secrets' | 'review';
export type ResultHook = 'pre-commit' | 'pre-push' | 'ci' | 'manual';
/**
 * ok        ran, nothing found
 * findings  ran, found something
 * error     could not produce a verdict (tool missing, crashed, unparseable output)
 * skipped   did not run: no changes to review, or the hook was bypassed (`--no-verify`)
 */
export type ResultStatus = 'ok' | 'findings' | 'error' | 'skipped';

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
  /** Why the run errored or was skipped. */
  reason: string | null;
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
export function writeResult(repoRoot: string, r: PrismResult): string {
  const dir = resolve(repoRoot, RESULTS_DIR);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, resultFileName(r));
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, dest);
  return dest;
}

/** Reads every parseable result file. Unparseable files are ignored, not fatal. */
export function readResults(repoRoot: string): PrismResult[] {
  const dir = resolve(repoRoot, RESULTS_DIR);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: PrismResult[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (r && r.schema_version === RESULT_SCHEMA_VERSION) out.push(r);
    } catch { /* skip */ }
  }
  return out;
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}
