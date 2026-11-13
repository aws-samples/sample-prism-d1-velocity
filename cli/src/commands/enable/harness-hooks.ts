/**
 * `prism-cli enable agent-hooks --client kiro|claude`: installs the harness
 * loop hooks (docs/DESIGN-harness-loop.md section 8.5) for a coding client
 * that has no PRISM plugin doing it.
 *
 * - kiro: `.kiro/hooks/prism-harness.json` in the repo, or
 *   `~/.kiro/hooks/prism-harness.json` with --global. The file is PRISM's
 *   own; one that holds other hooks is left alone unless --force.
 * - claude: the hooks the Claude Code plugin ships, written into
 *   `.claude/settings.json` (repo) or the user settings (--global), merged
 *   with the hooks already there. Skipped when the PRISM plugin is installed,
 *   so the hooks never run twice.
 *
 * Every write prints a diff, backs the file up first (`<name>.bak-<timestamp>`)
 * and is idempotent. PRISM entries are found by their command
 * (`prism-cli ... codewatch hook --client <c>`), so --uninstall removes only
 * those. cursor and codex are planned.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../utils/exec.js';
import { backup, configDir, lineDiff, ownCliLocation, pluginState, PLUGIN_ID, prismCliCommand, render, writeAtomic } from './claude-code.js';
import { runGuarded } from './security.js';

export const CLIENTS = ['kiro', 'claude'] as const;
export type Client = typeof CLIENTS[number];
export const PLANNED = ['cursor', 'codex'];
export const KIRO_FILE = 'prism-harness.json';
/** Kiro kills a hook at its `timeout`; prism-cli's own budget is 270 s (HOOK_BUDGET_MS). */
export const REVIEW_TIMEOUT_S = 300;
export const SESSION_TIMEOUT_S = 15;
export const GUARD_TIMEOUT_S = 30;
/** The Claude Code plugin ships the harness hooks from 0.3.0. */
export const PLUGIN_HOOKS_MINOR = 3;
/** What a project (committed) hook file calls. */
export const PORTABLE_CLI = 'prism-cli';

export interface AgentHooksOptions { client?: string; global?: boolean; dryRun?: boolean; status?: boolean; uninstall?: boolean; force?: boolean }

export interface AgentHooksDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  /** The git top-level of the current directory, or null outside a repo. */
  repoRoot: string | null;
  /** How the hooks run prism-cli (prismCliCommand). */
  cli: string;
  log: (line?: string) => void;
  error: (line: string) => void;
  now: () => Date;
}

/**
 * A command PRISM wrote: `prism-cli codewatch hook --client <c> ...`, or the same behind one
 * interpreter word (`'<node>' '<dir>/prism-cli.js' codewatch hook ...`). Anchored at both ends, so a
 * user's own hook that chains the PRISM command before or after its own is not taken for PRISM's.
 */
const isPrismCommand = (c: unknown, client: Client) => typeof c === 'string'
  && new RegExp(`^(?:(?:'[^']*'|"[^"]*"|\\S+)\\s+)?(?:'[^']*|"[^"]*|\\S*?)prism-cli(\\.[cm]?[jt]s)?['"]?\\s+codewatch\\s+hook\\s+--client\\s+${client}\\s+--event\\s+[a-z-]+\\s*$`).test(c);
const hookCmd = (cli: string, client: Client, event: string) => `${cli} codewatch hook --client ${client} --event ${event}`;
const tilde = (p: string, home: string) => (p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);

/** any: parsed hook files are user JSON of any shape; every field is checked where it is read. */
type Json = any;

class UserError extends Error {}

/** A file's `hooks` object (Claude settings), {} when absent; anything else is refused rather than rewritten. */
function hooksObject(json: Record<string, Json>, path: string): Record<string, Json> {
  const h = json.hooks;
  if (h === undefined) return {};
  if (!h || typeof h !== 'object' || Array.isArray(h)) throw new UserError(`${path}: "hooks" is not an object. Nothing was changed.`);
  return h;
}

