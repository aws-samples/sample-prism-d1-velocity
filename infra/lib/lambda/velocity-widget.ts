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

const DOCS = `## Team Velocity / Executive / CISO Panels
DDB-backed panels reading the PRISM events table (by-detail-type GSI) and
the attribution store. Full history, real event timestamps.

### Parameters
| Name | Type | Default | Description |
|------|------|---------|-------------|
| view | string | dora | dora, aidora, repos, eval, governance, agents, security, exec, exec-security, ciso-exposure, ciso-sla, ciso-risk, ciso-shiftleft, ciso-classes |

The \`exec\` view additionally computes an **observed** PRISM level from
outcome metrics (capped at L4 — L5 requires an autonomy signal that no
emitter produces). This is not the scanner's capability score.

The \`ciso-*\` views read finding events directly rather than CloudWatch
metrics, because the metric publisher emits either the full dimension set
or none — a widget querying a **partial** set (e.g. AIOrigin alone) never
matches. \`ciso-classes\` additionally surfaces \`compliance_mappings\`,
a string array that cannot be a CloudWatch dimension at all.
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
          // sk may be `${timestamp}#${finding_id}` for per-finding fan-out
          // events (see the sort-key note in metrics-processor.ts). Strip the
          // discriminator so Date.parse and slice() see a clean ISO string.
          // No-op for the bare-timestamp sks written before that change.
          timestamp: (item.sk?.S ?? '').split('#')[0],
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

// ---- Observed PRISM level (computed from live metrics, not the scanner) ----

/**
 * The scanner (`prism-cli assessment`) scores **capability** from static repo
 * signals — does CLAUDE.md exist, is there a specs/ dir, are AI trailers in
 * commit conventions. This computes **observed** maturity from outcomes that
 * are actually flowing, using the level definitions in the README maturity
 * table. The two can legitimately disagree: a team can score L4 on capability
 * (all the config exists) while observing L2 (nobody is shipping AI code), and
 * that gap is the interesting signal.
 *
 * Capped at L4. L5 ("agents contributing to architecture, >20% autonomous
 * deployments") requires an autonomy signal that no emitter produces — we do
 * not have a way to distinguish an autonomous deployment from an assisted one,
 * so claiming L5 from these inputs would be fabrication.
 *
 * Returns null when there is not enough data to assess. That is deliberately
 * distinct from L1: "no data" means the pipeline isn't reporting, whereas L1
 * is a real finding ("ad hoc AI use, no metrics").
 */
type ObservedLevel = {
  level: string;
  label: string;
  gates: Array<{ name: string; pass: boolean; detail: string }>;
  blockedBy: string | null;
};

function computeObservedLevel(input: {
  aiSharePct: number | null;
  mergeRatePct: number | null;
  defectRatePct: number | null;
  evalRuns: number;
  evalPassPct: number | null;
  costByToolCount: number;
  mcpCalls: number;
  guardrailTriggers: number;
}): ObservedLevel | null {
  const { aiSharePct, mergeRatePct, defectRatePct, evalRuns, evalPassPct,
    costByToolCount, mcpCalls, guardrailTriggers } = input;

  // Not assessable: no commit attribution at all.
  if (aiSharePct === null) return null;

  const gates = [
    {
      name: 'L2 — AI adoption',
      pass: aiSharePct >= 30,
      detail: `AI share ${pct(aiSharePct)} (need >= 30%)`,
    },
    {
      name: 'L3 — eval gates in pipeline',
      pass: evalRuns > 0 && (evalPassPct ?? 0) >= 80 && (mergeRatePct ?? 0) >= 20,
      detail: evalRuns === 0
        ? 'no eval gate runs in range'
        : `eval pass ${pct(evalPassPct)} (need >= 80%), AI merge ${pct(mergeRatePct)} (need >= 20%)`,
    },
    {
      name: 'L4 — FinOps + governed agents',
      pass: costByToolCount > 0 && (mcpCalls > 0 || guardrailTriggers > 0)
        && defectRatePct !== null && defectRatePct <= 20,
      detail: `cost attribution ${costByToolCount > 0 ? 'present' : 'missing'}, `
        + `governance events ${mcpCalls + guardrailTriggers}, AI defect ${pct(defectRatePct)} (need <= 20%)`,
    },
  ];

  // Levels are cumulative — the first failed gate caps the level.
  let level = 'L1';
  let label = 'Experimental';
  let blockedBy: string | null = gates[0].name;
  if (gates[0].pass) {
    level = 'L2'; label = 'Structured'; blockedBy = gates[1].name;
    if (gates[1].pass) {
      level = 'L3'; label = 'Integrated'; blockedBy = gates[2].name;
      if (gates[2].pass) {
        level = 'L4'; label = 'Orchestrated';
        // L5 is intentionally unreachable from these inputs.
        blockedBy = 'L5 — requires an autonomy signal (not emitted)';
      }
    }
  }
  return { level, label, gates, blockedBy };
}

// ---- View: exec (business KPIs + delivery proxies + observed level) ----

