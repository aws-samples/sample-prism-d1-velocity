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
import { HARNESS_MAX_ROUNDS_CEILING, modelLabel, readEvalConfig, readHarnessConfig, resolveReviewModel, reviewModelGitKey, REVIEWER_GIT_CONFIG_KEY, type BlockOn, type HarnessConfig } from '../config.js';
import { gitleaksInstallHint, safeWrite, scanCommits, scanFiles, type CommitScan, type CommitSecret, type FileScan, type ScannerConfigOverride } from '../gitleaks.js';
import { ensureResultsExcluded, makeResult, type Finding, type Severity } from '../results.js';
import { ADAPTERS, detectReviewers, findOnPath, normalizeReview, resolveReviewer, runReview, toolVersion, type ReviewerAdapter, type ReviewRequest, type ReviewRun } from '../reviewers/index.js';
import { fallbackPushBase, type PushBase } from '../pushbase.js';
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
export type HumanWhy = 'secret-committed' | 'tamper' | 'max-rounds' | 'reviewer-failed' | 'no-progress' | 'secrets-scan-failed' | 'push-unknown';
export type HarnessEvent = 'stop' | 'pre-push' | 'manual' | 'mcp';

/** One `git push` as the adapter read it from the command line. */
export interface PushTarget {
  /** The remote named on the command line, or null for the default. */
  remote: string | null;
  /** The source of the refspec (`HEAD`, a branch, a sha), or null for the current branch. */
  src: string | null;
  /** The branch it writes to on the remote, or null when not given. */
  dst: string | null;
  /** Set when the command's push target cannot be determined (`--all`, several refspecs, a glob): the push is held. */
  unknown: string | null;
}

/** Paths whose change during a session ends the loop (section 6.2). `.prism/results/**` and
 * `.prism/harness/**` are on the design's list but never appear here: every diff and snapshot
 * excludes PRISM's own output, so an edit to them is never seen (the section 6.2 non-goal). */
export const TAMPER_GLOBS = [
  '.gitleaksignore', '.gitleaks.toml', '.prism/gitleaks-baseline.json',
  '.prism/config.json', '.prism/review/rules.md',
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
  /**
   * Branch scope: secrets gitleaks found in a commit of the reviewed range,
   * even if a later commit removed them. Any entry makes the verdict `stop`
   * (`secret-committed`): the commit itself would leave with the push.
   */
  commit_secrets: CommitSecret[];
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
  /** pre-push: what the agent's `git push` command writes (parsed by the adapter). */
  push?: PushTarget;
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
    secrets_scanned: false, secrets: [], commit_secrets: [], block_on: opts.blockOn, findings: [], dropped: { out_of_scope: 0, unknown_file: 0 },
    reasons: [], next_action: '', human_needed: false, human_why: null, warnings: opts.warnings, reviewer: null, result_path: null, fail_open: false,
  };
}

/**
 * The base a branch-scope review compares the tip with: `since` when given, the
 * upstream, then what the push writes to and the shared fallback chain
 * (pushbase.ts), down to the commits on no remote and, on a first push, the
 * empty tree. Never "HEAD": that would review only uncommitted work while
 * commits leave the machine. Null only when git itself fails.
 */