function readObject(path: string): { exists: boolean; text: string; json: Record<string, Json> } {
  if (!existsSync(path)) return { exists: false, text: '', json: {} };
  const text = readFileSync(path, 'utf8');
  let json: unknown;
  try { json = text.trim() ? JSON.parse(text) : {}; } catch (e: any) { // any: JSON.parse error, message only
    throw new UserError(`${path} is not valid JSON (${String(e?.message || e).split('\n')[0]}); fix it first. Nothing was changed.`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new UserError(`${path} does not hold a JSON object. Nothing was changed.`);
  return { exists: true, text, json: json as Record<string, Json> };
}

// ------------------------------------------------------------ kiro

/** The Kiro hook file: SessionStart baseline, the push check on every shell call, the finish check, SessionEnd cleanup. */
export function kiroHookFile(cli: string): Record<string, unknown> {
  const h = (name: string, description: string, trigger: string, event: string, timeout: number, matcher?: string) => ({
    name, description, trigger, ...(matcher ? { matcher } : {}), action: { type: 'command', command: hookCmd(cli, 'kiro', event) }, timeout,
  });
  return {
    version: 'v1',
    hooks: [
      h('PRISM harness: session start', 'Records the working tree at session start, so only this session\'s changes are reviewed.', 'SessionStart', 'session-start', SESSION_TIMEOUT_S),
      h('PRISM harness: push check', 'Before a git push: gitleaks and the PRISM review. Denies only secrets, a failed secret scan, changes to the checks, an unknown push target and hook bypasses (exit 2). Other shell commands pass at once.', 'PreToolUse', 'pre-push', REVIEW_TIMEOUT_S, 'shell'),
      h('PRISM harness: finish check', 'When the agent finishes: hands over push findings, and with harness.finish_gate (or PRISM_HARNESS_FINISH_GATE=1) reviews the session\'s changes.', 'Stop', 'stop', REVIEW_TIMEOUT_S),
      h('PRISM harness: session end', 'Deletes this session\'s harness state.', 'SessionEnd', 'session-end', SESSION_TIMEOUT_S),
    ],
  };
}

const kiroDir = (o: AgentHooksOptions, d: AgentHooksDeps) => (o.global ? join(d.home, '.kiro', 'hooks') : join(d.repoRoot!, '.kiro', 'hooks'));

type State = 'installed' | 'outdated' | 'missing';

/** PRISM entries in a Kiro hook file and whether they equal what this prism-cli would write. */
function kiroState(json: Record<string, Json>, want: Record<string, unknown>): { state: State; others: number } {
  const hooks: Json[] = Array.isArray(json.hooks) ? json.hooks : [];
  const ours = hooks.filter((x) => isPrismCommand(x?.action?.command, 'kiro'));
  const others = hooks.length - ours.length;
  if (!ours.length) return { state: 'missing', others };
  return { state: JSON.stringify(ours) === JSON.stringify((want as { hooks: unknown }).hooks) && json.version === 'v1' ? 'installed' : 'outdated', others };
}

/** Other hook files in the same directory that also run the PRISM Kiro hook. */
function kiroDuplicates(dir: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json') && n !== KIRO_FILE); } catch { return []; }
  return names.filter((n) => {
    try { return (JSON.parse(readFileSync(join(dir, n), 'utf8'))?.hooks ?? []).some((x: Json) => isPrismCommand(x?.action?.command, 'kiro')); } catch { return false; }
  });
}

function write(path: string, before: string, exists: boolean, after: string, o: AgentHooksOptions, d: AgentHooksDeps): void {
  for (const l of lineDiff(before, after, tilde(path, d.home))) d.log(`    ${l}`);
  if (o.dryRun) { d.log('\n  Dry run: nothing was written. Re-run without --dry-run to apply.'); return; }
  if (exists) d.log(`  ✓ Backup: ${tilde(backup(path, d.now()), d.home)}`);
  writeAtomic(path, after);
  d.log(`  ✓ Wrote ${tilde(path, d.home)}`);
}

function kiroNotes(o: AgentHooksOptions, d: AgentHooksDeps): void {
  d.log('\n  Notes:');
  d.log('  - Hooks run only on the Kiro CLI V3 engine. kiro-cli chat --no-interactive defaults to v2, where no hook fires: pass --agent-engine v3.');
  d.log('  - Kiro Crew sessions do not load these hooks; there the prism-fix-findings skill is the check.');
  d.log('  - The push check runs on every shell command (about 0.1 s for one that is not a git push).');
  d.log('  - Finish gate: off until harness.finish_gate is true in .prism/config.json or PRISM_HARNESS_FINISH_GATE=1. Kiro runs it once per prompt.');
  if (!o.global) d.log('  - Commit .kiro/hooks/prism-harness.json yourself: a push by the agent that carries hook files is held as a change to the checks.');
}

function kiroInstall(o: AgentHooksOptions, d: AgentHooksDeps): number {
  const dir = kiroDir(o, d);
  const path = join(dir, KIRO_FILE);
  const want = kiroHookFile(d.cli);
  const f = readObject(path);
  const st = kiroState(f.json, want);
  d.log(`  File: ${tilde(path, d.home)}${f.exists ? '' : ' (new)'}`);
  if (st.state === 'installed' && st.others === 0) { d.log('  Already installed; nothing to do.'); kiroWarnings(o, d, dir); return 0; }
  if (f.exists && (st.others > 0 || !Array.isArray(f.json.hooks))) {
    if (!o.force) {
      d.error(`  Refusing to change it: ${tilde(path, d.home)} holds ${st.others ? `${st.others} hook(s) that are not PRISM's` : 'content that is not a Kiro hook list'}. Move them to another file in ${tilde(dir, d.home)}, or re-run with --force to replace the file (it is backed up first).`);
      return 1;
    }
    d.log('  --force: replacing a file that holds other hooks (they stay in the backup).');
  }
  write(path, f.text, f.exists, render(want), o, d);
  kiroWarnings(o, d, dir);
  kiroNotes(o, d);
  return 0;
}

function kiroWarnings(o: AgentHooksOptions, d: AgentHooksDeps, dir: string): void {
  for (const n of kiroDuplicates(dir)) d.log(`  ! ${tilde(join(dir, n), d.home)} also runs the PRISM Kiro hook: remove one, or every check runs twice.`);
  const otherDir = o.global ? (d.repoRoot ? join(d.repoRoot, '.kiro', 'hooks') : null) : join(d.home, '.kiro', 'hooks');
  if (otherDir && existsSync(join(otherDir, KIRO_FILE))) d.log(`  ! ${tilde(join(otherDir, KIRO_FILE), d.home)} exists too. Kiro runs global and project hooks side by side, so each check would run twice; keep one (--uninstall ${o.global ? 'in the repo' : '--global'}).`);
}

function kiroUninstall(o: AgentHooksOptions, d: AgentHooksDeps): number {
  const path = join(kiroDir(o, d), KIRO_FILE);
  const f = readObject(path);
  const hooks: Json[] = Array.isArray(f.json.hooks) ? f.json.hooks : [];
  const rest = hooks.filter((x) => !isPrismCommand(x?.action?.command, 'kiro'));
  if (!f.exists || rest.length === hooks.length) { d.log(`  No PRISM Kiro hooks in ${tilde(path, d.home)}. Nothing to remove.`); return 0; }
  if (rest.length) { write(path, f.text, true, render({ ...f.json, hooks: rest }), o, d); return 0; }
  for (const l of lineDiff(f.text, '', tilde(path, d.home))) d.log(`    ${l}`);
  if (o.dryRun) { d.log('\n  Dry run: nothing was removed.'); return 0; }
  d.log(`  ✓ Backup: ${tilde(backup(path, d.now()), d.home)}`);
  rmSync(path);
  d.log(`  ✓ Removed ${tilde(path, d.home)} (it held only PRISM hooks)`);
  return 0;
}

// ------------------------------------------------------------ claude

/** The plugin's bash-guard `if` rules (claude-plugin/hooks/hooks.json): the bypass check only, never a review. */
export const BASH_GUARD_IFS = ['Bash(*git*config*)', 'Bash(*git*-c*)', 'Bash(*git*ref*)', 'Bash(*git*remote*)', 'Bash(*git*fetch*)', 'Bash(*git*pull*)', 'Bash(*git*branch*)', 'Bash(*git*tag*)', 'Bash(*git*checkout*)', 'Bash(*git*switch*)'];

/** The plugin's harness hooks (claude-plugin/hooks/hooks.json), calling prism-cli directly instead of the plugin's script. */
export function claudeHooks(cli: string): Record<string, unknown[]> {
  const c = (event: string, timeout: number, extra: object = {}) => ({ type: 'command', ...extra, command: hookCmd(cli, 'claude', event), timeout });
  return {
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [c('session-start', SESSION_TIMEOUT_S)] }],
    Stop: [{ hooks: [c('stop', REVIEW_TIMEOUT_S)] }],
    SubagentStop: [{ hooks: [c('stop', REVIEW_TIMEOUT_S)] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [
      c('pre-push', REVIEW_TIMEOUT_S, { if: 'Bash(*git*push*)' }),
      ...BASH_GUARD_IFS.map((rule) => c('bash-guard', GUARD_TIMEOUT_S, { if: rule })),
    ] }],
    SessionEnd: [{ hooks: [c('session-end', SESSION_TIMEOUT_S)] }],
  };
}

/** `hooks` with every PRISM entry removed; groups and events left empty are dropped. */
export function withoutPrism(hooks: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) { out[ev] = groups; continue; }
    const kept = groups
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h: Json) => !isPrismCommand(h?.command, 'claude')) } : g))
      .filter((g, i) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0 && groups[i].hooks.length > 0));
    if (kept.length || !groups.length) out[ev] = kept;
  }
  return out;
}

