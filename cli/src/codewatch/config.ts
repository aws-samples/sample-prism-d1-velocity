/**
 * `.prism/config.json` access for codewatch (the local git-hook gate).
 *
 * The file is shared with other PRISM installers (team_id etc.) and is usually
 * committed, so reads tolerate any shape and writes merge rather than replace.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isReviewerId, type ReviewerId } from './reviewers/types.js';

export const CONFIG_PATH = '.prism/config.json';
export const RULES_PATH = '.prism/review/rules.md';
export const GITLEAKS_BASELINE_PATH = '.prism/gitleaks-baseline.json';
export const GITLEAKS_CONFIG_PATH = '.gitleaks.toml';
/** Per-clone override of the team's reviewer choice: `git config prism.reviewer claude`. */
export const REVIEWER_GIT_CONFIG_KEY = 'prism.reviewer';
/**
 * A developer's default review model for repos that pin none, one key per tool
 * so a model id never reaches the other tool: `git config --global prism.claudeModel sonnet`.
 */
export function reviewModelGitKey(reviewer: ReviewerId): string {
  return `prism.${reviewer}Model`;
}
/** Same rule the CI eval gate applies to its review model (prism-eval-gate-kiro.yml). */
export const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,100}$/;
export const DEFAULT_REVIEW_TIMEOUT_SECONDS = 300;

/** `auto` and `default` mean "the reviewer's own default" (kiro-cli: auto; Claude Code: its default). */
export function isDefaultModel(v: string): boolean {
  const s = v.trim().toLowerCase();
  return s === 'auto' || s === 'default';
}

export interface ModelChoice {
  /** Model to pass to the reviewer, or null for the reviewer's own default. */
  model: string | null;
  source: 'prism-config' | 'git-config' | 'default';
  /** Set when a configured value was ignored. */
  note: string | null;
}

/**
 * The model for `reviewer`, the tool that actually runs. Precedence:
 * `.prism/config.json` eval.model (the team pin, which the CI gate also reads),
 * then `git config prism.<reviewer>Model` (usually --global), then the
 * reviewer's default. `auto`/`default` at either level stops the search with
 * the reviewer's default. eval.model belongs to eval.reviewer: when another
 * tool runs (a per-clone prism.reviewer, or a fallback because the team's tool
 * is not installed) it is skipped with a note, never passed to that tool. An
 * invalid value is skipped with a note too.
 */
export function resolveReviewModel(opts: {
  reviewer: ReviewerId | null;
  prismConfigValue: unknown;
  /** eval.reviewer, the tool eval.model was chosen for. */
  prismConfigReviewer?: unknown;
  /** `git config prism.<reviewer>Model`. */
  gitConfigValue: string | null;
}): ModelChoice {
  const notes: string[] = [];
  let mismatch: string | null = null;
  const done = (model: string | null, source: ModelChoice['source']): ModelChoice => {
    if (mismatch) notes.push(`${mismatch}; using ${model ? `${opts.reviewer} model ${model} from git config ${reviewModelGitKey(opts.reviewer!)}` : `${opts.reviewer} default`}`);
    return { model, source, note: notes.length ? notes.join('. ') : null };
  };
  const levels: [unknown, ModelChoice['source'], string][] = [
    [opts.prismConfigValue, 'prism-config', 'eval.model in .prism/config.json'],
    [opts.reviewer ? opts.gitConfigValue : null, 'git-config', opts.reviewer ? `git config ${reviewModelGitKey(opts.reviewer)}` : ''],
  ];
  for (const [raw, source, label] of levels) {
    if (raw === undefined || raw === null || raw === '') continue;
    const v = String(raw).trim();
    if (!MODEL_ID_RE.test(v)) { notes.push(`ignored ${label}="${String(raw).slice(0, 100)}" (must match ${MODEL_ID_RE.source})`); continue; }
    if (isDefaultModel(v)) return done(null, source);
    const owner = opts.prismConfigReviewer;
    if (source === 'prism-config' && opts.reviewer && isReviewerId(owner) && owner !== opts.reviewer) {
      mismatch = `model ${v} was set for ${owner}`;
      continue;
    }
    return done(v, source);
  }
  return done(null, 'default');
}

/** How a model reads in logs and the dashboard: the id, or the reviewer's default. */
export function modelLabel(reviewer: string | null, model: string | null): string {
  return model || (reviewer === 'kiro' ? 'auto' : 'default');
}

export interface EvalConfig {
  reviewer?: string;
  model?: string;
  timeout_seconds?: number;
}

export function readPrismConfig(repoRoot: string): Record<string, any> {
  const p = resolve(repoRoot, CONFIG_PATH);
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function readEvalConfig(repoRoot: string): EvalConfig {
  const e = readPrismConfig(repoRoot).eval;
  return e && typeof e === 'object' ? e : {};
}

/** Merges `patch` into the `eval` block, keeping every other key in the file. */
export function writeEvalConfig(repoRoot: string, patch: EvalConfig): void {
  const p = resolve(repoRoot, CONFIG_PATH);
  const cfg = readPrismConfig(repoRoot);
  cfg.eval = { ...(cfg.eval && typeof cfg.eval === 'object' ? cfg.eval : {}), ...patch };
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}
