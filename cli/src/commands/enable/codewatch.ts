import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getAssetPath } from '../../utils/root.js';
import { run } from '../../utils/exec.js';
import {
  GITLEAKS_BASELINE_PATH, isDefaultModel, MODEL_ID_RE, modelLabel, readEvalConfig, resolveReviewModel, REVIEW_MODEL_GIT_CONFIG_KEY,
  REVIEWER_GIT_CONFIG_KEY, RULES_PATH, writeEvalConfig,
} from '../../codewatch/config.js';
import { gitleaksInstallHint, installGitleaksConfig } from '../../codewatch/gitleaks.js';
import { ensureResultsIgnored, installHooks, resolveHooksDir, retireLegacyCommitMsgHook, uninstallHooks } from '../../codewatch/hooks.js';
import { ADAPTERS, detectReviewers, findOnPath, isReviewerId, REVIEWER_IDS, type ReviewerId } from '../../codewatch/reviewers/index.js';
import { ensureRulesFile } from '../../codewatch/rules.js';
import { existsSync } from 'node:fs';
import { globalHooksDir, installGlobal, isOurHooksPath, OPT_OUT_KEY, readGlobalHooksPath, uninstallGlobal } from '../../codewatch/globalHooks.js';
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
async function chooseReviewer(flag: string | undefined, existing: string | undefined, tty: boolean): Promise<{ id: ReviewerId | null; how: string }> {
  if (flag) {
    if (!isReviewerId(flag)) throw new Error(`--reviewer must be one of: ${REVIEWER_IDS.join(', ')}`);
    return { id: flag, how: '--reviewer flag' };
  }
  const found = detectReviewers();
  if (found.length === 1) return { id: found[0], how: `only ${ADAPTERS[found[0]].binary} is on PATH` };
  if (found.length === 0) {
    return { id: isReviewerId(existing) ? existing : null, how: 'neither kiro-cli nor claude is on PATH' };
  }
  if (!tty) {
    const id = isReviewerId(existing) ? existing : 'claude';
    return { id, how: `both found, no TTY to ask; using ${isReviewerId(existing) ? 'the existing setting' : 'claude'}` };
  }
  const def = isReviewerId(existing) ? existing : 'claude';
  const a = (await ask(`Both kiro-cli and claude are installed. Which should review pushes? [kiro/claude] (${def}) `)).toLowerCase();
  const id = a === '' ? def : a;
  if (!isReviewerId(id)) throw new Error(`unknown reviewer "${a}"; expected ${REVIEWER_IDS.join(' or ')}`);
  return { id, how: 'chosen at the prompt' };
}

/** Claude Code's documented model aliases (`claude --help`: an alias for the latest model); it has no list command. */
export const CLAUDE_MODEL_ALIASES = ['sonnet', 'opus', 'haiku'];
/** Models from `kiro-cli chat --list-models` offered at the prompt; any other id can be typed. */
export const KIRO_MODELS_LISTED = 8;

export function modelFlagError(m: string): string | null {
  return MODEL_ID_RE.test(m.trim()) ? null : `--model must match ${MODEL_ID_RE.source} (the rule the CI eval gate uses)`;
}

/** kiro-cli's own model ids (`kiro-cli chat --list-models --format json`), without auto; null when it cannot say. */
export function listKiroModels(bin = 'kiro-cli'): string[] | null {
  const r = spawnSync(bin, ['chat', '--list-models', '--format', 'json'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const models = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).models;
    if (!Array.isArray(models)) return null;
    return models.map((m: any) => m?.model_id).filter((id: unknown): id is string => typeof id === 'string' && MODEL_ID_RE.test(id) && !isDefaultModel(id));
  } catch {
    return null;
  }
}

export interface ModelPromptDeps {
  tty: boolean;
  ask: (q: string) => Promise<string>;
  print: (line: string) => void;
  listKiroModels: () => string[] | null;
  /** eval.model already in .prism/config.json. */
  existing?: string;
}

/** write:false leaves eval.model as it is; model:null removes it (the reviewer's default). */
export type ModelDecision = { write: false; how: string } | { write: true; model: string | null; how: string };

/**
 * The review model. --model wins (auto/default clears it). Otherwise, in a
 * terminal, the developer picks from a short list for the chosen reviewer;
 * Enter keeps the current setting. Without a terminal (or with --yes) nothing
 * is written.
 */
