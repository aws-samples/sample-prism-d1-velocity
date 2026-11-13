/**
 * The harness loop engine: `prism-cli codewatch review --json`.
 *
 * One call reviews the lines an agent changed and answers pass, fix or stop
 * (docs/DESIGN-harness-loop.md sections 2.4, 3, 4, 5, 6 and 12):
 *
 *  1. diff for the scope (empty: pass, no cost)
 *  2. tamper check on the session's changed paths
 *  3. gitleaks on the changed files, redacted, filtered to the changed lines
 *  4. AI review with the existing reviewer resolution, skipped when a secret
 *     was found, for docs-only diffs, and when the push gate is off; one retry
 *     only when the reply cannot be parsed; fail open after that (D1)
 *  5. scope filter, block_on, round counter and loop guard
 *  6. result file under .prism/results/ (kind agent-harness)
 *
 * It never commits, pushes, stages or edits tracked files. It writes only
 * under .prism/results/ and .prism/harness/.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { modelLabel, readEvalConfig, readHarnessConfig, resolveReviewModel, reviewModelGitKey, REVIEWER_GIT_CONFIG_KEY, type BlockOn, type HarnessConfig } from '../config.js';
import { gitleaksInstallHint, safeWrite, scanFiles, type FileScan } from '../gitleaks.js';
import { ensureResultsExcluded, makeResult, type Finding, type Severity } from '../results.js';
import { ADAPTERS, detectReviewers, findOnPath, normalizeReview, resolveReviewer, runReview, toolVersion, type ReviewRun } from '../reviewers/index.js';
import { loadReviewRules } from '../rules.js';
import { diffTrees, gitIn, matchesAny, parseDiff, readBlobs, revParse, objectExists, snapshotTree, touchedPaths, type ParsedDiff } from './diff.js';
import { cleanupState, ensureHarnessDir, loadState, readCache, saveState, STATE_VERSION, writeCache, type SessionState, type Verdict } from './state.js';

export const VERDICT_SCHEMA = 'prism.harness.verdict';
export const VERDICT_VERSION = 1;
/** The harness reviews a smaller diff than the pre-push gate (200,000), because a person waits on it. */
export const MAX_HARNESS_DIFF_CHARS = 60_000;
/** Set in the reviewer's environment, so a reviewer that loads the same plugin does not re-enter the hook. */
export const HARNESS_CHILD_ENV = 'PRISM_HARNESS_CHILD';
export const RETRY_NOTE = 'Your previous reply was not valid JSON. Return exactly one JSON object matching that schema and nothing else: no prose, no code fences.';

export type Scope = 'new-lines' | 'files' | 'branch';
export const SCOPES: Scope[] = ['new-lines', 'files', 'branch'];
export type HumanWhy = 'secret-committed' | 'tamper' | 'max-rounds' | 'reviewer-failed' | 'no-progress' | 'secrets-scan-failed';
export type HarnessEvent = 'stop' | 'pre-push' | 'manual' | 'mcp';

/** Paths whose change during a session ends the loop (section 6.2). */
export const TAMPER_GLOBS = [
  '.gitleaksignore', '.gitleaks.toml', '.prism/gitleaks-baseline.json',
  '.prism/config.json', '.prism/review/rules.md', '.prism/results/**', '.prism/harness/**',
  '.kiro/steering/code-review.md', '.github/workflows/prism-*.yml', '.prism/gitlab-workflows/**',
  '.claude/settings*.json', 'claude-plugin/hooks/**', '.cursor/hooks.json', '.codex/hooks.json', '.codex/config.toml', '.kiro/hooks/**',
];
/** Tamper globs are anchored at the repo root, unlike skip_paths. */
const TAMPER_RES = TAMPER_GLOBS.map((g) => new RegExp(`^${g.split('**').map((p) => p.split('*').map((s) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^/]*')).join('.*')}$`));
export const isTamperPath = (p: string) => TAMPER_RES.some((re) => re.test(p));

