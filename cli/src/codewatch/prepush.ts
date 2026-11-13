/**
 * pre-push local eval gate: REPORT ONLY.
 *
 * Reviews each pushed branch's diff against its upstream with the configured
 * reviewer, writes a result file, prints a short summary, and returns 0 in
 * every case -- reviewer missing, reviewer crashing, unparseable output, or a
 * bug in this file. The push is never blocked by this gate.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from '../utils/exec.js';
import { getAssetPath } from '../utils/root.js';
import { DEFAULT_REVIEW_TIMEOUT_SECONDS, modelLabel, readEvalConfig, resolveReviewModel, REVIEW_MODEL_GIT_CONFIG_KEY, REVIEWER_GIT_CONFIG_KEY, RULES_PATH } from './config.js';
import { safeWrite } from './gitleaks.js';
import { countBySeverity, makeResult, readResults, type PrismResult } from './results.js';
import { ADAPTERS, detectReviewers, findOnPath, resolveReviewer, runReview, toolVersion, type ReviewerAdapter } from './reviewers/index.js';

const ZERO_SHA = /^0+$/;
/** Larger diffs are truncated before review; the result notes it. */
export const MAX_DIFF_CHARS = 200_000;
/** Upper bound on commits checked for a missing pre-commit scan per push. */
const MAX_SKIP_CHECK_COMMITS = 50;
/** Lock files are noise to a reviewer and can be megabytes. */
const DIFF_EXCLUDES = [':(exclude,glob)**/package-lock.json', ':(exclude,glob)**/yarn.lock', ':(exclude,glob)**/pnpm-lock.yaml', ':(exclude,glob)**/poetry.lock', ':(exclude,glob)**/Cargo.lock'];

export interface PushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