export async function chooseModel(flag: string | undefined, reviewer: ReviewerId | null, deps: ModelPromptDeps): Promise<ModelDecision> {
  if (flag !== undefined) {
    const err = modelFlagError(flag);
    if (err) throw new Error(err);
    return { write: true, model: isDefaultModel(flag) ? null : flag.trim(), how: '--model flag' };
  }
  if (!reviewer || !deps.tty) return { write: false, how: 'not asked' };
  const listed = reviewer === 'kiro' ? (deps.listKiroModels() ?? []).slice(0, KIRO_MODELS_LISTED) : CLAUDE_MODEL_ALIASES;
  const dflt = reviewer === 'kiro' ? 'auto' : "Claude Code's default";
  const other = listed.length + 2;
  deps.print(`Review model for ${ADAPTERS[reviewer].displayName}${deps.existing ? ` (now ${deps.existing})` : ''}:`);
  deps.print(`  1) default (recommended): ${dflt}`);
  listed.forEach((m, i) => deps.print(`  ${i + 2}) ${m}`));
  deps.print(`  ${other}) other (type an id)`);
  const a = (await deps.ask(`Choose [1-${other}] (Enter: ${deps.existing ? 'keep' : 'default'}) `)).trim();
  if (a === '') return { write: false, how: 'kept at the prompt' };
  const n = /^\d+$/.test(a) ? Number(a) : NaN;
  let id: string;
  if (n === 1) return { write: true, model: null, how: 'chosen at the prompt' };
  if (n >= 2 && n < other) id = listed[n - 2];
  else if (n === other) id = (await deps.ask('Model id: ')).trim();
  else if (Number.isNaN(n)) id = a;
  else throw new Error(`no choice ${a}; expected 1-${other}`);
  if (modelFlagError(id)) throw new Error(`model "${id.slice(0, 100)}" must match ${MODEL_ID_RE.source}`);
  return { write: true, model: isDefaultModel(id) ? null : id, how: 'chosen at the prompt' };
}

