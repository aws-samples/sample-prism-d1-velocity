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
/** Same rule the CI eval gate applies to its review model (prism-eval-gate-kiro.yml): 1-100 characters, no leading '-' so the id cannot be parsed as a flag. */
export const MODEL_ID_RE = /^[A-Za-z0-9._:/][A-Za-z0-9._:/-]{0,99}$/;
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

// ------------------------------------------------------------ harness block

export const HARNESS_BLOCK_ON_VALUES = ['secret', 'high', 'medium'] as const;
export type BlockOn = typeof HARNESS_BLOCK_ON_VALUES[number];
export const HARNESS_DEFAULT_MAX_ROUNDS = 2;
export const HARNESS_MAX_ROUNDS_CEILING = 3;
export const HARNESS_DEFAULT_TIMEOUT_SECONDS = 120;
/**
 * Ceiling for harness.timeout_seconds: two attempts (the retry) must fit inside the plugin
 * hook script's 290 s cap with room for gitleaks, or Claude Code kills the engine mid-write.
 */
export const HARNESS_MAX_TIMEOUT_SECONDS = 135;
export const HARNESS_DEFAULT_STATE_TTL_DAYS = 7;
export const HARNESS_DEFAULT_SKIP_PATHS = ['*.md', 'docs/**', '*.txt', '*.png', '*.jpg', '*.jpeg', '*.gif', '*.svg', '*.webp', '*.ico'];

/** The `harness` block of `.prism/config.json`, with defaults applied (docs/DESIGN-harness-loop.md, config keys). */
export interface HarnessConfig {
  push_gate: boolean;
  finish_gate: boolean;
  /** Always contains 'secret'. */
  block_on: BlockOn[];
  max_rounds: number;
  timeout_seconds: number;
  skip_paths: string[];
  state_ttl_days: number;
}

/**
 * Reads the harness block. A missing or mistyped key takes its default; a
 * wrong value is reported in `warnings`, never thrown, because a typo in a
 * team's config must not trap an agent.
 */
export function readHarnessConfig(repoRoot: string, warnings: string[] = []): HarnessConfig {
  const raw = readPrismConfig(repoRoot).harness;
  const h: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bool = (k: string, def: boolean): boolean => {
    if (h[k] === undefined) return def;
    if (typeof h[k] === 'boolean') return h[k] as boolean;
    warnings.push(`ignored harness.${k} in ${CONFIG_PATH} (expected true or false)`);
    return def;
  };
  const posInt = (k: string, def: number): number => {
    if (h[k] === undefined) return def;
    const n = h[k];
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) return n;
    warnings.push(`ignored harness.${k} in ${CONFIG_PATH} (expected a whole number above 0)`);
    return def;
  };

  let blockOn: BlockOn[] = ['secret', 'high'];
  if (h.block_on !== undefined) {
    if (Array.isArray(h.block_on)) {
      const vals = h.block_on.map((v) => String(v).toLowerCase());
      const bad = vals.filter((v) => !(HARNESS_BLOCK_ON_VALUES as readonly string[]).includes(v));
      if (bad.length) warnings.push(`ignored harness.block_on value(s) ${bad.map((b) => JSON.stringify(b.slice(0, 40))).join(', ')} (allowed: ${HARNESS_BLOCK_ON_VALUES.join(', ')})`);
      blockOn = HARNESS_BLOCK_ON_VALUES.filter((v) => vals.includes(v));
    } else {
      warnings.push(`ignored harness.block_on in ${CONFIG_PATH} (expected a list such as ["secret", "high"])`);
    }
  }
  if (!blockOn.includes('secret')) {
    warnings.push('harness.block_on has no "secret"; secrets always block, so it was added');
    blockOn = ['secret', ...blockOn];
  }

  let maxRounds = posInt('max_rounds', HARNESS_DEFAULT_MAX_ROUNDS);
  if (maxRounds > HARNESS_MAX_ROUNDS_CEILING) {
    warnings.push(`harness.max_rounds ${maxRounds} is above the ceiling of ${HARNESS_MAX_ROUNDS_CEILING}; using ${HARNESS_MAX_ROUNDS_CEILING}`);
    maxRounds = HARNESS_MAX_ROUNDS_CEILING;
  }

  let skip = HARNESS_DEFAULT_SKIP_PATHS;
  if (h.skip_paths !== undefined) {
    if (Array.isArray(h.skip_paths) && h.skip_paths.every((p) => typeof p === 'string')) skip = h.skip_paths as string[];
    else warnings.push(`ignored harness.skip_paths in ${CONFIG_PATH} (expected a list of glob strings)`);
  }

  let timeout = posInt('timeout_seconds', HARNESS_DEFAULT_TIMEOUT_SECONDS);
  if (timeout > HARNESS_MAX_TIMEOUT_SECONDS) {
    warnings.push(`harness.timeout_seconds ${timeout} is above the ceiling of ${HARNESS_MAX_TIMEOUT_SECONDS} (two attempts must fit in the agent hook's time); using ${HARNESS_MAX_TIMEOUT_SECONDS}`);
    timeout = HARNESS_MAX_TIMEOUT_SECONDS;
  }

  return {
    push_gate: bool('push_gate', true),
    finish_gate: bool('finish_gate', false),
    block_on: blockOn,
    max_rounds: maxRounds,
    timeout_seconds: timeout,
    skip_paths: skip,
    state_ttl_days: posInt('state_ttl_days', HARNESS_DEFAULT_STATE_TTL_DAYS),
  };
}
