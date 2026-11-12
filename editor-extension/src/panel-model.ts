/**
 * What the PRISM panel shows, and its HTML shell. The data goes to the
 * webview by postMessage and is drawn with textContent (media/panel.js); the
 * webview's messages back are checked here. No vscode import.
 */
import type { CheckItem, DashboardPayload, RepoView, UsageTotals } from './payload';
import type { LastCommit } from './cli';
import type { MachineRepo } from './machine';
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
export interface RowFinding { severity: string; location: string; message: string; branch: string; openable: boolean }
/** A repo with codewatch. It carries no path: the webview sends back only indexes into this list. */
export interface RepoRow {
  name: string; review: string; when: string; status: string; tone: Card['tone'];
  /** "abc1234 · 3 h ago · subject", or that the last commit is unknown. */
  commit: string;
  findings: RowFinding[];
  /** "N more findings" when the list was capped, else empty. */
  more: string;
  hasReport: boolean;
}

/** What the extension keeps per repo row and never posts: its path and each listed finding's file and 0-based line. */
export interface MachineTarget {
  path: string;
  name: string;
  commit: LastCommit | null | undefined;
  files: { path: string | null; line: number }[];
}

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

/** "5 min ago", "3 h ago", "2 d ago". shortcut: computed when the model is built, so it ages until the next refresh (at most 5 min). */
export function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function repoRow(m: MachineRepo, setupStatus: string | undefined, fileOf: (repoPath: string, file: unknown) => string | null, fmtTime: (iso: string) => string, now: number): { row: RepoRow; target: MachineTarget } {
  const r = m.row;
  const files = m.findings.map((f) => ({ path: fileOf(r.path, f.file), line: Number.isInteger(f.line) && (f.line as number) > 0 ? (f.line as number) - 1 : 0 }));
  const row: RepoRow = {
    name: one(r.label || r.name, 120),
    review: r.lastRunAt ? `${r.high} high · ${r.medium} med · ${r.low} low` : 'no review yet',
    when: r.lastRunAt ? fmtTime(r.lastRunAt) : '',
    status: one(setupStatus ?? 'unknown', 20),
    tone: !r.lastRunAt ? 'none' : r.high > 0 ? 'error' : r.medium > 0 ? 'warn' : 'ok',
    commit: m.commit ? `${one(m.commit.sha, 12)} · ${ago(m.commit.at, now)} · ${one(m.commit.subject, 80)}` : 'last commit: unknown',
    findings: m.findings.map((f, i) => ({
      severity: one(f.severity, 10),
      location: `${one(f.file, 200)}${Number.isInteger(f.line) ? `:${f.line}` : ''}`,
      message: one(f.message, 300),
      branch: one(f.branch ?? '(detached)', 80),
      openable: files[i].path !== null,
    })),
    more: m.moreFindings > 0 ? `${count(m.moreFindings, 'more finding')} not listed; open the report for all of them.` : '',
    hasReport: !!m.repo?.codewatch.lastReviewId,
  };
  return { row, target: { path: r.path, name: row.name, commit: m.commit, files } };
}

/**
 * The machine panel, and per repo row what the extension keeps for the
 * panel's index-only messages. `repos` is machineRepos() (sorted, capped);
 * `fileOf` is repoFile() (the path guard).
 */
export function machinePanelModel(p: DashboardPayload, repos: MachineRepo[], fileOf: (repoPath: string, file: unknown) => string | null, fmtTime: (iso: string) => string, now = Date.now()): { model: MachinePanelModel; targets: MachineTarget[] } {
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
  const built = repos.map((m) => repoRow(m, setupOf.get(m.row.path), fileOf, fmtTime, now));
  const c = p.overview?.counts;
  const model: MachinePanelModel = {
    mode: 'machine',
    generatedAt: fmtTime(p.generated_at),
    cards,
    topModels: (u?.topModels ?? []).map((m) => ({ name: one(m.name, 120), value: `${money(m.cost, cur)} · ${count(m.calls, 'call')}` })),
    topProjects: (u?.topProjects ?? []).map((m) => ({ name: baseName(m.name), value: `${money(m.cost, cur)} · ${count(m.sessions, 'session')}` })),
    checklist: p.machine.setup.map((i: CheckItem) => item(`m:${i.id}`, 'This machine', i.label, i.status, i.help?.text ?? i.detail, i.fix)),
    repos: built.map((b) => b.row),
    reposNote: c ? `${c.codewatch} of ${c.repos} repos found under your home folder have codewatch. Newest commit first.` : '',
  };
  return { model, targets: built.map((b) => b.target) };
}

const item = (key: string, group: ChecklistItem['group'], label: string, status: string, detail: string, fix: string): ChecklistItem =>
  ({ key, group, label: one(label, 120), status: one(status, 20), detail: one(detail, 500), fix: one(fix, 500) });

/** A message from the webview, checked. Anything else is ignored. */
export type PanelAction =
  | { type: 'open'; index: number }
  | { type: 'copy'; key: string }
  | { type: 'openFolder'; repoIndex: number }
  | { type: 'repoReport'; repoIndex: number }
  | { type: 'openRepoFinding'; repoIndex: number; findingIndex: number }
  | { type: 'refresh' } | { type: 'report' } | { type: 'enable' } | { type: 'ready' };

const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** Checked against the model the extension built from the last prism-cli JSON, never trusted from the webview. */
export function parsePanelMessage(m: unknown, model: AnyPanelModel | null): PanelAction | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'open':
      return Number.isInteger(o.index) && (o.index as number) >= 0 && model?.mode === 'repo' && model.findings.some((f) => f.openable && f.index === o.index) ? { type: 'open', index: o.index as number } : null;
    case 'copy':
      return typeof o.key === 'string' && model?.checklist.some((c) => c.key === o.key && c.fix) ? { type: 'copy', key: o.key } : null;
    case 'openFolder': case 'repoReport': {
      const row = model?.mode === 'machine' && isIndex(o.repoIndex) ? model.repos[o.repoIndex] : undefined;
      if (!row || (o.type === 'repoReport' && !row.hasReport)) return null;
      return { type: o.type, repoIndex: o.repoIndex as number };
    }
    case 'openRepoFinding': {
      const row = model?.mode === 'machine' && isIndex(o.repoIndex) ? model.repos[o.repoIndex] : undefined;
      const f = row && isIndex(o.findingIndex) ? row.findings[o.findingIndex] : undefined;
      return f?.openable ? { type: 'openRepoFinding', repoIndex: o.repoIndex as number, findingIndex: o.findingIndex as number } : null;
    }
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
