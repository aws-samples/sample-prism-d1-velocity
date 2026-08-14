/**
 * CloudWatch Custom Widget: Team Velocity panels.
 *
 * Invoked by CloudWatch dashboards with the VIEWING USER's IAM credentials
 * (access control is lambda:InvokeFunction on this function). Reads the
 * PRISM events table directly via the by-detail-type GSI — full history
 * (365-day TTL), real event timestamps, no CloudWatch metric-dimension
 * matching or 14-day ingestion-window constraints.
 *
 * Widget params:
 *   view — 'dora' | 'aidora' | 'eval' | 'governance' | 'agents' | 'security'
 * Time range follows the dashboard (widgetContext.timeRange).
 *
 * The 'aidora' view additionally delegates to the otel-receiver's
 * GET /v1/productivity handler (direct Lambda invoke — single aggregation
 * implementation, no drift) for attribution-store KPIs.
 */

import { DynamoDBClient, QueryCommand, AttributeValue } from '@aws-sdk/client-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const ddb = new DynamoDBClient({});
const lambdaClient = new LambdaClient({});
const EVENTS_TABLE = process.env.EVENTS_TABLE || 'prism-d1-events';
const RECEIVER_FUNCTION = process.env.RECEIVER_FUNCTION || 'prism-d1-otel-receiver';

interface WidgetEvent {
  describe?: boolean;
  view?: string;
  widgetContext?: { timeRange?: { start: number; end: number }; theme?: string };
}

const DOCS = `## Team Velocity Panels
DDB-backed panels reading the PRISM events table (by-detail-type GSI) and
the attribution store. Full history, real event timestamps.

### Parameters
| Name | Type | Default | Description |
|------|------|---------|-------------|
| view | string | dora | dora, aidora, repos, eval, governance, agents, security |
`;

type Palette = { fg: string; mut: string; bord: string; accent: string; ok: string; warn: string; danger: string };
function palette(dark: boolean): Palette {
  return {
    fg: dark ? '#d1d5db' : '#16191f',
    mut: dark ? '#8d99a8' : '#687078',
    bord: dark ? '#414750' : '#e9ebed',
    accent: dark ? '#44b9d6' : '#0073bb',
    ok: dark ? '#5fd38d' : '#1d8102',
    warn: dark ? '#e0b13e' : '#906806',
    danger: dark ? '#f2827f' : '#d13212',
  };
}

const esc = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (n: number): string => n.toLocaleString('en-US');
const pct = (n: number | null): string => (n === null || Number.isNaN(n) ? '—' : `${Math.round(n * 10) / 10}%`);

/** Horizontal CSS bar scaled against a maximum (inline, no JS). */
function bar(value: number, max: number, color: string): string {
  const w = max > 0 ? Math.max(1, Math.round((value / max) * 100)) : 0;
  return `<div style="background:${color};height:8px;width:${w}%;border-radius:2px;min-width:2px;margin-bottom:2px"></div>`;
}

// ---- Events table access ----

interface PrismEvent {
  timestamp: string;
  detail_type: string;
  data: Record<string, any>;
}

/** Query all events of a detail-type within [from, to] ISO range (paginated). */
async function queryEvents(detailType: string, fromIso: string, toIso: string): Promise<PrismEvent[]> {
  const out: PrismEvent[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const resp = await ddb.send(new QueryCommand({
      TableName: EVENTS_TABLE,
      IndexName: 'by-detail-type',
      KeyConditionExpression: 'detail_type = :dt AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':dt': { S: detailType },
        ':from': { S: fromIso },
        ':to': { S: toIso },
      },
      ExclusiveStartKey: lastKey,
      Limit: 1000,
    }));
    for (const item of resp.Items ?? []) {
      try {
        out.push({
          timestamp: item.sk?.S ?? '',
          detail_type: detailType,
          data: JSON.parse(item.data?.S ?? '{}'),
        });
      } catch { /* skip unparseable rows */ }
    }
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey && out.length < 50000);
  return out;
}

// ---- HTML helpers ----

