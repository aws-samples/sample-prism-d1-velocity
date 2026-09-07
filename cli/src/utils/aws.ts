/**
 * Thin JSON wrapper over the AWS CLI for the audit commands.
 *
 * Uses `run()` (execFileSync with an args array, no shell), so nothing here is
 * exposed to shell interpretation even though callers pass a user-supplied
 * --profile and --region.
 */

import { run } from './exec.js';

/**
 * Where an AWS call should be made: a named CLI profile, or temporary
 * credentials from an assumed role.
 *
 * Both are carried in one object so every check function is agnostic about how
 * the caller authenticated. `scan-account` supplies a profile; `scan-org`
 * supplies assumed-role credentials per member account. Credentials travel in
 * the child process environment rather than being written to `~/.aws/config`,
 * so nothing is persisted and the assumed role cannot leak into a later call.
 */
export interface AwsTarget {
  /** AWS CLI profile name. */
  profile?: string;
  /** Temporary credentials injected into the child environment. A key mapped
   *  to undefined is removed from it. */
  env?: Record<string, string | undefined>;
}

export interface AwsResult {
  ok: boolean;
  json: any;
  /** AWS error code parsed from stderr, e.g. NoSuchEntity, when ok === false. */
  errorCode: string;
  /** stderr on failure, stdout on an unparseable success. */
  raw: string;
}

/**
 * Several AWS commands exit 0 with a COMPLETELY EMPTY body when the thing being
 * described does not exist -- measured on `budgets describe-budgets` with no
 * budgets, and on `bedrock get-model-invocation-logging-configuration` with
 * logging disabled. `JSON.parse('')` throws, so a naive wrapper crashes on
 * precisely the accounts that most need auditing. Empty output is normalised to
 * {} here and interpreted by each individual check.
 */
export function aws(args: string[], target?: AwsTarget): AwsResult {
  const argv = target?.profile ? [...args, '--profile', target.profile] : args;
  const res = run('aws', [...argv, '--output', 'json'], target?.env);
  const body = (res.stdout || '').trim();

  if (!res.ok) {
    const m = /An error occurred \(([A-Za-z0-9.]+)\)/.exec(res.stderr || '');
    return { ok: false, json: null, errorCode: m ? m[1] : '', raw: res.stderr || '' };
  }
  if (!body) return { ok: true, json: {}, errorCode: '', raw: '' };
  try {
    return { ok: true, json: JSON.parse(body), errorCode: '', raw: body };
  } catch {
    return { ok: false, json: null, errorCode: 'UnparseableResponse', raw: body };
  }
}

/**
 * Assume a role and return credentials as an env fragment, or an error string.
 *
 * Deliberately returns the failure rather than throwing: at org scale a role
 * that cannot be assumed is an expected condition (an account onboarded without
 * the role, an SCP denying it), and the caller must surface that account as
 * INDETERMINATE rather than dropping it. A silently skipped account is exactly
 * how an org audit ends up reporting on a subset while looking complete.
 */
export function assumeRole(
  accountId: string,
  roleName: string,
  sessionName: string,
  durationSeconds: number,
  from?: AwsTarget,
  region?: string,
): { env: Record<string, string | undefined> } | { error: string } {
  const res = aws([
    'sts', 'assume-role',
    '--role-arn', `arn:aws:iam::${accountId}:role/${roleName}`,
    '--role-session-name', sessionName,
    '--duration-seconds', String(durationSeconds),
  ], from);

  if (!res.ok) {
    const reason = res.errorCode
      || (res.raw.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? 'unknown error');
    return { error: reason };
  }
  const c = res.json?.Credentials;
  if (!c?.AccessKeyId || !c?.SecretAccessKey || !c?.SessionToken) {
    return { error: 'assume-role returned no usable credentials' };
  }
  return {
    env: {
      AWS_ACCESS_KEY_ID: c.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: c.SecretAccessKey,
      AWS_SESSION_TOKEN: c.SessionToken,
      // REMOVED, not blanked. A profile left in the ambient environment takes
      // precedence over the injected keys and would silently audit the WRONG
      // account -- the worst failure available here, since every finding would
      // be misattributed. Blanking instead of removing breaks the CLI outright.
      AWS_PROFILE: undefined,
      AWS_DEFAULT_PROFILE: undefined,
      // The unset profile also took its region with it, so pin one explicitly
      // rather than depending on whatever the CLI can still resolve.
      ...(region ? { AWS_REGION: region, AWS_DEFAULT_REGION: region } : {}),
    },
  };
}

/**
 * Resolve the caller's account id, or print guidance and return null.
 *
 * Not every failure is an AWS API error with a parseable code -- an unknown
 * --profile fails in the CLI's own config layer and never reaches the service,
 * so fall back to its stderr rather than reporting "unknown error".
 */
export function resolveAccount(target?: AwsTarget): string | null {
  const who = aws(['sts', 'get-caller-identity'], target);
  if (who.ok) return who.json?.Account ?? null;

  const reason = who.errorCode
    || (who.raw.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? 'unknown error');
  console.error(`\n❌ Cannot resolve AWS identity: ${reason}`);
  console.error(`   Configure credentials, or pass --profile <name>.\n`);
  return null;
}

export function daysSince(iso: string): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export const PROFILE_OPTION = {
  flags: '--profile <name>',
  description: 'AWS CLI profile to audit (defaults to the ambient credentials)',
};
