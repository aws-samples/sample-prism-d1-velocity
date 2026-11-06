import { runGuarded } from '../enable/security.js';
import { FAIL_ON_LEVELS, securityFindings, type FindingsOptions } from '../../security/review.js';
import { REVIEW_TARGET_OPTIONS, reviewDeps, type ReviewHooks } from './code-review.js';

export default {
  description: 'List the findings of this repo\'s latest (or --job) AWS Security Agent code review and cache them for the dashboard (read-only)',
  options: [
    ...REVIEW_TARGET_OPTIONS,
    { flags: '--job <id>', description: 'A specific code review job (default: the latest for this repo)' },
    { flags: '--latest', description: 'The latest job for this repo (the default)' },
    { flags: '--severity <level>', description: `Show only findings at or above: ${FAIL_ON_LEVELS.join(' | ')}` },
    { flags: '--wait', description: 'If the job is still running, wait for it' },
    { flags: '--timeout <minutes>', description: 'How long --wait waits (default: 30)' },
    { flags: '--json', description: 'Print only the result JSON' },
  ],
  async action(opts: FindingsOptions, hooks: ReviewHooks = {}) {
    await runGuarded(() => {
      const o: FindingsOptions = { ...opts, profile: opts.profile || undefined, region: opts.region || undefined };
      return securityFindings(o, (hooks.reviewDeps ?? reviewDeps)(o));
    }, hooks);
  },
};
