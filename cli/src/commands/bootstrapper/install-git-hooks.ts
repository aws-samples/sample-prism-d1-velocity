import enableCodewatch from '../enable/codewatch.js';

/**
 * DEPRECATED alias for `prism-cli enable codewatch`.
 *
 * This used to install the prepare-commit-msg hook that wrote AI-Origin and
 * token/cost trailers. Commit trailers and the token tracker are retired (usage
 * tracking is codeburn), so that hook is no longer installed. The command is
 * kept so existing scripts and docs keep working: it prints a deprecation
 * notice and runs `enable codewatch`, which also removes the old trailer hook.
 *
 * The old trailer flags are accepted and ignored so pinned invocations do not
 * fail on an unknown option.
 */
export default {
  description: '[deprecated] Alias for "prism-cli enable codewatch" (the prepare-commit-msg trailer hook is retired)',
  options: [
    { flags: '--team-id <id>', description: '[ignored] retired with commit trailers' },
    { flags: '--max-tokens <n>', description: '[ignored] retired with the token tracker' },
    { flags: '--max-cost <n>', description: '[ignored] retired with the token tracker' },
    { flags: '--global', description: '[ignored] the global trailer template is no longer installed' },
    { flags: '--reviewer <tool>', description: 'Passed to enable codewatch' },
    { flags: '--uninstall', description: 'Passed to enable codewatch (also removes the legacy trailer hook on install)' },
  ],
  async action(opts: { teamId?: string; maxTokens?: string; maxCost?: string; global?: boolean; reviewer?: string; uninstall?: boolean }) {
    console.warn('⚠  "prism-cli bootstrapper install-git-hooks" is deprecated; use "prism-cli enable codewatch".');
    console.warn('   The prepare-commit-msg trailer hook (AI-Origin, token/cost limits) is retired; usage tracking is codeburn.');
    const ignored = ['teamId', 'maxTokens', 'maxCost', 'global'].filter((k) => (opts as Record<string, unknown>)[k] !== undefined);
    if (ignored.length) console.warn(`   Ignoring retired option(s): ${ignored.join(', ')}`);
    if (opts.global) {
      console.warn('   If you used --global before, remove the old template hook: ~/.git-templates/hooks/prepare-commit-msg');
    }
    console.warn('');
    await enableCodewatch.action({ reviewer: opts.reviewer, uninstall: opts.uninstall });
  },
};
