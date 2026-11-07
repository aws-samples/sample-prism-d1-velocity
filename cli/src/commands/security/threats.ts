import { runGuarded } from '../enable/security.js';
import { connectionDefaults } from '../../aws/connection.js';
import { FAIL_ON_LEVELS } from '../../security/review.js';
import { DEFAULT_TM_TIMEOUT_MIN, securityThreats, type ThreatsOptions } from '../../security/threat-model.js';
import { REVIEW_TARGET_OPTIONS, reviewDeps, type ReviewHooks } from './code-review.js';

export default {
  description: 'List the threats of this repo\'s pending or latest (or --job) AWS Security Agent threat model and cache them for the dashboard (read-only)',
  options: [
    ...REVIEW_TARGET_OPTIONS,
    { flags: '--job <id>', description: 'A specific threat model job (default: the pending one, else the latest for this repo)' },
    { flags: '--latest', description: 'The latest job for this repo (the default)' },
    { flags: '--severity <level>', description: `Show only threats at or above: ${FAIL_ON_LEVELS.join(' | ')}` },
    { flags: '--wait', description: 'If the job is still running, wait for it' },
    { flags: '--timeout <minutes>', description: `How long --wait waits (default: ${DEFAULT_TM_TIMEOUT_MIN})` },
    { flags: '--json', description: 'Print only the result JSON' },
  ],
  async action(opts: ThreatsOptions, hooks: ReviewHooks = {}) {
    await runGuarded(() => {
      const o: ThreatsOptions = connectionDefaults({ ...opts, profile: opts.profile || undefined, region: opts.region || undefined }, hooks.env);
      return securityThreats(o, (hooks.reviewDeps ?? reviewDeps)(o));
    }, hooks);
  },
};
