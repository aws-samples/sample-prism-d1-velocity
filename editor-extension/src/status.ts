/** Status bar text, tooltip and click command for each extension state. No vscode import. */
import { codewatchOff, type DashboardPayload, type RepoView } from './payload';
import { money, plainText } from './text';
import type { MachineRepo } from './machine';

export const INSTALL_CMD = 'npm i -g @prism-d1/cli';

export type State =
  | { kind: 'loading' }
  /** No repo in this window: machine-wide data from a home-directory scan. */
  | { kind: 'machine'; payload: DashboardPayload; repos: MachineRepo[] }
  | { kind: 'cli-missing'; reason: string; searched?: string[] }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; payload: DashboardPayload; view: RepoView };

export interface StatusView {
  text: string;
  /** Plain text (never markdown): parts of it come from recorded results. */
  tooltip: string;
  command: 'prism.openPanel' | 'prism.showInstallHint' | 'prism.enableCodewatch' | 'prism.refresh' | undefined;
  /** Background tint: error when the review has high findings. */
  tint: 'error' | 'warning' | null;
}

export const OPEN_REPO_HINT = 'Open a repository folder to see its findings.';

/** The not-found text for the tooltip and the install message: what was searched and how to set prism.cliPath. */
export function cliMissingText(reason: string, searched: string[] = []): string {
  const lines = [`prism-cli was not found (${one(reason)}).`];
  if (searched.length) lines.push('Searched:', ...searched.map((s) => `  ${one(s, 300)}`));
  lines.push(`Install it: ${INSTALL_CMD}`, 'Or set prism.cliPath in your user settings to the output of `command -v prism-cli` run in a terminal on this machine.');
  return lines.join('\n');
}

const one = (s: unknown, max = 200) => plainText(s, { oneLine: true, max });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function statusView(s: State, fmtTime: (iso: string) => string = (iso) => new Date(iso).toLocaleString()): StatusView {
  switch (s.kind) {
    case 'loading':
      return { text: '$(sync~spin) PRISM', tooltip: 'PRISM: reading prism-cli dashboard --json…', command: 'prism.openPanel', tint: null };
    case 'machine':
      return machineView(s.payload, fmtTime);
    case 'cli-missing':
      return {
        text: '$(shield) PRISM: install prism-cli',
        tooltip: cliMissingText(s.reason, s.searched),
        command: 'prism.showInstallHint', tint: 'warning',
      };
    case 'error':
      return { text: '$(shield) PRISM: error', tooltip: `prism-cli failed: ${one(s.message, 500)}\nClick to retry.`, command: 'prism.refresh', tint: 'warning' };
    case 'ready':
      return readyView(s.payload, s.view, fmtTime);
  }
}

/** Spend today and warnings ("$12.40 today", "1 warning"), shared by both modes. */
function spendAndWarnings(p: DashboardPayload): string[] {
  const spend = p.summary.spend;
  const warn = p.summary.warnings;
  const tail: string[] = [];
  if (spend.status === 'ok' && typeof spend.today === 'number') tail.push(`${money(spend.today, spend.currency)} today`);
  if (warn.count > 0) tail.push(plural(warn.count, 'warning'));
  return tail;
}

function machineView(p: DashboardPayload, fmtTime: (iso: string) => string): StatusView {
  const spend = p.summary.spend;
  const warn = p.summary.warnings;
  const tail = spendAndWarnings(p);
  const lines = ['PRISM: no repository open in this window; showing this machine.'];
  if (spend.status === 'ok') {
    if (typeof spend.month === 'number') lines.push(`Spend this month: ${money(spend.month, spend.currency)}`);
  } else {
    lines.push(`Spend: ${one(spend.message ?? spend.status)}`);
  }
  const r = p.summary.review;
  lines.push(r
    ? `Latest review: ${one(r.repo, 80)}, ${fmtTime(r.at)} (${r.high} high, ${r.medium} medium, ${r.low} low)`
    : 'No pre-push review recorded in any repo yet.');
  const c = p.overview?.counts;
  if (c) lines.push(`Repos with codewatch: ${c.codewatch} of ${c.repos}`);
  if (warn.count > 0 && warn.first) lines.push(`Warning: ${one(warn.first)}`);
  lines.push(OPEN_REPO_HINT, 'Click to open the PRISM panel.');
  return { text: tail.length ? `$(shield) PRISM: ${tail.join(' | ')}` : '$(shield) PRISM', tooltip: lines.join('\n'), command: 'prism.openPanel', tint: null };
}

function readyView(p: DashboardPayload, v: RepoView, fmtTime: (iso: string) => string): StatusView {
  const spend = p.summary.spend;
  const warn = p.summary.warnings;
  const tail = spendAndWarnings(p);

  const lines: string[] = [];
  const r = v.review;
  if (r) {
    const reason = r.reason ? `, ${one(r.reason)}` : '';
    lines.push(`Last review: ${fmtTime(r.started_at)} (${one(r.status, 20)}${reason})`);
    lines.push(`Reviewer: ${one(r.tool, 40)}`);
    lines.push(`Findings: ${r.high} high, ${r.medium} medium, ${r.low} low`);
    if (!r.onBranch) lines.push(`This review is of branch ${one(r.branch ?? '(detached)', 80)}, so the Problems panel shows no markers for it.`);
  } else {
    lines.push('No pre-push review recorded in this repo yet.');
  }
  if (spend.status === 'ok') {
    if (typeof spend.month === 'number') lines.push(`Spend this month (all repos): ${money(spend.month, spend.currency)}`);
  } else {
    lines.push(`Spend: ${one(spend.message ?? spend.status)}`);
  }
  lines.push(`Sync mode: ${one(p.machine.codeburnSync?.mode ?? 'unknown', 20)}`);
  if (warn.count > 0 && warn.first) lines.push(`Warning: ${one(warn.first)}`);

  if (codewatchOff(v.repo)) {
    return {
      text: ['$(shield) PRISM: codewatch off · Enable', ...tail].join(' | '),
      tooltip: ['Codewatch is not set up in this repo. Click to run prism-cli enable codewatch in a terminal.', ...lines.slice(1)].join('\n'), // lines[0] is "no review yet": codewatch off means no results
      command: 'prism.enableCodewatch', tint: null,
    };
  }
  const head = r ? `$(shield) PRISM: ${r.high} high · ${r.medium} med` : '$(shield) PRISM: no review yet';
  lines.push('Click to open the PRISM panel.');
  return { text: [head, ...tail].join(' | '), tooltip: lines.join('\n'), command: 'prism.openPanel', tint: r && r.high > 0 ? 'error' : null };
}
