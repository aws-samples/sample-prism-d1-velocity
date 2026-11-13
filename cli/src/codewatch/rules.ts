import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getAssetPath } from '../utils/root.js';
import { RULES_PATH } from './config.js';

/** Where install-eval-harness has always put the review rules for kiro-cli. */
export const KIRO_STEERING_RULES = '.kiro/steering/code-review.md';

/**
 * Ensures the tool-neutral rule set exists at `.prism/review/rules.md`.
 *
 * Seed order: keep an existing rules.md; else copy the repo's
 * `.kiro/steering/code-review.md` (a team may have customised it, and CI
 * reviewed against it until now); else the bundled default -- the same file
 * install-eval-harness ships as steering. Returns what happened.
 */
export function ensureRulesFile(gitRoot: string, bundledRulesPath: string): 'kept' | 'from-steering' | 'from-bundle' {
  const dest = resolve(gitRoot, RULES_PATH);
  if (existsSync(dest)) return 'kept';
  mkdirSync(dirname(dest), { recursive: true });
  const steering = resolve(gitRoot, KIRO_STEERING_RULES);
  if (existsSync(steering)) {
    copyFileSync(steering, dest);
    return 'from-steering';
  }
  copyFileSync(bundledRulesPath, dest);
  return 'from-bundle';
}

export interface LoadedRules {
  /** Path handed to the reviewer: repo-relative for the repo's own file, absolute for the bundled one. */
  rulesPath: string;
  rulesText: string;
  /** Set when no rules could be read. */
  note: string | null;
}

/**
 * The rules a review runs against. A repo covered only by the global hooks has
 * no rules file of its own: fall back to the bundled default, the same rules
 * enable codewatch installs.
 */
export function loadReviewRules(repoRoot: string): LoadedRules {
  const own = resolve(repoRoot, RULES_PATH);
  const text = existsSync(own) ? readFileSync(own, 'utf8') : '';
  if (text) return { rulesPath: RULES_PATH, rulesText: text, note: null };
  try {
    const p = getAssetPath(import.meta.url, 'bootstrapper/eval-harness/steering/code-review.md');
    return { rulesPath: p, rulesText: readFileSync(p, 'utf8'), note: null };
  } catch {
    return { rulesPath: RULES_PATH, rulesText: '', note: `${RULES_PATH} not found; reviewing without the shared rules` };
  }
}
