import { createInterface } from 'node:readline';
import { JSON_OPTION } from '../../utils/audit.js';
import { configuredRegion, connectionDefaults } from '../../aws/connection.js';
import { INFO_PERMISSIONS, teamInfo, type TeamDeps, type TeamOptions } from '../../aws/team.js';
import { AWS_TARGET_OPTIONS } from '../aws/check.js';
import { runGuarded, type RunHooks } from '../enable/security.js';

export function teamDeps(): TeamDeps {
  return {
    env: process.env,
    configRegion: configuredRegion,
    isTTY: !!(process.stdin.isTTY && process.stdout.isTTY),
    ask: (q) => new Promise((done) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(q, (a) => { rl.close(); done(a.trim()); });
    }),
    log: (line = '') => console.log(line),
    err: (line = '') => console.error(line),
  };
}

export interface TeamHooks extends RunHooks { teamDeps?: () => TeamDeps }

export default {
  description: `Read-only: print the PRISM stack's OtelCollectorUrl and OtelUserPoolId, and the line to send developers (needs ${INFO_PERMISSIONS})`,
  options: [...AWS_TARGET_OPTIONS, JSON_OPTION],
  async action(opts: TeamOptions, hooks: TeamHooks = {}) {
    await runGuarded(async () => {
      const o = connectionDefaults({ ...opts, profile: opts.profile || undefined, region: opts.region || undefined }, hooks.env);
      return teamInfo(o, (hooks.teamDeps ?? teamDeps)());
    }, hooks);
  },
};