function kpiRow(cells: Array<{ label: string; value: string; note?: string; color?: string }>, p: Palette): string {
  return `<div style="display:flex;gap:12px;flex-wrap:wrap">${cells.map(c => `
    <div style="flex:1;min-width:130px;border:1px solid ${p.bord};border-radius:6px;padding:10px 14px">
      <div style="color:${p.mut};font-size:11px">${esc(c.label)}</div>
      <div style="color:${c.color ?? p.fg};font-size:24px;font-weight:600;margin:2px 0">${c.value}</div>
      ${c.note ? `<div style="color:${p.mut};font-size:10px">${esc(c.note)}</div>` : ''}
    </div>`).join('')}</div>`;
}

function emptyState(what: string, hint: string, p: Palette): string {
  return `<div style="border:1px dashed ${p.bord};border-radius:6px;padding:16px;color:${p.mut}">
    No ${esc(what)} events in the selected time range.<br>
    <span style="font-size:11px">${esc(hint)}</span></div>`;
}

function table(headers: string[], rows: string[][], p: Palette, rightFrom = 1): string {
  if (rows.length === 0) return '';
  return `<table style="border-collapse:collapse;width:100%;margin-top:10px">
    <tr>${headers.map((h, i) => `<th style="padding:5px 8px;color:${p.mut};font-weight:normal;text-align:${i >= rightFrom ? 'right' : 'left'};font-size:11px">${esc(h)}</th>`).join('')}</tr>
    ${rows.map(r => `<tr style="border-top:1px solid ${p.bord}">${r.map((c, i) => `<td style="padding:5px 8px;text-align:${i >= rightFrom ? 'right' : 'left'};font-size:12px">${c}</td>`).join('')}</tr>`).join('')}
  </table>`;
}

function footnote(text: string, p: Palette): string {
  return `<div style="color:${p.mut};font-size:10px;margin-top:8px">${esc(text)}</div>`;
}

/**
 * Inline SVG sparkline. Custom widgets cannot execute JavaScript, so trend
 * visuals must be server-rendered — no Chart.js, no canvas.
 * Points are [x-ordered] values; y is auto-scaled to the series range.
 */
