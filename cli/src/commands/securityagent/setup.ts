import { runEnableSecurity, SECURITY_OPTIONS } from '../enable/security.js';
import type { SecurityOptions } from '../../security/setup.js';

/**
 * DEPRECATED alias for `prism-cli enable security`.
 *
 * The old command ran `cdk deploy --all --require-approval never`, always
 * re-attached the application role, and wrote the code review id to an SSM
 * parameter the CI eval gate never read. `enable security` replaces it: it
 * deploys only the Security Agent stack after a diff and a confirmation, is
 * idempotent, and writes the per-repo parameter the gate uses. The command is
 * kept so existing scripts and docs keep working; it takes the same flags as
 * `enable security`, so a script that relied on the old unattended run needs
 * --yes now.
 */
export const DEPRECATION = [
  '⚠  "prism-cli securityagent setup" is deprecated; use "prism-cli enable security".',
  '   It now shows a diff and asks before deploying (pass --yes to approve without a prompt).',
];

export default {
  description: '[deprecated] Alias for "prism-cli enable security"',
  options: SECURITY_OPTIONS,
  async action(opts: SecurityOptions) {
    for (const l of DEPRECATION) console.warn(l);
    console.warn('');
    await runEnableSecurity(opts);
  },
};