/** Existing hooks without PRISM's, then PRISM's appended to each event. */
export function mergeClaude(hooks: Record<string, Json>, want: Record<string, unknown[]>): Record<string, Json> {
  const out = withoutPrism(hooks);
  for (const [ev, groups] of Object.entries(want)) out[ev] = [...(Array.isArray(out[ev]) ? out[ev] : []), ...groups];
  return out;
}

function claudeState(hooks: Record<string, Json>, want: Record<string, unknown[]>): State {
  const has = JSON.stringify(withoutPrism(hooks)) !== JSON.stringify(hooks);
  if (!has) return 'missing';
  return JSON.stringify(mergeClaude(hooks, want)) === JSON.stringify(hooks) ? 'installed' : 'outdated';
}

const claudeSettings = (o: AgentHooksOptions, d: AgentHooksDeps) => (o.global ? join(configDir(d.env, d.home), 'settings.json') : join(d.repoRoot!, '.claude', 'settings.json'));

/** The PRISM plugin, read from the user's Claude Code config: installed and not disabled. */
function pluginActive(d: AgentHooksDeps): { active: boolean; version: string | null } {
  let user: Record<string, unknown> = {};
  try { user = readObject(join(configDir(d.env, d.home), 'settings.json')).json; } catch { /* unreadable settings: plugin state from installed_plugins only */ }
  const p = pluginState(configDir(d.env, d.home), user);
  return { active: p.installed && p.enabled !== false, version: p.version };
}

