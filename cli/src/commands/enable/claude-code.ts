/**
 * `prism-cli enable claude-code`: set Claude Code's status line to
 * `prism-cli statusline`.
 *
 * A Claude Code plugin cannot set `statusLine` (plugin settings only apply
 * `agent` and `subagentStatusLine`), so this is the one place that writes the
 * user's Claude Code settings: `$CLAUDE_CONFIG_DIR/settings.json`, else
 * `~/.claude/settings.json`, the same file Claude Code reads.
 *
 * Before a write it prints the plan and a diff, asks (or takes --yes), and
 * copies the file to `settings.json.bak-<timestamp>`. Only the `statusLine`
 * key changes; every other key is kept in order and the file is rewritten
 * as 2-space JSON. A status line that is not PRISM's is shown and left alone
 * unless --replace. --uninstall removes PRISM's status line and puts back the
 * one it replaced, read from the newest backup that holds one.
 *
 * It never installs the plugin; it prints the /plugin commands.
 */
import { createInterface } from 'node:readline';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageDir, installsOnPath } from '../_top/version.js';
import { findOnPath } from '../../utils/tool-check.js';
import { runGuarded } from './security.js';

export const PLUGIN_ID = 'prism@prism-d1-velocity';
export const PLUGIN_HINT = [
  '/plugin marketplace add aws-samples/sample-prism-d1-velocity',
  '/plugin install prism@prism-d1-velocity',
];
export const REFRESH_INTERVAL_S = 60;
export const BACKUP_PREFIX = 'settings.json.bak-';
/** The PATH a process started outside a login shell usually has (a desktop launcher, an IDE). */
export const NON_INTERACTIVE_PATH = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(delimiter);

export interface ClaudeCodeOptions {
  yes?: boolean;
  dryRun?: boolean;
  status?: boolean;
  uninstall?: boolean;
  replace?: boolean;
}

export interface ClaudeCodeDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The status line command to install (statuslineCommand()). */
  command: string;
  isTTY: boolean;
  ask: (question: string) => Promise<string>;
  log: (line?: string) => void;
  error: (line: string) => void;
  now: () => Date;
}

export interface StatusLine { type?: string; command?: string; [k: string]: unknown }

/** Where Claude Code keeps its user settings: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function configDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(home, '.claude');
}

/** Claude Code's global state file (MCP servers in user scope): `<CLAUDE_CONFIG_DIR>/.claude.json`, else `~/.claude.json`. */
export function globalConfigFile(env: NodeJS.ProcessEnv, home: string): string {
  return env.CLAUDE_CONFIG_DIR ? join(resolve(env.CLAUDE_CONFIG_DIR), '.claude.json') : join(home, '.claude.json');
}

