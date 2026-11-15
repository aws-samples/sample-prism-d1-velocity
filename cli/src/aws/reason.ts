/**
 * Why an `aws check` finding is INDETERMINATE, and what to do about it.
 *
 * Classified from the AWS CLI error (code and message) when the check has
 * it, else from the finding's detail (results written before 1.16.0, and the
 * bedrock-protection checks, whose detail carries the error code). Only an
 * access-denied read says "grant": a service that is not enabled, a throttled
 * call or a missing credential report has nothing to grant.
 */
import type { Finding, IndeterminateReason } from '../utils/audit.js';
import { ADVICE, GROUPS } from './advice.js';

export const NO_REPORT_STEP = 'No credential report exists yet. Run `prism-cli bedrock-protection scan-account` once (it generates one, which is a write) or `aws iam generate-credential-report`, then re-run aws check.';

const NO_REPORT = /ReportNotPresent/;
// Cost Explorer that is switched off answers AccessDeniedException "User not enabled for cost explorer access":
// the one access-denied-shaped error that is not about IAM, so it is matched before DENIED.
const CE_OFF = /not enabled for cost explorer/i;
const NOT_AVAILABLE = /OptInRequired|SubscriptionRequired|not (?:available|supported) in (?:this |the |your )?region/i;
// shortcut: 'Could not connect to the endpoint URL' stays 'other': it also means offline, DNS or a proxy. Classify it as not-available only if a regional service map is added.
const THROTTLED = /Throttl|TooManyRequests|RequestLimitExceeded|Rate exceeded|SlowDown/i;
const DENIED = /AccessDenied|UnauthorizedOperation|AuthorizationError|not authorized|Unauthorized/i;

/** The reason an AWS CLI error text points at, from its code and message. */
export function classifyAwsError(text: string): IndeterminateReason {
  if (NO_REPORT.test(text)) return 'no-credential-report';
  if (CE_OFF.test(text)) return 'not-available';
  // Access denied wins over a looser "not available" wording in the same message.
  if (DENIED.test(text)) return 'access-denied';
  if (NOT_AVAILABLE.test(text)) return 'not-available';
  if (THROTTLED.test(text)) return 'throttled';
  return 'other';
}

/** The IAM action an AccessDenied message names ("... is not authorized to perform: guardduty:ListDetectors ..."). */
export const deniedAction = (text: string): string | null => /not authorized to perform:?\s+([\w-]+:[\w*]+)/.exec(text)?.[1] ?? null;

/** The reason for a check id, from an error text: the check's own advice first (not integrated, waits on a fix). */
export function reasonFor(id: string, text: string): IndeterminateReason {
  const a = ADVICE[id];
  if (a?.indeterminate) return 'not-integrated';
  const r = classifyAwsError(text);
  return r === 'other' && a?.prerequisite ? 'prerequisite' : r;
}

/** A finding's stored reason, else the one its detail implies (older results). */
export const reasonOf = (f: Pick<Finding, 'id' | 'detail' | 'reason'>): IndeterminateReason => f.reason ?? reasonFor(f.id, f.detail);

/** One line of advice per reason. `needs` is used for access-denied only. */
export function reasonAdvice(reason: IndeterminateReason, id: string, needs: string[] = []): string {
  const a = ADVICE[id];
  switch (reason) {
    case 'access-denied':
      return needs.length ? `Grant ${needs.join(', ')} (read-only), then re-run prism-cli aws check.` : 'Grant read access for this check, then re-run prism-cli aws check.';
    case 'not-available':
      return 'The service is not enabled for this account, or not offered in this region; there is nothing to grant. Turn it on if you use it (or check a region where it is offered), then re-run prism-cli aws check.';
    case 'throttled':
      return 'AWS throttled the call (a rate limit); there is nothing to grant. Wait a minute, then re-run prism-cli aws check.';
    case 'no-credential-report':
      return NO_REPORT_STEP;
    case 'prerequisite': {
      const p = a?.prerequisite ?? '';
      return `${GROUPS[p]?.first ?? `Fix ${p}`} first, then re-run prism-cli aws check.`;
    }
    case 'not-integrated':
      return a?.indeterminate ?? 'Not integrated yet; nothing to grant or fix.';
    default:
      return 'The call failed without an access error (see the detail); re-run prism-cli aws check, and check the network and the AWS CLI if it repeats.';
  }
}

/**
 * Sets `reason`, `needs` (access-denied only) and the matching remediation on
 * an INDETERMINATE finding; other findings are returned unchanged. `text` is
 * the raw CLI error when the caller has it, `action` the IAM action the call
 * needs. Calling it again on its own output changes nothing.
 */
export function explainIndeterminate(f: Finding, text?: string, action?: string): Finding {
  if (f.status !== 'INDETERMINATE') return f;
  const reason = f.reason ?? reasonFor(f.id, text ?? f.detail);
  const named = text ? deniedAction(text) : null;
  const needs = reason !== 'access-denied' ? []
    : named ? [named] : action ? [action] : f.needs ?? ADVICE[f.id]?.needs ?? [];
  const { needs: _old, ...rest } = f;
  return { ...rest, reason, ...(needs.length ? { needs } : {}), remediation: reasonAdvice(reason, f.id, needs) };
}
