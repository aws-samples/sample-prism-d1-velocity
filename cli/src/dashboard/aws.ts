/**
 * The AWS account panel: the latest cached `aws check` result per account,
 * from .prism/results/ in each repo and in ~. Local files only; no AWS calls.
 */
import { readResults, type PrismResult } from '../codewatch/results.js';
import { severityRank, type Severity } from '../utils/audit.js';

export const MAX_TOP_FAILURES = 5;
export const AWS_CHECK_HINT = 'prism-cli aws check';
export const AWS_RECOMMEND_HINT = 'prism-cli aws recommend';

export interface AwsAccountRow {
  account: string;
  alias: string | null;
  region: string;
  profile: string | null;
  profile_source: string | null;
  checked_at: string;
  counts: { pass: number; fail: number; indeterminate: number };
  fail_by_severity: Record<Severity, number>;
  /** The worst FAILs first. */
  top_failures: { id: string; title: string; severity: Severity; section: string }[];
  /** FAILs beyond MAX_TOP_FAILURES. */
  more: number;
}

export interface AwsPanel { accounts: AwsAccountRow[]; hint: string; recommend_hint: string }

export function collectAws(roots: string[], read: (root: string) => PrismResult[] = readResults): AwsPanel {
  const latest = new Map<string, PrismResult>();
  for (const root of new Set(roots)) {
    for (const r of read(root)) {
      const c = r.kind === 'aws-check' ? r.aws_check : undefined;
      if (!c?.account) continue;
      const prev = latest.get(c.account);
      if (!prev || r.started_at > prev.started_at) latest.set(c.account, r);
    }
  }
  const accounts = [...latest.values()].map((r): AwsAccountRow => {
    const c = r.aws_check!;
    const fails = (c.checks || []).filter((f) => f.status === 'FAIL')
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id));
    return {
      account: c.account, alias: c.alias, region: c.region, profile: c.profile, profile_source: c.profile_source,
      checked_at: r.started_at, counts: c.counts, fail_by_severity: c.fail_by_severity,
      top_failures: fails.slice(0, MAX_TOP_FAILURES).map((f) => ({ id: f.id, title: f.title, severity: f.severity, section: f.category })),
      more: Math.max(0, fails.length - MAX_TOP_FAILURES),
    };
  }).sort((a, b) => b.checked_at.localeCompare(a.checked_at));
  return { accounts, hint: AWS_CHECK_HINT, recommend_hint: AWS_RECOMMEND_HINT };
}
