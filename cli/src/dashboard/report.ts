/**
 * Scan report: one pre-push review plus the pre-commit secret scans of the
 * commits it covers. One module builds the data and renders it three ways,
 * shared by GET /report/<id>, GET /report/<id>.md and `prism-cli codewatch report`.
 *
 * Ids are result file names without `.json`. They are only ever looked up in
 * the directory listing of `.prism/results/`; no path is built from one.
 * Secret values never appear: results do not store them, and the secret
 * section projects rule id and location only.
 */
import { basename } from 'node:path';
import { readResultEntries, type Finding, type PrismResult, type ResultEntry, type Severity } from '../codewatch/results.js';
import { attributeFindings, Blamer, collectCommits, expandRange, readLog, type CommitFinding, type LogEntry, type SecretScanState } from './commits.js';

/** Shape of a result id. Checked before the listing lookup, which is what actually decides. */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,120}$/;

/** The listing entry whose id equals `id`, or null. Unknown, malformed and traversal ids all return null. */
export function findResultById(repoRoot: string, id: string, entries?: ResultEntry[]): ResultEntry | null {
  if (typeof id !== 'string' || !ID_SHAPE.test(id)) return null;
  return (entries ?? readResultEntries(repoRoot)).find((e) => e.id === id) ?? null;
}

const isReview = (r: PrismResult) => r.kind === 'review' && r.hook === 'pre-push';
const byTime = (a: ResultEntry, b: ResultEntry) => String(a.result.started_at).localeCompare(String(b.result.started_at));

/** Newest review entries, newest first. */
export function reviewEntries(entries: ResultEntry[]): ResultEntry[] {
  return entries.filter((e) => isReview(e.result) && e.result.commit).sort(byTime).reverse();
}

export interface ReportCommit {
  sha: string;
  short: string;
  subject: string | null;
  authorDate: string | null;
  secretScan: SecretScanState;
  secretScanReason: string | null;
  high: number;
  medium: number;
  low: number;
}

export interface ReportFinding extends CommitFinding {
  commit: string | null;
  commitSubject: string | null;
}

export interface ReportBlock {
  at: string;
  branch: string | null;
  /** rule id and location only; never the secret. */
  items: { rule: string; file: string; line: number | null }[];
}

export interface ScanReport {
  schema: 'prism.codewatch.report.v1';
  id: string;
  repo: { name: string; path: string };
  branch: string | null;
  upstream: string | null;
  range: { base: string | null; tip: string; commits: number };
  reviewer: { tool: string; version: string | null; model: string | null };
  startedAt: string;
  finishedAt: string;
  durationSeconds: number | null;
  status: PrismResult['status'];
  /** Display state: findings, clean, error or skipped. */
  state: 'findings' | 'clean' | 'error' | 'skipped';
  reason: string | null;
  score: number | null;
  truncated: boolean;
  summary: string | null;
  totals: { severity: Record<Severity, number>; category: { security: number; quality: number }; findings: number };
  files: { file: string; findings: ReportFinding[] }[];
  secretScans: ReportCommit[];
  gitleaksBlocks: ReportBlock[];
  commits: ReportCommit[];
}

const SEV_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Resolves `--commit <sha>`: the newest review whose range includes it (prefix match allowed). */
export function reviewForCommit(entries: ResultEntry[], sha: string, log: Map<string, LogEntry>): ResultEntry | null {
  const want = sha.toLowerCase();
  for (const e of reviewEntries(entries)) {
    if (e.result.status === 'skipped') continue;
    const tip = e.result.commit as string;
    if (tip.startsWith(want)) return e;
    if (expandRange(log, e.result.base, tip).some((c) => c.startsWith(want))) return e;
  }
  return null;
}