/** Files whose content is the scanner's own configuration: never copied into the scan. */
const SCANNER_CONFIG = new Set(['.gitleaks.toml', '.gitleaksignore', '.prism/gitleaks-baseline.json']);

export interface VerdictSecret { file: string; line: number | null; rule: string; committed: boolean }
export interface VerdictFinding extends Finding { introduced_in_session: boolean; blocking: boolean }

export interface HarnessVerdict {
  schema: typeof VERDICT_SCHEMA;
  version: typeof VERDICT_VERSION;
  verdict: Verdict;
  round: number;
  max_rounds: number;
  session: string | null;
  scope: Scope;
  diff: { files: number; added_lines: number; hash: string | null; cached: boolean };
  secrets_scanned: boolean;
  secrets: VerdictSecret[];
  block_on: BlockOn[];
  findings: VerdictFinding[];
  dropped: { out_of_scope: number; unknown_file: number };
  reasons: string[];
  next_action: string;
  human_needed: boolean;
  human_why: HumanWhy | null;
  warnings: string[];
  reviewer: { tool: string; model: string | null; attempts: number; wall_s: number; cost_usd: number | null } | null;
  result_path: string | null;
  fail_open: boolean;
}

export interface HarnessOptions {
  repoRoot: string;
  /** working (default) | staged (index vs HEAD) | since (<ref>...HEAD plus uncommitted). */
  mode?: 'working' | 'staged' | 'since';
  since?: string;
  session?: string | null;
  client?: string | null;
  scope?: Scope;
  maxRounds?: number;
  timeoutSeconds?: number;
  /** --no-review: gitleaks and the tamper check only. */
  noReview?: boolean;
  /** false when the push gate is off: the AI review is skipped, gitleaks still runs. */
  aiReview?: boolean;
  event?: HarnessEvent;
  /** PATH for reviewer detection (tests). */
  pathEnv?: string;
  gitleaksBin?: string;
  now?: () => Date;
}

