import { homedir } from 'node:os';
import { run } from '../../utils/exec.js';
import { FAIL_ON_OPTION, JSON_OPTION } from '../../utils/audit.js';
import { configuredRegion, connectionDefaults } from '../../aws/connection.js';
import { SECTIONS } from '../../aws/check.js';
import { awsCheck, type CheckOptions, type CheckRunDeps } from '../../aws/run-check.js';
import { runGuarded, type RunHooks } from '../enable/security.js';

export function checkDeps(): CheckRunDeps {
  return {
    env: process.env,
    home: homedir(),
    cwd: () => process.cwd(),
    configRegion: configuredRegion,
    awsVersion: () => { const r = run('aws', ['--version']); return r.ok ? r.stdout : null; },
    git: (args) => run('git', args),
    log: (line = '') => console.log(line),
    err: (line = '') => console.error(line),
    now: () => new Date(),
  };
}

const collect = (v: string, prev: string[] = []) => [...prev, v];

/** --profile and --region, shared by aws check and aws recommend. */
export const AWS_TARGET_OPTIONS = [
  { flags: '--profile <name>', description: 'AWS CLI profile (default: AWS_PROFILE or env credentials, else the one saved by prism-cli aws connect, else the default chain)' },
  { flags: '--region <region>', description: 'AWS region (default: AWS_REGION, AWS_DEFAULT_REGION, the aws connect region, else the profile\'s region; refuses when none is set)' },
];

export interface CheckHooks extends RunHooks { checkDeps?: () => CheckRunDeps }

export default {
  description: 'Read-only AWS account checks: Bedrock protection, PRISM setup, account baseline (results saved for aws recommend and the dashboard)',
  options: [
    ...AWS_TARGET_OPTIONS,
    { flags: '--section <name>', description: `Run only this section, repeatable: ${SECTIONS.map((s) => s.name).join(', ')} (default: all)`, parser: collect },
    { ...FAIL_ON_OPTION, description: 'Exit 1 if any FAIL is at or above this severity (CRITICAL|HIGH|MEDIUM|LOW|none; default none: report only)' },
    JSON_OPTION,
  ],
  async action(opts: CheckOptions, hooks: CheckHooks = {}) {
    await runGuarded(async () => {
      const o = connectionDefaults({ ...opts, profile: opts.profile || undefined, region: opts.region || undefined }, hooks.env);
      return awsCheck(o, (hooks.checkDeps ?? checkDeps)()).code;
    }, hooks);
  },
};
