/**
 * CloudWatch Custom Widget: Developer Productivity.
 *
 * Invoked by CloudWatch dashboards (with the VIEWING USER's IAM
 * credentials — access control is lambda:InvokeFunction on this function).
 * Delegates aggregation to the otel-receiver's GET /v1/productivity
 * handler via direct Lambda invoke (single implementation, no drift),
 * then renders the report as themed HTML.
 *
 * Widget params:
 *   user  — email or 'all' (default 'all')
 * Time range follows the dashboard (widgetContext.timeRange).
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambdaClient = new LambdaClient({});
const RECEIVER_FUNCTION = process.env.RECEIVER_FUNCTION || 'prism-d1-otel-receiver';

interface WidgetEvent {
  describe?: boolean;
  user?: string;
  widgetContext?: {
    timeRange?: { start: number; end: number };
    theme?: string;
  };
}

const DOCS = `## Developer Productivity
Renders per-developer usage (tokens, cost, calls) and commit outcomes
(AI vs human, merged, reverted) with derived ratios, straight from the
PRISM attribution store. Full history, real commit timestamps.

### Parameters
| Name | Type | Default | Description |
|------|------|---------|-------------|
| user | string | all | Developer email, or 'all' for the fleet |
`;

type UserRow = {
  user: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number; calls: number; byTool: Record<string, { costUsd: number; calls: number }> };
  commits: { total: number; ai: number; human: number; mergedAi: number; revertedAi: number };
  ratios: { aiSharePct: number | null; mergeRatePct: number | null; defectRatePct: number | null; costPerAiCommit: number | null; costPerShippedCommit: number | null };
};

export async function handler(event: WidgetEvent): Promise<string> {
  if (event.describe) return DOCS;

  const user = (event.user ?? 'all').trim() || 'all';
  const tr = event.widgetContext?.timeRange;
  const from = tr ? new Date(tr.start).toISOString().slice(0, 10) : new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const to = tr ? new Date(tr.end).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const dark = event.widgetContext?.theme === 'dark';

  const receiverEvent = {
    rawPath: '/v1/productivity',
    rawQueryString: `user=${encodeURIComponent(user)}&from=${from}&to=${to}`,
    requestContext: {
      http: { method: 'GET', path: '/v1/productivity' },
      // Direct invoke bypasses the API GW JWT authorizer by design: reaching
      // this code path already required lambda:InvokeFunction IAM on the
      // widget, which gates dashboard viewers.
      authorizer: { jwt: { claims: { email: 'cloudwatch-dashboard-widget' } } },
    },
  };

  const resp = await lambdaClient.send(new InvokeCommand({
    FunctionName: RECEIVER_FUNCTION,
    Payload: Buffer.from(JSON.stringify(receiverEvent)),
  }));
  const raw = JSON.parse(Buffer.from(resp.Payload ?? new Uint8Array()).toString() || '{}');
  if (raw.statusCode !== 200) {
    return `<p style="color:#d13212">Productivity query failed (HTTP ${raw.statusCode ?? '?'}).</p>`;
  }
  const report = JSON.parse(raw.body) as { range: { from: string; to: string }; users: UserRow[]; totals: UserRow };

  // ---- Render ----
  const fg = dark ? '#d1d5db' : '#16191f';
  const mut = dark ? '#8d99a8' : '#687078';
  const bord = dark ? '#414750' : '#e9ebed';
  const accent = dark ? '#44b9d6' : '#0073bb';

  const money = (n: number): string => `$${n.toFixed(2)}`;
  const pct = (n: number | null): string => (n === null ? '—' : `${n}%`);
  const num = (n: number): string => n.toLocaleString('en-US');
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const row = (u: UserRow, bold = false): string => `
    <tr style="${bold ? 'font-weight:bold;' : ''}border-top:1px solid ${bord}">
      <td style="padding:6px 10px;color:${bold ? fg : accent}">${esc(u.user)}</td>
      <td style="padding:6px 10px;text-align:right">${money(u.usage.costUsd)}</td>
      <td style="padding:6px 10px;text-align:right">${num(u.usage.calls)}</td>
      <td style="padding:6px 10px;text-align:right">${num(u.commits.ai)} / ${num(u.commits.total)}</td>
      <td style="padding:6px 10px;text-align:right">${num(u.commits.mergedAi)}</td>
      <td style="padding:6px 10px;text-align:right">${pct(u.ratios.mergeRatePct)}</td>
      <td style="padding:6px 10px;text-align:right">${pct(u.ratios.defectRatePct)}</td>
      <td style="padding:6px 10px;text-align:right">${u.ratios.costPerShippedCommit === null ? '—' : money(u.ratios.costPerShippedCommit)}</td>
    </tr>`;

  const header = ['Developer', 'AI Spend', 'Calls', 'AI / Total Commits', 'Shipped (AI)', 'Merge Rate', 'Defect Rate', '$ / Shipped']
    .map((h, i) => `<th style="padding:6px 10px;color:${mut};font-weight:normal;text-align:${i === 0 ? 'left' : 'right'}">${h}</th>`)
    .join('');

  return `
  <div style="color:${fg};font-size:13px">
    <div style="color:${mut};margin-bottom:6px">
      ${report.range.from} → ${report.range.to}
      ${user !== 'all' ? ` · filtered: ${esc(user)}` : ` · ${report.users.length} developer(s)`}
      · data: attribution store (real commit times, full history)
    </div>
    <table style="border-collapse:collapse;width:100%">
      <tr>${header}</tr>
      ${report.users.map(u => row(u)).join('')}
      ${user === 'all' && report.users.length > 1 ? row({ ...report.totals, user: 'ORG TOTAL' }, true) : ''}
    </table>
  </div>`;
}