export function buildReport(repoRoot: string, entry: ResultEntry, all: ResultEntry[], deps: { log?: Map<string, LogEntry>; blamer?: Blamer } = {}): ScanReport {
  const rev = entry.result;
  if (!isReview(rev) || !rev.commit) throw new Error('not a pre-push review');
  const log = deps.log ?? readLog(repoRoot);
  const blamer = deps.blamer ?? new Blamer(repoRoot);
  const pushed = rev.status !== 'skipped';
  const { range, byCommit } = pushed ? attributeFindings(rev, log, blamer) : { range: [], byCommit: new Map<string, CommitFinding[]>() };
  const subj = (sha: string | null) => (sha ? log.get(sha)?.subject ?? null : null);

  // Findings with their commit, grouped by file, worst first.
  const findings: ReportFinding[] = [];
  for (const [sha, fs] of byCommit) for (const f of fs) findings.push({ ...f, commit: sha, commitSubject: subj(sha) });
  if (!pushed) for (const f of rev.findings || []) findings.push({ ...f, attributed: 'tip', inPushOf: null, commit: null, commitSubject: null });
  const groups = new Map<string, ReportFinding[]>();
  for (const f of findings) {
    const k = f.file || '(no file)';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(f);
  }
  const files = [...groups.entries()].map(([file, fs]) => ({
    file,
    findings: fs.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || (a.line ?? 0) - (b.line ?? 0)),
  }));
  const worst = (fs: Finding[]) => Math.min(...fs.map((f) => SEV_ORDER[f.severity]));
  files.sort((a, b) => worst(a.findings) - worst(b.findings) || b.findings.length - a.findings.length || a.file.localeCompare(b.file));

  const severity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  const category = { security: 0, quality: 0 };
  for (const f of findings) { severity[f.severity]++; category[f.category]++; }

  // Secret scan state per commit, from the same matching the Commits table uses.
  const rows = collectCommits(repoRoot, all.map((e) => e.result), { log, blamer, maxRows: Number.MAX_SAFE_INTEGER });
  const rowBy = new Map(rows.rows.map((r) => [r.sha, r]));
  const commits: ReportCommit[] = range.map((sha) => {
    const fs = byCommit.get(sha) || [];
    const r = rowBy.get(sha);
    return {
      sha, short: sha.slice(0, 8), subject: subj(sha), authorDate: log.get(sha)?.authorDate ?? null,
      secretScan: r?.secretScan.state ?? 'none', secretScanReason: r?.secretScan.reason ?? null,
      high: fs.filter((f) => f.severity === 'high').length,
      medium: fs.filter((f) => f.severity === 'medium').length,
      low: fs.filter((f) => f.severity === 'low').length,
    };
  }).sort((a, b) => String(b.authorDate ?? '').localeCompare(String(a.authorDate ?? '')));

  // Gitleaks blocks on this branch during the push window: after the previous
  // review of this branch, up to this one.
  const prev = reviewEntries(all).find((e) => e.result.branch === rev.branch && e.result.started_at < rev.started_at);
  const from = prev ? prev.result.started_at : '';
  const gitleaksBlocks: ReportBlock[] = all.map((e) => e.result)
    .filter((r) => r.kind === 'secrets' && r.hook === 'pre-commit' && r.status === 'findings' && r.branch === rev.branch && r.started_at > from && r.started_at <= rev.started_at)
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .map((r) => ({ at: r.started_at, branch: r.branch, items: (r.findings || []).map((f) => ({ rule: f.rule, file: f.file, line: f.line })) }));

  const started = Date.parse(rev.started_at);
  const finished = Date.parse(rev.finished_at);
  const state: ScanReport['state'] = rev.status === 'error' ? 'error' : rev.status === 'skipped' ? 'skipped' : findings.length ? 'findings' : 'clean';
  return {
    schema: 'prism.codewatch.report.v1',
    id: entry.id,
    repo: { name: basename(repoRoot), path: repoRoot },
    branch: rev.branch, upstream: rev.upstream,
    range: { base: rev.base, tip: rev.commit, commits: range.length },
    reviewer: { tool: rev.tool, version: rev.tool_version, model: rev.model },
    startedAt: rev.started_at, finishedAt: rev.finished_at,
    durationSeconds: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, Math.round((finished - started) / 1000)) : null,
    status: rev.status, state, reason: rev.reason, score: rev.score,
    truncated: /diff truncated/i.test(rev.reason || ''),
    summary: rev.summary,
    totals: { severity, category, findings: findings.length },
    files,
    secretScans: commits,
    gitleaksBlocks,
    commits,
  };
}

// ---------------------------------------------------------------- renderers

const SCAN_TEXT: Record<SecretScanState, string> = {
  ok: 'ok', 'not-scanned': 'not scanned', 'no-verify': 'no-verify', flagged: 'secrets found', none: 'no record',
};

