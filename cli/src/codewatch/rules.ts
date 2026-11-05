import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
