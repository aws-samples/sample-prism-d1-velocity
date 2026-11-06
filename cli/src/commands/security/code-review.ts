import { defaultDeps, runGuarded, type RunHooks } from '../enable/security.js';
import { FAIL_ON_LEVELS, securityCodeReview, type CodeReviewOptions, type ReviewDeps } from '../../security/review.js';
import type { SecurityOptions } from '../../security/setup.js';

/** The real runtime: enable security's runners plus a timer, Ctrl-C and the ticker. */
export function reviewDeps(opts: SecurityOptions): ReviewDeps {
  return {
    ...defaultDeps(opts),
    sleep: (ms, signal) => new Promise<void>((done) => {
      if (signal.aborted) return done();
      const t = setTimeout(done, ms);
      signal.addEventListener('abort', () => { clearTimeout(t); done(); }, { once: true });
    }),
    onInterrupt: (handler) => { process.once('SIGINT', handler); return () => { process.removeListener('SIGINT', handler); }; },
    ticker: (line) => { process.stderr.write(`\r\u001b[2K${line}`); },
    err: (line = '') => console.error(line),
    out: (text) => { process.stdout.write(text); },
  };
}

export const REVIEW_TARGET_OPTIONS = [
  { flags: '--profile <name>', description: 'AWS CLI profile (default: none; the standard credential chain)' },
  { flags: '--region <region>', description: 'AWS region (default: AWS_REGION, AWS_DEFAULT_REGION, else the profile\'s configured region)' },
  { flags: '--repo <host/owner/name>', description: 'Repo id for the code review, as the CI gate names it (default: from the origin remote)' },
];

export interface ReviewHooks extends RunHooks { reviewDeps?: (opts: SecurityOptions) => ReviewDeps }

export default {
  description: 'Run an AWS Security Agent code review of this branch (or --full repo) now, wait for it and print the findings',
  options: [
    ...REVIEW_TARGET_OPTIONS,
    { flags: '--full', description: 'Review the whole repo at HEAD instead of the branch diff' },
    { flags: '--timeout <minutes>', description: 'How long to wait for the job (default: 30)' },
    { flags: '--fail-on <level>', description: `Exit 1 when any finding is at or above this level: ${FAIL_ON_LEVELS.join(' | ')}` },
    { flags: '--json', description: 'Print only the final result JSON (progress goes to stderr)' },
    { flags: '--no-wait', description: 'Start the job, print its id and exit' },
  ],
  async action(opts: CodeReviewOptions, hooks: ReviewHooks = {}) {
    await runGuarded(() => {
      const o: CodeReviewOptions = { ...opts, profile: opts.profile || undefined, region: opts.region || undefined };
      return securityCodeReview(o, (hooks.reviewDeps ?? reviewDeps)(o));
    }, hooks);
  },
};