function withHooks(json: Record<string, Json>, hooks: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {};
  let placed = false;
  for (const [k, v] of Object.entries(json)) {
    if (k === 'hooks') { placed = true; if (Object.keys(hooks).length) out.hooks = hooks; continue; }
    out[k] = v;
  }
  if (!placed && Object.keys(hooks).length) out.hooks = hooks;
  return out;
}

function claudeInstall(o: AgentHooksOptions, d: AgentHooksDeps): number {
  const plugin = pluginActive(d);
  if (plugin.active) {
    const v = plugin.version?.split('.').map(Number);
    const old = v && v.length === 3 && v.every(Number.isFinite) && (v[0] === 0 && v[1] < PLUGIN_HOOKS_MINOR);
    d.log(old
      ? `  ! The PRISM Claude Code plugin ${plugin.version} is installed. It predates the harness hooks (plugin 0.${PLUGIN_HOOKS_MINOR}.0), so update it from Claude Code's /plugin menu rather than adding settings hooks that would run twice after the update. Skipped.`
      : `  ! The PRISM Claude Code plugin (${PLUGIN_ID}${plugin.version ? ` ${plugin.version}` : ''}) is installed and already runs these hooks. Skipped, so they do not run twice.`);
    return 0;
  }
  const path = claudeSettings(o, d);
  const f = readObject(path);
  const hooks = hooksObject(f.json, path);
  const want = claudeHooks(d.cli);
  d.log(`  File: ${tilde(path, d.home)}${f.exists ? '' : ' (new)'}`);
  if (claudeState(hooks, want) === 'installed') { d.log('  Already installed; nothing to do.'); return 0; }
  write(path, f.text, f.exists, render(withHooks(f.json, mergeClaude(hooks, want))), o, d);
  d.log('\n  Other hooks and keys are kept. Claude Code reads the hooks at session start; finish gate: harness.finish_gate in .prism/config.json or PRISM_HARNESS_FINISH_GATE=1.');
  if (!o.global) d.log('  Commit .claude/settings.json yourself: a push by the agent that carries hook files is held as a change to the checks.');
  return 0;
}