async function renderExec(fromIso: string, toIso: string, days: number, p: Palette): Promise<string> {
  const [report, evals, mcp, guardrails, deploys, prs, assessments] = await Promise.all([
    fetchProductivity(fromIso, toIso).catch(() => null),
    queryEvents('prism.d1.eval', fromIso, toIso),
    queryEvents('prism.d1.mcp.tool_call', fromIso, toIso),
    queryEvents('prism.d1.guardrail', fromIso, toIso),
    queryEvents('prism.d1.deploy', fromIso, toIso),
    queryEvents('prism.d1.pr', fromIso, toIso),
    queryEvents('prism.d1.assessment', fromIso, toIso),
  ]);

  const t = report?.totals;
  const r = t?.ratios ?? {};
  const evalPassPct = evals.length > 0
    ? (evals.filter(e => e.data.eval?.result === 'PASS').length / evals.length) * 100
    : null;

  const observed = computeObservedLevel({
    aiSharePct: r.aiSharePct ?? null,
    mergeRatePct: r.mergeRatePct ?? null,
    defectRatePct: r.defectRatePct ?? null,
    evalRuns: evals.length,
    evalPassPct,
    costByToolCount: Object.keys(t?.usage?.byTool ?? {}).length,
    mcpCalls: mcp.length,
    guardrailTriggers: guardrails.length,
  });

  // --- Observed level card ---
  const levelCard = observed === null
    ? `<div style="border:1px dashed ${p.bord};border-radius:6px;padding:10px 14px;color:${p.mut};min-width:230px">
         <div style="font-size:11px">Observed PRISM Level</div>
         <div style="font-size:20px;font-weight:600;margin:2px 0">Insufficient data</div>
         <div style="font-size:10px">No commit attribution in range — run <code>codeburn sync push --attribution</code></div>
       </div>`
    : `<div style="border:1px solid ${p.accent};border-radius:6px;padding:10px 14px;min-width:230px">
         <div style="color:${p.mut};font-size:11px">Observed PRISM Level <span style="opacity:.8">(outcomes)</span></div>
         <div style="font-size:26px;font-weight:600;color:${p.accent};margin:2px 0">${esc(observed.level)} <span style="font-size:14px;color:${p.fg}">${esc(observed.label)}</span></div>
         <div style="color:${p.mut};font-size:10px">Next: ${esc(observed.blockedBy ?? '—')}</div>
       </div>`;

  const gateTable = observed === null ? '' : table(
    ['Level gate', 'Status', 'Evidence'],
    observed.gates.map(g => [
      esc(g.name),
      `<span style="color:${g.pass ? p.ok : p.mut}">${g.pass ? 'met' : 'not met'}</span>`,
      `<span style="color:${p.mut}">${esc(g.detail)}</span>`,
    ]), p, 1);

  // --- Business KPIs (attribution store) ---
  const businessKpis = kpiRow([
    { label: 'AI Share of Commits', value: pct(r.aiSharePct ?? null), note: 'L2 >= 30%', color: (r.aiSharePct ?? 0) >= 30 ? p.ok : undefined },
    { label: 'AI Merge Rate', value: pct(r.mergeRatePct ?? null), note: 'L2 >= 20% · L4 >= 45%', color: (r.mergeRatePct ?? 0) >= 45 ? p.ok : (r.mergeRatePct ?? 0) >= 20 ? p.warn : undefined },
    { label: '$ / Shipped Commit', value: r.costPerShippedCommit != null ? `$${r.costPerShippedCommit.toFixed(2)}` : '—', note: 'unit economics' },
    { label: `AI Spend (${Math.round(days)}d)`, value: t?.usage?.costUsd != null ? `$${Math.round(t.usage.costUsd).toLocaleString('en-US')}` : '—', note: 'attribution store' },
    { label: 'Eval Gate Pass', value: pct(evalPassPct), note: evals.length ? `${num(evals.length)} runs` : 'no runs in range', color: evalPassPct === null ? undefined : evalPassPct >= 95 ? p.ok : evalPassPct >= 80 ? p.warn : p.danger },
  ], p);

  // --- Delivery proxies, humanized units ---
  const mergeFreq = days > 0 ? deploys.length / days : deploys.length;
  const leadTimes = prs.map(e => e.data.dora?.lead_time_seconds).filter((v: any) => typeof v === 'number' && v > 0);
  const avgLeadHrs = leadTimes.length ? leadTimes.reduce((a: number, b: number) => a + b, 0) / leadTimes.length / 3600 : null;
  const latest = assessments.filter(e => e.data.dora).sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  const cfrRaw = latest?.data.dora?.change_failure_rate;
  const cfr = typeof cfrRaw === 'number' ? (cfrRaw <= 1 ? cfrRaw * 100 : cfrRaw) : null;
  const mttrH = latest?.data.dora?.mttr_hours ?? null;

  const deliveryKpis = (deploys.length === 0 && prs.length === 0 && assessments.length === 0)
    ? footnote('No delivery events in range — install prism-ai-metrics.yml and prism-dora-weekly.yml to populate the delivery proxies.', p)
    : kpiRow([
      { label: 'Merge Frequency', value: `${Math.round(mergeFreq * 10) / 10}/day`, note: 'deploy proxy' },
      { label: 'PR Cycle Time', value: avgLeadHrs === null ? '—' : `${Math.round(avgLeadHrs * 10) / 10}h`, note: 'lead-time proxy', color: avgLeadHrs !== null && avgLeadHrs < 24 ? p.ok : undefined },
      { label: 'Revert Rate', value: pct(cfr), note: 'change-failure proxy', color: cfr !== null && cfr < 15 ? p.ok : cfr !== null ? p.warn : undefined },
      { label: 'Revert Turnaround', value: mttrH === null ? '—' : `${Math.round(mttrH * 10) / 10}h`, note: 'MTTR proxy' },
    ], p);

  const warn = report === null
    ? footnote('Attribution store unreachable — business KPIs and observed level unavailable.', p)
    : '';

  return `<div style="display:flex;gap:12px;align-items:stretch;flex-wrap:wrap;margin-bottom:12px">${levelCard}<div style="flex:1;min-width:420px">${businessKpis}</div></div>`
    + gateTable
    + `<div style="color:${p.mut};font-size:11px;margin:14px 0 6px">Delivery (proxies — merge-based, not true deploy/incident data)</div>`
    + deliveryKpis
    + warn
    + footnote('Observed level is computed from outcomes and capped at L4; L5 needs an autonomy signal no emitter produces. It is not the scanner\'s capability score — divergence between the two is expected and informative.', p);
}

// ---- Deferred origin resolution (attribution join at render time) ----

/**
 * Resolve AI-vs-human origin for a set of commit SHAs by looking them up in
 * the attribution store.
 *
 * Why this happens here and not in CI: attribution spans land when a
 * developer's machine runs `codeburn sync push --attribution`, which the
 * installer schedules every ~12 hours. CI emits events at PR merge, usually
 * before those spans exist — so an origin verdict computed in the workflow is
 * frequently wrong and then permanently baked into an immutable event. The
 * workflows therefore emit commit SHAs (facts that never expire) and this
 * runs the join at query time, by which point attribution has landed. A PR
 * merged before its sync simply renders correctly on the next look.
 *
 * Returns 'ai' if ANY commit in the set is AI-attributed, 'human' if all are
 * classified human, and 'unknown' when no SHA is found in the store (not yet
 * synced, or the author never onboarded codeburn). 'unknown' is deliberately
 * distinct from 'human' — conflating them would silently undercount AI origin
 * on a partially-onboarded team.
 */
