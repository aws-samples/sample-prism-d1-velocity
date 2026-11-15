// Starts the built `prism-cli dashboard` (cli/dist) against a seeded demo HOME, in a minimal
// environment: nothing is inherited from the caller, so no AWS_* variable, token or profile leaks in.
// PATH is <home>/bin (node, the fake codeburn and the fake aws from fakebin/) plus /usr/bin:/bin.
// prism-cli makes every AWS call through the aws CLI, so the fake one keeps the run away from AWS.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI = resolve(HERE, '..', '..');
export const ENTRY = join(CLI, 'dist', 'bin', 'prism-cli.js');

/** <home>/bin with node and the fakes; `noCodeburn` leaves codeburn out (the "not installed" state). */
export function binDir(home, opt = {}) {
  const bin = join(home, opt.noCodeburn ? 'bin-nocb' : 'bin');
  mkdirSync(bin, { recursive: true });
  const link = (target, name) => { if (!existsSync(join(bin, name))) symlinkSync(target, join(bin, name)); };
  link(process.execPath, 'node');
  link(join(HERE, 'fakebin', 'aws'), 'aws');
  if (!opt.noCodeburn) link(join(HERE, 'fakebin', 'codeburn'), 'codeburn');
  return bin;
}

/** The minimal environment every run uses. */
export function demoEnv(home, extra = {}, opt = {}) {
  mkdirSync(join(home, 'tmp'), { recursive: true });
  return {
    HOME: home, USER: 'demo', LANG: 'C.UTF-8', TZ: 'UTC', TMPDIR: join(home, 'tmp'),
    PATH: `${binDir(home, opt)}:/usr/bin:/bin`,
    AWS_EC2_METADATA_DISABLED: 'true',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
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
