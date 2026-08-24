/**
 * CloudWatch Custom Widget: Developer Productivity.
 *
 * Invoked by CloudWatch dashboards (with the VIEWING USER's IAM
 * credentials — access control is lambda:InvokeFunction on this function).
 * Delegates aggregation to the otel-receiver's GET /v1/productivity
 * handler via direct Lambda invoke (single implementation, no drift),
 * then renders themed HTML.
 *
 * Widget params:
 *   view — 'table' (team comparison, always all users) | 'detail'
 *          (by-tool/by-model breakdown + ratio card for the current scope)
 *   user — email or 'all' (default 'all'); scopes the detail view.
 * Time range follows the dashboard (widgetContext.timeRange).
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambdaClient = new LambdaClient({});
const RECEIVER_FUNCTION = process.env.RECEIVER_FUNCTION || 'prism-d1-otel-receiver';

interface WidgetEvent {
  describe?: boolean;
  view?: string;
  user?: string;
  widgetContext?: {
    timeRange?: { start: number; end: number };
    theme?: string;
  };
}

const DOCS = `## Developer Productivity
Per-developer usage and commit outcomes from the PRISM attribution store —
full history, real commit timestamps.

### Parameters
| Name | Type | Default | Description |
|------|------|---------|-------------|
| view | string | table | 'table' (team comparison), 'detail' (by-tool/by-model + ratios), or 'coding-agent' (the agent's own work, kept out of the human table) |
| user | string | all | Developer email, or 'all' — scopes the detail view |
`;

type Breakdown = Record<string, { costUsd: number; calls: number }>;
type UserRow = {
  issues?: number;
  autonomous?: boolean;
  user: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number; calls: number; byTool: Breakdown; byModel: Breakdown };
  commits: { total: number; ai: number; human: number; mergedAi: number; revertedAi: number };
  ratios: { aiSharePct: number | null; mergeRatePct: number | null; defectRatePct: number | null; costPerAiCommit: number | null; costPerShippedCommit: number | null };
};
type Report = {
  range: { from: string; to: string };
  users: UserRow[];
  totals: UserRow;
  // Present once the receiver splits autonomous identities out of `totals`.
  // Optional so this widget keeps rendering against an older receiver rather than
  // throwing on a missing key.
  agents?: UserRow[];
  agentTotals?: UserRow;
};

// Theme palette resolved once per invocation
type Palette = { fg: string; mut: string; bord: string; accent: string; ok: string; warn: string };
function palette(dark: boolean): Palette {
  return {
    fg: dark ? '#d1d5db' : '#16191f',
    mut: dark ? '#8d99a8' : '#687078',
    bord: dark ? '#414750' : '#e9ebed',
    accent: dark ? '#44b9d6' : '#0073bb',
    ok: dark ? '#5fd38d' : '#1d8102',
    warn: dark ? '#e0b13e' : '#906806',
  };
}

const money = (n: number): string => `$${n.toFixed(2)}`;
const pct = (n: number | null): string => (n === null ? '—' : `${n}%`);
const num = (n: number): string => n.toLocaleString('en-US');
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Horizontal CSS bar scaled against a maximum. */
function bar(value: number, max: number, color: string): string {
  const w = max > 0 ? Math.max(1, Math.round((value / max) * 100)) : 0;
  return `<div style="background:${color};height:9px;width:${w}%;border-radius:2px;min-width:2px"></div>`;
}

function fetchReport(user: string, from: string, to: string): Promise<Report> {
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
  return lambdaClient.send(new InvokeCommand({
    FunctionName: RECEIVER_FUNCTION,
    Payload: Buffer.from(JSON.stringify(receiverEvent)),
  })).then(resp => {
    const raw = JSON.parse(Buffer.from(resp.Payload ?? new Uint8Array()).toString() || '{}');
    if (raw.statusCode !== 200) throw new Error(`productivity query HTTP ${raw.statusCode ?? '?'}`);
    return JSON.parse(raw.body) as Report;
  });
}

