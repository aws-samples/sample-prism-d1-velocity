/**
 * What the PRISM panel shows, and its HTML shell. The data goes to the
 * webview by postMessage and is drawn with textContent (media/panel.js); the
 * webview's messages back are checked here. No vscode import.
 */
import type { CheckItem, DashboardPayload, RepoView, UsageTotals } from './payload';
import type { DiagnosticRecord } from './diagnostics';
import { money, plainText } from './text';

export interface Card { title: string; value: string; detail: string; tone: 'ok' | 'warn' | 'error' | 'none' }
export interface FindingItem { index: number; location: string; severity: string; category: string; message: string; openable: boolean }
export interface ChecklistItem { key: string; group: 'This machine' | 'This repo'; label: string; status: string; detail: string; fix: string }

export interface PanelModel {
  mode: 'repo';
  repo: string;
  generatedAt: string;
  cards: Card[];
  reviewNote: string;
  hasReport: boolean;
  findings: FindingItem[];
  findingsTruncated: boolean;
  checklist: ChecklistItem[];
  codewatchOff: boolean;
}

const one = (s: unknown, max = 300) => plainText(s, { oneLine: true, max });

export function panelModel(p: DashboardPayload, v: RepoView, diags: DiagnosticRecord[], codewatchOff: boolean, fmtTime: (iso: string) => string): PanelModel {
  const r = v.review;
  const spend = p.summary.spend;
  const warn = p.summary.warnings;
  const cards: Card[] = [
    r
      ? { title: 'Latest review', value: `${r.high} high · ${r.medium} med · ${r.low} low`, detail: `${fmtTime(r.started_at)} · ${one(r.tool, 40)} · ${one(r.status, 20)}${r.reason ? ` (${one(r.reason, 120)})` : ''}`, tone: r.high > 0 ? 'error' : r.medium > 0 ? 'warn' : 'ok' }
      : { title: 'Latest review', value: 'none yet', detail: codewatchOff ? 'codewatch is off in this repo' : 'no pre-push review recorded', tone: 'none' },
    spend.status === 'ok'
      ? { title: 'AI spend', value: typeof spend.today === 'number' ? `${money(spend.today, spend.currency)} today` : 'no data today', detail: `${typeof spend.month === 'number' ? money(spend.month, spend.currency) : 'n/a'} this month (all repos)${v.repo?.spend ? ` · ${money(v.repo.spend.cost, spend.currency)} in this repo` : ''}`, tone: 'none' }
      : { title: 'AI spend', value: one(spend.status, 20), detail: one(spend.message ?? ''), tone: 'none' },
    { title: 'Setup warnings', value: String(warn.count), detail: warn.first ? one(warn.first) : 'nothing to fix', tone: warn.count ? 'warn' : 'ok' },
    { title: 'Sync mode', value: one(p.machine.codeburnSync?.mode ?? 'unknown', 20), detail: 'where codeburn usage goes', tone: 'none' },
  ];
  // Findings that resolved to a file in this repo are clickable (index into diags); the rest are listed as text.
  const diagOf = new Map(diags.map((d, i) => [d.findingIndex, i]));
  const findings: FindingItem[] = v.findings.map((f, i) => {
    const msg = plainText(f.message);
    const idx = diagOf.get(i);
    return {
      index: idx ?? -1,
      location: `${one(f.file, 200)}${Number.isInteger(f.line) ? `:${f.line}` : ''}`,
      severity: one(f.severity, 10), category: one(f.category, 40), message: msg, openable: idx !== undefined,
    };
  });
  const checklist: ChecklistItem[] = [
    ...p.machine.setup.map((i: CheckItem) => item(`m:${i.id}`, 'This machine', i.label, i.status, i.help?.text ?? i.detail, i.fix)),
    ...(v.repo ? [
      item('r:codewatch', 'This repo', 'Codewatch git hooks', v.repo.setup.status, v.repo.setup.detail, v.repo.setup.fix || (codewatchOff ? 'prism-cli enable codewatch' : '')),
      item('r:security', 'This repo', 'AWS Security Agent (CI)', v.repo.security.status, v.repo.security.detail, v.repo.security.fix),
    ] : []),
  ];
  return {
    mode: 'repo',
    repo: one(v.repo?.label ?? '(not found)', 120),
    generatedAt: fmtTime(p.generated_at),
    cards,
    reviewNote: r && !r.onBranch ? `This review is of branch ${one(r.branch ?? '(detached)', 80)}, not the checked-out one, so its findings are not marked in the editor.` : '',
    hasReport: !!r,
    findings,
    findingsTruncated: !!v.repo?.codewatch.findingsTruncated,
    checklist,
    codewatchOff,
  };
}

export interface ListRow { name: string; value: string }
/** A repo with codewatch. `path` is only sent back in an openFolder message, which is checked against this model. */
export interface RepoRow { name: string; path: string; review: string; when: string; status: string; tone: Card['tone'] }

/** The panel with no repo in the window: this machine's spend, setup and the repos that have codewatch. */
export interface MachinePanelModel {
  mode: 'machine';
  generatedAt: string;
  cards: Card[];
  topModels: ListRow[];
  topProjects: ListRow[];
  checklist: ChecklistItem[];
  repos: RepoRow[];
  reposNote: string;
}

