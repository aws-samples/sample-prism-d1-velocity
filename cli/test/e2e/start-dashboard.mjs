// Starts the built `prism-cli dashboard` (cli/dist) against a seeded demo HOME, in a minimal
// environment: nothing is inherited from the caller, so no AWS_* variable, token or profile leaks in.
// PATH is <home>/bin (node, the fake codeburn and the fake aws from fakebin/) plus /usr/bin:/bin.
// prism-cli makes every AWS call through the aws CLI, so the fake one keeps the run away from AWS.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI = resolve(HERE, '..', '..');
export const ENTRY = join(CLI, 'dist', 'bin', 'prism-cli.js');

/** <home>/bin with node and the fakes; `noCodeburn` leaves codeburn out (the "not installed" state). */
export function binDir(home, opt = {}) {
  const bin = join(home, opt.noCodeburn ? 'bin-nocb' : opt.reviewers ? 'bin-rev' : 'bin');
  mkdirSync(bin, { recursive: true });
  const link = (target, name) => { if (!existsSync(join(bin, name))) symlinkSync(target, join(bin, name)); };
  link(process.execPath, 'node');
  link(join(HERE, 'fakebin', 'aws'), 'aws');
  if (!opt.noCodeburn) link(join(HERE, 'fakebin', 'codeburn'), 'codeburn');
  // opt.reviewers: fake reviewer tools on PATH (fakebin/reviewer: logs and exits 1, never reviews).
  for (const r of opt.reviewers || []) link(join(HERE, 'fakebin', 'reviewer'), r);
  return bin;
}

/** AWS variables set to '' in every run, so no credential, profile or region can come from anywhere else. */
export const EMPTIED_AWS_VARS = [
  'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION',
];

/** Throws unless `aws` on env.PATH is fakebin/aws: a run must never reach the real AWS CLI (or an instance profile). */
export function assertFakeAws(env) {
  const found = spawnSync('sh', ['-c', 'command -v aws'], { env, encoding: 'utf8' }).stdout.trim();
  let ok = false;
  try { ok = !!found && realpathSync(found) === realpathSync(join(HERE, 'fakebin', 'aws')); } catch { ok = false; }
  if (!ok) throw new Error(`refusing to run: aws on PATH is ${found || 'missing'}, not ${join(HERE, 'fakebin', 'aws')}`);
  if (env.AWS_EC2_METADATA_DISABLED !== 'true') throw new Error('refusing to run: AWS_EC2_METADATA_DISABLED is not true');
  return env;
}

/** The minimal environment every run uses. Every CLI spawn in the e2e run gets it, so each one is checked. */
export function demoEnv(home, extra = {}, opt = {}) {
  mkdirSync(join(home, 'tmp'), { recursive: true });
  const env = {
    HOME: home, USER: 'demo', LANG: 'C.UTF-8', TZ: 'UTC', TMPDIR: join(home, 'tmp'),
    PATH: `${binDir(home, opt)}:/usr/bin:/bin`,
    GIT_CONFIG_NOSYSTEM: '1',
    ...Object.fromEntries(EMPTIED_AWS_VARS.map((k) => [k, ''])),
    ...extra,
    AWS_EC2_METADATA_DISABLED: 'true',
  };
  return assertFakeAws(env);
}

/** Resolves { url, port, proc, getLog } once the server prints its URL. */
export function startDashboard(home, extraEnv = {}, args = [], opt = {}) {
  if (!existsSync(ENTRY)) throw new Error(`${ENTRY} is missing: run npm run build in cli/ first`);
  const cwd = readFileSync(join(home, '.start-dir'), 'utf8').trim();
  const proc = spawn(process.execPath, [ENTRY, 'dashboard', '--no-open', ...args], { cwd, env: demoEnv(home, extraEnv, opt), stdio: ['pipe', 'pipe', 'pipe'] });
  let log = '';
  return new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error('dashboard did not print its URL in 30 s\n' + log)), 30000);
    proc.stdout.on('data', (b) => {
      log += b.toString();
      const m = /(http:\/\/127\.0\.0\.1:(\d+)\/\?token=[A-Za-z0-9_-]+)/.exec(log);
      if (m) { clearTimeout(t); ok({ url: m[1], port: Number(m[2]), proc, getLog: () => log }); }
    });
    proc.stderr.on('data', (b) => { log += b.toString(); });
    proc.on('exit', (c) => { clearTimeout(t); fail(new Error(`dashboard exited ${c}\n${log}`)); });
  });
}