// ---- Table view: team comparison with spend bars ----
function renderTable(report: Report, p: Palette): string {
  const maxCost = Math.max(...report.users.map(u => u.usage.costUsd), 0.01);
  const header = ['Developer', 'AI Spend', 'Calls', 'AI / Total Commits', 'Shipped (AI)', 'Merge Rate', 'Defect Rate', '$ / Shipped']
    .map((h, i) => `<th style="padding:6px 10px;color:${p.mut};font-weight:normal;text-align:${i <= 1 ? 'left' : 'right'}">${h}</th>`)
    .join('');

  const row = (u: UserRow, bold = false, withBar = true): string => `
    <tr style="${bold ? 'font-weight:bold;' : ''}border-top:1px solid ${p.bord}">
      <td style="padding:6px 10px;color:${bold ? p.fg : p.accent};white-space:nowrap">${esc(u.user)}</td>
      <td style="padding:6px 10px;min-width:140px">${withBar ? bar(u.usage.costUsd, maxCost, p.accent) : ''}<span style="color:${p.mut}">${money(u.usage.costUsd)}</span></td>
      <td style="padding:6px 10px;text-align:right">${num(u.usage.calls)}</td>
      <td style="padding:6px 10px;text-align:right">${num(u.commits.ai)} / ${num(u.commits.total)}</td>
      <td style="padding:6px 10px;text-align:right">${num(u.commits.mergedAi)}</td>
      <td style="padding:6px 10px;text-align:right;color:${(u.ratios.mergeRatePct ?? 100) >= 85 ? p.ok : p.warn}">${pct(u.ratios.mergeRatePct)}</td>
      <td style="padding:6px 10px;text-align:right">${pct(u.ratios.defectRatePct)}</td>
      <td style="padding:6px 10px;text-align:right">${u.ratios.costPerShippedCommit === null ? '—' : money(u.ratios.costPerShippedCommit)}</td>
    </tr>`;

  return `
    <table style="border-collapse:collapse;width:100%">
      <tr>${header}</tr>
      ${report.users.map(u => row(u)).join('')}
      ${report.users.length > 1 ? row({ ...report.totals, user: 'ORG TOTAL' }, true, false) : ''}
    </table>`;
}

// ---- Detail view: by-tool + by-model bars and ratio card ----
function renderDetail(report: Report, user: string, p: Palette): string {
  const scope = user === 'all'
    ? report.totals
    : report.users.find(u => u.user === user) ?? report.totals;
  const title = user === 'all' ? 'Organization' : esc(scope.user);

  const breakdownTable = (label: string, data: Breakdown, color: string): string => {
    const entries = Object.entries(data).sort((a, b) => b[1].costUsd - a[1].costUsd).slice(0, 8);
    const max = Math.max(...entries.map(([, v]) => v.costUsd), 0.01);
    if (entries.length === 0) return `<div style="color:${p.mut}">no ${label.toLowerCase()} data</div>`;
    return `
      <table style="border-collapse:collapse;width:100%">
        <tr style="color:${p.mut}"><th align="left" style="padding:4px 8px;font-weight:normal">${label}</th><th align="left" style="padding:4px 8px;font-weight:normal;width:40%">Spend</th><th align="right" style="padding:4px 8px;font-weight:normal">Calls</th></tr>
        ${entries.map(([k, v]) => `
          <tr style="border-top:1px solid ${p.bord}">
            <td style="padding:4px 8px;white-space:nowrap">${esc(k)}</td>
            <td style="padding:4px 8px">${bar(v.costUsd, max, color)}<span style="color:${p.mut}">${money(v.costUsd)}</span></td>
            <td style="padding:4px 8px;text-align:right">${num(v.calls)}</td>
          </tr>`).join('')}
      </table>`;
  };

  const stat = (label: string, value: string, color = p.fg): string =>
    `<div style="display:flex;justify-content:space-between;padding:5px 8px;border-bottom:1px solid ${p.bord}">
      <span style="color:${p.mut}">${label}</span><b style="color:${color}">${value}</b>
    </div>`;

  const r = scope.ratios;
  const c = scope.commits;
  return `
    <div style="margin-bottom:6px"><b style="color:${p.accent}">${title}</b>
      ${user === 'all' ? `<span style="color:${p.mut}"> · set the Developer variable to an email to drill into one person</span>` : ''}
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap">
      <div style="flex:2;min-width:280px">${breakdownTable('By Tool', scope.usage.byTool, p.accent)}</div>
      <div style="flex:2;min-width:280px">${breakdownTable('By Model', scope.usage.byModel, p.warn)}</div>
      <div style="flex:1;min-width:200px">
        ${stat('AI share of commits', pct(r.aiSharePct))}
        ${stat('Merge rate', pct(r.mergeRatePct), (r.mergeRatePct ?? 100) >= 85 ? p.ok : p.warn)}
        ${stat('Defect rate', pct(r.defectRatePct))}
        ${stat('$ / AI commit', r.costPerAiCommit === null ? '—' : money(r.costPerAiCommit))}
        ${stat('$ / shipped commit', r.costPerShippedCommit === null ? '—' : money(r.costPerShippedCommit))}
        ${stat('Commits (AI / human)', `${num(c.ai)} / ${num(c.human)}`)}
      </div>
    </div>`;
}


/**
 * The coding agent's own work, kept apart from the human table.
 *
 * Separate because autonomous work is not human-assisted AI use: mixing them makes
 * the human AI-share figure mean nothing and spends the one signal PRISM has no
 * other emitter for, since L5 is about autonomous deployments. "Issues" appears
 * here and not in the human table because it has no human analogue -- nobody is
 * handed issues one at a time by a label.
 */