const short = (s: string | null) => (s ? s.slice(0, 8) : '-');
const oneLine = (s: string | null | undefined) => String(s ?? '').replace(/\s+/g, ' ').trim();
const loc = (f: { line: number | null }) => (f.line ? `line ${f.line}` : 'no line');
const counts = (c: { high: number; medium: number; low: number }) => `${c.high} high, ${c.medium} medium, ${c.low} low`;
const dur = (s: number | null) => (s === null ? '-' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

export function renderReportJson(r: ScanReport): string {
  return JSON.stringify(r, null, 2) + '\n';
}

/** Markdown: escapes the characters that would change structure inside list items and code spans. */
function md(s: string | null | undefined): string {
  return oneLine(s).replace(/([\\`*_[\]<>|#])/g, '\\$1');
}

export function renderReportMarkdown(r: ScanReport): string {
  const L: string[] = [];
  L.push(`# Codewatch scan report: ${md(r.repo.name)}`, '');
  if (r.truncated) L.push(`> **Warning:** the diff was truncated before review, so later changes were not reviewed. (${md(r.reason)})`, '');
  L.push(`- **Status:** ${r.state}${r.state === 'error' || r.state === 'skipped' ? ` (${md(r.reason)})` : ''}`);
  L.push(`- **Branch:** ${md(r.branch ?? '-')}${r.upstream ? ` (against ${md(r.upstream)})` : ''}`);
  L.push(`- **Pushed range:** ${short(r.range.base)}..${short(r.range.tip)} (${r.range.commits} commit${r.range.commits === 1 ? '' : 's'})`);
  L.push(`- **Reviewer:** ${md(r.reviewer.tool)}${r.reviewer.model ? ` / ${md(r.reviewer.model)}` : ''}${r.reviewer.version ? ` (${md(r.reviewer.version)})` : ''}`);
  L.push(`- **Started:** ${r.startedAt} · **Finished:** ${r.finishedAt} · **Duration:** ${dur(r.durationSeconds)}`);
  if (r.score !== null) L.push(`- **Score:** ${r.score}`);
  L.push(`- **Report id:** ${md(r.id)}`, '');
  L.push('## Summary', '', r.summary ? md(r.summary) : '_No summary._', '');
  L.push('## Totals', '');
  L.push(`- **By severity:** ${counts(r.totals.severity)}`);
  L.push(`- **By category:** ${r.totals.category.security} security, ${r.totals.category.quality} quality`, '');
  L.push('## Findings by file', '');
  if (!r.files.length) L.push('_No findings._', '');
  for (const g of r.files) {
    L.push(`### ${md(g.file)}`, '');
    for (const f of g.findings) {
      const who = f.commit ? `${short(f.commit)} "${md(f.commitSubject ?? '')}"${f.inPushOf ? ' (in push of tip; blame could not place this line)' : ''}` : 'not attributed';
      L.push(`- **${f.severity}** · ${f.category} · ${loc(f)} · ${md(f.rule)} · commit ${who}`);
      L.push(`  ${md(f.message)}`);
    }
    L.push('');
  }
  L.push('## Secret scan', '');
  if (!r.secretScans.length) L.push('_No commits in range._');
  for (const c of r.secretScans) L.push(`- ${c.short} ${md(c.subject ?? '(no longer in history)')}: **${SCAN_TEXT[c.secretScan]}**${c.secretScanReason && c.secretScan !== 'ok' ? ` (${md(c.secretScanReason)})` : ''}`);
  L.push('');
  L.push('### Gitleaks blocks during this push', '');
  if (!r.gitleaksBlocks.length) L.push('_None._');
  for (const b of r.gitleaksBlocks) L.push(`- ${b.at}: ${b.items.map((i) => `${md(i.rule)} at ${md(i.file)}${i.line ? `:${i.line}` : ''}`).join('; ')}`);
  L.push('');
  L.push('## Commits', '');
  if (!r.commits.length) L.push('_No commits in range._');
  for (const c of r.commits) L.push(`- ${c.short} ${md(c.subject ?? '(no longer in history)')}${c.authorDate ? ` (${c.authorDate})` : ''}: ${counts(c)}`);
  L.push('');
  return L.join('\n');
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const REPORT_CSS = `
:root { color-scheme: light dark; --bg:#f7f7f8; --card:#fff; --text:#1d1d1f; --muted:#6b6b73; --line:#e3e3e8; --high:#cf222e; --medium:#9a6700; --low:#57606a; --ok:#1a7f37; --warn:#9a6700; --accent:#0969da; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --card:#161b22; --text:#e6edf3; --muted:#8b949e; --line:#30363d; --high:#f85149; --medium:#d29922; --low:#8b949e; --ok:#3fb950; --warn:#d29922; --accent:#58a6ff; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
main { max-width:1100px; margin:0 auto; padding:20px; }
nav { margin-bottom:12px; font-size:13px; } nav a { color:var(--accent); margin-right:14px; }
section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 18px; margin-bottom:14px; }
h1 { font-size:20px; margin:0 0 8px; } h2 { font-size:15px; margin:0 0 10px; } h3 { font-size:13px; margin:14px 0 6px; } h3.file { font-family: ui-monospace, Menlo, monospace; }
dl { display:grid; grid-template-columns: max-content 1fr; gap:4px 16px; margin:0; } dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
table { width:100%; border-collapse:collapse; font-size:13px; } th, td { text-align:left; padding:5px 6px; border-bottom:1px solid var(--line); vertical-align:top; overflow-wrap:anywhere; } th { color:var(--muted); white-space:nowrap; }
.sev-high, .sev-medium, .sev-low { white-space:nowrap; } .sev-high { color:var(--high); font-weight:600; } .sev-medium { color:var(--medium); font-weight:600; } .sev-low { color:var(--low); }
.state { display:inline-block; padding:0 8px; border-radius:10px; border:1px solid currentColor; font-size:12px; font-weight:600; }
.s-findings, .s-error { color:var(--high); } .s-clean { color:var(--ok); } .s-skipped { color:var(--muted); }
.alert { border:1px solid var(--warn); border-left-width:4px; border-radius:6px; padding:10px 12px; margin:10px 0; font-weight:600; }
.muted { color:var(--muted); } .totals { display:flex; gap:24px; flex-wrap:wrap; } .totals b { font-size:20px; display:block; }
.summary { white-space:pre-wrap; }
@media print {
  :root { --bg:#fff; --card:#fff; --text:#000; --muted:#444; --line:#bbb; }
  body { font-size:11pt; } main { max-width:none; padding:0; } nav { display:none; }
  section { border:none; border-radius:0; padding:0; margin:0 0 14pt; break-inside:avoid-page; }
  table { page-break-inside:auto; } tr { break-inside:avoid; }
  a { color:inherit; text-decoration:none; }
}
`;

export interface HtmlOptions {
  /** CSP nonce for the inline style, when served by the dashboard. */
  nonce?: string;
  /** Show the back and Download Markdown links (served page only). */
  links?: { back: string; markdown: string };
}

/** Self-contained HTML: inline CSS, no script, every value escaped. */
export function renderReportHtml(r: ScanReport, opts: HtmlOptions = {}): string {
  const e = escapeHtml;
  const nonce = opts.nonce ? ` nonce="${e(opts.nonce)}"` : '';
  const rows = (cells: string[][]) => cells.map((c) => `<tr>${c.map((x) => `<td>${x}</td>`).join('')}</tr>`).join('');
  const sev = (s: Severity) => `<span class="sev-${s}">${s}</span>`;
  const p: string[] = [];
  p.push(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`);
  p.push(`<title>Codewatch report: ${e(r.repo.name)} ${e(short(r.range.tip))}</title><style${nonce}>${REPORT_CSS}</style></head><body><main>`);
  if (opts.links) p.push(`<nav><a href="${e(opts.links.back)}">&larr; Dashboard</a><a href="${e(opts.links.markdown)}" download>Download Markdown</a><span class="muted">Print to PDF from the browser's Print dialog.</span></nav>`);
  p.push(`<section><h1>Codewatch scan report: ${e(r.repo.name)}</h1>`);
  if (r.truncated) p.push(`<div class="alert" role="alert">The diff was truncated before review, so later changes were not reviewed. ${e(r.reason)}</div>`);
  p.push('<dl>');
  const dd = (k: string, v: string) => p.push(`<dt>${k}</dt><dd>${v}</dd>`);
  dd('Status', `<span class="state s-${e(r.state)}">${e(r.state)}</span>${r.state === 'error' || r.state === 'skipped' ? ` ${e(r.reason)}` : ''}`);
  dd('Branch', `${e(r.branch ?? '-')}${r.upstream ? ` <span class="muted">against ${e(r.upstream)}</span>` : ''}`);
  dd('Pushed range', `<code>${e(short(r.range.base))}..${e(short(r.range.tip))}</code> (${r.range.commits} commit${r.range.commits === 1 ? '' : 's'})`);
  dd('Reviewer', `${e(r.reviewer.tool)}${r.reviewer.model ? ` / ${e(r.reviewer.model)}` : ''}${r.reviewer.version ? ` <span class="muted">${e(r.reviewer.version)}</span>` : ''}`);
  dd('Started', e(r.startedAt));
  dd('Finished', `${e(r.finishedAt)} <span class="muted">(${e(dur(r.durationSeconds))})</span>`);
  if (r.score !== null) dd('Score', e(r.score));
  dd('Repository', `<code>${e(r.repo.path)}</code>`);
  p.push('</dl></section>');

  p.push(`<section><h2>Summary</h2><p class="summary">${r.summary ? e(r.summary) : '<span class="muted">No summary.</span>'}</p></section>`);
  const t = r.totals;
  p.push(`<section><h2>Totals</h2><div class="totals">`
    + `<div><b class="sev-high">${t.severity.high}</b>high</div><div><b class="sev-medium">${t.severity.medium}</b>medium</div><div><b class="sev-low">${t.severity.low}</b>low</div>`
    + `<div><b>${t.category.security}</b>security</div><div><b>${t.category.quality}</b>quality</div></div></section>`);

  p.push('<section><h2>Findings by file</h2>');
  if (!r.files.length) p.push('<p class="muted">No findings.</p>');
  for (const g of r.files) {
    p.push(`<h3 class="file">${e(g.file)}</h3><table><thead><tr><th>Severity</th><th>Category</th><th>Line</th><th>Rule</th><th>Message</th><th>Commit</th></tr></thead><tbody>`);
    p.push(rows(g.findings.map((f) => [
      sev(f.severity), e(f.category), e(f.line ?? '-'), e(f.rule), e(f.message),
      f.commit ? `<code>${e(short(f.commit))}</code> ${e(f.commitSubject ?? '')}${f.inPushOf ? '<br><span class="muted">in push of tip; blame could not place this line</span>' : ''}` : '<span class="muted">not attributed</span>',
    ])));
    p.push('</tbody></table>');
  }
  p.push('</section>');

  p.push('<section><h2>Secret scan</h2>');
  if (!r.secretScans.length) p.push('<p class="muted">No commits in range.</p>');
  else p.push(`<table><thead><tr><th>Commit</th><th>Subject</th><th>Pre-commit scan</th></tr></thead><tbody>${rows(r.secretScans.map((c) => [
    `<code>${e(c.short)}</code>`, e(c.subject ?? '(no longer in history)'),
    `${e(SCAN_TEXT[c.secretScan])}${c.secretScanReason && c.secretScan !== 'ok' ? `<br><span class="muted">${e(c.secretScanReason)}</span>` : ''}`,
  ]))}</tbody></table>`);
  p.push('<h3>Gitleaks blocks during this push</h3>');
  if (!r.gitleaksBlocks.length) p.push('<p class="muted">None.</p>');
  else p.push(`<table><thead><tr><th>When</th><th>Rule</th><th>Location</th></tr></thead><tbody>${rows(r.gitleaksBlocks.flatMap((b) => b.items.map((i) => [
    e(b.at), e(i.rule), `<code>${e(i.file)}${i.line ? `:${e(i.line)}` : ''}</code>`])))}</tbody></table>`);
  p.push('</section>');

  p.push('<section><h2>Commits</h2>');
  if (!r.commits.length) p.push('<p class="muted">No commits in range.</p>');
  else p.push(`<table><thead><tr><th>Commit</th><th>Subject</th><th>Date</th><th>High</th><th>Medium</th><th>Low</th></tr></thead><tbody>${rows(r.commits.map((c) => [
    `<code>${e(c.short)}</code>`, e(c.subject ?? '(no longer in history)'), e(c.authorDate ?? '-'), e(c.high), e(c.medium), e(c.low)]))}</tbody></table>`);
  p.push(`<p class="muted">Report id ${e(r.id)} · generated by prism-cli codewatch</p></section>`);
  p.push('</main></body></html>');
  return p.join('');
}

/** Finds `id` in any of `repos` and builds its report; null when unknown or not a review. */
export function reportFromRepos(repos: string[], id: string): ScanReport | null {
  for (const repo of repos) {
    const entries = readResultEntries(repo);
    const hit = findResultById(repo, id, entries);
    if (!hit) continue;
    if (!isReview(hit.result) || !hit.result.commit) return null;
    return buildReport(repo, hit, entries);
  }
  return null;
}
