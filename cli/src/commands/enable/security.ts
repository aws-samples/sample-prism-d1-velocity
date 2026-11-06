import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { aws } from '../../utils/aws.js';
import { run } from '../../utils/exec.js';
import { getAssetPath } from '../../utils/root.js';
import { describeUnexpectedError } from '../../security/errors.js';
import { enableSecurity, type CdkEnv, type CdkRunner, type Deps, type SecurityOptions } from '../../security/setup.js';

/** Room for the full synth and diff output of the whole app. */
const CDK_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

/** Resolved on first use, so importing this module (tests, --help) needs no built assets. */
let infraDir: string | null = null;
const INFRA = () => (infraDir ??= getAssetPath(import.meta.url, 'infra'));

/** npm_* variables from the outer `npm` would leak into the infra project's own npm/cdk runs. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('npm_')) delete env[k];
  return env;
}

function ensureInfraDeps(): void {
  if (existsSync(resolve(INFRA(), 'node_modules'))) return;
  console.log('Installing the CDK app dependencies (local, one time)...');
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: INFRA(), stdio: 'inherit', env: cleanEnv({}) });
}

/**
 * CDK runs with the default credential chain unless --profile was given, and
 * always in the resolved region, so every step works in the same place.
 */
function cdkRunner(opts: SecurityOptions): CdkRunner {
  const bin = () => resolve(INFRA(), 'node_modules/.bin/cdk');
  const profile = opts.profile ? ['--profile', opts.profile] : [];
  const env = (e: CdkEnv) => cleanEnv({ CDK_DEFAULT_ACCOUNT: e.account, CDK_DEFAULT_REGION: e.region, AWS_DEFAULT_REGION: e.region, AWS_REGION: e.region, AWS_PAGER: '' });
  return {
    synth(outDir, context, e) {
      ensureInfraDeps();
      const ctx = Object.entries(context).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
      const r = spawnSync(bin(), ['synth', '--quiet', '-o', outDir, ...ctx, ...profile], { cwd: INFRA(), env: env(e), encoding: 'utf8', maxBuffer: CDK_OUTPUT_MAX_BUFFER });
      return { ok: r.status === 0, stdout: r.stdout || '', stderr: `${r.stderr || ''}${r.error ? r.error.message : ''}` };
    },
    diff(outDir, stack, e) {
      // cdk diff prints to stderr; keep both streams.
      const r = spawnSync(bin(), ['diff', '--app', outDir, stack, '--exclusively', '--no-color', ...profile], { cwd: INFRA(), env: env(e), encoding: 'utf8', maxBuffer: CDK_OUTPUT_MAX_BUFFER });
      return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}` };
    },
    deploy(outDir, stack, e, { approveAll }) {
      // Interactive: CDK's own default (--require-approval broadening) also asks
      // before IAM/security-group broadening. --yes is the user's explicit
      // approval, given after seeing the plan, so CDK is not asked again.
      const approval = approveAll ? ['--require-approval', 'never'] : [];
      const r = spawnSync(bin(), ['deploy', '--app', outDir, stack, '--exclusively', ...approval, ...profile], { cwd: INFRA(), env: env(e), stdio: 'inherit' });
      return r.status === 0;
    },
  };
}

export function defaultDeps(opts: SecurityOptions): Deps {
  const target = opts.profile ? { profile: opts.profile } : {};
  return {
    aws: (args, region) => aws([...args, '--region', region], { ...target, env: { AWS_PAGER: '' } }),
    configRegion: (profile) => {
      const r = run('aws', ['configure', 'get', 'region', ...(profile ? ['--profile', profile] : [])]);
      return r.ok && r.stdout ? r.stdout : null;
    },
    env: process.env,
    awsVersion: () => { const r = run('aws', ['--version']); return r.ok ? r.stdout : null; },
    cdk: cdkRunner(opts),
    git: (args) => run('git', args),
    makeTempDir: () => mkdtempSync(join(tmpdir(), 'prism-enable-security-')),
    isTTY: !!(process.stdin.isTTY && process.stdout.isTTY),
    ask: (q) => new Promise((done) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(q, (a) => { rl.close(); done(a); });
    }),
    log: (line = '') => console.log(line),
    now: () => new Date(),
  };
}

const collect = (v: string, prev: string[] = []) => [...prev, v];

export const SECURITY_OPTIONS: { flags: string; description: string; default?: string; parser?: (v: string, prev?: string[]) => string[] }[] = [
  { flags: '--profile <name>', description: 'AWS CLI profile (default: none; the standard credential chain, e.g. AWS_PROFILE, env keys, SSO, instance role)' },
  { flags: '--region <region>', description: 'AWS region (default: AWS_REGION, AWS_DEFAULT_REGION, else the profile\'s configured region; refuses when none is set)' },
  { flags: '--yes', description: 'Approve the changes without a prompt (CI and other non-interactive use)' },
  { flags: '--dry-run', description: 'Run every read-only step and print the plan, including the exact calls; change nothing' },
  { flags: '--status', description: 'Read-only report: credentials, stack, agent space, application, code review, SSM, CI step' },
  { flags: '--repo <host/owner/name>', description: 'Repo id for the code review, as the CI gate names it (default: from the origin remote)' },
  { flags: '--context <key=value>', description: 'Extra cdk context, repeatable (match how the stack was deployed, e.g. skipVpc=true)', parser: collect },
];

/** Test seams: everything else uses the real runners, console and process. */
export interface RunHooks {
  deps?: (opts: SecurityOptions) => Deps;
  error?: (line: string) => void;
  exit?: (code: number) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * The one entry point for `enable security` and its `securityagent setup`
 * alias. Abort errors are already printed by enableSecurity; anything else
 * (a failed npm or cdk run, a JSON parse, git or fs) is caught here and
 * printed as one redacted line plus a hint, never as a raw stack or an
 * unhandled rejection. PRISM_DEBUG=1 adds the redacted stack.
 */
export async function runEnableSecurity(opts: SecurityOptions, hooks: RunHooks = {}): Promise<void> {
  const exit = hooks.exit ?? ((c: number) => process.exit(c));
  const error = hooks.error ?? ((l: string) => console.error(l));
  let code: number;
  try {
    const o: SecurityOptions = { ...opts, profile: opts.profile || undefined, region: opts.region || undefined };
    code = await enableSecurity(o, (hooks.deps ?? defaultDeps)(o));
  } catch (e) {
    for (const l of describeUnexpectedError(e, hooks.env ?? process.env)) error(l);
    code = 1;
  }
  if (code !== 0) exit(code);
}

export default {
  description: 'Set up AWS Security Agent: deploy only its stack (after a diff and your confirmation), then the application, the code review for this repo and its SSM pointer',
  options: SECURITY_OPTIONS,
  action: runEnableSecurity,
};