/** True for a status line this command wrote (any prism-cli path, any flags). */
export function isPrismStatusLine(s: unknown): boolean {
  const c = s && typeof s === 'object' ? (s as StatusLine).command : undefined;
  return typeof c === 'string' && /prism-cli(\.js)?['"]?\s+statusline\b/.test(c);
}

export function desiredStatusLine(command: string): StatusLine {
  return { type: 'command', command, refreshInterval: REFRESH_INTERVAL_S };
}

/** Single-quotes a path for the shell Claude Code runs the command with, when it needs it. */
export function shQuote(p: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * `prism-cli statusline` when this prism-cli, and node, are on the PATH a
 * non-interactive process has; else the absolute node and entry script, so an
 * nvm or Volta install still works when Claude Code starts without the shell's PATH.
 */
export function statuslineCommand(o: CliLocation): string {
  return `${prismCliCommand(o)} statusline`;
}

export interface CliLocation { ownPackageDir: string; execPath: string; entry: string; systemPath?: string }

/** How a hook or the status line runs this prism-cli: `prism-cli`, or the absolute node and entry script (see statuslineCommand). */
export function prismCliCommand(o: CliLocation): string {
  const sys = o.systemPath ?? NON_INTERACTIVE_PATH;
  const first = installsOnPath(sys, o.ownPackageDir)[0];
  if (first?.isThis && findOnPath('node', sys)) return 'prism-cli';
  return `${shQuote(o.execPath)} ${shQuote(o.entry)}`;
}

/** This process's prism-cli: its package dir, node and the real entry script. */
export function ownCliLocation(): CliLocation {
  const here = dirname(fileURLToPath(import.meta.url));
  const ownPackageDir = findPackageDir(here) ?? process.cwd();
  let entry = process.argv[1] ? resolve(process.argv[1]) : join(ownPackageDir, 'dist', 'bin', 'prism-cli.js');
  try { entry = realpathSync(entry); } catch { /* keep as is */ }
  return { ownPackageDir, execPath: process.execPath, entry };
}

// ------------------------------------------------------------ settings file

interface Settings { path: string; exists: boolean; text: string; json: Record<string, unknown> }

function readSettings(path: string): Settings {
  if (!existsSync(path)) return { path, exists: false, text: '', json: {} };
  const text = readFileSync(path, 'utf8');
  let json: unknown;
  try { json = text.trim() ? JSON.parse(text) : {}; } catch (e: any) {
    throw new UserError(`${path} is not valid JSON (${String(e?.message || e).split('\n')[0]}); fix it first. Nothing was changed.`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new UserError(`${path} does not hold a JSON object. Nothing was changed.`);
  return { path, exists: true, text, json: json as Record<string, unknown> };
}

class UserError extends Error {}

/** `obj` with statusLine set (kept in place when present, else appended) or removed. */
export function withStatusLine(obj: Record<string, unknown>, s: StatusLine | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'statusLine') { if (s) out[k] = s; placed = true; continue; }
    out[k] = v;
  }
  if (s && !placed) out.statusLine = s;
  return out;
}

export const render = (obj: Record<string, unknown>) => JSON.stringify(obj, null, 2) + '\n';

/** A unified-style line diff (LCS); settings files are small. */
export function lineDiff(a: string, b: string, label: string): string[] {
  const x = a ? a.replace(/\n$/, '').split('\n') : [];
  const y = b.replace(/\n$/, '').split('\n');
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [`--- ${label}`, `+++ ${label}`];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { out.push(`  ${x[i]}`); i++; j++; }
    else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  return out;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Copies a file to <name>.bak-<timestamp> (settings.json.bak-..., mode 0600); returns its path. */
export function backup(path: string, now: Date): string {
  const prefix = `${basename(path)}.bak-`;
  let b = join(dirname(path), `${prefix}${stamp(now)}`);
  for (let n = 1; existsSync(b); n++) b = join(dirname(path), `${prefix}${stamp(now)}-${n}`);
  copyFileSync(path, b);
  chmodSync(b, 0o600);
  return b;
}

/**
 * Writes beside the file and renames it into place, keeping the file's mode
 * (0600 for a new file). A symlinked settings.json (a dotfiles repo) is
 * written at its target, so the link stays a link.
 */
export function writeAtomic(link: string, text: string): void {
  let path = link;
  try { path = realpathSync(link); } catch { /* new file */ }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** The statusLine PRISM replaced: walk backups newest first, skipping ones that hold PRISM's own. */
export function previousStatusLine(dir: string): { file: string; statusLine: StatusLine | null } | null {
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.startsWith(BACKUP_PREFIX)).sort().reverse(); } catch { return null; }
  for (const n of names) {
    let j: any; // any: a backup of a JSON settings file, checked below.
    try { j = JSON.parse(readFileSync(join(dir, n), 'utf8')); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    const s = j.statusLine;
    if (s && isPrismStatusLine(s)) continue;
    return { file: join(dir, n), statusLine: s && typeof s === 'object' ? s : null };
  }
  return null;
}

// ------------------------------------------------------------ plugin and MCP detection (read-only)

export function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export interface PluginState { installed: boolean; enabled: boolean | null; version: string | null }

/** From `<config>/plugins/installed_plugins.json` and `enabledPlugins` in settings.json. */
export function pluginState(dir: string, settings: Record<string, unknown>): PluginState {
  const j = readJson(join(dir, 'plugins', 'installed_plugins.json'));
  const entries = j?.plugins?.[PLUGIN_ID];
  const list = Array.isArray(entries) ? entries : [];
  const enabledMap = settings.enabledPlugins as Record<string, unknown> | undefined;
  const enabled = enabledMap && typeof enabledMap === 'object' && PLUGIN_ID in enabledMap ? enabledMap[PLUGIN_ID] === true : null;
  return { installed: list.length > 0, enabled, version: typeof list[0]?.version === 'string' ? list[0].version : null };
}

const runsPrismMcp = (s: any) => s && typeof s === 'object' && /prism-cli/.test(String(s.command ?? '')) && [s.command, ...(Array.isArray(s.args) ? s.args : [])].join(' ').includes('mcp');

/** Where a `prism-cli mcp` server is configured: user scope in the global config, this repo's .mcp.json. */
export function mcpServers(globalFile: string, cwd: string): string[] {
  const out: string[] = [];
  const g = readJson(globalFile);
  for (const [name, s] of Object.entries(g?.mcpServers ?? {})) if (runsPrismMcp(s)) out.push(`user scope: ${name}`);
  const p = readJson(join(cwd, '.mcp.json'));
  for (const [name, s] of Object.entries(p?.mcpServers ?? {})) if (runsPrismMcp(s)) out.push(`project .mcp.json: ${name}`);
  return out;
}

// ------------------------------------------------------------ main

const yes = (a: string) => ['y', 'yes'].includes(a.trim().toLowerCase());

async function confirm(question: string, opts: ClaudeCodeOptions, d: ClaudeCodeDeps): Promise<boolean> {
  if (opts.yes) return true;
  if (!d.isTTY) {
    d.error('Error: no terminal to confirm. Re-run with --yes, or --dry-run to see the plan.');
    return false;
  }
  if (yes(await d.ask(question))) return true;
  d.error('Nothing changed.');
  return false;
}

function tilde(p: string, home: string): string {
  return p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

function pluginHint(state: PluginState, d: ClaudeCodeDeps): void {
  if (state.installed && state.enabled !== false) return;
  d.log(state.installed ? '\n  The PRISM plugin is installed but disabled: /plugin enable prism@prism-d1-velocity' : '\n  The PRISM plugin (slash commands, MCP tools, a findings summary at session start) is not installed. In Claude Code:');
  if (!state.installed) for (const l of PLUGIN_HINT) d.log(`    ${l}`);
}

function showStatus(s: Settings, dir: string, d: ClaudeCodeDeps): number {
  const sl = s.json.statusLine as StatusLine | undefined;
  const plugin = pluginState(dir, s.json);
  const mcp = mcpServers(globalConfigFile(d.env, d.home), d.cwd);
  d.log('\n📊 Claude Code status\n');
  d.log(`  Settings:     ${tilde(s.path, d.home)}${s.exists ? '' : ' (does not exist yet)'}${d.env.CLAUDE_CONFIG_DIR ? ' (CLAUDE_CONFIG_DIR)' : ''}`);
  d.log(`  Status line:  ${!sl ? 'not set' : isPrismStatusLine(sl) ? `PRISM: ${String(sl.command)}` : `another one: ${JSON.stringify(sl)}`}`);
  if (sl && isPrismStatusLine(sl) && sl.command !== d.command) d.log(`                (this prism-cli would write: ${d.command})`);
  d.log(`  Plugin:       ${plugin.installed ? `${PLUGIN_ID}${plugin.version ? ` ${plugin.version}` : ''}${plugin.enabled === false ? ' (disabled)' : ''}` : 'not installed'}`);
  d.log(`  MCP server:   ${plugin.installed ? 'from the plugin (plugin:prism:prism)' : ''}${mcp.length ? `${plugin.installed ? '; also ' : ''}${mcp.join(', ')}` : plugin.installed ? '' : 'not configured'}`);
  if (plugin.installed && mcp.length) d.log('                The plugin already runs prism-cli mcp; remove the other entry (claude mcp remove <name>) so tools are not listed twice.');
  pluginHint(plugin, d);
  if (!sl || !isPrismStatusLine(sl)) d.log('\n  → prism-cli enable claude-code');
  d.log('');
  return 0;
}

async function apply(s: Settings, next: Record<string, unknown>, title: string, opts: ClaudeCodeOptions, d: ClaudeCodeDeps): Promise<boolean> {
  const text = render(next);
  d.log('');
  for (const l of lineDiff(s.text, text, tilde(s.path, d.home))) d.log(`    ${l}`);
  d.log(`\n  ${s.exists ? `A copy of the current file is saved first as ${BACKUP_PREFIX}<timestamp>.` : 'The file is created (mode 0600).'} Other keys are kept; the file is rewritten as 2-space JSON.`);
  if (opts.dryRun) { d.log('\n  Dry run: nothing was written. Re-run without --dry-run to apply.\n'); return false; }
  if (!await confirm(`\n  ${title}? [y/N] `, opts, d)) return false;
  if (s.exists) d.log(`  ✓ Backup: ${tilde(backup(s.path, d.now()), d.home)}`);
  writeAtomic(s.path, text);
  d.log(`  ✓ Wrote ${tilde(s.path, d.home)}`);
  return true;
}

async function uninstall(s: Settings, dir: string, opts: ClaudeCodeOptions, d: ClaudeCodeDeps): Promise<number> {
  const sl = s.json.statusLine;
  d.log(opts.dryRun ? '\n🔌 enable claude-code --uninstall: dry run, nothing is changed\n' : '\n🔌 enable claude-code --uninstall\n');
  if (!sl) { d.log('  No status line is set. Nothing to remove.\n'); return 0; }
  if (!isPrismStatusLine(sl)) {
    d.log(`  The status line is not PRISM's, so it is left alone: ${JSON.stringify(sl)}\n`);
    return 0;
  }
  const prev = previousStatusLine(dir);
  const restore = prev?.statusLine ?? null;
  d.log(restore ? `  Plan: put back the status line PRISM replaced (from ${tilde(prev!.file, d.home)}): ${JSON.stringify(restore)}` : '  Plan: remove PRISM\'s status line (there was none before it).');
  if (!await apply(s, withStatusLine(s.json, restore), restore ? 'Restore it' : 'Remove it', opts, d)) return opts.dryRun ? 0 : 1;
  d.log('  Claude Code picks the change up on its next status line update.\n');
  return 0;
}

export async function enableClaudeCode(opts: ClaudeCodeOptions, d: ClaudeCodeDeps): Promise<number> {
  if (opts.replace && (opts.uninstall || opts.status)) { d.error('Error: --replace only applies when installing.'); return 1; }
  const dir = configDir(d.env, d.home);
  let s: Settings;
  try { s = readSettings(join(dir, 'settings.json')); } catch (e) {
    if (e instanceof UserError) { d.error(`Error: ${e.message}`); return 1; }
    throw e;
  }
  if (opts.status) return showStatus(s, dir, d);
  if (opts.uninstall) return uninstall(s, dir, opts, d);

  const want = desiredStatusLine(d.command);
  const cur = s.json.statusLine as StatusLine | undefined;
  d.log(opts.dryRun ? '\n🔌 enable claude-code: dry run, nothing is changed\n' : '\n🔌 enable claude-code\n');
  d.log(`  Settings: ${tilde(s.path, d.home)}${s.exists ? '' : ' (new file)'}`);
  d.log(`  Command:  ${d.command}${d.command === 'prism-cli statusline' ? '' : '\n            (absolute paths: prism-cli is not on the PATH Claude Code may start with, e.g. an nvm or Volta install)'}`);
  const plugin = pluginState(dir, s.json);
  if (cur && JSON.stringify(cur) === JSON.stringify(want)) {
    d.log('  Plan:     already set; nothing to do.');
    pluginHint(plugin, d);
    d.log('');
    return 0;
  }
  if (cur && !isPrismStatusLine(cur)) {
    d.log(`  Existing status line (not PRISM's): ${JSON.stringify(cur)}`);
    if (!opts.replace) {
      d.error('  Refusing to replace it. Re-run with --replace (it is kept in the backup, and --uninstall puts it back).');
      return 1;
    }
    d.log('  Plan:     replace it with PRISM\'s (--replace); --uninstall puts it back.');
  } else {
    d.log(`  Plan:     ${cur ? 'update PRISM\'s status line' : 'add a statusLine entry'}: ${JSON.stringify(want)}`);
  }
  if (!await apply(s, withStatusLine(s.json, want), 'Write it', opts, d)) return opts.dryRun ? 0 : 1;
  d.log('\n  Claude Code shows it on its next status line update (a new session, or after the next message).');
  d.log('  Check:  prism-cli enable claude-code --status');
  d.log('  Remove: prism-cli enable claude-code --uninstall');
  pluginHint(plugin, d);
  d.log('');
  return 0;
}

export function defaultDeps(): ClaudeCodeDeps {
  return {
    home: homedir(),
    env: process.env,
    cwd: process.cwd(),
    command: statuslineCommand(ownCliLocation()),
    isTTY: !!(process.stdin.isTTY && process.stdout.isTTY),
    ask: (q) => new Promise((done) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(q, (a) => { rl.close(); done(a.trim()); });
    }),
    log: (line = '') => console.log(line),
    error: (line) => console.error(line),
    now: () => new Date(),
  };
}

export default {
  description: 'Set Claude Code\'s status line to prism-cli statusline in your Claude Code user settings (CLAUDE_CONFIG_DIR respected), after a diff, a backup and your confirmation',
  options: [
    { flags: '--yes', description: 'Do not ask before writing settings.json' },
    { flags: '--dry-run', description: 'Print the plan and the diff; write nothing' },
    { flags: '--replace', description: 'Replace a status line that is not PRISM\'s (it is kept in the backup; --uninstall puts it back)' },
    { flags: '--status', description: 'Show the status line, the PRISM plugin and the prism-cli MCP server configuration (read-only)' },
    { flags: '--uninstall', description: 'Remove PRISM\'s status line, putting back the one it replaced' },
  ],
  action: (opts: ClaudeCodeOptions) => runGuarded(() => enableClaudeCode(opts, defaultDeps())),
};