function sparkline(values: number[], p: Palette, opts: { color?: string; height?: number; width?: number; yMax?: number } = {}): string {
  const w = opts.width ?? 260;
  const h = opts.height ?? 36;
  const color = opts.color ?? p.accent;
  if (values.length === 0) return `<span style="color:${p.mut};font-size:11px">no data</span>`;
  if (values.length === 1) {
    return `<svg width="${w}" height="${h}"><circle cx="${w / 2}" cy="${h / 2}" r="3" fill="${color}"/></svg>`;
  }
  const max = opts.yMax ?? Math.max(...values, 0.0001);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (w - 4) + 2;
    const y = h - 2 - ((v - min) / span) * (h - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg width="${w}" height="${h}" style="display:block">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/>
  </svg>`;
}

/** Bucket timestamped values into per-day series (ascending by day). */
function dailySeries<T>(items: T[], tsOf: (t: T) => string, valueOf: (bucket: T[]) => number): number[] {
  const byDay = new Map<string, T[]>();
  for (const it of items) {
    const day = tsOf(it).slice(0, 10);
    if (!day) continue;
    const arr = byDay.get(day) ?? [];
    arr.push(it);
    byDay.set(day, arr);
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, bucket]) => valueOf(bucket));
}

// ---- View: dora (proxy KPIs, honestly labeled) ----

async function renderDora(fromIso: string, toIso: string, days: number, p: Palette): Promise<string> {
  const [deploys, prs, assessments] = await Promise.all([
    queryEvents('prism.d1.deploy', fromIso, toIso),
    queryEvents('prism.d1.pr', fromIso, toIso),
    queryEvents('prism.d1.assessment', fromIso, toIso),
  ]);

  if (deploys.length === 0 && prs.length === 0 && assessments.length === 0) {
    return emptyState('deploy / PR / assessment', 'Populated by prism-ai-metrics.yml (on PR merge) and prism-dora-weekly.yml. Install the workflows and set PRISM_METRICS_ROLE_ARN.', p);
  }

  const mergeFreq = days > 0 ? deploys.length / days : deploys.length;
  const leadTimes = prs.map(e => e.data.dora?.lead_time_seconds).filter((v: any) => typeof v === 'number' && v > 0);
  const avgLeadHrs = leadTimes.length ? leadTimes.reduce((a: number, b: number) => a + b, 0) / leadTimes.length / 3600 : null;
  // Latest weekly assessment carries the title-heuristic CFR / MTTR
  const latest = assessments.filter(e => e.data.dora).sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  const cfr = latest?.data.dora?.change_failure_rate ?? null;
  const mttrH = latest?.data.dora?.mttr_hours ?? null;

  return kpiRow([
    { label: 'Merge Frequency', value: `${Math.round(mergeFreq * 10) / 10}/day`, note: `${num(deploys.length)} merges in range (deploy proxy)` },
    { label: 'PR Cycle Time', value: avgLeadHrs === null ? '—' : `${Math.round(avgLeadHrs * 10) / 10}h`, note: 'PR open → merge (lead-time proxy)', color: avgLeadHrs !== null && avgLeadHrs < 24 ? p.ok : undefined },
    { label: 'Revert Rate', value: pct(typeof cfr === 'number' ? (cfr <= 1 ? cfr * 100 : cfr) : null), note: 'revert/hotfix-titled PRs (CFR proxy)', color: typeof cfr === 'number' && (cfr <= 1 ? cfr * 100 : cfr) < 15 ? p.ok : p.warn },
    { label: 'Revert Turnaround', value: mttrH === null ? '—' : `${Math.round(mttrH * 10) / 10}h`, note: 'revert PR open → merge (MTTR proxy)' },
  ], p) + footnote('Proxies: merge≈deploy, PR cycle≈lead time, revert-titled PRs≈failures. True deploy/incident integration is on the roadmap.', p);
}

// ---- View: aidora (attribution store + eval events) ----

/** Invoke an otel-receiver GET route directly (single aggregation impl, no drift). */
async function invokeReceiver(routePath: string, query: string): Promise<any> {
  const receiverEvent = {
    rawPath: routePath,
    rawQueryString: query,
    requestContext: {
      http: { method: 'GET', path: routePath },
      // Direct invoke bypasses the API GW JWT authorizer by design: this code
      // path already required lambda:InvokeFunction IAM, which gates viewers.
      authorizer: { jwt: { claims: { email: 'cloudwatch-dashboard-widget' } } },
    },
  };
  const resp = await lambdaClient.send(new InvokeCommand({
    FunctionName: RECEIVER_FUNCTION,
    Payload: Buffer.from(JSON.stringify(receiverEvent)),
  }));
  const raw = JSON.parse(Buffer.from(resp.Payload ?? new Uint8Array()).toString() || '{}');
  if (raw.statusCode !== 200) throw new Error(`${routePath} HTTP ${raw.statusCode ?? '?'}`);
  return JSON.parse(raw.body);
}

async function fetchProductivity(fromIso: string, toIso: string): Promise<any> {
  // Receiver validates from/to as YYYY-MM-DD (day granularity).
  return invokeReceiver('/v1/productivity', `user=all&from=${fromIso.slice(0, 10)}&to=${toIso.slice(0, 10)}`);
}

// ---- View: repos (per-repo attribution breakdown) ----

async function renderRepos(fromIso: string, toIso: string, p: Palette): Promise<string> {
  let report: any;
  try {
    report = await invokeReceiver('/v1/repos', `from=${fromIso.slice(0, 10)}&to=${toIso.slice(0, 10)}`);
  } catch (err) {
    return emptyState('repo attribution', `Attribution store unreachable (${(err as Error).message}). Requires codeburn sync --attribution.`, p);
  }
  const rows: any[] = report?.repos ?? [];
  if (rows.length === 0) {
    return emptyState('repo attribution', 'Populated by `codeburn sync push --attribution` from developer machines.', p);
  }

  const maxCommits = Math.max(...rows.map(r => r.commits.total), 1);
  const body = rows.slice(0, 15).map(r => [
    esc(r.repo),
    `${bar(r.commits.total, maxCommits, p.accent)}<span style="color:${p.mut}">${num(r.commits.total)}</span>`,
    `${num(r.commits.ai)} / ${num(r.commits.human)}`,
    `<span style="color:${(r.ratios.aiSharePct ?? 0) >= 30 ? p.ok : p.mut}">${pct(r.ratios.aiSharePct)}</span>`,
    `<span style="color:${r.ratios.mergeRatePct === null ? p.mut : r.ratios.mergeRatePct >= 85 ? p.ok : p.warn}">${pct(r.ratios.mergeRatePct)}</span>`,
    `<span style="color:${r.ratios.defectRatePct === null ? p.mut : r.ratios.defectRatePct <= 10 ? p.ok : p.danger}">${pct(r.ratios.defectRatePct)}</span>`,
    num(r.contributors),
    esc((r.lastActivity ?? '').slice(0, 10) || '—'),
  ]);

  return table(
    ['Repository', 'Commits', 'AI / Human', 'AI Share', 'AI Merge Rate', 'AI Defect Rate', 'Devs', 'Last Activity'],
    body, p, 2,
  ) + footnote('Attribution store — full history. Spend is per-developer (see Developer Productivity); sessions spanning repos cannot be split by repo without double-counting.', p);
}

async function renderAidora(fromIso: string, toIso: string, p: Palette): Promise<string> {
  const [report, evals] = await Promise.all([
    fetchProductivity(fromIso, toIso).catch(() => null),
    queryEvents('prism.d1.eval', fromIso, toIso),
  ]);

  const t = report?.totals;
  const passRate = evals.length > 0
    ? (evals.filter(e => e.data.eval?.result === 'PASS').length / evals.length) * 100
    : null;

  const cells = [
    { label: 'AI Share of Commits', value: pct(t?.ratios?.aiSharePct ?? null), note: 'attribution store', color: (t?.ratios?.aiSharePct ?? 0) >= 30 ? p.ok : undefined },
    { label: 'AI → Merge Rate', value: pct(t?.ratios?.mergeRatePct ?? null), note: 'L2 ≥20% · L4 ≥45%', color: (t?.ratios?.mergeRatePct ?? 0) >= 45 ? p.ok : (t?.ratios?.mergeRatePct ?? 0) >= 20 ? p.warn : undefined },
    { label: 'AI Defect Proxy', value: pct(t?.ratios?.defectRatePct ?? null), note: 'reverted / merged AI commits', color: (t?.ratios?.defectRatePct ?? 100) <= 10 ? p.ok : p.warn },
    { label: '$ / Shipped Commit', value: t?.ratios?.costPerShippedCommit != null ? `$${t.ratios.costPerShippedCommit.toFixed(2)}` : '—', note: 'attribution store' },
    { label: 'Eval Gate Pass', value: pct(passRate), note: evals.length ? `${num(evals.length)} gate runs · L2 ≥80% · L4 ≥95%` : 'no eval events in range', color: passRate === null ? undefined : passRate >= 95 ? p.ok : passRate >= 80 ? p.warn : p.danger },
  ];
  const warn = report === null ? footnote('Attribution store unreachable — commit KPIs unavailable.', p) : '';
  return kpiRow(cells, p) + warn;
}

// ---- View: eval ----

async function renderEval(fromIso: string, toIso: string, p: Palette): Promise<string> {
  const evals = await queryEvents('prism.d1.eval', fromIso, toIso);
  if (evals.length === 0) {
    return emptyState('prism.d1.eval', 'Populated by prism-eval-gate-kiro.yml / prism-eval-gate.yml on pull requests.', p);
  }

  const byRubric = new Map<string, { total: number; pass: number; scoreSum: number }>();
  for (const e of evals) {
    const r = e.data.eval?.rubric ?? 'unknown';
    const agg = byRubric.get(r) ?? { total: 0, pass: 0, scoreSum: 0 };
    agg.total += 1;
    if (e.data.eval?.result === 'PASS') agg.pass += 1;
    agg.scoreSum += e.data.eval?.score ?? 0;
    byRubric.set(r, agg);
  }

  const rubricRows = [...byRubric.entries()].map(([r, a]) => [
    esc(r),
    `<span style="color:${a.pass / a.total >= 0.8 ? p.ok : p.danger}">${pct((a.pass / a.total) * 100)}</span>`,
    (a.scoreSum / a.total).toFixed(2),
    num(a.total),
  ]);

  const recent = evals.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 8).map(e => [
    esc(e.timestamp.slice(0, 16).replace('T', ' ')),
    esc(e.data.eval?.rubric ?? '—'),
    `<span style="color:${e.data.eval?.result === 'PASS' ? p.ok : p.danger}">${esc(e.data.eval?.result ?? '—')}</span>`,
    (e.data.eval?.score ?? 0).toFixed(2),
    e.data.eval?.pr_number ? `#${e.data.eval.pr_number}` : '—',
    esc(e.data.repo ?? '—'),
  ]);

  // Trend sparklines (chronological). Custom widgets can't run JS, so these
  // are server-rendered inline SVG.
  const chrono = [...evals].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const scoreSeries = dailySeries(chrono, e => e.timestamp,
    bucket => bucket.reduce((s, e) => s + (e.data.eval?.score ?? 0), 0) / bucket.length);
  const findingsSeries = dailySeries(chrono, e => e.timestamp,
    bucket => bucket.reduce((s, e) => s + (e.data.eval?.findings ?? 0), 0) / bucket.length);
  const highTotal = chrono.reduce((s, e) => s + (e.data.eval?.high_findings ?? 0), 0);

  const trends = `<div style="display:flex;gap:24px;margin-bottom:12px;flex-wrap:wrap">
    <div>
      <div style="color:${p.mut};font-size:11px">Avg score / day (0–1)</div>
      ${sparkline(scoreSeries, p, { color: p.accent, yMax: 1 })}
    </div>
    <div>
      <div style="color:${p.mut};font-size:11px">Avg findings / PR</div>
      ${sparkline(findingsSeries, p, { color: p.warn })}
    </div>
    <div>
      <div style="color:${p.mut};font-size:11px">High-severity findings (range)</div>
      <div style="font-size:22px;font-weight:600;color:${highTotal > 0 ? p.danger : p.ok}">${num(highTotal)}</div>
    </div>
  </div>`;

  return trends
    + table(['Rubric / Gate', 'Pass Rate', 'Avg Score', 'Runs'], rubricRows, p)
    + `<div style="color:${p.mut};font-size:11px;margin-top:12px">Recent gate runs</div>`
    + table(['Time (UTC)', 'Rubric', 'Result', 'Score', 'PR', 'Repo'], recent, p, 2);
}

