import { spawnSync } from 'node:child_process';
import { findOnPath } from '../../utils/tool-check.js';
import { claudeAdapter } from './claude.js';
import { kiroAdapter } from './kiro.js';
import { isReviewerId, REVIEWER_IDS, type ParsedReview, type ReviewerAdapter, type ReviewerId, type ReviewRequest } from './types.js';

export * from './types.js';

export const ADAPTERS: Record<ReviewerId, ReviewerAdapter> = {
  kiro: kiroAdapter,
  claude: claudeAdapter,
};

export { findOnPath, toolVersion } from '../../utils/tool-check.js';

/** Reviewer tools present on PATH, in REVIEWER_IDS order. */
export function detectReviewers(pathEnv: string | undefined = process.env.PATH): ReviewerId[] {
  return REVIEWER_IDS.filter((id) => findOnPath(ADAPTERS[id].binary, pathEnv) !== null);
}

export interface ReviewerChoice {
  /** The reviewer to run, or null when none is available. */
  id: ReviewerId | null;
  /** Where the choice came from. */
  source: 'git-config' | 'prism-config' | 'detected' | 'fallback' | 'none';
  /** Set when the configured reviewer was not available and another was used. */
  note: string | null;
}

/**
 * Precedence: `git config prism.reviewer` (per-clone developer override), then
 * `.prism/config.json` eval.reviewer (team default), then whatever is on PATH.
 *
 * If the chosen tool is not installed, another installed one is used and the
 * substitution is noted, so a Claude Code user on a team that defaults to kiro
 * still gets a review without installing kiro-cli.
 */
export function resolveReviewer(opts: {
  gitConfigValue: string | null;
  prismConfigValue: string | null | undefined;
  available: ReviewerId[];
}): ReviewerChoice {
  const { gitConfigValue, prismConfigValue, available } = opts;
  let wanted: ReviewerId | null = null;
  let source: ReviewerChoice['source'] = 'detected';
  let note: string | null = null;

  if (gitConfigValue) {
    if (isReviewerId(gitConfigValue)) { wanted = gitConfigValue; source = 'git-config'; }
    else note = `ignored git config prism.reviewer="${gitConfigValue}" (expected ${REVIEWER_IDS.join(' or ')})`;
  }
  if (!wanted && prismConfigValue) {
    if (isReviewerId(prismConfigValue)) { wanted = prismConfigValue; source = 'prism-config'; }
    else note = `ignored eval.reviewer="${prismConfigValue}" in .prism/config.json`;
  }

  if (wanted && available.includes(wanted)) return { id: wanted, source, note };
  if (available.length === 0) {
    return { id: null, source: 'none', note: wanted ? `${ADAPTERS[wanted].binary} is not on PATH` : 'neither kiro-cli nor claude is on PATH' };
  }
  if (wanted) {
    return { id: available[0], source: 'fallback', note: `${ADAPTERS[wanted].binary} is not on PATH; used ${ADAPTERS[available[0]].binary} instead` };
  }
  return { id: available[0], source: 'detected', note };
}

/** Git sets these for hooks; a reviewer that shells out to git must not inherit them. */
const GIT_HOOK_ENV = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];

export interface ReviewRun {
  ok: boolean;
  review: ParsedReview | null;
  error: string | null;
  rawStdout: string;
  /** The tool ran to completion but its reply held no usable review: the one case that is retried. */
  unparseable?: boolean;
}

/**
 * Runs one adapter and parses its output. Never throws: a missing binary, a
 * timeout, a non-zero exit and unparseable output all come back as ok:false.
 */
export function runReview(adapter: ReviewerAdapter, req: ReviewRequest, timeoutMs: number, binaryPath?: string, extraEnv: Record<string, string> = {}): ReviewRun {
  const env = { ...process.env };
  for (const k of GIT_HOOK_ENV) delete env[k];
  // Child only: this process's own environment is never changed.
  Object.assign(env, extraEnv);
  let inv;
  try {
    inv = adapter.invocation(req);
  } catch (e: any) {
    return { ok: false, review: null, error: `could not build invocation: ${e.message}`, rawStdout: '' };
  }
  const res = spawnSync(binaryPath || adapter.binary, inv.args, {
    cwd: req.repoRoot,
    input: inv.input ?? '',
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = res.stdout || '';
  if (res.error) {
    const msg = (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
      ? `${adapter.binary} timed out after ${Math.round(timeoutMs / 1000)}s`
      : `${adapter.binary} failed to start: ${res.error.message}`;
    return { ok: false, review: null, error: msg, rawStdout: stdout };
  }
  try {
    const review = adapter.parse(stdout);
    return { ok: true, review, error: null, rawStdout: stdout };
  } catch (e: any) {
    const exit = res.status !== 0 ? ` (exit ${res.status}${res.stderr ? `: ${res.stderr.trim().slice(0, 200)}` : ''})` : '';
    return { ok: false, review: null, error: `${e.message}${exit}`, rawStdout: stdout, unparseable: true };
  }
}
