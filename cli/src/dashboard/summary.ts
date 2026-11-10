/**
 * The dashboard's one-glance summary: the latest codewatch review, spend
 * today and this month, and the setup warnings. One function, so the page,
 * `--json` and any later status line print the same object.
 */
import type { CodewatchPanel } from './codewatch.js';
import type { CheckItem, CodewatchSetup } from './setup.js';
import type { UsagePanel } from './usage.js';

export interface DashboardSummary {
  /** The newest pre-push review in any repo, whatever its verdict; null when there is none. */
  review: {
    repo: string;
    path: string;
    at: string;
    /** ok (clean), findings, error or skipped. */
    status: string;
    reason: string | null;
    high: number;
    medium: number;
    low: number;
    reviewer: string;
    /** Result id, for the report link. */
    id: string;
  } | null;
  spend: { status: UsagePanel['status']; currency: string; today: number | null; month: number | null; message: string | null };
  /** Checks in the warn state or needing an administrator (help set): machine checks, then repos whose own hooks bypass codewatch. */
  warnings: { count: number; first: string | null };
}

export interface SummaryRepo {
  path: string;
  label: string;
  codewatch: Pick<CodewatchPanel, 'scans'>;
  setup: Pick<CodewatchSetup, 'status' | 'detail'>;
}

export function buildSummary(repos: SummaryRepo[], usage: UsagePanel, machine: CheckItem[]): DashboardSummary {
  let review: DashboardSummary['review'] = null;
  for (const r of repos) {
    const s = r.codewatch.scans[0]; // newest first
    if (s && (!review || s.started_at > review.at)) {
      review = { repo: r.label, path: r.path, at: s.started_at, status: s.status, reason: s.reason, high: s.high, medium: s.medium, low: s.low, reviewer: s.tool, id: s.id };
    }
  }
  const warnings = [
    // A check with help (it needs an administrator) counts whatever its status, and its hint is the warning text.
    ...machine.filter((i) => i.help || i.status === 'warn').map((i) => i.help ? i.help.text : `${i.label}: ${i.detail}`),
    ...repos.filter((r) => r.setup.status === 'warn').map((r) => `${r.label}: ${r.setup.detail}`),
  ];
  return {
    review,
    spend: { status: usage.status, currency: usage.currency, today: usage.today?.cost ?? null, month: usage.month?.cost ?? null, message: usage.message },
    warnings: { count: warnings.length, first: warnings[0] ?? null },
  };
}
