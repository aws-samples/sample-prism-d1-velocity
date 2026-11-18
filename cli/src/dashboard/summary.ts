/**
 * The dashboard's one-glance summary: the latest codewatch review, spend
 * today and this month, and the setup warnings. One function, so the page,
 * `--json` and any later status line print the same object.
 */
import type { CodewatchPanel } from './codewatch.js';
import type { NeedsItem } from './needs-you.js';
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
  /** updatedAt: when the usage was collected (it may come from the cache). */
  spend: { status: UsagePanel['status']; currency: string; today: number | null; month: number | null; message: string | null; updatedAt: string | null };
  /** The Needs you list (needs-you.ts), the same one the Settings badges count: how many, and the first item's text. */
  warnings: { count: number; first: string | null };
}

export interface SummaryRepo {
  path: string;
  label: string;
  codewatch: Pick<CodewatchPanel, 'scans'>;
}

export function buildSummary(repos: SummaryRepo[], usage: UsagePanel, needs: NeedsItem[]): DashboardSummary {
  let review: DashboardSummary['review'] = null;
  for (const r of repos) {
    const s = r.codewatch.scans[0]; // newest first
    if (s && (!review || s.started_at > review.at)) {
      review = { repo: r.label, path: r.path, at: s.started_at, status: s.status, reason: s.reason, high: s.high, medium: s.medium, low: s.low, reviewer: s.tool, id: s.id };
    }
  }
  return {
    review,
    spend: { status: usage.status, currency: usage.currency, today: usage.today?.cost ?? null, month: usage.month?.cost ?? null, message: usage.message, updatedAt: usage.updatedAt },
    warnings: { count: needs.length, first: needs[0]?.text ?? null },
  };
}