const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const where = (f: { file: string; line: number | null }) => `${f.file}${f.line ? `:${f.line}` : ''}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function emptyVerdict(opts: { session: string | null; scope: Scope; maxRounds: number; blockOn: BlockOn[]; warnings: string[] }): HarnessVerdict {
  return {
    schema: VERDICT_SCHEMA, version: VERDICT_VERSION, verdict: 'pass', round: 1, max_rounds: opts.maxRounds,
    session: opts.session, scope: opts.scope, diff: { files: 0, added_lines: 0, hash: null, cached: false },
    secrets_scanned: false, secrets: [], block_on: opts.blockOn, findings: [], dropped: { out_of_scope: 0, unknown_file: 0 },
    reasons: [], next_action: '', human_needed: false, human_why: null, warnings: opts.warnings, reviewer: null, result_path: null, fail_open: false,
  };
}

/** The base to diff against for a branch-scope review: merge-base of HEAD with `since`, the upstream, or the remote default branch. */
function branchBase(repoRoot: string, since: string | undefined, warnings: string[]): string | null {
  const candidates: string[] = [];
  if (since) candidates.push(since);
  else {
    candidates.push('@{upstream}');
    const remote = gitIn(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    if (remote.ok && remote.stdout) candidates.push(remote.stdout);
  }
  for (const c of candidates) {
    if (c.startsWith('-')) continue;
    const sha = revParse(repoRoot, `${c}^{commit}`);
    if (!sha) { if (since) warnings.push(`--since ${since.slice(0, 100)} is not a commit git knows`); continue; }
    const mb = gitIn(repoRoot, ['merge-base', sha, 'HEAD']);
    if (mb.ok && mb.stdout) return mb.stdout;
  }
  return null;
}

function hashOf(parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) { h.update(p); h.update('\0'); }
  return `sha256:${h.digest('hex')}`;
}

/** Line `n` (1-based) of a buffer, without its newline. */
function lineOf(buf: Buffer | undefined, n: number): string | null {
  if (!buf) return null;
  const lines = buf.toString('utf8').split('\n');
  return n >= 1 && n <= lines.length ? lines[n - 1].replace(/\r$/, '') : null;
}

/** Fixed-template text for the agent. Never contains reviewer prose. */
function nextAction(v: HarnessVerdict): string {
  if (v.verdict === 'pass') return v.findings.length ? 'No blocking findings. The non-blocking findings are listed for information.' : 'No blocking findings.';
  if (v.verdict === 'stop') {
    switch (v.human_why) {
      case 'tamper': return 'Stop. This session changed PRISM, secret-scan or hook configuration. Tell the person which of those files you changed and why; do not undo or repeat the change to get past the check.';
      case 'secrets-scan-failed': return 'Stop. The secret scan ran but gave no verdict, so the push is held. Tell the person to check gitleaks and its config.';
      case 'max-rounds': return `Stop fixing: the ${plural(v.max_rounds, 'fix round')} for this session are used. Report the remaining blocking findings to the person${v.secrets.length ? ', and do not push while a secret remains' : ''}.`;
      case 'no-progress': return 'Stop: nothing changed since the last review. Report the remaining blocking findings to the person instead of trying again.';
      case 'secret-committed': return 'Stop. A secret is already in a commit. Tell the person: it must be rotated and the history cleaned; removing the line does not un-expose it.';
      default: return 'Stop and report the remaining findings to the person.';
    }
  }
  const parts: string[] = [];
  if (v.secrets.length) {
    parts.push(`Remove the secret${v.secrets.length > 1 ? 's' : ''} at ${v.secrets.slice(0, 5).map(where).join(', ')} and read the value from an environment variable or the project's secret store; if the project has an example env file, add a placeholder there. Do not add an allowlist entry or a gitleaks:allow comment.`);
    if (v.secrets.some((s) => s.committed)) parts.push('A secret is already in a commit: also tell the person it must be rotated, because removing the line does not un-expose it.');
  }
  const blocking = v.findings.filter((f) => f.blocking);
  if (blocking.length) parts.push(`${v.secrets.length ? 'Then fix' : 'Fix'} the blocking finding${blocking.length > 1 ? 's' : ''} at ${blocking.slice(0, 5).map(where).join(', ')}${blocking.length > 5 ? ` and ${blocking.length - 5} more` : ''}.`);
  parts.push('Do not commit or push.');
  return parts.join(' ');
}

function reasons(v: HarnessVerdict): string[] {
  const scope = v.scope === 'new-lines' ? 'in lines changed this session' : v.scope === 'files' ? 'in files changed this session' : 'in this branch\'s changes';
  const out: string[] = [];
  if (v.secrets.length) out.push(`${plural(v.secrets.length, 'secret')} ${scope}`);
  const c = { high: 0, medium: 0, low: 0 };
  for (const f of v.findings) if (f.blocking) c[f.severity]++;
  for (const s of ['high', 'medium'] as const) if (c[s]) out.push(`${plural(c[s], `${s} finding`)} ${scope}`);
  const info = v.findings.filter((f) => !f.blocking).length;
  if (info) out.push(`${plural(info, 'non-blocking finding')} (reported, not blocking)`);
  if (v.human_why) out.push(`human needed: ${v.human_why}`);
  return out;
}

/**
 * Runs one review. Throws only on an internal error (the CLI turns that into
 * exit 1, adapters into "no decision").
 */
