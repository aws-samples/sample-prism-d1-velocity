import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Claude Code SessionStart hook (Node port — no jq).
 *
 * Claude Code pipes a JSON event ({ session_id, ... }) to this command on
 * session start. We (a) echo the id back as `additionalContext` so the model
 * sees it, and (b) persist `CLAUDE_CODE_SESSION_ID` to the env file Claude
 * sources, so later `git commit`s detect claude-code and attribute tokens.
 *
 * Registered in ~/.claude/settings.json by `bootstrapper install-git-hooks`.
 */

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export default {
  description: 'Claude Code SessionStart hook: capture the session id for AI-origin commit attribution (no jq required)',
  options: [],
  async action() {
    const raw = await readStdin();

    let sessionId = '';
    try {
      const evt = JSON.parse(raw) as { session_id?: string };
      sessionId = evt.session_id || '';
    } catch { /* malformed/empty input → no session id */ }

    // Feed the id back to Claude Code as additional context
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `CLAUDE_CODE_SESSION_ID=${sessionId}`,
      },
    }));

    // Persist to the env file Claude sources, so subsequent git commits see it.
    // Only write when we actually resolved an id and it's not already present.
    const envFile = process.env.CLAUDE_ENV_FILE;
    if (envFile && sessionId) {
      let existing = '';
      if (existsSync(envFile)) { try { existing = readFileSync(envFile, 'utf8'); } catch { /* ignore */ } }
      if (!existing.includes('CLAUDE_CODE_SESSION_ID')) {
        try { writeFileSync(envFile, `export CLAUDE_CODE_SESSION_ID="${sessionId}"\n`); } catch { /* non-fatal */ }
      }
    }
  },
};
