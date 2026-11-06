import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { aws } from '../../utils/aws.js';
import { run } from '../../utils/exec.js';
import { getAssetPath } from '../../utils/root.js';
import { enableSecurity, STACK_NAME, type CdkRunner, type Deps, type SecurityOptions } from '../../security/setup.js';

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

function cdkRunner(opts: SecurityOptions): CdkRunner {
  const bin = () => resolve(INFRA(), 'node_modules/.bin/cdk');
  const profile = opts.profile ? ['--profile', opts.profile] : [];
  const env = (account: string) => cleanEnv({ CDK_DEFAULT_ACCOUNT: account, CDK_DEFAULT_REGION: opts.region, AWS_DEFAULT_REGION: opts.region, AWS_REGION: opts.region, AWS_PAGER: '' });
  return {
    synth(outDir, context, account) {
      ensureInfraDeps();
      const ctx = Object.entries(context).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
      const r = spawnSync(bin(), ['synth', '--quiet', '-o', outDir, ...ctx, ...profile], { cwd: INFRA(), env: env(account), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return { ok: r.status === 0, stdout: r.stdout || '', stderr: `${r.stderr || ''}${r.error ? r.error.message : ''}` };
    },
    diff(outDir, account) {
      // cdk diff prints to stderr; keep both streams.
      const r = spawnSync(bin(), ['diff', '--app', outDir, STACK_NAME, '--exclusively', '--no-color', ...profile], { cwd: INFRA(), env: env(account), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}` };
    },
    deploy(outDir, account, { approveAll }) {
      // Interactive: CDK's own default (--require-approval broadening) also asks
      // before IAM/security-group broadening. --yes is the user's explicit
      // approval, given after seeing the plan, so CDK is not asked again.
      const approval = approveAll ? ['--require-approval', 'never'] : [];
      const r = spawnSync(bin(), ['deploy', '--app', outDir, STACK_NAME, '--exclusively', ...approval, ...profile], { cwd: INFRA(), env: env(account), stdio: 'inherit' });
      return r.status === 0;
    },
  };
}

export function defaultDeps(opts: SecurityOptions): Deps {
  const target = opts.profile ? { profile: opts.profile } : undefined;
  return {
    aws: (args) => aws([...args, '--region', opts.region], { ...target, env: { AWS_PAGER: '' } }),
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

export const SECURITY_OPTIONS = [
  { flags: '--profile <name>', description: 'AWS CLI profile', default: process.env.AWS_PROFILE || '' },
  { flags: '--region <region>', description: 'AWS region', default: 'us-west-2' },
  { flags: '--yes', description: 'Approve the changes without a prompt (CI and other non-interactive use)' },
  { flags: '--dry-run', description: 'Run every read-only step and print the plan, including the exact calls; change nothing' },
  { flags: '--status', description: 'Read-only report: credentials, stack, agent space, application, code review, SSM, CI step' },
  { flags: '--repo <host/owner/name>', description: 'Repo id for the code review, as the CI gate names it (default: from the origin remote)' },
  { flags: '--context <key=value>', description: 'Extra cdk context, repeatable (match how the stack was deployed, e.g. skipVpc=true)', parser: collect },
];

export async function runEnableSecurity(opts: SecurityOptions & { profile?: string }): Promise<void> {
  const o: SecurityOptions = { ...opts, profile: opts.profile || undefined };
  const code = await enableSecurity(o, defaultDeps(o));
  if (code !== 0) process.exit(code);
}

export default {
  description: 'Set up AWS Security Agent: deploy only its stack (after a diff and your confirmation), then the application, the code review for this repo and its SSM pointer',
  options: SECURITY_OPTIONS,
  action: runEnableSecurity,
};
