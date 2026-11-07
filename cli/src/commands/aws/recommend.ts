import { connectionDefaults } from '../../aws/connection.js';
import { awsRecommend, type RecommendOptions } from '../../aws/recommend.js';
import { runGuarded } from '../enable/security.js';
import { AWS_TARGET_OPTIONS, checkDeps, type CheckHooks } from './check.js';

export default {
  description: 'Turn the latest aws check result into a ranked fix list (no AWS calls; --refresh runs aws check first)',
  options: [
    ...AWS_TARGET_OPTIONS,
    { flags: '--account <id>', description: 'Account whose result to read (default: the aws connect account, else the latest result)' },
    { flags: '--refresh', description: 'Run prism-cli aws check first (read-only AWS calls)' },
    { flags: '--json', description: 'Print the recommendations as JSON' },
    { flags: '--markdown', description: 'Also write a Markdown report next to the result in .prism/results/' },
  ],
  async action(opts: RecommendOptions, hooks: CheckHooks = {}) {
    await runGuarded(async () => {
      const o = connectionDefaults({ ...opts, profile: opts.profile || undefined, region: opts.region || undefined }, hooks.env);
      return awsRecommend(o, (hooks.checkDeps ?? checkDeps)());
    }, hooks);
  },
};
