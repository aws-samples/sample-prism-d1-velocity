/** Status bar text, tooltip and click command for each extension state. No vscode import. */
import { codewatchOff, type DashboardPayload, type RepoView } from './payload';
import { money, plainText } from './text';

export const INSTALL_CMD = 'npm i -g @prism-d1/cli';

export type State =
  | { kind: 'loading' }
  | { kind: 'cli-missing'; reason: string }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; payload: DashboardPayload; view: RepoView };

export interface StatusView {
  text: string;
  /** Plain text (never markdown): parts of it come from recorded results. */
  tooltip: string;
  command: 'prism.openPanel' | 'prism.showInstallHint' | 'prism.enableCodewatch' | 'prism.refresh';
  /** Background tint: error when the review has high findings. */
  tint: 'error' | 'warning' | null;
}

const one = (s: unknown, max = 200) => plainText(s, { oneLine: true, max });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function statusView(s: State, fmtTime: (iso: string) => string = (iso) => new Date(iso).toLocaleString()): StatusView {
  switch (s.kind) {
    case 'loading':
      return { text: '$(sync~spin) PRISM', tooltip: 'PRISM: reading prism-cli dashboard --json…', command: 'prism.openPanel', tint: null };
    case 'cli-missing':
      return {
        text: '$(shield) PRISM: install prism-cli',
        tooltip: `prism-cli was not found (${one(s.reason)}).\nInstall it: ${INSTALL_CMD}\nOr set prism.cliPath in your user settings.`,
        command: 'prism.showInstallHint', tint: 'warning',
      };
    case 'error':
      return { text: '$(shield) PRISM: error', tooltip: `prism-cli failed: ${one(s.message, 500)}\nClick to retry.`, command: 'prism.refresh', tint: 'warning' };
    case 'ready':
      return readyView(s.payload, s.view, fmtTime);
  }
}

function readyView(p: DashboardPayload, v: RepoView, fmtTime: (iso: string) => string): StatusView {
  const spend = p.summary.spend;
  const warn = p.summary.warnings;
  const tail: string[] = [];
  if (spend.status === 'ok' && typeof spend.today === 'number') tail.push(`${money(spend.today, spend.currency)} today`);
  if (warn.count > 0) tail.push(plural(warn.count, 'warning'));

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