export type AnyPanelModel = PanelModel | MachinePanelModel;

/** Last path segment: a project is shown by its folder name, never its full path. */
const baseName = (s: unknown) => one(String(s ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '', 120);
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function machinePanelModel(p: DashboardPayload, fmtTime: (iso: string) => string): MachinePanelModel {
  const u = p.usage;
  const warn = p.summary.warnings;
  const cur = u?.currency ?? p.summary.spend.currency;
  const spendCard = (title: string, t: UsageTotals | null, extra = ''): Card => t
    ? { title, value: money(t.cost, cur), detail: `${count(t.calls, 'call')} · ${count(t.sessions, 'session')}${extra}`, tone: 'none' }
    : { title, value: 'no data', detail: '', tone: 'none' };
  const cards: Card[] = u && u.status === 'ok'
    ? [
      spendCard('AI spend today', u.today),
      spendCard('AI spend this month', u.month, u.month ? ` · ${one(u.month.from, 10)} to ${one(u.month.to, 10)}` : ''),
    ]
    : [{ title: 'AI spend', value: one(u?.status ?? p.summary.spend.status, 20), detail: one(u?.message ?? p.summary.spend.message ?? ''), tone: 'none' }];
  cards.push({ title: 'Setup warnings', value: String(warn.count), detail: warn.first ? one(warn.first) : 'nothing to fix', tone: warn.count ? 'warn' : 'ok' });
  const setupOf = new Map((p.overview?.setup ?? []).map((r) => [r.path, r.status]));
  const repos: RepoRow[] = (p.overview?.codewatch ?? []).map((r) => ({
    name: one(r.label || r.name, 120),
    path: r.path,
    review: r.lastRunAt ? `${r.high} high · ${r.medium} med · ${r.low} low` : 'no review yet',
    when: r.lastRunAt ? fmtTime(r.lastRunAt) : '',
    status: one(setupOf.get(r.path) ?? 'unknown', 20),
    tone: !r.lastRunAt ? 'none' : r.high > 0 ? 'error' : r.medium > 0 ? 'warn' : 'ok',
  }));
  const c = p.overview?.counts;
  return {
    mode: 'machine',
    generatedAt: fmtTime(p.generated_at),
    cards,
    topModels: (u?.topModels ?? []).map((m) => ({ name: one(m.name, 120), value: `${money(m.cost, cur)} · ${count(m.calls, 'call')}` })),
    topProjects: (u?.topProjects ?? []).map((m) => ({ name: baseName(m.name), value: `${money(m.cost, cur)} · ${count(m.sessions, 'session')}` })),
    checklist: p.machine.setup.map((i: CheckItem) => item(`m:${i.id}`, 'This machine', i.label, i.status, i.help?.text ?? i.detail, i.fix)),
    repos,
    reposNote: c ? `${c.codewatch} of ${c.repos} repos found under your home folder have codewatch.` : '',
  };
}

const item = (key: string, group: ChecklistItem['group'], label: string, status: string, detail: string, fix: string): ChecklistItem =>
  ({ key, group, label: one(label, 120), status: one(status, 20), detail: one(detail, 500), fix: one(fix, 500) });

/** A message from the webview, checked. Anything else is ignored. */
export type PanelAction =
  | { type: 'open'; index: number }
  | { type: 'copy'; key: string }
  | { type: 'openFolder'; path: string }
  | { type: 'refresh' } | { type: 'report' } | { type: 'enable' } | { type: 'ready' };

/** Checked against the model the extension built from the last prism-cli JSON, never trusted from the webview. */
export function parsePanelMessage(m: unknown, model: AnyPanelModel | null): PanelAction | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'open':
      return Number.isInteger(o.index) && (o.index as number) >= 0 && model?.mode === 'repo' && model.findings.some((f) => f.openable && f.index === o.index) ? { type: 'open', index: o.index as number } : null;
    case 'copy':
      return typeof o.key === 'string' && model?.checklist.some((c) => c.key === o.key && c.fix) ? { type: 'copy', key: o.key } : null;
    case 'openFolder':
      return typeof o.path === 'string' && model?.mode === 'machine' && model.repos.some((r) => r.path === o.path) ? { type: 'openFolder', path: o.path } : null;
    case 'refresh': case 'report': case 'enable': case 'ready':
      return { type: o.type };
    default:
      return null;
  }
}

/** The panel's HTML shell: no data in it, a nonce'd script, nothing remote. */
export function panelHtml(o: { nonce: string; cspSource: string; scriptUri: string; styleUri: string }): string {
  const csp = [`default-src 'none'`, `style-src ${o.cspSource}`, `script-src 'nonce-${o.nonce}'`, `img-src ${o.cspSource}`, `font-src ${o.cspSource}`].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${o.styleUri}">
<title>PRISM</title>
</head>
<body>
<main id="app" hidden></main>
<p id="loading">Loading PRISM results…</p>
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}

/** A CSP for the CLI-rendered report: its inline styles only, no script, nothing remote. */
export const REPORT_CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src data:`;

export function withReportCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`;
  const m = /<head[^>]*>/i.exec(html);
  return m ? html.slice(0, m.index + m[0].length) + meta + html.slice(m.index + m[0].length) : `<!DOCTYPE html><html><head>${meta}</head><body>${html}</body></html>`;
}
