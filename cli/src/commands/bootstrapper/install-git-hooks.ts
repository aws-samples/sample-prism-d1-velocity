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
    const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
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

const CLAUDE_SESSION_HOOK_SCRIPT = `#!/usr/bin/env bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
jq -n --arg ctx "CLAUDE_CODE_SESSION_ID=$SESSION_ID" \\
    '{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $ctx } }'
if [ -n "$CLAUDE_ENV_FILE" ] && ! grep -q "CLAUDE_CODE_SESSION_ID" "$CLAUDE_ENV_FILE" 2>/dev/null; then
    echo "export CLAUDE_CODE_SESSION_ID=\\"$SESSION_ID\\"" > "$CLAUDE_ENV_FILE"
fi
`;

function installClaudeSessionHook() {
  const home = homedir();
  const binDir = resolve(home, '.local/bin');
  const hookScriptPath = resolve(binDir, 'claude-session-id-hook');

  mkdirSync(binDir, { recursive: true });
  writeFileSync(hookScriptPath, CLAUDE_SESSION_HOOK_SCRIPT, { mode: 0o755 });

  const pathDirs = (process.env.PATH || '').split(':');
  if (!pathDirs.includes(binDir)) {
    console.log(`\n  ⚠️  ${binDir} is not in your PATH.`);
    console.log(`  Add to your shell profile: export PATH="$HOME/.local/bin:$PATH"\n`);
  }

  // Register in ~/.claude/settings.json
  const claudeDir = resolve(home, '.claude');
  const settingsPath = resolve(claudeDir, 'settings.json');
  mkdirSync(claudeDir, { recursive: true });

  let settings: any = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { /* ignore */ }
  }

  if (!settings.hooks) settings.hooks = {};
  const hook = { matcher: '', hooks: [{ type: 'command', command: 'claude-session-id-hook', timeout: 5000 }] };

  if (!settings.hooks.SessionStart) {
    settings.hooks.SessionStart = [hook];
  } else if (!settings.hooks.SessionStart.some((e: any) => e.hooks?.some((h: any) => h.command === 'claude-session-id-hook'))) {
    settings.hooks.SessionStart.push(hook);
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log('Claude Code session hook installed.');
}