// ---- View: governance ----

async function renderGovernance(fromIso: string, toIso: string, p: Palette): Promise<string> {
  const [guardrails, mcp] = await Promise.all([
    queryEvents('prism.d1.guardrail', fromIso, toIso),
    queryEvents('prism.d1.mcp.tool_call', fromIso, toIso),
  ]);
  if (guardrails.length === 0 && mcp.length === 0) {
    return emptyState('guardrail / MCP', 'Populated while the sample-app agent and MCP server run (Module 02 exercises).', p);
  }

  const byCat = new Map<string, number>();
  let blocked = 0, anonymized = 0;
  for (const g of guardrails) {
    const c = g.data.guardrail?.trigger_category ?? 'UNKNOWN';
    byCat.set(c, (byCat.get(c) ?? 0) + 1);
    if (g.data.guardrail?.action_taken === 'BLOCK') blocked += 1;
    if (g.data.guardrail?.action_taken === 'ANONYMIZE') anonymized += 1;
  }
  const denied = mcp.filter(m => m.data.mcp_tool_call?.authorized === false || m.data.mcp_tool_call?.result_status === 'denied').length;
  // risk_level is emitted per tool call by the MCP audit logger — high-risk
  // call volume is the governance headline, not raw call count.
  const HIGH_RISK = new Set(['high', 'critical']);
  const highRisk = mcp.filter(m => HIGH_RISK.has(String(m.data.mcp_tool_call?.risk_level ?? '').toLowerCase())).length;
  const byTool = new Map<string, { calls: number; denied: number; risk: string; scopes: Set<string> }>();
  for (const m of mcp) {
    const call = m.data.mcp_tool_call ?? {};
    const t = call.tool_name ?? 'unknown';
    const agg = byTool.get(t) ?? { calls: 0, denied: 0, risk: '—', scopes: new Set<string>() };
    agg.calls += 1;
    if (call.authorized === false || call.result_status === 'denied') agg.denied += 1;
    if (call.risk_level) agg.risk = String(call.risk_level);
    for (const s of call.scopes_used ?? []) agg.scopes.add(String(s));
    byTool.set(t, agg);
  }

  return kpiRow([
    { label: 'Guardrail Triggers', value: num(guardrails.length), note: [...byCat.entries()].map(([c, n]) => `${c}:${n}`).join(' · ') || undefined },
    { label: 'Blocked', value: num(blocked), color: blocked > 0 ? p.warn : p.ok },
    { label: 'Anonymized', value: num(anonymized) },
    { label: 'MCP Tool Calls', value: num(mcp.length) },
    { label: 'High-Risk Calls', value: num(highRisk), note: 'risk_level high/critical', color: highRisk > 0 ? p.warn : p.ok },
    { label: 'MCP Denied', value: num(denied), color: denied > 0 ? p.warn : p.ok },
  ], p) + table(['MCP Tool', 'Risk', 'Scopes Used', 'Calls', 'Denied'],
    [...byTool.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 10)
      .map(([t, a]) => [
        esc(t),
        `<span style="color:${HIGH_RISK.has(a.risk.toLowerCase()) ? p.warn : p.mut}">${esc(a.risk)}</span>`,
        `<span style="color:${p.mut}">${esc([...a.scopes].slice(0, 3).join(', ') || '—')}</span>`,
        num(a.calls),
        `<span style="color:${a.denied > 0 ? p.warn : p.mut}">${num(a.denied)}</span>`,
      ]), p, 3);
}

