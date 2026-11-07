import { runGuarded } from '../enable/security.js';
import { connectionDefaults } from '../../aws/connection.js';
import { FAIL_ON_LEVELS, securityFindings, type FindingsOptions } from '../../security/review.js';
import { securityPentestFindings, type PentestOptions } from '../../security/pentest.js';
import { REVIEW_TARGET_OPTIONS, reviewDeps, type ReviewHooks } from './code-review.js';

export default {
  description: 'List the findings of this repo\'s latest AWS Security Agent code review (or, with --pentest, its penetration test) and cache them for the dashboard (read-only)',
  options: [
    ...REVIEW_TARGET_OPTIONS,
    { flags: '--job <id>', description: 'A specific code review job (default: the latest for this repo)' },
    { flags: '--latest', description: 'The latest job for this repo (the default)' },
    { flags: '--severity <level>', description: `Show only findings at or above: ${FAIL_ON_LEVELS.join(' | ')}` },
    { flags: '--pentest [job]', description: 'Read the latest (or given) penetration-test job instead of a code review' },
    { flags: '--include-false-positives', description: 'With --pentest: show findings the agent rated FALSE_POSITIVE confidence' },
    { flags: '--wait', description: 'If the job is still running, wait for it' },
    { flags: '--timeout <minutes>', description: 'How long --wait waits (code review: 30; pentest: 360)' },
    { flags: '--json', description: 'Print only the result JSON' },
  ],
  async action(opts: FindingsOptions & { pentest?: boolean | string; includeFalsePositives?: boolean }, hooks: ReviewHooks = {}) {
    await runGuarded(() => {
      // Defaults first, so the runners use the saved profile too.
      const base = connectionDefaults({ ...opts, profile: opts.profile || undefined, region: opts.region || undefined }, hooks.env);
      const deps = (hooks.reviewDeps ?? reviewDeps)(base);
      if (opts.pentest !== undefined && opts.pentest !== false) {
        const job = typeof opts.pentest === 'string' ? opts.pentest : opts.job;
        const o: PentestOptions = { ...base, job };
        return securityPentestFindings(o, deps);
      }
      return securityFindings(base, deps);
    }, hooks);
  },
};