function claudeUninstall(o: AgentHooksOptions, d: AgentHooksDeps): number {
  const path = claudeSettings(o, d);
  const f = readObject(path);
  const hooks = hooksObject(f.json, path);
  const rest = withoutPrism(hooks);
  if (!f.exists || JSON.stringify(rest) === JSON.stringify(hooks)) { d.log(`  No PRISM hooks in ${tilde(path, d.home)}. Nothing to remove.`); return 0; }
  write(path, f.text, true, render(withHooks(f.json, rest)), o, d);
  return 0;
}

// ------------------------------------------------------------ status and main

function status(clients: Client[], d: AgentHooksDeps): number {
  d.log('\n📊 Agent hooks status\n');
  for (const c of clients) {
    for (const global of [false, true]) {
      const o = { global };
      const cli = global ? d.cli : PORTABLE_CLI;
      if (!global && !d.repoRoot) { d.log(`  ${c} (project): not in a git repository`); continue; }
      let line: string;
      try {
        if (c === 'kiro') {
          const path = join(kiroDir(o, d), KIRO_FILE);
          const f = readObject(path);
          const st = kiroState(f.json, kiroHookFile(cli));
          line = `${st.state}  ${tilde(path, d.home)}${st.others ? ` (also ${st.others} other hook(s))` : ''}`;
        } else {
          const path = claudeSettings(o, d);
          const f = readObject(path);
          line = `${claudeState(hooksObject(f.json, path), claudeHooks(cli))}  ${tilde(path, d.home)}`;
        }
      } catch (e: any) { line = `unreadable: ${String(e?.message || e).split('\n')[0]}`; } // any: a read error, message only
      d.log(`  ${c} (${global ? 'global' : 'project'}): ${line}`);
    }
    if (c === 'claude') {
      const p = pluginActive(d);
      d.log(`  claude plugin: ${p.active ? `${PLUGIN_ID}${p.version ? ` ${p.version}` : ''} (the plugin runs the harness hooks itself from 0.${PLUGIN_HOOKS_MINOR}.0)` : 'not installed or disabled'}`);
    }
  }
  d.log(`\n  outdated: PRISM hooks are there but differ from what this prism-cli writes (command path or entries); re-run prism-cli enable agent-hooks --client <c>.`);
  d.log(`  cursor, codex: planned.\n`);
  return 0;
}

