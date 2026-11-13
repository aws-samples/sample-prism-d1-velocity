import { readFileSync } from 'node:fs';
import { CLAUDE_EVENTS, runClaudeHook, type ClaudeEvent } from '../../codewatch/harness/claude.js';
import { HARNESS_CHILD_ENV } from '../../codewatch/harness/engine.js';

const CLIENTS = ['claude'] as const;

/**
 * Hook adapter for AI coding clients (the harness loop). Reads the client's
 * hook JSON on stdin, prints the client's JSON on stdout, and always exits 0.
 */
export default {
  description: `Agent harness loop hook adapter: reads a coding client's hook JSON on stdin and prints its decision JSON. Client: ${CLIENTS.join(', ')}. Events: ${CLAUDE_EVENTS.join(', ')}. Always exits 0`,
  options: [
    { flags: '--client <client>', description: `Coding client: ${CLIENTS.join(' | ')}` },
    { flags: '--event <event>', description: `Hook event: ${CLAUDE_EVENTS.join(' | ')}` },
  ],
  action(opts: { client?: string; event?: string }) {
    // A reviewer started by the engine runs with this set: never re-enter.
    process.exitCode = 0;
    if (process.env[HARNESS_CHILD_ENV] === '1') return;
    try {
      if (opts.client !== 'claude') {
        process.stderr.write(`prism: codewatch hook supports --client ${CLIENTS.join(', ')} in this version; doing nothing\n`);
        return;
      }
      if (!(CLAUDE_EVENTS as readonly string[]).includes(opts.event ?? '')) {
        process.stderr.write(`prism: unknown --event ${String(opts.event).slice(0, 40)}; expected ${CLAUDE_EVENTS.join(', ')}\n`);
        return;
      }
      let stdin = '';
      try { stdin = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
      const out = runClaudeHook(opts.event as ClaudeEvent, stdin);
      if (out) process.stdout.write(out + '\n');
    } catch (e: any) { // any: never let a PRISM bug block the agent
      try { process.stderr.write(`prism: harness hook failed (${String(e?.message || e).split('\n')[0]}); no decision\n`); } catch { /* ignore */ }
    }
  },
};
