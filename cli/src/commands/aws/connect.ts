import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { aws } from '../../utils/aws.js';
import { run } from '../../utils/exec.js';
import { configuredRegion, listProfiles } from '../../aws/connection.js';
import { awsConnect, type ConnectDeps, type ConnectOptions } from '../../aws/connect.js';
import { runGuarded, type RunHooks } from '../enable/security.js';

export function connectDeps(): ConnectDeps {
  return {
    aws: (args, profile, region) => aws([...args, '--region', region], { profile, env: { AWS_PAGER: '' } }),
    listProfiles,
    configRegion: configuredRegion,
    git: (args) => run('git', args),
    env: process.env,
    home: homedir(),
    cwd: () => process.cwd(),
    isTTY: !!(process.stdin.isTTY && process.stdout.isTTY),
    ask: (q) => new Promise((done) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(q, (a) => { rl.close(); done(a); });
    }),
    log: (line = '') => console.log(line),
    now: () => new Date(),
  };
}

export interface ConnectHooks extends RunHooks { connectDeps?: () => ConnectDeps }

export default {
  description: 'Choose and verify the AWS profile and region the other AWS commands default to (read-only; stores no credentials)',
  options: [
    { flags: '--profile <name>', description: 'AWS CLI profile to save (default: choose from aws configure list-profiles on a terminal)' },
    { flags: '--region <region>', description: 'Region to save (default: AWS_REGION, AWS_DEFAULT_REGION or the profile\'s region; asked on a terminal)' },
    { flags: '--repo', description: 'Save (or clear) a per-repo override in .prism/aws.local.json instead of ~/.prism/aws.json' },
    { flags: '--status', description: 'Show what is saved, where it comes from, and whether it still validates' },
    { flags: '--clear', description: 'Remove the saved connection (the user file, or the repo file with --repo)' },
  ],
  async action(opts: ConnectOptions, hooks: ConnectHooks = {}) {
    await runGuarded(() => awsConnect(
      { ...opts, profile: opts.profile || undefined, region: opts.region || undefined },
      (hooks.connectDeps ?? connectDeps)(),
    ), hooks);
  },
};