// ---- View: agents ----

async function renderAgents(fromIso: string, toIso: string, p: Palette): Promise<string> {
  const events = await queryEvents('prism.d1.agent', fromIso, toIso);
  if (events.length === 0) {
    return emptyState('prism.d1.agent', 'Populated while the sample-app Strands agent runs (Module 02 exercises).', p);
  }
  const byAgent = new Map<string, { runs: number; ok: number; durSum: number; steps: number; tokens: number; tools: number; guardrails: number }>();
  for (const e of events) {
    const a = e.data.agent?.agent_name ?? 'unknown';
    const agg = byAgent.get(a) ?? { runs: 0, ok: 0, durSum: 0, steps: 0, tokens: 0, tools: 0, guardrails: 0 };
    agg.runs += 1;
    if (e.data.agent?.status === 'success') agg.ok += 1;
    agg.durSum += e.data.agent?.duration_ms ?? 0;
    agg.steps += e.data.agent?.steps_taken ?? 0;
    agg.tokens += e.data.agent?.tokens_used ?? 0;
    agg.tools += e.data.agent?.tools_invoked ?? 0;
    agg.guardrails += e.data.agent?.guardrails_triggered ?? 0;
    byAgent.set(a, agg);
  }
  const totals = [...byAgent.values()].reduce((t, a) => ({
    runs: t.runs + a.runs, ok: t.ok + a.ok, durSum: t.durSum + a.durSum,
    tokens: t.tokens + a.tokens, guardrails: t.guardrails + a.guardrails,
  }), { runs: 0, ok: 0, durSum: 0, tokens: 0, guardrails: 0 });

  return kpiRow([
    { label: 'Invocations', value: num(totals.runs) },
    { label: 'Success Rate', value: pct(totals.runs ? (totals.ok / totals.runs) * 100 : null), color: totals.ok === totals.runs ? p.ok : p.warn },
    { label: 'Avg Duration', value: totals.runs ? `${num(Math.round(totals.durSum / totals.runs))}ms` : '—' },
    { label: 'Tokens Used', value: num(totals.tokens) },
    { label: 'Guardrails Hit', value: num(totals.guardrails), note: 'during agent runs', color: totals.guardrails > 0 ? p.warn : p.ok },
  ], p) + table(['Agent', 'Runs', 'Success', 'Avg ms', 'Avg Steps', 'Avg Tools', 'Tokens', 'Guardrails'],
    [...byAgent.entries()].sort((a, b) => b[1].runs - a[1].runs).map(([a, v]) => [
      esc(a),
      num(v.runs),
      `<span style="color:${v.ok === v.runs ? p.ok : p.warn}">${pct((v.ok / v.runs) * 100)}</span>`,
      num(Math.round(v.durSum / v.runs)),
      (v.steps / v.runs).toFixed(1),
      (v.tools / v.runs).toFixed(1),
      num(v.tokens),
      `<span style="color:${v.guardrails > 0 ? p.warn : p.mut}">${num(v.guardrails)}</span>`,
    ]), p);
}

