/**
 * Thin JSON wrapper over the AWS CLI for the audit commands.
 *
 * Uses `run()` (execFileSync with an args array, no shell), so nothing here is
 * exposed to shell interpretation even though callers pass a user-supplied
 * --profile and --region.
 */

import { run } from './exec.js';

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
export function aws(args: string[], profile?: string): AwsResult {
  const argv = profile ? [...args, '--profile', profile] : args;
  const res = run('aws', [...argv, '--output', 'json']);
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
 * Resolve the caller's account id, or print guidance and return null.
 *
 * Not every failure is an AWS API error with a parseable code -- an unknown
 * --profile fails in the CLI's own config layer and never reaches the service,
 * so fall back to its stderr rather than reporting "unknown error".
 */
export function resolveAccount(profile?: string): string | null {
  const who = aws(['sts', 'get-caller-identity'], profile);
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