export function runHarnessReview(opts: HarnessOptions): HarnessVerdict {
  const t0 = Date.now();
  const now = opts.now ?? (() => new Date());
  const started = now().toISOString();
  const repoRoot = opts.repoRoot;
  const warnings: string[] = [];
  const cfg: HarnessConfig = readHarnessConfig(repoRoot, warnings);
  const session = opts.session ?? null;
  let maxRounds = opts.maxRounds ?? cfg.max_rounds;
  if (maxRounds > 3) { warnings.push(`--max-rounds ${maxRounds} is above the ceiling of 3; using 3`); maxRounds = 3; }
  if (maxRounds < 1) maxRounds = 1;
  let scope: Scope = opts.scope ?? (session && opts.mode !== 'since' ? 'new-lines' : 'branch');
  const event: HarnessEvent = opts.event ?? 'manual';
  const base = { session, scope, maxRounds: session ? maxRounds : 1, blockOn: cfg.block_on, warnings };

  const head = revParse(repoRoot, 'HEAD^{commit}');
  if (!head) {
    warnings.push('no commit yet (no HEAD): nothing to diff, no review');
    const v = emptyVerdict(base);
    v.next_action = nextAction(v);
    return v;
  }

  try { ensureResultsExcluded(repoRoot); } catch { /* ignore */ }
  ensureHarnessDir(repoRoot);
  cleanupState(repoRoot, cfg.state_ttl_days);

  // ---- session state and baseline
  let state: SessionState | null = session ? loadState(repoRoot, session, warnings) : null;
  if (session && !state) {
    state = { version: STATE_VERSION, session, client: opts.client ?? null, started_at: started, head, baseline_tree: null, rounds: 0, last: null };
  }
  let sessionBase: string = head;
  if (state) {
    if (state.baseline_tree && objectExists(repoRoot, state.baseline_tree)) sessionBase = state.baseline_tree;
    else {
      if (state.baseline_tree) warnings.push('the session baseline snapshot is gone (git gc?); comparing against the commit the session started on');
      else warnings.push('no session baseline (the SessionStart hook did not run); uncommitted work from before the session counts as session work');
      sessionBase = state.head && objectExists(repoRoot, state.head) ? state.head : head;
    }
    if (state.head && scope === 'new-lines' && !gitIn(repoRoot, ['merge-base', '--is-ancestor', state.head, 'HEAD']).ok) {
      warnings.push('HEAD is no longer a descendant of the commit the session started on (branch switch or rebase); judging whole changed files this run');
      scope = 'files';
      base.scope = scope;
    }
  }

  // ---- diffs
  const current = opts.mode === 'staged' ? (gitIn(repoRoot, ['write-tree']).stdout || null) : snapshotTree(repoRoot);
  if (!current) throw new Error('could not snapshot the working tree');
  let reviewBase: string | null;
  let upstreamLabel: string | null = null;
  if (opts.mode === 'staged') reviewBase = head;
  else if (scope === 'branch' || opts.mode === 'since' || !state) {
    reviewBase = branchBase(repoRoot, opts.since, warnings);
    upstreamLabel = opts.since ?? '@{upstream}';
    if (!reviewBase) {
      warnings.push('no upstream or remote default branch to compare with; reviewing uncommitted changes only');
      reviewBase = head;
      upstreamLabel = null;
    }
  } else reviewBase = sessionBase;

  let diffText = diffTrees(repoRoot, reviewBase, current);
  if (diffText === null) throw new Error('git diff failed');
  const diff = parseDiff(diffText);
  const sessionDiff: ParsedDiff = state && reviewBase !== sessionBase && opts.mode !== 'staged'
    ? parseDiff(diffTrees(repoRoot, sessionBase, current) ?? '')
    : diff;

  const v = emptyVerdict(base);
  v.diff = { files: diff.files.length, added_lines: diff.addedLines, hash: null, cached: false };
  if (!diff.files.length) {
    v.secrets_scanned = true; // nothing to scan
    v.next_action = 'No changes to review.';
    if (state) { state.last = null; saveState(repoRoot, state); }
    return v;
  }

  // ---- tamper check (section 6.2): about what this session changed, so a
  // stateless run (no session, no fix rounds) has nothing to guard.
  const tamper = state ? touchedPaths(sessionDiff).filter(isTamperPath) : [];
  const allowMarkers = state ? sessionDiff.allowMarkers : [];

  // ---- gitleaks on the changed files (section 6.1)
  const scanPaths = diff.files.filter((f) => !f.deleted && f.added.size && !SCANNER_CONFIG.has(f.path)).map((f) => f.path);
  const blobs = readBlobs(repoRoot, current, scanPaths);
  const scan: FileScan = scanFiles(repoRoot, [...blobs].map(([path, content]) => ({ path, content })), opts.gitleaksBin);
  const addedIn = new Map(diff.files.map((f) => [f.path, f.added]));
  if (scan.status === 'missing') warnings.push(`secrets not scanned: ${scan.reason}. Install it: ${gitleaksInstallHint()}`);
  if (scan.status === 'error') warnings.push(`secrets not scanned: ${scan.reason}`);
  v.secrets_scanned = scan.status === 'ok' || scan.status === 'findings';
  const secretFindings = scan.findings.filter((f) => f.line !== null && addedIn.get(f.file)?.has(f.line));
  const headBlobs = secretFindings.length ? readBlobs(repoRoot, head, [...new Set(secretFindings.map((f) => f.file))]) : new Map<string, Buffer>();
  v.secrets = secretFindings.map((f) => {
    const text = lineOf(blobs.get(f.file), f.line!);
    const headLines = headBlobs.get(f.file)?.toString('utf8').split('\n').map((l) => l.replace(/\r$/, ''));
    return { file: f.file, line: f.line, rule: f.rule, committed: !!(text && text.trim() && headLines?.includes(text)) };
  });

  // ---- AI review (section 2.4 step 5)
  const docsOnly = diff.files.every((f) => matchesAny(f.path, cfg.skip_paths));
  const evalCfg = readEvalConfig(repoRoot);
  const choice = resolveReviewer({
    gitConfigValue: gitIn(repoRoot, ['config', '--get', REVIEWER_GIT_CONFIG_KEY]).stdout || null,
    prismConfigValue: evalCfg.reviewer,
    available: detectReviewers(opts.pathEnv ?? process.env.PATH),
  });
  const adapter = choice.id ? ADAPTERS[choice.id] : null;
  const modelChoice = resolveReviewModel({
    reviewer: adapter?.id ?? null, prismConfigValue: evalCfg.model, prismConfigReviewer: evalCfg.reviewer,
    gitConfigValue: adapter ? gitIn(repoRoot, ['config', '--get', reviewModelGitKey(adapter.id)]).stdout || null : null,
  });
  const rules = loadReviewRules(repoRoot);
  let truncated = false;
  if (diffText.length > MAX_HARNESS_DIFF_CHARS) { diffText = diffText.slice(0, MAX_HARNESS_DIFF_CHARS); truncated = true; }
  const hash = hashOf([diffText, hashOf([rules.rulesText]), adapter?.id ?? 'none', modelChoice.model ?? 'default', scope]);
  v.diff.hash = hash;

  const skipWhy = opts.noReview ? 'review off (--no-review)'
    : opts.aiReview === false ? 'review off (push gate disabled)'
    : tamper.length || allowMarkers.length ? 'review skipped (tamper)'
    : v.secrets.length ? 'review skipped: a secret was found; the diff is not sent to a reviewer'
    : scan.status === 'error' && event === 'pre-push' ? 'review skipped (secret scan failed)'
    : docsOnly ? 'review skipped: docs-only change' : null;

  let findings: Finding[] = [];
  let summary: string | null = null;
  let score: number | null = null;
  let failOpen = false;
  let reviewerFailed = false;
  if (!skipWhy) {
    if (!adapter) {
      warnings.push(`AI review did not run: ${choice.note}. Install kiro-cli or Claude Code to get reviews; gitleaks still ran`);
    } else {
      if (choice.note) warnings.push(choice.note);
      if (modelChoice.note) warnings.push(modelChoice.note);
      if (rules.note) warnings.push(rules.note);
      if (truncated) warnings.push(`diff truncated to ${MAX_HARNESS_DIFF_CHARS} characters for the review; findings in the rest are not seen`);
      const cached = readCache(repoRoot, hash);
      const rt0 = Date.now();
      let attempts = 0;
      let cost: number | null = null;
      let model = modelChoice.model;
      if (cached) {
        findings = normalizeReview({ findings: cached.findings }, null).findings;
        summary = typeof cached.summary === 'string' ? cached.summary.slice(0, 500) : null;
        score = typeof cached.score === 'number' ? cached.score : null;
        model = typeof cached.model === 'string' ? cached.model : model;
        v.diff.cached = true;
      } else {
        const bin = findOnPath(adapter.binary, opts.pathEnv ?? process.env.PATH) || adapter.binary;
        const timeoutS = opts.timeoutSeconds ?? cfg.timeout_seconds;
        const tmp = mkdtempSync(join(tmpdir(), 'prism-harness-review-'));
        const savedChild = process.env[HARNESS_CHILD_ENV];
        process.env[HARNESS_CHILD_ENV] = '1';
        try {
          const diffPath = join(tmp, 'session.diff');
          writeFileSync(diffPath, diffText, { mode: 0o600 });
          const req = { repoRoot, rulesPath: rules.rulesPath, rulesText: rules.rulesText, diffPath, diff: diffText, model: model || undefined };
          let res: ReviewRun = runReview(adapter, req, timeoutS * 1000, bin);
          attempts = 1;
          if (!res.ok && res.unparseable) {
            res = runReview(adapter, { ...req, retryNote: RETRY_NOTE }, timeoutS * 1000, bin);
            attempts = 2;
          }
          if (res.ok && res.review) {
            findings = res.review.findings;
            summary = res.review.summary;
            score = res.review.score;
            model = res.review.model || model;
            cost = res.review.cost_usd ?? null;
            writeCache(repoRoot, { hash, tool: adapter.id, model, findings, summary, score });
          } else {
            failOpen = true;
            reviewerFailed = true;
            warnings.push(`AI review failed open after ${plural(attempts, 'attempt')} (${String(res.error).slice(0, 300)}); the git pre-push review and the CI gate still run`);
          }
        } finally {
          if (savedChild === undefined) delete process.env[HARNESS_CHILD_ENV]; else process.env[HARNESS_CHILD_ENV] = savedChild;
          rmSync(tmp, { recursive: true, force: true });
        }
      }
      v.reviewer = { tool: adapter.id, model: model ?? modelLabel(adapter.id, null), attempts, wall_s: Math.round((Date.now() - rt0) / 100) / 10, cost_usd: cost };
    }
  } else if (skipWhy !== 'review skipped: docs-only change') {
    // Docs-only skips are routine; the rest are worth saying.
    if (!skipWhy.startsWith('review skipped (tamper)')) warnings.push(skipWhy);
  }

  // ---- scope filter (section 4.2)
  const inDiff = new Set(diff.files.map((f) => f.path));
  for (const f of findings) {
    const file = f.file.replace(/^\.\//, '').replace(/^[ab]\//, '');
    if (!inDiff.has(file)) { v.dropped.unknown_file++; continue; }
    const added = addedIn.get(file)!;
    const introduced = f.line !== null && added.has(f.line);
    if (scope === 'new-lines' && f.line !== null && !introduced) { v.dropped.out_of_scope++; continue; }
    const blocking = (f.severity === 'high' && cfg.block_on.includes('high')) || (f.severity === 'medium' && cfg.block_on.includes('medium'));
    v.findings.push({ ...f, file, introduced_in_session: scope === 'new-lines' ? true : introduced, blocking });
  }
  v.findings.sort((a, b) => Number(b.blocking) - Number(a.blocking) || SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));

  // ---- verdict and round rules (sections 3 and 5)
  let verdict: Verdict = 'pass';
  let why: HumanWhy | null = null;
  if (tamper.length || allowMarkers.length) {
    verdict = 'stop'; why = 'tamper';
    const hits = [...tamper, ...allowMarkers.map((m) => `${m.file}:${m.line} (gitleaks:allow)`)];
    warnings.push(`tamper: this session changed ${hits.slice(0, 10).join(', ')}`);
  } else if (scan.status === 'error' && event === 'pre-push') {
    verdict = 'stop'; why = 'secrets-scan-failed';
  } else if (v.secrets.length || v.findings.some((f) => f.blocking)) {
    verdict = 'fix';
  }
  const committed = v.secrets.some((s) => s.committed);

  let round = 1;
  if (state) {
    const last = state.last;
    round = Math.min(state.rounds + 1, maxRounds + 1);
    if (verdict === 'fix') {
      if (last && last.hash === hash && last.verdict === 'stop') { verdict = 'stop'; why = (last.human_why as HumanWhy) ?? 'no-progress'; }
      else if (state.rounds >= maxRounds) { verdict = 'stop'; why = 'max-rounds'; }
      else if (last && last.hash === hash && last.verdict === 'fix') { verdict = 'stop'; why = 'no-progress'; }
      else { state.rounds++; round = state.rounds; }
    }
    state.last = { hash, verdict, human_why: why, at: started };
  }
  if (committed && why !== 'tamper') why = 'secret-committed';
  if (!why && reviewerFailed) why = 'reviewer-failed';

  v.verdict = verdict;
  v.round = round;
  v.human_why = why;
  v.human_needed = why !== null;
  v.fail_open = failOpen;
  v.next_action = nextAction(v);
  v.reasons = reasons(v);

  // ---- persist: state, then the result file (section 11.1)
  if (state) { try { saveState(repoRoot, state); } catch (e: any) { warnings.push(`could not save the session state (${String(e?.message || e).slice(0, 200)})`); } }
  const secretAsFindings: Finding[] = v.secrets.map((s) => ({ severity: 'high', category: 'security', rule: s.rule, file: s.file, line: s.line, message: 'Secret detected (value redacted)' }));
  const blockingN = v.findings.filter((f) => f.blocking).length;
  const branch = gitIn(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout || null;
  const result = makeResult({
    kind: 'agent-harness', hook: 'agent',
    status: v.secrets.length || v.findings.length ? 'findings' : failOpen ? 'error' : 'ok',
    tool: v.reviewer?.tool ?? (scan.version ? 'gitleaks' : 'none'), tool_version: adapter && v.reviewer && !v.diff.cached ? toolVersion(findOnPath(adapter.binary, opts.pathEnv ?? process.env.PATH) || adapter.binary) : scan.version,
    model: v.reviewer?.model ?? null, commit: head, tree: current, branch, upstream: upstreamLabel, base: reviewBase,
    started_at: started, finished_at: now().toISOString(),
    findings: [...secretAsFindings, ...v.findings.map(({ introduced_in_session: _i, blocking: _b, ...f }) => f)],
    summary, score, reason: warnings.length ? warnings.join('; ').slice(0, 2000) : null,
    harness: {
      client: opts.client ?? null, event, session, verdict, round, max_rounds: v.max_rounds, scope,
      secrets: v.secrets.length, dropped_out_of_scope: v.dropped.out_of_scope, cached: v.diff.cached,
      human_needed: v.human_needed, human_why: why, fail_open: failOpen, secrets_scanned: v.secrets_scanned,
      block_on: cfg.block_on, blocking_findings: blockingN + v.secrets.length, nonblocking_findings: v.findings.length - blockingN,
      wall_s: Math.round((Date.now() - t0) / 100) / 10, cost_usd: v.reviewer?.cost_usd ?? null,
    },
  });
  const written = safeWrite(repoRoot, result);
  v.result_path = written ? relative(repoRoot, written) : null;
  return v;
}

/** CLI exit code for a verdict: 0 pass, 3 fix, 4 stop (exit 2 is avoided on purpose, section 3). */
export function exitCodeFor(v: HarnessVerdict): number {
  return v.verdict === 'pass' ? 0 : v.verdict === 'fix' ? 3 : 4;
}