function branchBase(repoRoot: string, tip: string, since: string | undefined, push: PushTarget | undefined, warnings: string[]): PushBase | null {
  const merge = (ref: string, label: string): PushBase | null => {
    const sha = revParse(repoRoot, `${ref}^{commit}`);
    if (!sha) return null;
    const mb = gitIn(repoRoot, ['merge-base', sha, tip]);
    return mb.ok && mb.stdout ? { base: mb.stdout, label, emptyTree: false, note: null } : null;
  };
  if (since && !since.startsWith('-')) {
    const b = merge(since, since);
    if (b) return b;
    warnings.push(`--since ${since.slice(0, 100)} is not a commit git knows; using the upstream or remote branch instead`);
  }
  const up = merge('@{upstream}', '@{upstream}');
  if (up) return up;
  const branch = gitIn(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout || null;
  const b = fallbackPushBase(repoRoot, { remote: push?.remote, dst: push?.dst, branch, tip });
  if (b?.note) warnings.push(b.note);
  return b;
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

/** Up to five items, then "and N more", the way the secrets list is capped. */
const listFive = (items: string[]) => `${items.slice(0, 5).join(', ')}${items.length > 5 ? ` and ${items.length - 5} more` : ''}`;
/** A path from the diff, quoted so a file name cannot read as an instruction. */
const quotePath = (p: string) => JSON.stringify(p.length > 200 ? `${p.slice(0, 200)}...` : p);

/** The tamper stop text, naming what tripped it: the guarded files changed, and any gitleaks:allow markers added. */
function tamperAction(integ: Integrity, session: boolean): string {
  const parts: string[] = [];
  if (integ.tamper.length) parts.push(`${session ? 'This session changed' : 'This change edits'} PRISM, secret-scan or hook configuration: ${listFive(integ.tamper.map(quotePath))}.`);
  if (integ.allowMarkers.length) parts.push(`${session ? 'This session added' : 'This change adds'} a gitleaks:allow marker at ${listFive(integ.allowMarkers.map((m) => quotePath(`${m.file}:${m.line}`)))}.`);
  return `Stop. ${parts.join(' ')} Tell the person what you changed there and why; do not undo or repeat the change to get past the check.`;
}

/** The stop text for a secret in a commit of the range: which commit, why a new commit does not help, what the person does. */
function committedAction(hits: CommitSecret[], base: string | undefined): string {
  const commits = [...new Set(hits.map((h) => h.commit.slice(0, 12)))];
  const where = listFive(hits.map((h) => quotePath(`${h.file}:${h.line ?? '?'}`)));
  const onto = base && /^[0-9a-f]{40,64}$/.test(base) ? ` (for example git rebase -i ${base.slice(0, 12)}, or a reset onto ${base.slice(0, 12)} and a new commit without the secret)` : ' (for example an interactive rebase onto the base, or a reset onto it and a new commit without the secret)';
  return `Stop. A secret is in commit ${listFive(commits)} at ${where}, which this push would send. Removing it in a new commit does not help: the earlier commit still carries the value. Do not push. Tell the person: they must rotate the key, then rewrite the unpushed history so no commit holds it${onto} before pushing. Offer to do the history rewrite only if the person asks.`;
}

/** Fixed-template text for the agent. Never contains reviewer prose. */
function nextAction(v: HarnessVerdict, integ?: Integrity, base?: string): string {
  if (v.verdict === 'pass') return v.findings.length ? 'No blocking findings. The non-blocking findings are listed for information.' : 'No blocking findings.';
  if (v.verdict === 'stop') {
    switch (v.human_why) {
      case 'tamper': return integ && (integ.tamper.length || integ.allowMarkers.length)
        ? tamperAction(integ, v.session !== null)
        : 'Stop. This change touched PRISM, secret-scan or hook configuration. Tell the person what you changed there and why; do not undo or repeat the change to get past the check.';
      case 'secrets-scan-failed': return 'Stop. The secret scan ran but gave no verdict, so the push is held. Tell the person to check gitleaks and its config.';
      case 'push-unknown': return 'Stop. PRISM could not tell which commits this push would send, so it is held. Push one branch at a time with an explicit remote and branch (git push origin <branch>), or tell the person why it was held.';
      case 'max-rounds': return `Stop fixing: the ${plural(v.max_rounds, 'fix round')} for this session are used. Report the remaining blocking findings to the person${v.secrets.length ? ', and do not push while a secret remains' : ''}.`;
      case 'no-progress': return 'Stop: nothing changed since the last review. Report the remaining blocking findings to the person instead of trying again.';
      case 'secret-committed': return v.commit_secrets.length
        ? committedAction(v.commit_secrets, base)
        : 'Stop. A secret is already in a commit. Tell the person: it must be rotated and the history cleaned; removing the line does not un-expose it.';
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
  if (v.commit_secrets.length) out.push(`${plural(v.commit_secrets.length, 'secret')} in commits this push would send (commit ${[...new Set(v.commit_secrets.map((c) => c.commit.slice(0, 12)))].slice(0, 5).join(', ')})`);
  const c = { high: 0, medium: 0, low: 0 };
  for (const f of v.findings) if (f.blocking) c[f.severity]++;
  for (const s of ['high', 'medium'] as const) if (c[s]) out.push(`${plural(c[s], `${s} finding`)} ${scope}`);
  const info = v.findings.filter((f) => !f.blocking).length;
  if (info) out.push(`${plural(info, 'non-blocking finding')} (reported, not blocking)`);
  if (v.human_why) out.push(`human needed: ${v.human_why}`);
  return out;
}

/** Everything one run shares; built once in runHarnessReview. */
interface Run {
  opts: HarnessOptions;
  repoRoot: string;
  cfg: HarnessConfig;
  warnings: string[];
  session: string | null;
  maxRounds: number;
  scope: Scope;
  event: HarnessEvent;
  started: string;
  t0: number;
  now: () => Date;
  head: string;
  pathEnv: string | undefined;
}

interface Diffs {
  state: SessionState | null;
  /** The commit being reviewed: HEAD, or the source of a push of another ref. */
  tip: string;
  current: string;
  reviewBase: string;
  upstreamLabel: string | null;
  diffText: string;
  diff: ParsedDiff;
  /** What this session changed (baseline to now); the same as `diff` without a session. */
  sessionDiff: ParsedDiff;
}

interface Integrity { tamper: string[]; allowMarkers: ParsedDiff['allowMarkers'] }

interface SecretScan { scan: FileScan; secrets: VerdictSecret[]; history: CommitScan | null }

interface ReviewOutcome {
  findings: Finding[];
  summary: string | null;
  score: number | null;
  hash: string;
  cached: boolean;
  failOpen: boolean;
  reviewer: HarnessVerdict['reviewer'];
  toolVersion: string | null;
}

/** Loads the session state and picks the session's baseline; may narrow the scope to `files`. */
function loadSession(r: Run): { state: SessionState | null; sessionBase: string } {
  const { repoRoot, session, head, warnings } = r;
  let state: SessionState | null = session ? loadState(repoRoot, session, warnings) : null;
  if (session && !state) {
    state = { version: STATE_VERSION, session, client: r.opts.client ?? null, started_at: r.started, head, baseline_tree: null, rounds: 0, last: null };
  }
  if (!state) return { state, sessionBase: head };
  let sessionBase = head;
  if (state.baseline_tree && objectExists(repoRoot, state.baseline_tree)) sessionBase = state.baseline_tree;
  else {
    if (state.baseline_tree) warnings.push('the session baseline snapshot is gone (git gc?); comparing against the commit the session started on');
    else warnings.push('no session baseline (the SessionStart hook did not run); uncommitted work from before the session counts as session work');
    sessionBase = state.head && objectExists(repoRoot, state.head) ? state.head : head;
  }
  if (state.head && r.scope === 'new-lines' && !gitIn(repoRoot, ['merge-base', '--is-ancestor', state.head, 'HEAD']).ok) {
    warnings.push('HEAD is no longer a descendant of the commit the session started on (branch switch or rebase); judging whole changed files this run');
    r.scope = 'files';
  }
  return { state, sessionBase };
}

/** The current tree, the base it is compared with, and the review and session diffs; or why the push target is unknown. */
function resolveDiffs(r: Run): Diffs | { unknown: string } {
  const { repoRoot, opts, warnings, head } = r;
  const push = opts.push;
  if (push?.unknown) return { unknown: push.unknown };
  const { state, sessionBase } = loadSession(r);
  // A push of something other than HEAD (`git push origin other:main`) reviews that commit's tree.
  let tip = head;
  let current: string | null = null;
  if (push?.src && push.src !== 'HEAD') {
    // A source git cannot resolve makes git refuse the push; HEAD is reviewed instead.
    const src = revParse(repoRoot, `${push.src}^{commit}`);
    if (src && src !== head) {
      tip = src;
      current = revParse(repoRoot, `${src}^{tree}`);
    }
  }
  if (!current) current = opts.mode === 'staged' ? (gitIn(repoRoot, ['write-tree']).stdout || null) : snapshotTree(repoRoot, warnings);
  if (!current) throw new Error('could not snapshot the working tree');
  let reviewBase: string;
  let upstreamLabel: string | null = null;
  if (opts.mode === 'staged') reviewBase = head;
  else if (r.scope === 'branch' || opts.mode === 'since' || !state || tip !== head) {
    const b = branchBase(repoRoot, tip, opts.since, push, warnings);
    if (!b) {
      if (r.event === 'pre-push') return { unknown: 'git could not tell which commits this push carries' };
      warnings.push('git could not tell which commits are on a remote; reviewing uncommitted changes only');
      reviewBase = head;
    } else {
      reviewBase = b.base;
      upstreamLabel = b.label;
    }
  } else reviewBase = sessionBase;

  const diffText = diffTrees(repoRoot, reviewBase, current);
  if (diffText === null) throw new Error('git diff failed');
  const diff = parseDiff(diffText);
  const sessionDiff = state && reviewBase !== sessionBase && opts.mode !== 'staged'
    ? parseDiff(diffTrees(repoRoot, sessionBase, current) ?? '')
    : diff;
  return { state, tip, current, reviewBase, upstreamLabel, diffText, diff, sessionDiff };
}

/**
 * Tamper rules (section 6.2). With a session: any listed path the session
 * changed, and any `gitleaks:allow` it added. Without one there are no fix
 * rounds to guard and a branch may legitimately tune its own config, so only
 * added `gitleaks:allow` lines count; the scanner config is handled by
 * scanning with the base's copy instead (scannerOverride).
 */
function integrityChecks(d: Diffs): Integrity {
  if (d.state) return { tamper: touchedPaths(d.sessionDiff).filter(isTamperPath), allowMarkers: d.sessionDiff.allowMarkers };
  return { tamper: [], allowMarkers: d.diff.allowMarkers };
}

/**
 * Stateless runs: when the diff changes the scanner's own config, scan with
 * the base's version of it, so a change cannot allowlist itself.
 */
function scannerOverride(r: Run, d: Diffs): ScannerConfigOverride | undefined {
  if (d.state) return undefined;
  const changed = touchedPaths(d.diff).filter((p) => SCANNER_CONFIG.has(p));
  if (!changed.length) return undefined;
  const blobs = readBlobs(r.repoRoot, d.reviewBase, [...SCANNER_CONFIG]);
  r.warnings.push(`this change edits ${changed.join(', ')}; secrets were scanned with the base's version of the gitleaks config`);
  return {
    config: blobs.get('.gitleaks.toml') ?? null,
    ignore: blobs.get('.gitleaksignore') ?? null,
    baseline: blobs.get('.prism/gitleaks-baseline.json') ?? null,
  };
}

/** gitleaks on the changed files, filtered to added lines (section 6.1), and in branch scope on every commit of the range. */
function secretScan(r: Run, d: Diffs): SecretScan {
  const { repoRoot, warnings, opts } = r;
  const override = scannerOverride(r, d);
  const scanPaths = d.diff.files.filter((f) => !f.deleted && f.added.size && !SCANNER_CONFIG.has(f.path)).map((f) => f.path);
  const blobs = readBlobs(repoRoot, d.current, scanPaths);
  const scan = scanFiles(repoRoot, [...blobs].map(([path, content]) => ({ path, content })), opts.gitleaksBin, { override });
  if (scan.status === 'missing') warnings.push(`secrets not scanned: ${scan.reason}. Install it: ${gitleaksInstallHint()}`);
  if (scan.status === 'error') warnings.push(`secrets not scanned: ${scan.reason}`);
  if (scan.skipped.length) warnings.push(`secrets not scanned in ${scan.skipped.length} file(s) with an unsafe path: ${scan.skipped.slice(0, 5).map((p) => JSON.stringify(p.slice(0, 200))).join(', ')}`);
  const addedIn = new Map(d.diff.files.map((f) => [f.path, f.added]));
  const hits = scan.findings.filter((f) => f.line !== null && addedIn.get(f.file)?.has(f.line));
  const headBlobs = hits.length ? readBlobs(repoRoot, d.tip, [...new Set(hits.map((f) => f.file))]) : new Map<string, Buffer>();
  const secrets = hits.map((f) => {
    const text = lineOf(blobs.get(f.file), f.line!);
    const headLines = headBlobs.get(f.file)?.toString('utf8').split('\n').map((l) => l.replace(/\r$/, ''));
    return { file: f.file, line: f.line, rule: f.rule, committed: !!(text && text.trim() && headLines?.includes(text)) };
  });
  return { scan, secrets, history: commitScan(r, d, override) };
}

/**
 * Branch scope: every commit the range carries, scanned one by one. The tree
 * diff alone misses a secret one commit adds and a later one removes, yet that
 * commit still leaves with the push (section 6.1, "push stays blocked").
 */
function commitScan(r: Run, d: Diffs, override: ScannerConfigOverride | undefined): CommitScan | null {
  if (r.scope !== 'branch' || r.opts.mode === 'staged') return null;
  // A commit base gives `base..tip`; the empty tree (a first push) means the tip's whole history.
  const range = revParse(r.repoRoot, `${d.reviewBase}^{commit}`) ? `${d.reviewBase}..${d.tip}` : d.tip;
  const count = gitIn(r.repoRoot, ['rev-list', '--count', range]);
  if (!count.ok || count.stdout === '0') return null;
  const h = scanCommits(r.repoRoot, range, r.opts.gitleaksBin, { override });
  if (h.status === 'error') r.warnings.push(`commits not scanned for secrets: ${h.reason}`);
  return h;
}

/** Runs the reviewer once, plus one retry when the reply cannot be parsed. */
function callReviewer(r: Run, adapter: ReviewerAdapter, req: ReviewRequest): { res: ReviewRun; attempts: number } {
  const bin = findOnPath(adapter.binary, r.pathEnv) || adapter.binary;
  const timeoutMs = (r.opts.timeoutSeconds ?? r.cfg.timeout_seconds) * 1000;
  const childEnv = { [HARNESS_CHILD_ENV]: '1' };
  const res = runReview(adapter, req, timeoutMs, bin, childEnv);
  if (res.ok || !res.unparseable) return { res, attempts: 1 };
  return { res: runReview(adapter, { ...req, retryNote: RETRY_NOTE }, timeoutMs, bin, childEnv), attempts: 2 };
}

/** The AI review (section 2.4 step 5), from the cache when the diff hash was seen. `skipWhy` set: no reviewer call. */
function aiReview(r: Run, d: Diffs, skipWhy: string | null): ReviewOutcome {
  const { repoRoot, warnings } = r;
  const evalCfg = readEvalConfig(repoRoot);
  const choice = resolveReviewer({
    gitConfigValue: gitIn(repoRoot, ['config', '--get', REVIEWER_GIT_CONFIG_KEY]).stdout || null,
    prismConfigValue: evalCfg.reviewer,
    available: detectReviewers(r.pathEnv),
  });
  const adapter = choice.id ? ADAPTERS[choice.id] : null;
  const modelChoice = resolveReviewModel({
    reviewer: adapter?.id ?? null, prismConfigValue: evalCfg.model, prismConfigReviewer: evalCfg.reviewer,
    gitConfigValue: adapter ? gitIn(repoRoot, ['config', '--get', reviewModelGitKey(adapter.id)]).stdout || null : null,
  });
  const rules = loadReviewRules(repoRoot);
  const truncated = d.diffText.length > MAX_HARNESS_DIFF_CHARS;
  const diffText = truncated ? d.diffText.slice(0, MAX_HARNESS_DIFF_CHARS) : d.diffText;
  const hash = hashOf([diffText, hashOf([rules.rulesText]), adapter?.id ?? 'none', modelChoice.model ?? 'default', r.scope]);
  const out: ReviewOutcome = { findings: [], summary: null, score: null, hash, cached: false, failOpen: false, reviewer: null, toolVersion: null };

  if (skipWhy) {
    // Docs-only and tamper skips are routine or reported elsewhere; the rest are worth saying.
    if (skipWhy !== SKIP_DOCS && skipWhy !== SKIP_TAMPER) warnings.push(skipWhy);
    return out;
  }
  if (!adapter) {
    warnings.push(`AI review did not run: ${choice.note}. Install kiro-cli or Claude Code to get reviews; gitleaks still ran`);
    return out;
  }
  for (const n of [choice.note, modelChoice.note, rules.note]) if (n) warnings.push(n);
  if (truncated) warnings.push(`diff truncated to ${MAX_HARNESS_DIFF_CHARS} characters for the review; findings in the rest are not seen`);

  const rt0 = Date.now();
  let model = modelChoice.model;
  let attempts = 0;
  let cost: number | null = null;
  const cached = readCache(repoRoot, hash);
  if (cached) {
    out.findings = normalizeReview({ findings: cached.findings }, null).findings;
    out.summary = typeof cached.summary === 'string' ? cached.summary.slice(0, 500) : null;
    out.score = typeof cached.score === 'number' ? cached.score : null;
    model = typeof cached.model === 'string' ? cached.model : model;
    out.cached = true;
  } else {
    const tmp = mkdtempSync(join(tmpdir(), 'prism-harness-review-'));
    try {
      const diffPath = join(tmp, 'session.diff');
      writeFileSync(diffPath, diffText, { mode: 0o600 });
      const call = callReviewer(r, adapter, { repoRoot, rulesPath: rules.rulesPath, rulesText: rules.rulesText, diffPath, diff: diffText, model: model || undefined });
      attempts = call.attempts;
      if (call.res.ok && call.res.review) {
        const rv = call.res.review;
        Object.assign(out, { findings: rv.findings, summary: rv.summary, score: rv.score });
        model = rv.model || model;
        cost = rv.cost_usd ?? null;
        writeCache(repoRoot, { hash, tool: adapter.id, model, findings: rv.findings, summary: rv.summary, score: rv.score });
      } else {
        out.failOpen = true;
        warnings.push(`AI review failed open after ${plural(attempts, 'attempt')} (${String(call.res.error).slice(0, 300)}); the git pre-push review and the CI gate still run`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    out.toolVersion = toolVersion(findOnPath(adapter.binary, r.pathEnv) || adapter.binary);
  }
  out.reviewer = { tool: adapter.id, model: model ?? modelLabel(adapter.id, null), attempts, wall_s: Math.round((Date.now() - rt0) / 100) / 10, cost_usd: cost };
  return out;
}

const SKIP_DOCS = 'review skipped: docs-only change';
const SKIP_TAMPER = 'review skipped (tamper)';

function skipReason(r: Run, d: Diffs, integ: Integrity, sec: SecretScan): string | null {
  if (r.opts.noReview) return 'review off (--no-review)';
  if (r.opts.aiReview === false) return 'review off (push gate disabled)';
  if (integ.tamper.length || integ.allowMarkers.length) return SKIP_TAMPER;
  if (sec.secrets.length || sec.history?.findings.length) return 'review skipped: a secret was found; the diff is not sent to a reviewer';
  if ((sec.scan.status === 'error' || sec.history?.status === 'error') && r.event === 'pre-push') return 'review skipped (secret scan failed)';
  if (d.diff.files.every((f) => matchesAny(f.path, r.cfg.skip_paths))) return SKIP_DOCS;
  return null;
}

/** Keeps findings in scope (section 4.2), marks the blocking ones (D3) and sorts them. */
function scopeFindings(r: Run, d: Diffs, findings: Finding[], v: HarnessVerdict): void {
  const addedIn = new Map(d.diff.files.map((f) => [f.path, f.added]));
  for (const f of findings) {
    const file = f.file.replace(/^\.\//, '').replace(/^[ab]\//, '');
    const added = addedIn.get(file);
    if (!added) { v.dropped.unknown_file++; continue; }
    const introduced = f.line !== null && added.has(f.line);
    if (r.scope === 'new-lines' && f.line !== null && !introduced) { v.dropped.out_of_scope++; continue; }
    const blocking = (f.severity === 'high' && r.cfg.block_on.includes('high')) || (f.severity === 'medium' && r.cfg.block_on.includes('medium'));
    v.findings.push({ ...f, file, introduced_in_session: r.scope === 'new-lines' ? true : introduced, blocking });
  }
  v.findings.sort((a, b) => Number(b.blocking) - Number(a.blocking) || SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
}

/** Verdict and round rules (sections 3 and 5). Updates `state.last` and the round counter. */
function decide(r: Run, v: HarnessVerdict, state: SessionState | null, integ: Integrity, sec: SecretScan, rev: ReviewOutcome, base?: string): void {
  let verdict: Verdict = 'pass';
  let why: HumanWhy | null = null;
  if (integ.tamper.length || integ.allowMarkers.length) {
    verdict = 'stop'; why = 'tamper';
    const hits = [...integ.tamper, ...integ.allowMarkers.map((m) => `${m.file}:${m.line} (gitleaks:allow)`)];
    r.warnings.push(`tamper: ${state ? 'this session changed' : 'this change adds'} ${hits.slice(0, 10).join(', ')}`);
  } else if (v.commit_secrets.length) {
    // Recomputed from the range every run, so no later pass clears it while the commit is in the range.
    verdict = 'stop'; why = 'secret-committed';
  } else if ((sec.scan.status === 'error' || sec.history?.status === 'error') && r.event === 'pre-push') {
    verdict = 'stop'; why = 'secrets-scan-failed';
  } else if (v.secrets.length || v.findings.some((f) => f.blocking)) {
    verdict = 'fix';
  }

  let round = 1;
  if (state) {
    const last = state.last;
    round = Math.min(state.rounds + 1, r.maxRounds + 1);
    if (verdict === 'fix') {
      if (last && last.hash === rev.hash && last.verdict === 'stop') { verdict = 'stop'; why = (last.human_why as HumanWhy) ?? 'no-progress'; }
      else if (state.rounds >= r.maxRounds) { verdict = 'stop'; why = 'max-rounds'; }
      else if (last && last.hash === rev.hash && last.verdict === 'fix') { verdict = 'stop'; why = 'no-progress'; }
      else { state.rounds++; round = state.rounds; }
    }
    state.last = { hash: rev.hash, verdict, human_why: why, at: r.started };
  }
  if (v.secrets.some((s) => s.committed) && why !== 'tamper') why = 'secret-committed';
  if (!why && rev.failOpen) why = 'reviewer-failed';

  v.verdict = verdict;
  v.round = round;
  v.human_why = why;
  v.human_needed = why !== null;
  v.fail_open = rev.failOpen;
  v.next_action = nextAction(v, integ, base);
  v.reasons = reasons(v);
}

/** Saves the session state, then writes the result file (section 11.1). */
function persist(r: Run, v: HarnessVerdict, d: Diffs, sec: SecretScan, rev: ReviewOutcome): void {
  const { repoRoot, warnings } = r;
  if (d.state) { try { saveState(repoRoot, d.state); } catch (e: any) { warnings.push(`could not save the session state (${String(e?.message || e).slice(0, 200)})`); } } // any: fs error, message only
  const secretAsFindings: Finding[] = [
    ...v.secrets.map((s) => ({ severity: 'high' as const, category: 'security' as const, rule: s.rule, file: s.file, line: s.line, message: 'Secret detected (value redacted)' })),
    ...v.commit_secrets.map((s) => ({ severity: 'high' as const, category: 'security' as const, rule: s.rule, file: s.file, line: s.line, message: `Secret in commit ${s.commit.slice(0, 12)} of the pushed range (value redacted)` })),
  ];
  const blockingN = v.findings.filter((f) => f.blocking).length;
  const result = makeResult({
    kind: 'agent-harness', hook: 'agent',
    status: v.secrets.length || v.findings.length ? 'findings' : rev.failOpen ? 'error' : 'ok',
    tool: v.reviewer?.tool ?? (sec.scan.version ? 'gitleaks' : 'none'), tool_version: rev.toolVersion ?? sec.scan.version,
    model: v.reviewer?.model ?? null, commit: d.tip, tree: d.current,
    branch: gitIn(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout || null, upstream: d.upstreamLabel, base: d.reviewBase,
    started_at: r.started, finished_at: r.now().toISOString(),
    findings: [...secretAsFindings, ...v.findings.map(({ introduced_in_session: _i, blocking: _b, ...f }) => f)],
    summary: rev.summary, score: rev.score, reason: warnings.length ? warnings.join('; ').slice(0, 2000) : null,
    harness: {
      client: r.opts.client ?? null, event: r.event, session: r.session, verdict: v.verdict, round: v.round, max_rounds: v.max_rounds, scope: r.scope,
      secrets: v.secrets.length + v.commit_secrets.length, dropped_out_of_scope: v.dropped.out_of_scope, cached: v.diff.cached,
      human_needed: v.human_needed, human_why: v.human_why, fail_open: v.fail_open, secrets_scanned: v.secrets_scanned,
      block_on: r.cfg.block_on, blocking_findings: blockingN + v.secrets.length + v.commit_secrets.length, nonblocking_findings: v.findings.length - blockingN,
      wall_s: Math.round((Date.now() - r.t0) / 100) / 10, cost_usd: v.reviewer?.cost_usd ?? null,
    },
  });
  const written = safeWrite(repoRoot, result);
  v.result_path = written ? relative(repoRoot, written) : null;
}

/**
 * Runs one review. Throws only on an internal error (the CLI turns that into
 * exit 1, adapters into "no decision").
 */
export function runHarnessReview(opts: HarnessOptions): HarnessVerdict {
  const now = opts.now ?? (() => new Date());
  const warnings: string[] = [];
  const cfg = readHarnessConfig(opts.repoRoot, warnings);
  const session = opts.session ?? null;
  let maxRounds = opts.maxRounds ?? cfg.max_rounds;
  if (maxRounds > HARNESS_MAX_ROUNDS_CEILING) {
    warnings.push(`--max-rounds ${maxRounds} is above the ceiling of ${HARNESS_MAX_ROUNDS_CEILING}; using ${HARNESS_MAX_ROUNDS_CEILING}`);
    maxRounds = HARNESS_MAX_ROUNDS_CEILING;
  }
  if (maxRounds < 1) maxRounds = 1;
  const scope: Scope = opts.scope ?? (session && opts.mode !== 'since' ? 'new-lines' : 'branch');
  const head = revParse(opts.repoRoot, 'HEAD^{commit}');
  if (!head) {
    warnings.push('no commit yet (no HEAD): nothing to diff, no review');
    const v = emptyVerdict({ session, scope, maxRounds: session ? maxRounds : 1, blockOn: cfg.block_on, warnings });
    v.next_action = nextAction(v);
    return v;
  }
  const r: Run = {
    opts, repoRoot: opts.repoRoot, cfg, warnings, session, maxRounds, scope, event: opts.event ?? 'manual',
    started: now().toISOString(), t0: Date.now(), now, head, pathEnv: opts.pathEnv ?? process.env.PATH,
  };

  try { ensureResultsExcluded(r.repoRoot); } catch { /* never fail a review over this */ }
  ensureHarnessDir(r.repoRoot);
  cleanupState(r.repoRoot, cfg.state_ttl_days);

  const resolved = resolveDiffs(r);
  const v = emptyVerdict({ session, scope: r.scope, maxRounds: session ? maxRounds : 1, blockOn: cfg.block_on, warnings });
  if ('unknown' in resolved) {
    // Fail closed at push, as for a secret scan with no verdict: what leaves the machine is not known.
    warnings.push(`push held: ${resolved.unknown}`);
    v.verdict = 'stop';
    v.human_why = 'push-unknown';
    v.human_needed = true;
    v.next_action = nextAction(v);
    v.reasons = reasons(v);
    return v;
  }
  const d = resolved;
  v.diff = { files: d.diff.files.length, added_lines: d.diff.addedLines, hash: null, cached: false };
  if (!d.diff.files.length) {
    v.secrets_scanned = true; // nothing to scan
    v.next_action = 'No changes to review.';
    if (d.state) { d.state.last = null; saveState(r.repoRoot, d.state); }
    return v;
  }

  const integ = integrityChecks(d);
  const sec = secretScan(r, d);
  v.secrets = sec.secrets;
  v.commit_secrets = sec.history?.findings ?? [];
  v.secrets_scanned = (sec.scan.status === 'ok' || sec.scan.status === 'findings') && !sec.scan.skipped.length && sec.history?.status !== 'error';
  const rev = aiReview(r, d, skipReason(r, d, integ, sec));
  v.diff.hash = rev.hash;
  v.diff.cached = rev.cached;
  v.reviewer = rev.reviewer;
  scopeFindings(r, d, rev.findings, v);
  decide(r, v, d.state, integ, sec, rev, d.reviewBase);
  persist(r, v, d, sec, rev);
  return v;
}

/** CLI exit code for a verdict: 0 pass, 3 fix, 4 stop (exit 2 is avoided on purpose, section 3). */
export function exitCodeFor(v: HarnessVerdict): number {
  return v.verdict === 'pass' ? 0 : v.verdict === 'fix' ? 3 : 4;
}