export default {
  description: `Install codewatch git hooks: gitleaks pre-commit (blocks) and a report-only pre-push code review (kiro-cli or Claude Code). Turn them off in a repo with "git config ${OPT_OUT_KEY} false"`,
  options: [
    { flags: '--reviewer <tool>', description: `Team default reviewer: ${REVIEWER_IDS.join(' | ')} (skips detection)` },
    { flags: '--model <id>', description: `Review model: eval.model in .prism/config.json (with --global: git config --global ${REVIEW_MODEL_GIT_CONFIG_KEY}). auto or default clears it` },
    { flags: '--yes', description: 'Do not ask for the reviewer or model' },
    { flags: '--uninstall', description: 'Remove the hooks and restore any hooks they replaced' },
    { flags: '--global', description: 'Install for every repo: hooks in ~/.prism/hooks and git config --global core.hooksPath' },
    { flags: '--force', description: 'With --global: replace a global core.hooksPath set by another tool (its hooks are chained)' },
  ],
  async action(opts: { reviewer?: string; model?: string; yes?: boolean; uninstall?: boolean; global?: boolean; force?: boolean }) {
    const modelErr = opts.model !== undefined ? modelFlagError(opts.model) : null;
    if (modelErr) {
      console.error(`Error: ${modelErr}`);
      process.exit(1);
    }
    if (opts.global) return globalAction(opts);

    const top = run('git', ['rev-parse', '--show-toplevel']);
    if (!top.ok) {
      console.error('Error: not inside a git repository.');
      process.exit(1);
    }
    const gitRoot = top.stdout;
    let hooksDir = resolveHooksDir(gitRoot);
    // With the global hooks installed, git resolves this repo's hooks to
    // ~/.prism/hooks. Per-repo hooks belong in the repo's own hooks dir, and
    // must never overwrite the global scripts.
    const coveredGlobally = isOurHooksPath(readGlobalHooksPath()) && hooksDir === globalHooksDir();
    if (coveredGlobally) {
      const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      hooksDir = resolve(common.ok ? common.stdout : resolve(gitRoot, '.git'), 'hooks');
    }

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

    const tty = !!process.stdin.isTTY && !opts.yes;
    let choice;
    try {
      choice = await chooseReviewer(opts.reviewer, readEvalConfig(gitRoot).reviewer, tty);
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

    let decision: ModelDecision;
    try {
      decision = await chooseModel(opts.model, choice.id, {
        tty, ask, print: (l) => console.log(l), existing: readEvalConfig(gitRoot).model,
        listKiroModels: () => listKiroModels(findOnPath('kiro-cli') || 'kiro-cli'),
      });
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    if (decision.write) writeEvalConfig(gitRoot, { model: decision.model ?? undefined });
    const gitModel = run('git', ['config', '--get', REVIEW_MODEL_GIT_CONFIG_KEY]);
    const eff = resolveReviewModel({ prismConfigValue: readEvalConfig(gitRoot).model, gitConfigValue: gitModel.ok ? gitModel.stdout : null });
    const from = { 'prism-config': '.prism/config.json eval.model', 'git-config': `git config ${REVIEW_MODEL_GIT_CONFIG_KEY}`, default: 'reviewer default' }[eff.source];
    console.log(`✓ Review model: ${modelLabel(choice.id, eff.model)} (${from}${decision.write ? `; ${decision.how}` : ''})`);
    if (eff.note) console.log(`  Note: ${eff.note}`);

    if (ensureResultsIgnored(gitRoot)) console.log('✓ Added .prism/results/ to .gitignore');

    for (const c of installHooks(hooksDir)) console.log(`✓ ${c.hook}: ${c.action}`);
    if (coveredGlobally) {
      console.log('\n  Note: the global codewatch hooks (~/.prism/hooks) already cover this repo. While the global');
      console.log('  core.hooksPath is set, git does not run these per-repo hooks, so nothing runs twice.');
    }

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
    console.log('  Model       prism-cli enable codewatch --model <id|auto>   (eval.model; the CI gate reads it from the base branch)');
    console.log(`  Opt out     git config ${OPT_OUT_KEY} false   (this repo; add --global for every repo)`);
    console.log('  Remove      prism-cli enable codewatch --uninstall');
  },
};

/** `enable codewatch --global [--force] [--uninstall]`: needs no repo. */
function globalAction(opts: { reviewer?: string; model?: string; uninstall?: boolean; force?: boolean }) {
  if (opts.uninstall) {
    const r = uninstallGlobal();
    const cfg = {
      restored: `restored global core.hooksPath to ${r.restoredTo}`,
      unset: 'unset global core.hooksPath (none was set before)',
      'left-alone': `left global core.hooksPath alone: it now points to ${readGlobalHooksPath()}, not ~/.prism/hooks`,
      'not-set': 'global core.hooksPath was not set',
    }[r.config];
    console.log(`✓ ${cfg}`);
    console.log(r.removed.length ? `✓ Removed ${r.removed.join(', ')} from ${globalHooksDir()}` : '  No global codewatch hooks to remove.');
    console.log('  Repo-local hooks were not touched.');
    return;
  }
  if (opts.reviewer) {
    if (!isReviewerId(opts.reviewer)) {
      console.error(`Error: --reviewer must be one of: ${REVIEWER_IDS.join(', ')}`);
      process.exit(1);
    }
  }
  let r;
  try {
    r = installGlobal({ force: opts.force });
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  if (!r.ok) {
    console.error(`Error: ${r.refused}.`);
    console.error('  Another tool manages your global hooks, and replacing it would stop its hooks from running.');
    console.error('  Re-run with --force to save that value, point core.hooksPath at ~/.prism/hooks, and run its');
    console.error('  hooks after codewatch. --global --uninstall restores it.');
    process.exit(1);
  }
  console.log(`✓ Installed pre-commit and pre-push in ${r.dir}`);
  console.log(r.reinstalled ? '✓ Global core.hooksPath already points there (scripts refreshed)'
    : `✓ git config --global core.hooksPath ${r.dir}${r.previous ? `  (previous value saved: ${r.previous})` : ''}`);
  if (r.chained) console.log(`✓ Chaining the hooks in ${r.chained} after codewatch`);
  if (opts.reviewer) {
    run('git', ['config', '--global', REVIEWER_GIT_CONFIG_KEY, opts.reviewer]);
    console.log(`✓ Reviewer: git config --global ${REVIEWER_GIT_CONFIG_KEY} ${opts.reviewer}`);
  } else {
    const found = detectReviewers();
    console.log(found.length ? `✓ Reviewer: detected per push (${found.join(', ')} on PATH); a repo's .prism/config.json or git config ${REVIEWER_GIT_CONFIG_KEY} overrides`
      : '! No reviewer on PATH: pre-push will report "no reviewer" until kiro-cli or claude is installed.');
  }
  if (opts.model !== undefined) {
    if (isDefaultModel(opts.model)) {
      run('git', ['config', '--global', '--unset', REVIEW_MODEL_GIT_CONFIG_KEY]);
      console.log(`✓ Review model: reviewer default (unset git config --global ${REVIEW_MODEL_GIT_CONFIG_KEY})`);
    } else {
      run('git', ['config', '--global', REVIEW_MODEL_GIT_CONFIG_KEY, opts.model.trim()]);
      console.log(`✓ Review model: git config --global ${REVIEW_MODEL_GIT_CONFIG_KEY} ${opts.model.trim()} (a repo's eval.model overrides)`);
    }
  }
  if (!findOnPath('gitleaks')) console.log(`\n! gitleaks is not on PATH; commits are allowed but not scanned. Install it: ${gitleaksInstallHint()}`);
  if (!findOnPath('prism-cli')) console.log('\n! prism-cli is not on PATH. The hooks call it; install with: npm i -g @prism-d1/cli');
  console.log('\n  Every repo now runs codewatch, then its own .git/hooks (exit codes pass through).');
  console.log('  Results go to each repo\'s .prism/results/ (excluded locally via .git/info/exclude).');
  console.log(`  Opt a repo out:  git config ${OPT_OUT_KEY} false`);
  console.log('  Not covered:     repos that set their own core.hooksPath (husky and similar)');
  console.log('  Remove:          prism-cli enable codewatch --global --uninstall');
}
