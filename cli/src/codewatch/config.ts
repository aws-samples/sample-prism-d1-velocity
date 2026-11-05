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
export const DEFAULT_REVIEW_TIMEOUT_SECONDS = 300;

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
