import { createInterface } from 'node:readline';
import { getAssetPath } from '../../utils/root.js';
import { run } from '../../utils/exec.js';
import { GITLEAKS_BASELINE_PATH, readEvalConfig, REVIEWER_GIT_CONFIG_KEY, RULES_PATH, writeEvalConfig } from '../../codewatch/config.js';
import { gitleaksInstallHint, installGitleaksConfig } from '../../codewatch/gitleaks.js';
import { ensureResultsIgnored, installHooks, resolveHooksDir, retireLegacyCommitMsgHook, uninstallHooks } from '../../codewatch/hooks.js';
import { ADAPTERS, detectReviewers, findOnPath, isReviewerId, REVIEWER_IDS, type ReviewerId } from '../../codewatch/reviewers/index.js';
import { ensureRulesFile } from '../../codewatch/rules.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(question, (a) => { rl.close(); r(a.trim()); }));
}

/**
 * Chooses the team's default reviewer. An explicit --reviewer wins; with one
 * tool on PATH it is used; with both, the developer is asked (non-TTY: claude,
 * the repo's primary tool); with neither, the existing setting is kept.
 */
async function chooseReviewer(flag: string | undefined, existing: string | undefined): Promise<{ id: ReviewerId | null; how: string }> {
  if (flag) {
    if (!isReviewerId(flag)) throw new Error(`--reviewer must be one of: ${REVIEWER_IDS.join(', ')}`);
    return { id: flag, how: '--reviewer flag' };
  }
  const found = detectReviewers();
  if (found.length === 1) return { id: found[0], how: `only ${ADAPTERS[found[0]].binary} is on PATH` };
  if (found.length === 0) {
    return { id: isReviewerId(existing) ? existing : null, how: 'neither kiro-cli nor claude is on PATH' };
  }
  if (!process.stdin.isTTY) {
    const id = isReviewerId(existing) ? existing : 'claude';
    return { id, how: `both found, no TTY to ask; using ${isReviewerId(existing) ? 'the existing setting' : 'claude'}` };
  }
  const def = isReviewerId(existing) ? existing : 'claude';
  const a = (await ask(`Both kiro-cli and claude are installed. Which should review pushes? [kiro/claude] (${def}) `)).toLowerCase();
  const id = a === '' ? def : a;
  if (!isReviewerId(id)) throw new Error(`unknown reviewer "${a}"; expected ${REVIEWER_IDS.join(' or ')}`);
  return { id, how: 'chosen at the prompt' };
}

export default {
  description: 'Install codewatch git hooks: gitleaks pre-commit (blocks) and a report-only pre-push code review (kiro-cli or Claude Code)',
  options: [
    { flags: '--reviewer <tool>', description: `Team default reviewer: ${REVIEWER_IDS.join(' | ')} (skips detection)` },
    { flags: '--uninstall', description: 'Remove the hooks and restore any hooks they replaced' },
  ],
  async action(opts: { reviewer?: string; uninstall?: boolean }) {
    const top = run('git', ['rev-parse', '--show-toplevel']);
    if (!top.ok) {
      console.error('Error: not inside a git repository.');
      process.exit(1);
    }
    const gitRoot = top.stdout;
    const hooksDir = resolveHooksDir(gitRoot);

    if (opts.uninstall) {
      for (const c of uninstallHooks(hooksDir)) console.log(`✓ ${c.hook}: ${c.action}`);
      console.log(`  Kept ${RULES_PATH}, .prism/config.json and .prism/results/ (delete manually if unwanted).`);
      return;
    }

    const legacy = retireLegacyCommitMsgHook(hooksDir);
    if (legacy) console.log(`✓ ${legacy}`);

    const rules = ensureRulesFile(gitRoot, getAssetPath(import.meta.url, 'bootstrapper/eval-harness/steering/code-review.md'));
    console.log(`✓ Review rules: ${RULES_PATH} (${rules === 'kept' ? 'kept existing' : rules === 'from-steering' ? 'copied from .kiro/steering/code-review.md' : 'installed default'})`);

    if (installGitleaksConfig(gitRoot)) console.log('✓ Installed .gitleaks.toml (allowlist starter)');
    else console.log('✓ Using existing .gitleaks.toml');
    if (existsSync(resolve(gitRoot, GITLEAKS_BASELINE_PATH))) console.log(`✓ Using baseline ${GITLEAKS_BASELINE_PATH}`);

    let choice;
    try {
      choice = await chooseReviewer(opts.reviewer, readEvalConfig(gitRoot).reviewer);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    if (choice.id) {
      writeEvalConfig(gitRoot, { reviewer: choice.id });
      console.log(`✓ Reviewer: ${choice.id} (${choice.how}) -> .prism/config.json eval.reviewer`);
      if (!findOnPath(ADAPTERS[choice.id].binary)) console.log(`  Note: ${ADAPTERS[choice.id].binary} is not on PATH here; pushes will use another installed reviewer or skip.`);
    } else {
      console.log(`! No reviewer configured (${choice.how}). Pre-push will report "no reviewer" until kiro-cli or claude is installed.`);
    }

    if (ensureResultsIgnored(gitRoot)) console.log('✓ Added .prism/results/ to .gitignore');

    for (const c of installHooks(hooksDir)) console.log(`✓ ${c.hook}: ${c.action}`);

    if (!findOnPath('gitleaks')) {
      console.log('\n! gitleaks is not on PATH, so the pre-commit scan cannot run yet (commits are allowed with a warning).');
      console.log(`  Install it: ${gitleaksInstallHint()}`);
    }
    if (!findOnPath('prism-cli')) {
      console.log('\n! prism-cli is not on PATH. The hooks call it to record results; install with: npm i -g @prism-d1/cli');
    }

    console.log('\n  pre-commit  gitleaks protect --staged. BLOCKS the commit on a finding.');
    console.log('  pre-push    reviews the branch diff against its upstream. Report only; never blocks.');
    console.log(`  Results     .prism/results/*.json (gitignored)`);
    console.log(`  Override    git config ${REVIEWER_GIT_CONFIG_KEY} <kiro|claude>   (this clone only)`);
    console.log('  Remove      prism-cli enable codewatch --uninstall');
  },
};
