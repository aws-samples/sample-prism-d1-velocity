/**
 * The one list of what needs the person: the Dashboard's Settings warnings
 * card (its count and first item), the Settings tab badge, each Settings
 * section's badge, the Overview's Needs you list, and `dashboard --json`
 * summary.warnings all read this list from the payload, so they can never
 * disagree. Each item names the Settings tab it belongs to and its fix
 * commands.
 */
import type { AgentHookStatus } from '../commands/enable/harness-hooks.js';
import type { CheckItem } from './setup.js';
import type { SetupRow, Suggestion } from './payload.js';
import type { VersionInfo } from './update-check.js';

export type NeedsTab = 'machine' | 'repos' | 'agents' | 'sync' | 'aws' | 'updates';

export interface NeedsItem {
  tab: NeedsTab;
  text: string;
  /** Commands (or instructions) that fix it; may be empty. */
  fixes: string[];
}

/** The Claude Code plugin update, as the Agent hooks and Updates panes show it. */
export const PLUGIN_UPDATE = ['claude plugin marketplace update prism-d1-velocity', 'claude plugin update prism@prism-d1-velocity'];
/** The prism-cli update; the Update button runs it as a fixed action id, never as text from the page. */
export const UPDATE_CMD = 'npm i -g @prism-d1/cli@latest';

export interface NeedsInput {
  machine: CheckItem[];
  setup: Pick<SetupRow, 'status' | 'label' | 'detail' | 'fix'>[];
  suggestions: Suggestion[];
  agentHooks: AgentHookStatus;
  version: Pick<VersionInfo, 'installed' | 'latest' | 'update'>;
}

const needs = (s: CheckItem['status']) => s === 'missing' || s === 'warn';

export function needsYou(d: NeedsInput): NeedsItem[] {
  const out: NeedsItem[] = [];
  const add = (tab: NeedsTab, text: string, fixes: (string | null | undefined)[] = []) => out.push({ tab, text, fixes: fixes.filter((f): f is string => !!f) });
  for (const i of d.machine) {
    if (!needs(i.status)) continue;
    const tab = i.id === 'codeburn-sync' ? 'sync' : i.id === 'aws-credentials' ? 'aws' : 'machine';
    add(tab, i.help && i.status === 'missing' ? i.help.text : `${i.label}: ${i.detail}`, [i.fix]);
  }
  for (const r of d.setup.filter((x) => x.status === 'warn')) add('repos', `${r.label}: ${r.detail}`, [r.fix]);
  const missing = d.setup.filter((x) => x.status === 'missing').length;
  const sg = d.suggestions.find((x) => x.id === 'codewatch-global');
  if (missing) add('repos', `${missing} repo${missing === 1 ? " doesn't" : "s don't"} have codewatch yet.`, [sg ? sg.command : 'prism-cli enable codewatch']);
  for (const r of d.agentHooks.rows.filter((x) => x.state === 'outdated' || x.state === 'unreadable')) {
    const cmd = `prism-cli enable agent-hooks --client ${r.client}${r.scope === 'global' ? ' --global' : ''}`;
    add('agents', `${r.client} agent hooks (${r.scope}) are ${r.state === 'outdated' ? 'outdated' : `unreadable: ${r.error ?? ''}`}`, r.state === 'outdated' ? [cmd] : []);
  }
  const p = d.agentHooks.plugin;
  if (p.outdated) add('agents', `Claude Code plugin ${p.version ?? ''} is installed; the harness hooks need 0.3.0 or newer.`, PLUGIN_UPDATE);
  const kc = d.machine.find((i) => i.id === 'kirocrew-app');
  if (kc && /^outdated/.test(kc.detail)) add('agents', `Kiro Crew app: ${kc.detail}`, [kc.fix]);
  const st = d.machine.find((i) => i.id === 'kirocrew-steering');
  const kiroRow = d.agentHooks.rows.find((r) => r.client === 'kiro' && (r.state === 'installed' || r.state === 'outdated'));
  if (st && /^(outdated|missing)/.test(st.detail)) add('agents', `Kiro Crew steering note ${st.detail}`, [st.fix]);
  // Kiro hooks installed without the Kiro Crew app: the same note, fixed by re-running the Kiro hooks install.
  else if (!st && kiroRow && (d.agentHooks.steering === 'outdated' || d.agentHooks.steering === 'missing')) {
    add('agents', `Kiro steering note ~/.kiro/steering/prism-codewatch.md is ${d.agentHooks.steering}`, [`prism-cli enable agent-hooks --client kiro${kiroRow.scope === 'global' ? ' --global' : ''}`]);
  }
  if (d.version.update) add('updates', `prism-cli ${d.version.latest ?? ''} is available (you have ${d.version.installed}).`, [UPDATE_CMD]);
  return out;
}
