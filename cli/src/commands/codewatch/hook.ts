import { readFileSync } from 'node:fs';
import { CLAUDE_EVENTS, runClaudeHook, type ClaudeEvent } from '../../codewatch/harness/claude.js';
import { HARNESS_CHILD_ENV } from '../../codewatch/harness/engine.js';
import { failClosed, KIRO_EVENTS, runKiroHook, type KiroEvent } from '../../codewatch/harness/kiro.js';

const CLIENTS = ['claude', 'kiro'] as const;
const EVENTS: Record<typeof CLIENTS[number], readonly string[]> = { claude: CLAUDE_EVENTS, kiro: KIRO_EVENTS };

function readStdin(): string {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

/**
 * Hook adapter for AI coding clients (the harness loop). Reads the client's
 * hook JSON on stdin and prints the client's decision. Claude: always exits 0,
 * the decision is in the JSON. Kiro: exits 2 to deny a push (Kiro reads only
 * the exit code), else 0.
 */
export default {
  description: `Agent harness loop hook adapter: reads a coding client's hook JSON on stdin and prints its decision. Clients: ${CLIENTS.join(', ')}. Events: claude ${CLAUDE_EVENTS.join(', ')}; kiro ${KIRO_EVENTS.join(', ')}. Exits 0, except --client kiro, which exits 2 to deny a git push (and fails closed on an error during a push check)`,
  options: [
    { flags: '--client <client>', description: `Coding client: ${CLIENTS.join(' | ')}` },
    { flags: '--event <event>', description: `Hook event: ${[...new Set([...CLAUDE_EVENTS, ...KIRO_EVENTS])].join(' | ')}` },
  ],
  action(opts: { client?: string; event?: string }) {
    // A reviewer started by the engine runs with this set: never re-enter.
    process.exitCode = 0;
    if (process.env[HARNESS_CHILD_ENV] === '1') return;
    const client = opts.client as typeof CLIENTS[number];
    if (!(CLIENTS as readonly string[]).includes(client ?? '')) {
      process.stderr.write(`prism: codewatch hook supports --client ${CLIENTS.join(', ')} in this version; doing nothing\n`);
      return;
    }
    if (!EVENTS[client].includes(opts.event ?? '')) {
      process.stderr.write(`prism: unknown --event ${String(opts.event).slice(0, 40)} for --client ${client}; expected ${EVENTS[client].join(', ')}\n`);
      return;
    }
    if (client === 'kiro') {
      const stdin = readStdin();
      let r;
      try { r = runKiroHook(opts.event as KiroEvent, stdin); } catch (e: any) { // any: runKiroHook does not throw; this is the last guard
        r = opts.event === 'pre-push' ? failClosed(String(e?.message || e)) : { exit: 0 as const, stdout: '', stderr: '' };
      }
      if (r.stdout) process.stdout.write(r.stdout + '\n');
      if (r.stderr) process.stderr.write(r.stderr);
      process.exitCode = r.exit;
      return;
    }
    try {
      const out = runClaudeHook(opts.event as ClaudeEvent, readStdin());
      if (out) process.stdout.write(out + '\n');
    } catch (e: any) { // any: never let a PRISM bug block the agent
      try { process.stderr.write(`prism: harness hook failed (${String(e?.message || e).split('\n')[0]}); no decision\n`); } catch { /* ignore */ }
    }
  },
};
