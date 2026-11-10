import { connectionDefaults } from '../../aws/connection.js';
import { ADD_PERMISSIONS, addDeveloper, type AddDeveloperOptions } from '../../aws/team.js';
import { AWS_TARGET_OPTIONS } from '../aws/check.js';
import { runGuarded } from '../enable/security.js';
import { teamDeps, type TeamHooks } from './info.js';

export default {
  description: `AWS write: create a developer's telemetry account (Cognito user named by their email) after showing the plan and asking (needs ${ADD_PERMISSIONS})`,
  argument: { name: 'email', spec: '<email>', description: "the developer's email; it is also the username" },
  options: [
    ...AWS_TARGET_OPTIONS,
    { flags: '--user-pool-id <id>', description: "Cognito user pool (default: the PRISM stack's OtelUserPoolId output)" },
    { flags: '--yes', description: 'Create without the confirmation prompt (for scripts)' },
    { flags: '--dry-run', description: 'Show the plan (account, region, pool, email); change nothing' },
  ],
  async action(opts: AddDeveloperOptions, hooks: TeamHooks = {}) {
    await runGuarded(async () => {
      const o = connectionDefaults({ ...opts, profile: opts.profile || undefined, region: opts.region || undefined }, hooks.env);
      return addDeveloper(o, (hooks.teamDeps ?? teamDeps)());
    }, hooks);
  },
};
