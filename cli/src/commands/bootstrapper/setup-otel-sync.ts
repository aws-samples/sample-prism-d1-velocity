import { CODEBURN_OPTIONS, runEnableCodeburn, type CodeburnHooks, type CodeburnOptions } from '../enable/codeburn.js';

/**
 * DEPRECATED alias for `prism-cli enable codeburn`.
 *
 * `enable codeburn` is this command under its new name: the same flags, sync
 * setup and schedule, plus a codeburn install when it is missing (after a
 * confirmation), --dry-run, and re-runs that report what is already done. The
 * command is kept so existing scripts and docs keep working.
 */
export const DEPRECATION = [
  '⚠  "prism-cli bootstrapper setup-otel-sync" is deprecated; use "prism-cli enable codeburn".',
  '   It takes the same flags, and also installs codeburn when missing (asks first; --yes skips the prompt).',
];

export default {
  description: '[deprecated] Alias for "prism-cli enable codeburn"',
  options: CODEBURN_OPTIONS,
  /** Errors are handled once, in runEnableCodeburn, for this alias too. `hooks` is for tests. */
  async action(opts: CodeburnOptions, hooks?: CodeburnHooks) {
    for (const l of DEPRECATION) console.warn(l);
    console.warn('');
    await runEnableCodeburn(opts, hooks);
  },
};
