import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { getAssetPath } from '../../utils/root.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_SOURCE = getAssetPath(import.meta.url, 'bootstrapper/metric-hooks');

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(question, (a) => { rl.close(); r(a.trim()); }));
}

export default {
  description: 'Install prepare-commit-msg hook and configure .prism/config.json',
  options: [
    { flags: '--team-id <id>', description: 'Team ID (skips interactive prompt)' },
    { flags: '--max-tokens <n>', description: 'Max tokens per commit (default: 1000000)' },
    { flags: '--max-cost <n>', description: 'Max cost per commit in USD (default: 100)' },
    { flags: '--global', description: 'Also set git template dir so all future clones get the hook' },
    { flags: '--uninstall', description: 'Remove PRISM hooks' },
  ],
  async action(opts: { teamId?: string; maxTokens?: string; maxCost?: string; global?: boolean; uninstall?: boolean }) {
    let gitRoot = '';
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      if (!opts.global) {
        console.error('Error: not inside a git repository. Use --global to install the template without a repo.');
        process.exit(1);
      }
    }

    // --global without a repo: just install the template and exit
    if (!gitRoot && opts.global) {
      const source = resolve(HOOKS_SOURCE, 'prepare-commit-msg');
      if (!existsSync(source)) { console.error(`Hook source not found: ${source}`); process.exit(1); }
      const home = homedir();
      const templateHooksDir = resolve(home, '.git-templates/hooks');
      mkdirSync(templateHooksDir, { recursive: true });
      copyFileSync(source, resolve(templateHooksDir, 'prepare-commit-msg'));
      chmodSync(resolve(templateHooksDir, 'prepare-commit-msg'), 0o755);
      execSync(`git config --global init.templateDir "${resolve(home, '.git-templates')}"`, { encoding: 'utf8' });
      console.log('Global template dir set — all future clones will get the hook automatically.');
      console.log('Run again inside a repo to install locally + configure .prism/config.json.');
      return;
    }

    const hooksDir = resolve(gitRoot, '.git/hooks');
    const prismDir = resolve(gitRoot, '.prism');
    const configFile = resolve(prismDir, 'config.json');

    // --- Uninstall ---
    if (opts.uninstall) {
      const target = resolve(hooksDir, 'prepare-commit-msg');
      if (existsSync(target) && readFileSync(target, 'utf8').includes('AI-Origin')) {
        execSync(`rm "${target}"`);
        console.log('Removed prepare-commit-msg hook.');
      } else {
        console.log('No PRISM hook found.');
      }
      return;
    }

    // --- Resolve team ID ---
    let teamId = opts.teamId || '';
    if (!teamId && existsSync(configFile)) {
      try {
        const existing = JSON.parse(readFileSync(configFile, 'utf8'));
        if (existing.team_id && existing.team_id !== 'YOUR_TEAM_ID') {
          const keep = await prompt(`Existing team ID: ${existing.team_id}. Keep? [Y/n] `);
          if (keep !== 'n' && keep !== 'N') teamId = existing.team_id;
        }
      } catch { /* ignore */ }
    }
    if (!teamId) {
      teamId = await prompt('Enter your team ID (e.g., team-payments): ');
      if (!teamId) { console.error('Error: team ID is required.'); process.exit(1); }
    }

    // --- Create .prism/ ---
    mkdirSync(prismDir, { recursive: true });
    const maxTokens = parseInt(opts.maxTokens || '1000000', 10);
    const maxCost = parseFloat(opts.maxCost || '100');
    writeFileSync(configFile, JSON.stringify({ team_id: teamId, max_tokens: maxTokens, max_cost: maxCost }, null, 2) + '\n');
    console.log(`Config: ${configFile}`);

    // --- .gitignore (keep .prism/config.json trackable, no tokentracker in repo) ---
    const gitignore = resolve(gitRoot, '.gitignore');
    const ignoreEntry = '.prism/';
    if (existsSync(gitignore)) {
      const content = readFileSync(gitignore, 'utf8');
      if (!content.includes(ignoreEntry) && !content.includes('.prism/tokentracker/')) {
        // No entry needed — tokentracker is now in ~/.prism/ globally
      }
    }

    // --- Install hook ---
    const source = resolve(HOOKS_SOURCE, 'prepare-commit-msg');
    const target = resolve(hooksDir, 'prepare-commit-msg');

    if (!existsSync(source)) {
      console.error(`Hook source not found: ${source}`);
      process.exit(1);
    }

    // Back up existing non-PRISM hook
    if (existsSync(target) && !readFileSync(target, 'utf8').includes('AI-Origin')) {
      copyFileSync(target, `${target}.pre-prism`);
      console.log('Backed up existing prepare-commit-msg to prepare-commit-msg.pre-prism');
    }

    copyFileSync(source, target);
    chmodSync(target, 0o755);
    console.log('Installed prepare-commit-msg hook.');

    // --- Global template dir (--global flag) ---
    if (opts.global) {
      const home = homedir();
      const templateHooksDir = resolve(home, '.git-templates/hooks');
      mkdirSync(templateHooksDir, { recursive: true });
      copyFileSync(source, resolve(templateHooksDir, 'prepare-commit-msg'));
      chmodSync(resolve(templateHooksDir, 'prepare-commit-msg'), 0o755);
      execSync(`git config --global init.templateDir "${resolve(home, '.git-templates')}"`, { encoding: 'utf8' });
      console.log('Global template dir set — all future clones will get the hook automatically.');
    }

    // --- Summary ---
    console.log(`\nTeam: ${teamId}`);
    console.log('Every commit will now get AI-Origin, AI-Tool, and token trailers automatically.');

    // --- Claude Code session hook ---
    installClaudeSessionHook();
  },
};

const CLAUDE_HOOK_COMMAND = 'prism-cli git claude-session-context';

function installClaudeSessionHook() {
  const home = homedir();

  // Register the SessionStart hook in ~/.claude/settings.json.
  // The hook is served by `prism-cli git claude-session-context` (Node, no jq),
  // so there's no standalone script in ~/.local/bin and no PATH requirement.
  const claudeDir = resolve(home, '.claude');
  const settingsPath = resolve(claudeDir, 'settings.json');
  mkdirSync(claudeDir, { recursive: true });

  let settings: any = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { /* ignore */ }
  }

  if (!settings.hooks) settings.hooks = {};
  let sessionStart: any[] = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : [];

  // Drop any prior PRISM entry (legacy 'claude-session-id-hook' script or this
  // command) so re-running the installer upgrades cleanly without duplicates.
  sessionStart = sessionStart.filter((e: any) =>
    !e?.hooks?.some((h: any) => h.command === 'claude-session-id-hook' || h.command === CLAUDE_HOOK_COMMAND));

  sessionStart.push({ matcher: '', hooks: [{ type: 'command', command: CLAUDE_HOOK_COMMAND, timeout: 5000 }] });
  settings.hooks.SessionStart = sessionStart;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Claude Code session hook installed (${CLAUDE_HOOK_COMMAND}).`);
}