// ---- View: security ----

async function renderSecurity(fromIso: string, toIso: string, p: Palette): Promise<string> {
  const types = ['prism.d1.security.code_review', 'prism.d1.security.design_review', 'prism.d1.security.pen_test'];
  const [findingEvents, remediationEvents] = await Promise.all([
    Promise.all(types.map(t => queryEvents(t, fromIso, toIso))).then(r => r.flat()),
    queryEvents('prism.d1.security.remediation', fromIso, toIso),
  ]);
  const findings = findingEvents.filter(e => e.data.security_agent_finding);
  const remediations = remediationEvents.filter(e => e.data.security_remediation);

  if (findings.length === 0 && remediations.length === 0) {
    return emptyState('security finding', 'Populated by the Continuum scan step in prism-eval-gate-kiro.yml when findings exist.', p);
  }

  const bySev = new Map<string, number>();
  const byPhase = new Map<string, number>();
  let ai = 0, human = 0, exploitValidated = 0;
  const cvssScores: number[] = [];
  for (const f of findings) {
    const d = f.data.security_agent_finding;
    bySev.set(d.severity ?? 'UNKNOWN', (bySev.get(d.severity ?? 'UNKNOWN') ?? 0) + 1);
    byPhase.set(d.phase ?? 'unknown', (byPhase.get(d.phase ?? 'unknown') ?? 0) + 1);
    if (d.ai_origin && d.ai_origin !== 'human') ai += 1; else human += 1;
    if (d.exploit_validated) exploitValidated += 1;
    if (typeof d.cvss_score === 'number') cvssScores.push(d.cvss_score);
  }
  const critHigh = (bySev.get('CRITICAL') ?? 0) + (bySev.get('HIGH') ?? 0);
  const avgCvss = cvssScores.length ? cvssScores.reduce((a, b) => a + b, 0) / cvssScores.length : null;

  // --- Remediation SLA (steering file SECURITY-09: 24h Critical, 72h High,
  // 30d Medium). Closure is half the security story — findings alone don't
  // tell you whether the team is actually fixing them.
  const SLA_HOURS: Record<string, number> = { CRITICAL: 24, HIGH: 72, MEDIUM: 720, LOW: 720 };
  let remedHoursSum = 0, withinSla = 0, slaEligible = 0, remedAi = 0, remedHuman = 0;
  const remedBySev = new Map<string, { count: number; hoursSum: number; within: number }>();
  for (const r of remediations) {
    const d = r.data.security_remediation;
    const sev = String(d.severity ?? 'UNKNOWN').toUpperCase();
    const hours = Number(d.remediation_time_hours ?? 0);
    remedHoursSum += hours;
    const agg = remedBySev.get(sev) ?? { count: 0, hoursSum: 0, within: 0 };
    agg.count += 1;
    agg.hoursSum += hours;
    const budget = SLA_HOURS[sev];
    if (budget !== undefined) {
      slaEligible += 1;
      if (hours <= budget) { withinSla += 1; agg.within += 1; }
    }
    remedBySev.set(sev, agg);
    if (d.remediated_by_origin && d.remediated_by_origin !== 'human') remedAi += 1; else remedHuman += 1;
  }
  const avgRemedHours = remediations.length ? remedHoursSum / remediations.length : null;
  const slaPct = slaEligible > 0 ? (withinSla / slaEligible) * 100 : null;

  const kpis = kpiRow([
    { label: 'Critical + High', value: num(critHigh), color: critHigh > 0 ? p.danger : p.ok },
    { label: 'Total Findings', value: num(findings.length), note: [...bySev.entries()].map(([s, n]) => `${s}:${n}`).join(' · ') },
    { label: 'Exploit Validated', value: num(exploitValidated), note: 'pen-test proven — immediate blocker', color: exploitValidated > 0 ? p.danger : p.ok },
    { label: 'Avg CVSS', value: avgCvss === null ? '—' : avgCvss.toFixed(1), color: avgCvss !== null && avgCvss >= 7 ? p.danger : undefined },
    { label: 'AI-Origin', value: num(ai), note: `${num(human)} human-origin` },
  ], p);

  const remedKpis = remediations.length === 0
    ? footnote('No remediation events in range — remediation tracking populates from prism.d1.security.remediation (security-remediation-tracker).', p)
    : `<div style="color:${p.mut};font-size:11px;margin:12px 0 6px">Remediation (SLA: 24h Critical · 72h High · 30d Medium)</div>` + kpiRow([
      { label: 'Remediated', value: num(remediations.length) },
      { label: 'Avg Time', value: avgRemedHours === null ? '—' : `${Math.round(avgRemedHours * 10) / 10}h` },
      { label: 'Within SLA', value: pct(slaPct), color: slaPct === null ? undefined : slaPct >= 90 ? p.ok : slaPct >= 70 ? p.warn : p.danger },
      { label: 'Fixed by AI', value: num(remedAi), note: `${num(remedHuman)} by human` },
    ], p) + table(['Severity', 'Fixed', 'Avg Hours', 'Within SLA'],
      [...remedBySev.entries()].sort((a, b) => b[1].count - a[1].count).map(([sev, v]) => [
        esc(sev),
        num(v.count),
        (v.hoursSum / v.count).toFixed(1),
        `<span style="color:${v.within === v.count ? p.ok : p.warn}">${v.within} / ${v.count}</span>`,
      ]), p);

  const recent = findings.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 8).map(f => {
    const d = f.data.security_agent_finding;
    const sevColor = d.severity === 'CRITICAL' || d.severity === 'HIGH' ? p.danger : d.severity === 'MEDIUM' ? p.warn : p.mut;
    return [
      esc(f.timestamp.slice(0, 16).replace('T', ' ')),
      `<span style="color:${sevColor}">${esc(d.severity ?? '—')}</span>`,
      typeof d.cvss_score === 'number' ? d.cvss_score.toFixed(1) : '—',
      esc(d.phase ?? '—'),
      esc(d.cwe_id ?? '—'),
      d.exploit_validated ? `<span style="color:${p.danger}">yes</span>` : '—',
      esc(d.ai_origin ?? '—'),
      esc(f.data.repo ?? '—'),
    ];
  });

  return kpis + remedKpis
    + `<div style="color:${p.mut};font-size:11px;margin-top:12px">Recent findings · by phase: ${esc([...byPhase.entries()].map(([ph, n]) => `${ph}:${n}`).join(' · ') || 'none')}</div>`
    + table(['Time (UTC)', 'Severity', 'CVSS', 'Phase', 'CWE', 'Exploit', 'Origin', 'Repo'], recent, p, 99);
}