/** Parses git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line. */
export function parsePushInput(stdin: string): PushRef[] {
  const refs: PushRef[] = [];
  for (const line of stdin.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length !== 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = p;
    if (ZERO_SHA.test(localSha)) continue; // branch deletion: nothing to review
    refs.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return refs;
}

function git(args: string[]): string | null {
  const r = run('git', args);
  return r.ok ? r.stdout : null;
}

/**
 * Base for the review range. The branch's upstream if it has one, else what
 * the remote already has for this ref, else the remote's default branch (a
 * first push of a new branch). The diff is merge-base based (`base...sha`).
 */
export function resolveBase(ref: PushRef, remote: string | null): { base: string | null; upstream: string | null } {
  const branch = ref.localRef.startsWith('refs/heads/') ? ref.localRef.slice('refs/heads/'.length) : null;
  if (branch) {
    const up = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]);
    if (up) {
      const sha = git(['rev-parse', '--verify', '--quiet', `${up}^{commit}`]);
      if (sha) return { base: sha, upstream: up };
    }
  }
  if (!ZERO_SHA.test(ref.remoteSha) && git(['cat-file', '-e', `${ref.remoteSha}^{commit}`]) !== null) {
    return { base: ref.remoteSha, upstream: remote ? `${remote}/${ref.remoteRef.replace(/^refs\/heads\//, '')}` : ref.remoteRef };
  }
  if (remote) {
    const head = git(['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`]);
    if (head) {
      const sha = git(['rev-parse', '--verify', '--quiet', head]);
      if (sha) return { base: sha, upstream: head.replace(/^refs\/remotes\//, '') };
    }
  }
  return { base: null, upstream: null };
}

/**
 * Commits in the range whose tree has no pre-commit secrets result: committed
 * with `--no-verify`, or produced without a commit hook (rebase, cherry-pick,
 * merge). Recorded as `skipped` results; this is a heuristic, and the reason
 * says so.
 */
export function recordUnscannedCommits(repoRoot: string, base: string | null, sha: string, branch: string | null, upstream: string | null): number {
  const range = base ? `${base}..${sha}` : sha;
  const list = git(['rev-list', `--max-count=${MAX_SKIP_CHECK_COMMITS}`, range]);
  if (!list) return 0;
  const scanned = new Set(
    readResults(repoRoot)
      .filter((r) => r.kind === 'secrets' && r.hook === 'pre-commit' && r.status !== 'skipped' && r.tree)
      .map((r) => r.tree as string),
  );
  // Trees committed while gitleaks was missing already have their own skipped
  // record (reason gitleaks-missing); do not report them a second time as --no-verify.
  const knownSkips = new Set(
    readResults(repoRoot)
      .filter((r) => r.kind === 'secrets' && r.hook === 'pre-commit' && r.status === 'skipped' && r.tree)
      .map((r) => r.tree as string),
  );
  const already = new Set(
    readResults(repoRoot).filter((r) => r.kind === 'secrets' && r.status === 'skipped' && r.commit).map((r) => r.commit as string),
  );
  let n = 0;
  for (const c of list.split('\n').filter(Boolean)) {
    if (already.has(c)) continue;
    const tree = git(['rev-parse', `${c}^{tree}`]);
    if (!tree || scanned.has(tree) || knownSkips.has(tree)) continue;
    const now = new Date().toISOString();
    safeWrite(repoRoot, makeResult({
      kind: 'secrets', hook: 'pre-push', status: 'skipped', tool: 'gitleaks', commit: c, tree, branch, upstream, base,
      started_at: now, finished_at: now,
      reason: 'no pre-commit secret scan recorded for this commit (git commit --no-verify, or a rebase/cherry-pick/merge that runs no commit hook)',
    }));
    n++;
  }
  return n;
}

export interface PrePushOptions {
  repoRoot: string;
  stdin: string;
  remote: string | null;
  /** Injected for tests. */
  pathEnv?: string;
  log?: (line: string) => void;
}

/** Reviews one pushed ref. Never throws. */
function reviewRef(opts: PrePushOptions, ref: PushRef, log: (l: string) => void): PrismResult | null {
  const { repoRoot } = opts;
  const started = new Date().toISOString();
  const branch = ref.localRef.startsWith('refs/heads/') ? ref.localRef.slice(11) : ref.localRef;
  const { base, upstream } = resolveBase(ref, opts.remote);

  const unscanned = recordUnscannedCommits(repoRoot, base, ref.localSha, branch, upstream);
  if (unscanned > 0) log(`prism: ${unscanned} pushed commit(s) have no pre-commit secret scan (recorded in .prism/results/)`);

  const common = { kind: 'review' as const, hook: 'pre-push' as const, commit: ref.localSha, branch, upstream, base, started_at: started };

  const evalCfg = readEvalConfig(repoRoot);
  const choice = resolveReviewer({
    gitConfigValue: git(['config', '--get', REVIEWER_GIT_CONFIG_KEY]),
    prismConfigValue: evalCfg.reviewer,
    available: detectReviewers(opts.pathEnv),
  });
  if (choice.note) log(`prism: ${choice.note}`);

  if (!choice.id) {
    return makeResult({ ...common, tool: 'none', status: 'error', finished_at: new Date().toISOString(), reason: `no reviewer available: ${choice.note}` });
  }
  const adapter: ReviewerAdapter = ADAPTERS[choice.id];
  const bin = findOnPath(adapter.binary, opts.pathEnv) || adapter.binary;
  const modelChoice = resolveReviewModel({ prismConfigValue: evalCfg.model, gitConfigValue: git(['config', '--get', REVIEW_MODEL_GIT_CONFIG_KEY]) });
  if (modelChoice.note) log(`prism: ${modelChoice.note}`);
  const model = modelChoice.model;

  if (!base) {
    return makeResult({ ...common, tool: adapter.id, status: 'skipped', finished_at: new Date().toISOString(), reason: 'no upstream or remote default branch to diff against' });
  }

  // spawnSync rather than run(): run() inherits execFileSync's 1 MB buffer,
  // which a large branch diff exceeds.
  const d = spawnSync('git', ['diff', '--no-color', '--no-ext-diff', `${base}...${ref.localSha}`, '--', '.', ...DIFF_EXCLUDES],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  let diff = d.status === 0 ? d.stdout : null;
  if (diff === null) {
    return makeResult({ ...common, tool: adapter.id, status: 'error', finished_at: new Date().toISOString(), reason: 'git diff failed' });
  }
  if (!diff.trim()) {
    return makeResult({ ...common, tool: adapter.id, status: 'skipped', finished_at: new Date().toISOString(), reason: 'no changes against upstream' });
  }
  let truncated = false;
  if (diff.length > MAX_DIFF_CHARS) { diff = diff.slice(0, MAX_DIFF_CHARS); truncated = true; }

  // A repo covered only by the global hooks has no rules file of its own:
  // fall back to the bundled default, the same rules enable codewatch installs.
  let rulesPath = RULES_PATH;
  let rulesText = existsSync(resolve(repoRoot, RULES_PATH)) ? readFileSync(resolve(repoRoot, RULES_PATH), 'utf8') : '';
  if (!rulesText) {
    try {
      rulesPath = getAssetPath(import.meta.url, 'bootstrapper/eval-harness/steering/code-review.md');
      rulesText = readFileSync(rulesPath, 'utf8');
    } catch {
      rulesPath = RULES_PATH;
      log(`prism: ${RULES_PATH} not found; reviewing without the shared rules`);
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), 'prism-review-'));
  try {
    const diffPath = join(tmp, 'branch.diff');
    writeFileSync(diffPath, diff, { mode: 0o600 });
    const timeoutS = Number(evalCfg.timeout_seconds) > 0 ? Number(evalCfg.timeout_seconds) : DEFAULT_REVIEW_TIMEOUT_SECONDS;
    log(`prism: reviewing ${branch} against ${upstream} with ${adapter.displayName}, model ${modelLabel(adapter.id, model)} (report only, up to ${timeoutS}s)...`);
    const res = runReview(adapter, { repoRoot, rulesPath, rulesText, diffPath, diff, model: model || undefined }, timeoutS * 1000, bin);
    const finished = new Date().toISOString();
    const version = toolVersion(bin);
    if (!res.ok || !res.review) {
      return makeResult({ ...common, tool: adapter.id, tool_version: version, model, status: 'error', finished_at: finished, reason: res.error });
    }
    const r = res.review;
    return makeResult({
      ...common, tool: adapter.id, tool_version: version, model: r.model || model,
      status: r.findings.length ? 'findings' : 'ok', findings: r.findings, summary: r.summary, score: r.score,
      finished_at: finished, reason: truncated ? `diff truncated to ${MAX_DIFF_CHARS} characters` : null,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function summarize(r: PrismResult, path: string | null): string {
  const where = path ? ` -> ${path}` : '';
  if (r.status === 'error') return `prism: review did not run (${r.reason}). Push continues.${where}`;
  if (r.status === 'skipped') return `prism: review skipped (${r.reason}).${where}`;
  const c = countBySeverity(r.findings);
  const top = r.findings
    .filter((f) => f.severity === 'high')
    .slice(0, 3)
    .map((f) => `\n  [high/${f.category}] ${f.file}${f.line ? `:${f.line}` : ''} ${f.message.slice(0, 120)}`)
    .join('');
  return `prism: ${r.tool} review: ${r.findings.length} finding(s) (${c.high} high, ${c.medium} medium, ${c.low} low)` +
    `${r.score !== null ? `, score ${r.score}` : ''}. Report only; push continues.${top}${where}`;
}

/** Entry point for the hook. Always returns 0. */
export function runPrePush(opts: PrePushOptions): number {
  const log = opts.log || ((l: string) => process.stderr.write(l + '\n'));
  try {
    const refs = parsePushInput(opts.stdin);
    if (refs.length === 0) return 0;
    for (const ref of refs) {
      let result: PrismResult | null = null;
      try {
        result = reviewRef(opts, ref, log);
      } catch (e: any) {
        const now = new Date().toISOString();
        result = makeResult({ kind: 'review', hook: 'pre-push', tool: 'none', status: 'error', commit: ref.localSha, started_at: now, finished_at: now, reason: `internal error: ${e?.message || e}` });
      }
      if (result) log(summarize(result, safeWrite(opts.repoRoot, result)));
    }
  } catch (e: any) {
    try { log(`prism: pre-push review failed (${e?.message || e}). Push continues.`); } catch { /* ignore */ }
  }
  return 0;
}
