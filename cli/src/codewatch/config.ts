/**
 * `.prism/config.json` access for codewatch (the local git-hook gate).
 *
 * The file is shared with other PRISM installers (team_id etc.) and is usually
 * committed, so reads tolerate any shape and writes merge rather than replace.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const CONFIG_PATH = '.prism/config.json';
export const RULES_PATH = '.prism/review/rules.md';
export const GITLEAKS_BASELINE_PATH = '.prism/gitleaks-baseline.json';
export const GITLEAKS_CONFIG_PATH = '.gitleaks.toml';
/** Per-clone override of the team's reviewer choice: `git config prism.reviewer claude`. */
export const REVIEWER_GIT_CONFIG_KEY = 'prism.reviewer';
/** Fallback review model for repos that pin none: `git config --global prism.reviewModel <id>`. */
export const REVIEW_MODEL_GIT_CONFIG_KEY = 'prism.reviewModel';
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
 * Precedence: `.prism/config.json` eval.model (the team pin, which the CI gate
 * also reads), then `git config prism.reviewModel` (usually --global: the
 * developer's default for repos that pin none), then the reviewer's default.
 * `auto`/`default` at either level stops the search with the reviewer's default.
 * An invalid value is ignored with a note.
 */
export function resolveReviewModel(opts: { prismConfigValue: unknown; gitConfigValue: string | null }): ModelChoice {
  let note: string | null = null;
  const levels: [unknown, ModelChoice['source'], string][] = [
    [opts.prismConfigValue, 'prism-config', 'eval.model in .prism/config.json'],
    [opts.gitConfigValue, 'git-config', `git config ${REVIEW_MODEL_GIT_CONFIG_KEY}`],
  ];
  for (const [raw, source, label] of levels) {
    if (raw === undefined || raw === null || raw === '') continue;
    const v = String(raw).trim();
    if (!MODEL_ID_RE.test(v)) { note = note || `ignored ${label}="${String(raw).slice(0, 100)}" (must match ${MODEL_ID_RE.source})`; continue; }
    return { model: isDefaultModel(v) ? null : v, source, note };
  }
  return { model: null, source: 'default', note };
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