// ---- Handler ----

export async function handler(event: WidgetEvent): Promise<string> {
  if (event.describe) return DOCS;

  const dark = event.widgetContext?.theme === 'dark';
  const p = palette(dark);
  const end = event.widgetContext?.timeRange?.end ?? Date.now();
  const start = event.widgetContext?.timeRange?.start ?? end - 30 * 24 * 3600 * 1000;
  const fromIso = new Date(start).toISOString();
  const toIso = new Date(end).toISOString();
  const days = Math.max((end - start) / 86400000, 1 / 24);
  const view = event.view ?? 'dora';

  try {
    let body: string;
    switch (view) {
      case 'dora': body = await renderDora(fromIso, toIso, days, p); break;
      case 'aidora': body = await renderAidora(fromIso, toIso, p); break;
      case 'repos': body = await renderRepos(fromIso, toIso, p); break;
      case 'eval': body = await renderEval(fromIso, toIso, p); break;
      case 'governance': body = await renderGovernance(fromIso, toIso, p); break;
      case 'agents': body = await renderAgents(fromIso, toIso, p); break;
      case 'security': body = await renderSecurity(fromIso, toIso, p); break;
      default: body = `<div style="color:${p.danger}">Unknown view: ${esc(view)}</div>`;
    }
    return `<div style="font-family:'Amazon Ember',Helvetica,Arial,sans-serif;color:${p.fg};font-size:13px">${body}</div>`;
  } catch (err) {
    return `<div style="color:${p.danger};font-size:12px">Panel error: ${esc((err as Error).message)}</div>`;
  }
}