type ResolvedOrigin = 'ai' | 'human' | 'unknown';

async function resolveOriginForShas(
  repo: string,
  shas: string[],
  cache: Map<string, ResolvedOrigin>,
): Promise<ResolvedOrigin> {
  if (!repo || shas.length === 0) return 'unknown';
  const cacheKey = `${repo}|${shas.join(',')}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let sawHuman = false;
  for (const sha of shas) {
    try {
      const commit = await invokeReceiver('/v1/attribution', `repo=${encodeURIComponent(repo)}&sha=${encodeURIComponent(sha)}`);
      // The receiver infers origin from correlated usage spans (traceId join):
      // a commit with LLM API calls in its session is AI-generated.
      if (commit?.aiOrigin === 'ai-generated' || commit?.aiOrigin === 'ai-assisted' || commit?.ai_origin === 'ai-generated') {
        cache.set(cacheKey, 'ai');
        return 'ai';
      }
      sawHuman = true;
    } catch {
      // 404 (not synced yet) or transport failure — treat as no signal for
      // this SHA and keep checking the rest.
    }
  }
  const result: ResolvedOrigin = sawHuman ? 'human' : 'unknown';
  cache.set(cacheKey, result);
  return result;
}

/**
 * Resolve origin for a finding, preferring the deferred attribution join and
 * falling back to the legacy trailer-derived `ai_origin` for events emitted
 * before the cutover.
 */
async function findingOrigin(
  f: PrismEvent,
  cache: Map<string, ResolvedOrigin>,
): Promise<{ origin: ResolvedOrigin; source: 'attribution' | 'trailer' | 'none' }> {
  const d = f.data.security_agent_finding ?? {};
  const shas: string[] = Array.isArray(d.commit_shas) ? d.commit_shas : [];
  if (shas.length > 0) {
    const origin = await resolveOriginForShas(f.data.repo ?? '', shas, cache);
    if (origin !== 'unknown') return { origin, source: 'attribution' };
  }
  if (d.ai_origin) {
    return { origin: d.ai_origin === 'human' ? 'human' : 'ai', source: 'trailer' };
  }
  return { origin: 'unknown', source: 'none' };
}

/**
 * Resolve who remediated a finding, using the FIX PR's commit SHAs.
 *
 * Same deferred-join rationale as findingOrigin, but note this was a SECOND
 * and separate trailer path: the remediation tracker copied
 * `ai_context.origin` off the merged-PR event, which `prism-ai-metrics.yml`
 * derived from `ai_ratio` — itself computed by counting AI-Origin trailers.
 * So "which code had findings" and "who fixed them" both silently degraded to
 * human at hook removal, via different routes.
 */
async function remediationOrigin(
  r: PrismEvent,
  cache: Map<string, ResolvedOrigin>,
): Promise<{ origin: ResolvedOrigin; source: 'attribution' | 'trailer' | 'none' }> {
  const d = r.data.security_remediation ?? {};
  const shas: string[] = Array.isArray(d.fix_commit_shas) ? d.fix_commit_shas : [];
  if (shas.length > 0) {
    const origin = await resolveOriginForShas(r.data.repo ?? '', shas, cache);
    if (origin !== 'unknown') return { origin, source: 'attribution' };
  }
  // 'unknown' is the tracker's own default when the PR event carried no
  // ai_context at all — treat it as no signal rather than as a human fix.
  if (d.remediated_by_origin && d.remediated_by_origin !== 'unknown') {
    return { origin: d.remediated_by_origin === 'human' ? 'human' : 'ai', source: 'trailer' };
  }
  return { origin: 'unknown', source: 'none' };
}

// ---- Shared security event access ----

/** Remediation SLA budgets per the AI-DLC steering baseline (SECURITY-09). */
const SLA_HOURS: Record<string, number> = { CRITICAL: 24, HIGH: 72, MEDIUM: 720, LOW: 720 };
const FINDING_TYPES = [
  'prism.d1.security.code_review',
  'prism.d1.security.design_review',
  'prism.d1.security.pen_test',
];

interface SecurityCorpus {
  findings: PrismEvent[];
  remediations: PrismEvent[];
}

/** Findings across all three review phases plus their remediation events. */
async function loadSecurityCorpus(fromIso: string, toIso: string): Promise<SecurityCorpus> {
  const [findingEvents, remediationEvents] = await Promise.all([
    Promise.all(FINDING_TYPES.map(t => queryEvents(t, fromIso, toIso))).then(r => r.flat()),
    queryEvents('prism.d1.security.remediation', fromIso, toIso),
  ]);
  return {
    findings: findingEvents.filter(e => e.data.security_agent_finding),
    remediations: remediationEvents.filter(e => e.data.security_remediation),
  };
}

const noFindings = (p: Palette): string => emptyState(
  'security finding',
  'Populated by the Continuum scan step (prism-eval-gate-kiro.yml) and the security-agent-processor webhook.',
  p,
);

// ---- View: exec-security (condensed posture strip; CISO dashboard has depth) ----

async function renderExecSecurity(fromIso: string, toIso: string, p: Palette): Promise<string> {
  const [{ findings, remediations }, guardrails, mcp, exfil] = await Promise.all([
    loadSecurityCorpus(fromIso, toIso),
    queryEvents('prism.d1.guardrail', fromIso, toIso),
    queryEvents('prism.d1.mcp.tool_call', fromIso, toIso),
    queryEvents('prism.d1.security', fromIso, toIso),
  ]);

  if (findings.length === 0 && remediations.length === 0 && guardrails.length === 0 && mcp.length === 0) {
    return emptyState('security / governance', 'Populated by the Continuum scan step and the sample-app runtime.', p);
  }

  const bySev = new Map<string, number>();
  let exploitValidated = 0;
  for (const f of findings) {
    const d = f.data.security_agent_finding;
    bySev.set(d.severity ?? 'UNKNOWN', (bySev.get(d.severity ?? 'UNKNOWN') ?? 0) + 1);
    if (d.exploit_validated) exploitValidated += 1;
  }
  const critHigh = (bySev.get('CRITICAL') ?? 0) + (bySev.get('HIGH') ?? 0);

  // SLA per the AI-DLC steering baseline (SECURITY-09).
  let withinSla = 0, slaEligible = 0;
  for (const r of remediations) {
    const sev = String(r.data.security_remediation.severity ?? '').toUpperCase();
    const budget = SLA_HOURS[sev];
    if (budget === undefined) continue;
    slaEligible += 1;
    if (Number(r.data.security_remediation.remediation_time_hours ?? 0) <= budget) withinSla += 1;
  }
  const slaPct = slaEligible > 0 ? (withinSla / slaEligible) * 100 : null;

  const blocked = guardrails.filter(g => g.data.guardrail?.action_taken === 'BLOCK').length;
  const denied = mcp.filter(m => m.data.mcp_tool_call?.authorized === false || m.data.mcp_tool_call?.result_status === 'denied').length;

  return kpiRow([
    { label: 'Open Critical + High', value: num(critHigh), note: [...bySev.entries()].map(([s, n]) => `${s}:${n}`).join(' · ') || undefined, color: critHigh > 0 ? p.danger : p.ok },
    { label: 'Exploit Validated', value: num(exploitValidated), note: 'immediate blockers', color: exploitValidated > 0 ? p.danger : p.ok },
    { label: 'Within Remediation SLA', value: pct(slaPct), note: '24h crit · 72h high', color: slaPct === null ? undefined : slaPct >= 90 ? p.ok : p.warn },
    { label: 'Guardrail Blocks', value: num(blocked), color: blocked > 0 ? p.warn : p.ok },
    { label: 'MCP Denials', value: num(denied), note: 'out-of-scope attempts', color: denied > 0 ? p.warn : p.ok },
    { label: 'Exfiltration Alerts', value: num(exfil.length), color: exfil.length > 0 ? p.danger : p.ok },
  ], p) + footnote('Condensed posture. Full severity/phase/origin breakdowns are on the CISO Compliance dashboard.', p);
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
  const { findings, remediations } = await loadSecurityCorpus(fromIso, toIso);

  if (findings.length === 0 && remediations.length === 0) {
    return emptyState('security finding', 'Populated by the Continuum scan step in prism-eval-gate-kiro.yml when findings exist.', p);
  }

  const bySev = new Map<string, number>();
  const byPhase = new Map<string, number>();
  let ai = 0, human = 0, unknownOrigin = 0, exploitValidated = 0;
  const cvssScores: number[] = [];
  const originCache = new Map<string, ResolvedOrigin>();
  const originSources = new Set<string>();
  for (const f of findings) {
    const d = f.data.security_agent_finding;
    bySev.set(d.severity ?? 'UNKNOWN', (bySev.get(d.severity ?? 'UNKNOWN') ?? 0) + 1);
    byPhase.set(d.phase ?? 'unknown', (byPhase.get(d.phase ?? 'unknown') ?? 0) + 1);
    // Deferred join — see resolveOriginForShas. Falls back to the legacy
    // trailer field for events emitted before the cutover.
    const { origin, source } = await findingOrigin(f, originCache);
    if (source !== 'none') originSources.add(source);
    if (origin === 'ai') ai += 1;
    else if (origin === 'human') human += 1;
    else unknownOrigin += 1;
    if (d.exploit_validated) exploitValidated += 1;
    if (typeof d.cvss_score === 'number') cvssScores.push(d.cvss_score);
  }
  const critHigh = (bySev.get('CRITICAL') ?? 0) + (bySev.get('HIGH') ?? 0);
  const avgCvss = cvssScores.length ? cvssScores.reduce((a, b) => a + b, 0) / cvssScores.length : null;

  // --- Remediation SLA (steering file SECURITY-09: 24h Critical, 72h High,
  // 30d Medium). Closure is half the security story — findings alone don't
  // tell you whether the team is actually fixing them.
  let remedHoursSum = 0, withinSla = 0, slaEligible = 0, remedAi = 0, remedHuman = 0, remedUnknown = 0;
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
    // Deferred join on the fix PR's commits — see remediationOrigin. Shares
    // originCache with the findings loop above, so overlapping PRs are
    // resolved once per render.
    const { origin: remOrigin, source: remSource } = await remediationOrigin(r, originCache);
    if (remSource !== 'none') originSources.add(remSource);
    if (remOrigin === 'ai') remedAi += 1;
    else if (remOrigin === 'human') remedHuman += 1;
    else remedUnknown += 1;
  }
  const avgRemedHours = remediations.length ? remedHoursSum / remediations.length : null;
  const slaPct = slaEligible > 0 ? (withinSla / slaEligible) * 100 : null;

  const kpis = kpiRow([
    { label: 'Critical + High', value: num(critHigh), color: critHigh > 0 ? p.danger : p.ok },
    { label: 'Total Findings', value: num(findings.length), note: [...bySev.entries()].map(([s, n]) => `${s}:${n}`).join(' · ') },
    { label: 'Exploit Validated', value: num(exploitValidated), note: 'pen-test proven — immediate blocker', color: exploitValidated > 0 ? p.danger : p.ok },
    { label: 'Avg CVSS', value: avgCvss === null ? '—' : avgCvss.toFixed(1), color: avgCvss !== null && avgCvss >= 7 ? p.danger : undefined },
    { label: 'AI-Origin', value: num(ai), note: `${num(human)} human` + (unknownOrigin > 0 ? ` · ${num(unknownOrigin)} unresolved` : '') },
  ], p);

  const remedKpis = remediations.length === 0
    ? footnote('No remediation events in range — remediation tracking populates from prism.d1.security.remediation (security-remediation-tracker).', p)
    : `<div style="color:${p.mut};font-size:11px;margin:12px 0 6px">Remediation (SLA: 24h Critical · 72h High · 30d Medium)</div>` + kpiRow([
      { label: 'Remediated', value: num(remediations.length) },
      { label: 'Avg Time', value: avgRemedHours === null ? '—' : `${Math.round(avgRemedHours * 10) / 10}h` },
      { label: 'Within SLA', value: pct(slaPct), color: slaPct === null ? undefined : slaPct >= 90 ? p.ok : slaPct >= 70 ? p.warn : p.danger },
      { label: 'Fixed by AI', value: num(remedAi), note: `${num(remedHuman)} by human` + (remedUnknown > 0 ? ` · ${num(remedUnknown)} unresolved` : '') },
    ], p) + table(['Severity', 'Fixed', 'Avg Hours', 'Within SLA'],
      [...remedBySev.entries()].sort((a, b) => b[1].count - a[1].count).map(([sev, v]) => [
        esc(sev),
        num(v.count),
        (v.hoursSum / v.count).toFixed(1),
        `<span style="color:${v.within === v.count ? p.ok : p.warn}">${v.within} / ${v.count}</span>`,
      ]), p);

  const recentFindings = findings.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 8);
  const recent = await Promise.all(recentFindings.map(async f => {
    const d = f.data.security_agent_finding;
    const sevColor = d.severity === 'CRITICAL' || d.severity === 'HIGH' ? p.danger : d.severity === 'MEDIUM' ? p.warn : p.mut;
    // originCache is already warm from the KPI loop above, so this adds no
    // extra receiver invokes for findings we have already resolved.
    const { origin, source } = await findingOrigin(f, originCache);
    const originLabel = origin === 'unknown' ? '—' : origin === 'ai' ? 'ai' : 'human';
    return [
      esc(f.timestamp.slice(0, 16).replace('T', ' ')),
      `<span style="color:${sevColor}">${esc(d.severity ?? '—')}</span>`,
      typeof d.cvss_score === 'number' ? d.cvss_score.toFixed(1) : '—',
      esc(d.phase ?? '—'),
      esc(d.cwe_id ?? '—'),
      d.exploit_validated ? `<span style="color:${p.danger}">yes</span>` : '—',
      `${esc(originLabel)}${source === 'trailer' ? `<span style="color:${p.mut}"> (trailer)</span>` : ''}`,
      esc(f.data.repo ?? '—'),
    ];
  }));

  const originNote = originSources.has('trailer')
    ? footnote('Some origins resolved from legacy git trailers — those events predate the commit-SHA cutover. New findings resolve against the attribution store at render time.', p)
    : '';

  return kpis + remedKpis
    + `<div style="color:${p.mut};font-size:11px;margin-top:12px">Recent findings · by phase: ${esc([...byPhase.entries()].map(([ph, n]) => `${ph}:${n}`).join(' · ') || 'none')}</div>`
    + table(['Time (UTC)', 'Severity', 'CVSS', 'Phase', 'CWE', 'Exploit', 'Origin', 'Repo'], recent, p, 99)
    + originNote;
}

// ---- CISO views (depth; the exec strip owns the headline numbers) ----

// --- Row 1: current exposure ---

async function renderCisoExposure(fromIso: string, toIso: string, p: Palette): Promise<string> {
  const { findings, remediations } = await loadSecurityCorpus(fromIso, toIso);
  if (findings.length === 0) return noFindings(p);

  const bySev = new Map<string, number>();
  const cvss: number[] = [];
  let exploitValidated = 0;
  for (const f of findings) {
    const d = f.data.security_agent_finding;
    const sev = String(d.severity ?? 'UNKNOWN').toUpperCase();
    bySev.set(sev, (bySev.get(sev) ?? 0) + 1);
    if (d.exploit_validated) exploitValidated += 1;
    if (typeof d.cvss_score === 'number') cvss.push(d.cvss_score);
  }
  const critHigh = (bySev.get('CRITICAL') ?? 0) + (bySev.get('HIGH') ?? 0);

  // Aging: a finding is open until a remediation event references its id.
  const remediatedIds = new Set(
    remediations.map(r => r.data.security_remediation?.finding_id).filter(Boolean),
  );
  const now = Date.parse(toIso);
  let oldestOpenDays: number | null = null;
  let openCount = 0;
  for (const f of findings) {
    const d = f.data.security_agent_finding;
    if (d.finding_id && remediatedIds.has(d.finding_id)) continue;
    openCount += 1;
    const found = Date.parse(d.found_at ?? f.timestamp);
    if (Number.isNaN(found)) continue;
    const ageDays = (now - found) / 86400000;
    if (oldestOpenDays === null || ageDays > oldestOpenDays) oldestOpenDays = ageDays;
  }

  const cvssNote = cvss.length === 0
    ? 'not scored by this emitter'
    : `${num(cvss.length)} of ${num(findings.length)} scored`;

  return kpiRow([
    {
      label: 'Open Critical + High',
      value: num(critHigh),
      note: [...bySev.entries()].sort().map(([s, n]) => `${s}:${n}`).join(' · '),
      color: critHigh > 0 ? p.danger : p.ok,
    },
    {
      label: 'Exploit Validated',
      value: num(exploitValidated),
      note: 'pen-test proven — immediate blocker',
      color: exploitValidated > 0 ? p.danger : p.ok,
    },
    {
      label: 'Max CVSS',
      value: cvss.length ? Math.max(...cvss).toFixed(1) : '—',
      note: cvssNote,
      color: cvss.length && Math.max(...cvss) >= 9 ? p.danger : cvss.length && Math.max(...cvss) >= 7 ? p.warn : undefined,
    },
    {
      label: 'Avg CVSS',
      value: cvss.length ? (cvss.reduce((a, b) => a + b, 0) / cvss.length).toFixed(1) : '—',
    },
    {
      label: 'Oldest Unremediated',
      value: oldestOpenDays === null ? '—' : `${Math.floor(oldestOpenDays)}d`,
      note: `${num(openCount)} still open`,
      color: oldestOpenDays !== null && oldestOpenDays > 30 ? p.danger : oldestOpenDays !== null && oldestOpenDays > 7 ? p.warn : p.ok,
    },
    {
      label: 'Findings Recorded',
      value: num(findings.length),
      note: 'in selected range',
    },
  ], p) + footnote(
    'Open = no remediation event references the finding id. "Findings Recorded" counts findings, not scan runs — the SecurityScanCount metric is emitted once per finding, so a scan-count KPI would be double-labelled.',
    p,
  );
}

// --- Row 2: remediation SLA compliance ---

async function renderCisoSla(fromIso: string, toIso: string, p: Palette): Promise<string> {
  const { remediations } = await loadSecurityCorpus(fromIso, toIso);
  if (remediations.length === 0) {
    return emptyState(
      'prism.d1.security.remediation',
      'Populated by security-remediation-tracker when a finding is closed. No remediations in range means nothing has been fixed yet — or the tracker is not wired.',
      p,
    );
  }

  const bySev = new Map<string, { count: number; hoursSum: number; within: number; worst: number }>();
  let withinTotal = 0, eligibleTotal = 0;
  for (const r of remediations) {
    const d = r.data.security_remediation;
    const sev = String(d.severity ?? 'UNKNOWN').toUpperCase();
    const hours = Number(d.remediation_time_hours ?? 0);
    const agg = bySev.get(sev) ?? { count: 0, hoursSum: 0, within: 0, worst: 0 };
    agg.count += 1;
    agg.hoursSum += hours;
    if (hours > agg.worst) agg.worst = hours;
    const budget = SLA_HOURS[sev];
    if (budget !== undefined) {
      eligibleTotal += 1;
      if (hours <= budget) { agg.within += 1; withinTotal += 1; }
    }
    bySev.set(sev, agg);
  }
  const slaPct = eligibleTotal > 0 ? (withinTotal / eligibleTotal) * 100 : null;
  const breached = eligibleTotal - withinTotal;

  const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const rows = [...bySev.entries()]
    .sort((a, b) => (order.indexOf(a[0]) + 99 * (order.indexOf(a[0]) < 0 ? 1 : 0)) - (order.indexOf(b[0]) + 99 * (order.indexOf(b[0]) < 0 ? 1 : 0)))
    .map(([sev, v]) => {
      const budget = SLA_HOURS[sev];
      const breach = budget === undefined ? 0 : v.count - v.within;
      return [
        esc(sev),
        budget === undefined ? '—' : budget >= 720 ? `${budget / 24}d` : `${budget}h`,
        num(v.count),
        (v.hoursSum / v.count).toFixed(1),
        v.worst.toFixed(1),
        budget === undefined ? '—' : `<span style="color:${v.within === v.count ? p.ok : p.warn}">${v.within} / ${v.count}</span>`,
        breach > 0 ? `<span style="color:${p.danger}">${num(breach)}</span>` : '0',
      ];
    });

  return kpiRow([
    {
      label: 'Within Remediation SLA',
      value: pct(slaPct),
      note: `${num(withinTotal)} of ${num(eligibleTotal)} eligible`,
      color: slaPct === null ? undefined : slaPct >= 90 ? p.ok : slaPct >= 70 ? p.warn : p.danger,
    },
    { label: 'SLA Breaches', value: num(breached), note: 'named per severity below', color: breached > 0 ? p.danger : p.ok },
    { label: 'Findings Closed', value: num(remediations.length) },
  ], p)
    + table(['Severity', 'Budget', 'Fixed', 'Avg Hours', 'Worst', 'Within SLA', 'Breached'], rows, p)
    + footnote('Budgets from the AI-DLC steering baseline (SECURITY-09): 24h Critical, 72h High, 30d Medium/Low. Breaches are counted per severity rather than averaged into a single number, because one 200h Critical is not offset by ten fast Lows.', p);
}

// --- Row 3: AI code risk profile, normalized by commit volume ---

async function renderCisoRisk(fromIso: string, toIso: string, p: Palette): Promise<string> {
  const [{ findings, remediations }, report] = await Promise.all([
    loadSecurityCorpus(fromIso, toIso),
    fetchProductivity(fromIso, toIso).catch(() => null),
  ]);
  if (findings.length === 0) return noFindings(p);

  const cache = new Map<string, ResolvedOrigin>();
  const sources = new Set<string>();
  // origin -> severity -> count
  const matrix = new Map<ResolvedOrigin, Map<string, number>>();
  const totals = new Map<ResolvedOrigin, number>();
  for (const f of findings) {
    const { origin, source } = await findingOrigin(f, cache);
    if (source !== 'none') sources.add(source);
    const sev = String(f.data.security_agent_finding.severity ?? 'UNKNOWN').toUpperCase();
    const row = matrix.get(origin) ?? new Map<string, number>();
    row.set(sev, (row.get(sev) ?? 0) + 1);
    matrix.set(origin, row);
    totals.set(origin, (totals.get(origin) ?? 0) + 1);
  }

  const aiCommits = report?.totals?.commits?.ai ?? null;
  const humanCommits = report?.totals?.commits?.human ?? null;
  const aiFindings = totals.get('ai') ?? 0;
  const humanFindings = totals.get('human') ?? 0;
  const unresolved = totals.get('unknown') ?? 0;

  const per100 = (f: number, c: number | null): number | null =>
    c === null || c === 0 ? null : (f / c) * 100;
  const aiRate = per100(aiFindings, aiCommits);
  const humanRate = per100(humanFindings, humanCommits);
  const ratio = aiRate !== null && humanRate !== null && humanRate > 0 ? aiRate / humanRate : null;

  const normalized = kpiRow([
    {
      label: 'AI findings / 100 commits',
      value: aiRate === null ? '—' : aiRate.toFixed(1),
      note: aiCommits === null ? 'commit volume unavailable' : `${num(aiFindings)} findings / ${num(aiCommits)} AI commits`,
    },
    {
      label: 'Human findings / 100 commits',
      value: humanRate === null ? '—' : humanRate.toFixed(1),
      note: humanCommits === null ? 'commit volume unavailable' : `${num(humanFindings)} findings / ${num(humanCommits)} human commits`,
    },
    {
      label: 'AI : Human risk ratio',
      value: ratio === null ? '—' : `${ratio.toFixed(2)}x`,
      // A bare dash invites the reader to assume the worst. Say which side is
      // missing: no human baseline is a very different situation from no data.
      note: ratio !== null
        ? 'L2 ≤1.2x · L4 ≤0.9x'
        : humanCommits === null
          ? 'commit volume unavailable'
          : humanRate === 0
            ? 'no human-origin findings to compare against'
            : 'insufficient data',
      color: ratio === null ? undefined : ratio <= 0.9 ? p.ok : ratio <= 1.2 ? p.warn : p.danger,
    },
    {
      label: 'Unresolved Origin',
      value: num(unresolved),
      note: unresolved > 0 ? 'SHAs not in attribution store' : 'all findings attributed',
      color: unresolved > 0 ? p.warn : p.ok,
    },
  ], p);

  const sevOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
  const matrixRows = (['ai', 'human', 'unknown'] as ResolvedOrigin[])
    .filter(o => totals.has(o))
    .map(o => {
      const row = matrix.get(o) ?? new Map<string, number>();
      return [
        o === 'unknown' ? 'unresolved' : o,
        ...sevOrder.map(s => {
          const n = row.get(s) ?? 0;
          const color = n === 0 ? p.mut : s === 'CRITICAL' || s === 'HIGH' ? p.danger : p.fg;
          return `<span style="color:${color}">${num(n)}</span>`;
        }),
        num(totals.get(o) ?? 0),
      ];
    });

  // Remediation latency by who fixed it — now resolved by the same deferred
  // attribution join as the findings, so this survives hook removal.
  const remedByOrigin = new Map<string, { count: number; hoursSum: number }>();
  for (const r of remediations) {
    const { origin, source } = await remediationOrigin(r, cache);
    if (source !== 'none') sources.add(source);
    const key = origin === 'unknown' ? 'unresolved' : origin;
    const agg = remedByOrigin.get(key) ?? { count: 0, hoursSum: 0 };
    agg.count += 1;
    agg.hoursSum += Number(r.data.security_remediation?.remediation_time_hours ?? 0);
    remedByOrigin.set(key, agg);
  }
  const remedRows = [...remedByOrigin.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([k, v]) => [esc(k), num(v.count), (v.hoursSum / v.count).toFixed(1)]);

  const volumeWarn = aiCommits === null
    ? footnote('Attribution store unreachable — rates cannot be normalized, so only raw counts are shown. Raw counts are not comparable when AI and human commit volumes differ.', p)
    : '';
  const trailerWarn = sources.has('trailer')
    ? footnote('Some origins came from legacy git trailers (events predating the commit-SHA cutover, on either the finding or the remediation path). Trailers disappear at Phase 3 hook removal; new events resolve against the attribution store.', p)
    : '';

  return normalized
    + `<div style="color:${p.mut};font-size:11px;margin:14px 0 0">Origin × severity</div>`
    + table(['Origin', ...sevOrder, 'Total'], matrixRows, p)
    + (remedRows.length
      ? `<div style="color:${p.mut};font-size:11px;margin:14px 0 0">Remediation latency by fixer</div>`
        + table(['Fixed by', 'Count', 'Avg Hours'], remedRows, p)
      : '')
    + volumeWarn
    + trailerWarn
    + footnote('Rates are the only defensible answer to "is AI code riskier?" — raw finding counts scale with how much code each origin produced.', p);
}

// --- Row 4: shift-left effectiveness ---

async function renderCisoShiftleft(fromIso: string, toIso: string, p: Palette): Promise<string> {
  const { findings } = await loadSecurityCorpus(fromIso, toIso);
  if (findings.length === 0) return noFindings(p);

  const PHASES = ['design_review', 'code_review', 'pen_test'];
  const byPhase = new Map<string, PrismEvent[]>();
  for (const f of findings) {
    const phase = String(f.data.security_agent_finding.phase ?? 'unknown');
    const arr = byPhase.get(phase) ?? [];
    arr.push(f);
    byPhase.set(phase, arr);
  }

  // Survival rate: a class of issue (CWE, else category) raised at design
  // review that reappears in a later phase was not actually fixed early.
  // Both steering files define this metric and nothing emits it.
  const classOf = (f: PrismEvent): string | null => {
    const d = f.data.security_agent_finding;
    return d.cwe_id ?? d.category ?? null;
  };
  const designClasses = new Set(
    (byPhase.get('design_review') ?? []).map(classOf).filter((c): c is string => !!c),
  );
  const laterClasses = new Set(
    [...(byPhase.get('code_review') ?? []), ...(byPhase.get('pen_test') ?? [])]
      .map(classOf).filter((c): c is string => !!c),
  );
  const survived = [...designClasses].filter(c => laterClasses.has(c));
  const survivalPct = designClasses.size > 0 ? (survived.length / designClasses.size) * 100 : null;

  const phaseKpis = kpiRow([
    ...PHASES.map(ph => ({
      label: ph.replace(/_/g, ' '),
      value: num((byPhase.get(ph) ?? []).length),
      note: ph === 'design_review' ? 'cheapest to fix' : ph === 'pen_test' ? 'most expensive' : undefined,
    })),
    {
      label: 'Finding Survival Rate',
      value: pct(survivalPct),
      note: designClasses.size === 0
        ? 'no design-phase findings to track'
        : `${survived.length} of ${designClasses.size} classes resurfaced`,
      color: survivalPct === null ? undefined : survivalPct <= 10 ? p.ok : survivalPct <= 30 ? p.warn : p.danger,
    },
  ], p);

  const trends = `<div style="display:flex;gap:24px;margin:14px 0 0;flex-wrap:wrap">${PHASES.map(ph => {
    const chrono = (byPhase.get(ph) ?? []).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const series = dailySeries(chrono, e => e.timestamp, bucket => bucket.length);
    return `<div>
      <div style="color:${p.mut};font-size:11px">${esc(ph.replace(/_/g, ' '))} findings / day</div>
      ${sparkline(series, p, { color: ph === 'pen_test' ? p.danger : ph === 'code_review' ? p.warn : p.accent, width: 200 })}
    </div>`;
  }).join('')}</div>`;

  const survivedRows = survived.slice(0, 10).map(c => {
    const design = (byPhase.get('design_review') ?? []).filter(f => classOf(f) === c).length;
    const later = [...(byPhase.get('code_review') ?? []), ...(byPhase.get('pen_test') ?? [])]
      .filter(f => classOf(f) === c).length;
    return [esc(c), num(design), num(later)];
  });

  const unknownPhase = (byPhase.get('unknown') ?? []).length;

  return phaseKpis
    + trends
    + (survivedRows.length
      ? `<div style="color:${p.mut};font-size:11px;margin:14px 0 0">Issue classes that survived design review</div>`
        + table(['CWE / Category', 'At Design', 'Later Phases'], survivedRows, p)
      : '')
    + (unknownPhase > 0 ? footnote(`${unknownPhase} finding(s) carry no phase and are excluded from shift-left analysis.`, p) : '')
    + footnote('Survival rate matches issue classes (CWE, else category) across phases — lower is better. A class raised at design that reappears in code review or pen test was flagged early but not actually prevented.', p);
}

// --- Row 5: vulnerability classes and compliance coverage ---

async function renderCisoClasses(fromIso: string, toIso: string, p: Palette): Promise<string> {
  const { findings } = await loadSecurityCorpus(fromIso, toIso);
  if (findings.length === 0) return noFindings(p);

  const SEV_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
  const byCwe = new Map<string, { count: number; worst: string; cvss: number[] }>();
  const byCategory = new Map<string, number>();
  const byFramework = new Map<string, number>();
  let taggedCwe = 0, taggedCategory = 0, taggedCompliance = 0;

  for (const f of findings) {
    const d = f.data.security_agent_finding;
    const sev = String(d.severity ?? 'UNKNOWN').toUpperCase();
    if (d.cwe_id) {
      taggedCwe += 1;
      const agg = byCwe.get(d.cwe_id) ?? { count: 0, worst: 'UNKNOWN', cvss: [] };
      agg.count += 1;
      if ((SEV_RANK[sev] ?? 0) > (SEV_RANK[agg.worst] ?? 0)) agg.worst = sev;
      if (typeof d.cvss_score === 'number') agg.cvss.push(d.cvss_score);
      byCwe.set(d.cwe_id, agg);
    }
    if (d.category) {
      taggedCategory += 1;
      byCategory.set(d.category, (byCategory.get(d.category) ?? 0) + 1);
    }
    const mappings: unknown = d.compliance_mappings;
    if (Array.isArray(mappings) && mappings.length > 0) {
      taggedCompliance += 1;
      for (const m of mappings) {
        const key = String(m);
        byFramework.set(key, (byFramework.get(key) ?? 0) + 1);
      }
    }
  }

  const cweMax = Math.max(...[...byCwe.values()].map(v => v.count), 1);
  const cweRows = [...byCwe.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 12)
    .map(([cwe, v]) => [
      esc(cwe),
      `${bar(v.count, cweMax, (SEV_RANK[v.worst] ?? 0) >= 3 ? p.danger : p.accent)}${num(v.count)}`,
      `<span style="color:${(SEV_RANK[v.worst] ?? 0) >= 3 ? p.danger : p.fg}">${esc(v.worst)}</span>`,
      v.cvss.length ? (v.cvss.reduce((a, b) => a + b, 0) / v.cvss.length).toFixed(1) : '—',
    ]);

  const catRows = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([c, n]) => [esc(c), num(n)]);

  const fwRows = [...byFramework.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([fw, n]) => [esc(fw), num(n), pct((n / findings.length) * 100)]);

  const coverage = kpiRow([
    { label: 'Distinct CWEs', value: num(byCwe.size), note: `${num(taggedCwe)} of ${num(findings.length)} findings tagged` },
    { label: 'Categories', value: num(byCategory.size), note: `${num(taggedCategory)} tagged` },
    { label: 'Frameworks Touched', value: num(byFramework.size), note: `${num(taggedCompliance)} findings mapped` },
  ], p);

  // The kiro workflow's inline emission only carries finding_id, phase,
  // severity, cwe_id and commit_shas. category / compliance_mappings /
  // cvss_score come from the security-agent-processor webhook path, so a
  // kiro-only deployment legitimately has empty category and framework tables.
  const emitterNote = (taggedCategory === 0 || taggedCompliance === 0)
    ? footnote('Empty category / framework tables mean findings arrived via the kiro eval-gate inline emission, which carries only finding_id, phase, severity, cwe_id and commit_shas. category and compliance_mappings are populated by the security-agent-processor webhook path.', p)
    : '';

  return coverage
    + (cweRows.length
      ? `<div style="color:${p.mut};font-size:11px;margin:14px 0 0">Top CWEs</div>`
        + table(['CWE', 'Findings', 'Worst Severity', 'Avg CVSS'], cweRows, p)
      : footnote('No findings carry a cwe_id in this range.', p))
    + (catRows.length
      ? `<div style="color:${p.mut};font-size:11px;margin:14px 0 0">Vulnerability categories</div>` + table(['Category', 'Findings'], catRows, p)
      : '')
    + (fwRows.length
      ? `<div style="color:${p.mut};font-size:11px;margin:14px 0 0">Compliance framework coverage</div>`
        + table(['Framework', 'Findings', '% of all findings'], fwRows, p)
      : '')
    + emitterNote
    + footnote('compliance_mappings is a string array on each finding — it cannot be expressed as a CloudWatch dimension, so this view is only possible by reading events directly.', p);
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
      case 'exec': body = await renderExec(fromIso, toIso, days, p); break;
      case 'exec-security': body = await renderExecSecurity(fromIso, toIso, p); break;
      case 'aidora': body = await renderAidora(fromIso, toIso, p); break;
      case 'repos': body = await renderRepos(fromIso, toIso, p); break;
      case 'eval': body = await renderEval(fromIso, toIso, p); break;
      case 'governance': body = await renderGovernance(fromIso, toIso, p); break;
      case 'agents': body = await renderAgents(fromIso, toIso, p); break;
      case 'security': body = await renderSecurity(fromIso, toIso, p); break;
      case 'ciso-exposure': body = await renderCisoExposure(fromIso, toIso, p); break;
      case 'ciso-sla': body = await renderCisoSla(fromIso, toIso, p); break;
      case 'ciso-risk': body = await renderCisoRisk(fromIso, toIso, p); break;
      case 'ciso-shiftleft': body = await renderCisoShiftleft(fromIso, toIso, p); break;
      case 'ciso-classes': body = await renderCisoClasses(fromIso, toIso, p); break;
      default: body = `<div style="color:${p.danger}">Unknown view: ${esc(view)}</div>`;
    }
    return `<div style="font-family:'Amazon Ember',Helvetica,Arial,sans-serif;color:${p.fg};font-size:13px">${body}</div>`;
  } catch (err) {
    return `<div style="color:${p.danger};font-size:12px">Panel error: ${esc((err as Error).message)}</div>`;
  }
}
