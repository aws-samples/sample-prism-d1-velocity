import { runGuarded } from '../enable/security.js';
import { connectionDefaults } from '../../aws/connection.js';
import { FAIL_ON_LEVELS } from '../../security/review.js';
import { DEFAULT_TM_TIMEOUT_MIN, securityThreatModel, type ThreatModelOptions } from '../../security/threat-model.js';
import { REVIEW_TARGET_OPTIONS, reviewDeps, type ReviewHooks } from './code-review.js';

const collect = (v: string, prev: string[] = []) => [...prev, v];

export default {
  description: 'Run an AWS Security Agent threat model of this repo at HEAD, focused by design docs, wait for it and print the threats',
  options: [
    ...REVIEW_TARGET_OPTIONS,
    { flags: '--doc <path>', description: 'A design doc (scope doc) committed in HEAD, repeatable (default: .kiro/specs/*/design.md and requirements.md)', parser: collect },
    { flags: '--no-docs', description: 'Model the source alone, with no scope docs' },
    { flags: '--timeout <minutes>', description: `How long to wait for the job (default: ${DEFAULT_TM_TIMEOUT_MIN})` },
    { flags: '--fail-on <level>', description: `Exit 1 when any threat is at or above this level: ${FAIL_ON_LEVELS.join(' | ')}` },
    { flags: '--json', description: 'Print only the final result JSON (progress goes to stderr)' },
    { flags: '--no-wait', description: 'Start the job, print its id and exit' },
  ],
  async action(opts: ThreatModelOptions, hooks: ReviewHooks = {}) {
    await runGuarded(() => {
      const o: ThreatModelOptions = connectionDefaults({ ...opts, profile: opts.profile || undefined, region: opts.region || undefined }, hooks.env);
      return securityThreatModel(o, (hooks.reviewDeps ?? reviewDeps)(o));
    }, hooks);
  },
};
