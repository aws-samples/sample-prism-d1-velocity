import { resolve } from 'node:path';
import { run } from '../../utils/exec.js';
import { detectReviewers, isReviewerId, REVIEWER_IDS, type ReviewerId } from '../../codewatch/reviewers/index.js';
import { applySetting, clearOverrides, isScope, ORIGIN_LABEL, pinWarning, reviewerView, SCOPES, settingError, type Scope } from '../../codewatch/reviewer-settings.js';
import { GIT_CONFIG_LIST, parseConfigList } from '../../dashboard/setup.js';

/** The repo's git config, with scopes, for reviewerView. */
export function configEntries(root: string) {
  const r = run('git', ['-C', root, ...GIT_CONFIG_LIST]);
  return r.ok ? parseConfigList(r.stdout + '\0') : [];
}

export default {
  description: 'Show or change the reviewer and model codewatch\'s pre-push review uses here: just this clone, the team default (.prism/config.json) or your default for all repos',
  options: [
    { flags: '--scope <scope>', description: `Where to write: ${SCOPES.join(' | ')} (clone: git config --local; team: .prism/config.json eval, a file to commit that CI reads too; global: git config --global prism.<tool>Model)`, default: 'clone' },
    { flags: '--reviewer <tool>', description: `Reviewer: ${REVIEWER_IDS.join(' | ')} (with --scope global: the tool the model is for)` },
    { flags: '--model <id>', description: 'Review model id; auto or default means the tool\'s own default' },
    { flags: '--reset', description: 'Remove the reviewer and model settings at that scope' },
    { flags: '--path <dir>', description: 'Repository (default: the current one)' },
    { flags: '--clear-overrides <dir...>', description: 'Remove each repo\'s own reviewer and model (git config --local prism.reviewer, prism.<tool>Model) so it follows your default; .prism/config.json is not touched' },
  ],
  action(opts: { scope?: string; reviewer?: string; model?: string; reset?: boolean; path?: string; clearOverrides?: string[] }) {
    const fail = (m: string): never => { console.error(`Error: ${m}`); process.exit(1); };
    if (opts.clearOverrides) {
      if (opts.reviewer !== undefined || opts.model !== undefined || opts.reset) fail('--clear-overrides takes no other change');
      const roots = opts.clearOverrides.map((d) => {
        const t = run('git', ['-C', resolve(d), 'rev-parse', '--show-toplevel']);
        return t.ok ? t.stdout.trim() : fail(`not a git repository: ${resolve(d)}`);
      });
      let changed: string[] = [];
      try { changed = clearOverrides(roots, (a) => run('git', a)); } catch (e: any) { fail(e.message); }
      for (const r of changed) console.log(`✓ ${r}: removed its own reviewer and model; it follows your default now`);
      console.log(changed.length ? `${changed.length} of ${roots.length} repos changed.` : `None of the ${roots.length} repos had its own reviewer or model.`);
      return;
    }
    const scope = opts.scope ?? 'clone';
    const top = run('git', ['-C', resolve(opts.path || '.'), 'rev-parse', '--show-toplevel']);
    // Your default for all repos needs no repo: it is git config --global.
    if (!top.ok && scope !== 'global') fail(`not a git repository: ${resolve(opts.path || '.')}`);
    const root = top.ok ? top.stdout.trim() : resolve(opts.path || '.');
    const change = opts.reviewer !== undefined || opts.model !== undefined || !!opts.reset;
    if (change) {
      const err = settingError({ scope, reviewer: opts.reviewer, model: opts.model, reset: opts.reset });
      if (err) fail(err);
      const before = reviewerView(root, configEntries(root), detectReviewers());
      const reviewer = isReviewerId(opts.reviewer) ? opts.reviewer : undefined;
      try {
        for (const l of applySetting(root, (a) => run('git', a), { scope: scope as Scope, reviewer, model: opts.model, reset: opts.reset }, before.reviewer ?? before.wanted.id)) console.log(`✓ ${l}`);
      } catch (e: any) { fail(e.message); }
      const warn = isScope(scope) ? pinWarning(before, scope, opts.model, reviewer as ReviewerId | undefined) : null;
      if (warn) console.log(`! ${warn}`);
    }
    if (!top.ok) {
      const g = (k: string) => { const r = run('git', ['config', '--global', '--get', k]); return r.ok ? r.stdout.trim() : 'not set'; };
      console.log(`Your default: reviewer ${g('prism.reviewer')}; models: ${REVIEWER_IDS.map((id) => `${id} ${g(`prism.${id}Model`)}`).join(', ')}`);
      return;
    }
    const v = reviewerView(root, configEntries(root), detectReviewers());
    console.log(`Reviewer: ${v.reviewer ?? 'none'} (from ${ORIGIN_LABEL[v.reviewerFrom]})${v.fallback ? `; ${v.fallback}` : ''}`);
    console.log(`Model:    ${v.model} (from ${ORIGIN_LABEL[v.modelFrom]})${v.modelNote ? `; ${v.modelNote}` : ''}`);
  },
};