function renderCodingAgent(report: Report, p: Palette): string {
  const agents = report.agents ?? [];
  if (agents.length === 0) {
    return `
      <div style="padding:14px 10px;color:${p.mut};line-height:1.6">
        <div style="color:${p.fg};font-weight:bold;margin-bottom:4px">No agent activity yet</div>
        This panel fills in once the PRISM coding agent emits usage spans. It needs
        <code>PRISM_COLLECTOR_URL</code>, <code>PRISM_OIDC_TOKEN_ENDPOINT</code> and
        <code>PRISM_AGENT_SECRET_ID</code> set as repository or organization
        variables, and the harness deployed. An empty panel here means the emitter is
        not configured &mdash; not that the agent has done nothing.
      </div>`;
  }

  const t = report.agentTotals ?? agents[0];
  const card = (label: string, value: string, note = ''): string => `
    <div style="flex:1;min-width:120px;padding:8px 10px;border:1px solid ${p.bord};border-radius:6px">
      <div style="color:${p.mut};font-size:11px">${label}</div>
      <div style="color:${p.fg};font-size:20px;font-weight:bold">${value}</div>
      ${note ? `<div style="color:${p.mut};font-size:11px">${note}</div>` : ''}
    </div>`;

  const perIssue = t.issues && t.issues > 0 ? t.usage.costUsd / t.issues : null;

  const rows = agents.map(a => `
    <tr style="border-top:1px solid ${p.bord}">
      <td style="padding:6px 10px;color:${p.accent};white-space:nowrap">${esc(a.user)}</td>
      <td style="padding:6px 10px;text-align:right">${num(a.issues ?? 0)}</td>
      <td style="padding:6px 10px;text-align:right">${num(a.commits.ai)}</td>
      <td style="padding:6px 10px;text-align:right">${num(a.commits.mergedAi)}</td>
      <td style="padding:6px 10px;text-align:right;color:${(a.ratios.mergeRatePct ?? 100) >= 85 ? p.ok : p.warn}">${pct(a.ratios.mergeRatePct)}</td>
      <td style="padding:6px 10px;text-align:right">${pct(a.ratios.defectRatePct)}</td>
      <td style="padding:6px 10px;text-align:right">${money(a.usage.costUsd)}</td>
      <td style="padding:6px 10px;text-align:right">${a.ratios.costPerShippedCommit === null ? '&mdash;' : money(a.ratios.costPerShippedCommit)}</td>
    </tr>`).join('');

  const header = ['Agent', 'Issues', 'Commits', 'Shipped', 'Merge Rate', 'Defect Rate', 'Spend', '$ / Shipped']
    .map((h, i) => `<th style="padding:6px 10px;color:${p.mut};font-weight:normal;text-align:${i === 0 ? 'left' : 'right'}">${h}</th>`)
    .join('');

  return `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      ${card('Issues worked', num(t.issues ?? 0))}
      ${card('Commits shipped', num(t.commits.mergedAi), `of ${num(t.commits.ai)} made`)}
      ${card('Spend', money(t.usage.costUsd), 'estimated from tokens')}
      ${card('$ / issue', perIssue === null ? '&mdash;' : money(perIssue))}
      ${card('$ / shipped', t.ratios.costPerShippedCommit === null ? '&mdash;' : money(t.ratios.costPerShippedCommit))}
    </div>
    <table style="border-collapse:collapse;width:100%">
      <tr>${header}</tr>
      ${rows}
    </table>
    <div style="color:${p.mut};font-size:11px;margin-top:8px;line-height:1.5">
      Excluded from the developer table and from ORG TOTAL above. Cost is estimated
      from token counts, since the harness reports tokens and not dollars.
    </div>`;
}

export async function handler(event: WidgetEvent): Promise<string> {
  if (event.describe) return DOCS;

  const view = (event.view ?? 'table').trim();
  const user = (event.user ?? 'all').trim() || 'all';
  const tr = event.widgetContext?.timeRange;
  const from = tr ? new Date(tr.start).toISOString().slice(0, 10) : new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const to = tr ? new Date(tr.end).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const p = palette(event.widgetContext?.theme === 'dark');

  let report: Report;
  try {
    // The table always compares the whole team; the detail view scopes to
    // the selected user (fetching 'all' also covers user-scope via totals
    // when the email doesn't match — cheap at team scale).
    report = await fetchReport('all', from, to);
  } catch (e) {
    return `<p style="color:#d13212">${esc((e as Error).message)}</p>`;
  }

  const body = view === 'coding-agent' ? renderCodingAgent(report, p)
    : view === 'detail' ? renderDetail(report, user, p)
    : renderTable(report, p);
  return `
  <div style="color:${p.fg};font-size:13px">
    <div style="color:${p.mut};margin-bottom:6px">
      ${report.range.from} → ${report.range.to}
      · ${view === 'coding-agent' ? `${(report.agents ?? []).length} agent(s)` : `${report.users.length} developer(s)`}
      · attribution store (real commit times, full history)
    </div>
    ${body}
  </div>`;
}