export function enableAgentHooks(o: AgentHooksOptions, d: AgentHooksDeps): number {
  const c = o.client?.trim().toLowerCase();
  if (c && PLANNED.includes(c)) { d.error(`Error: --client ${c} is planned, not available yet. Available: ${CLIENTS.join(', ')}.`); return 1; }
  if (c && !(CLIENTS as readonly string[]).includes(c)) { d.error(`Error: --client must be one of: ${CLIENTS.join(', ')} (planned: ${PLANNED.join(', ')}).`); return 1; }
  if (o.status) return status(c ? [c as Client] : [...CLIENTS], d);
  if (!c) { d.error(`Error: --client is required: ${CLIENTS.join(' | ')}.`); return 1; }
  if (!o.global && !d.repoRoot) { d.error('Error: not inside a git repository. Run it in the repo, or pass --global.'); return 1; }
  const client = c as Client;
  // A project file is committed and shared, so it names `prism-cli` on PATH: a machine-specific
  // absolute path would exit 127 on a teammate's machine, which Kiro treats as "let it through".
  if (!o.global && d.cli !== PORTABLE_CLI) {
    d.log(`  ! This prism-cli is not on the system PATH (${d.cli}). The project file still calls "${PORTABLE_CLI}" so it works for everyone who commits and shares it; make sure prism-cli is on the PATH your agent starts with, or use --global, which writes this machine's absolute path.`);
    d = { ...d, cli: PORTABLE_CLI };
  }
  d.log(`\n🔌 enable agent-hooks --client ${client}${o.global ? ' --global' : ''}${o.uninstall ? ' --uninstall' : ''}${o.dryRun ? ': dry run, nothing is changed' : ''}\n`);
  d.log(`  Command: ${d.cli} codewatch hook --client ${client} ...`);
  try {
    if (client === 'kiro') return o.uninstall ? kiroUninstall(o, d) : kiroInstall(o, d);
    return o.uninstall ? claudeUninstall(o, d) : claudeInstall(o, d);
  } catch (e) {
    if (e instanceof UserError) { d.error(`Error: ${e.message}`); return 1; }
    throw e;
  } finally {
    d.log('');
  }
}

export function defaultDeps(): AgentHooksDeps {
  const top = run('git', ['rev-parse', '--show-toplevel']);
  return {
    home: homedir(), env: process.env, repoRoot: top.ok && top.stdout ? top.stdout : null,
    cli: prismCliCommand(ownCliLocation()),
    log: (l = '') => console.log(l), error: (l) => console.error(l), now: () => new Date(),
  };
}

export default {
  description: 'Install the agent harness loop hooks (push check, opt-in finish check) for a coding client without a PRISM plugin: Kiro CLI V3 / IDE (.kiro/hooks/prism-harness.json) or Claude Code (.claude/settings.json hooks; skipped when the PRISM plugin is installed). Backs up, merges, and prints what it changed',
  options: [
    { flags: '--client <client>', description: `Coding client: ${CLIENTS.join(' | ')} (${PLANNED.join(', ')}: planned)` },
    { flags: '--global', description: 'User level for every repo: ~/.kiro/hooks, or the Claude Code user settings (CLAUDE_CONFIG_DIR respected)' },
    { flags: '--dry-run', description: 'Print the plan and the diff; write nothing' },
    { flags: '--status', description: 'Show installed, outdated or missing per client and scope (read-only)' },
    { flags: '--uninstall', description: 'Remove only the PRISM hook entries (the file is backed up first)' },
    { flags: '--force', description: 'kiro: replace a prism-harness.json that holds hooks that are not PRISM\'s' },
  ],
  action: (opts: AgentHooksOptions) => runGuarded(async () => enableAgentHooks(opts, defaultDeps())),
};
