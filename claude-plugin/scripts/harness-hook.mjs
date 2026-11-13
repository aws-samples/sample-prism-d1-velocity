#!/usr/bin/env node
/**
 * Harness loop hooks of the PRISM Claude Code plugin (session-start, stop,
 * pre-push, session-end). A thin pass-through: the hook JSON on stdin goes to
 * `prism-cli codewatch hook --client claude --event <event>`, and what it
 * prints goes back to Claude Code. All logic (gates, diff, gitleaks, review,
 * rounds, verdict) is in prism-cli (docs/DESIGN-harness-loop.md section 2.3).
 *
 * Always exits 0. A missing or old prism-cli means no decision, never a block.
 * The plugin options reach prism-cli as CLAUDE_PLUGIN_OPTION_FINISH_GATE and
 * CLAUDE_PLUGIN_OPTION_PUSH_GATE in the inherited environment.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const EVENTS = new Set(['session-start', 'stop', 'pre-push', 'session-end']);
/** Above prism-cli's own worst case (two 120 s reviewer attempts plus gitleaks), under the 300 s hook timeout. */
const CLI_TIMEOUT_MS = 290_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

const isWin = process.platform === 'win32';
/** $PRISM_CLI (an absolute path, for nvm installs Claude Code cannot see), else prism-cli on PATH. Same rule as session-start.mjs. */
export const prismCli = (env = process.env) => env.PRISM_CLI || (isWin ? 'prism-cli.cmd' : 'prism-cli');
const cliCommand = (cli) => (isWin ? `"${cli.replace(/"/g, '')}"` : cli);

/**
 * Runs the adapter and returns what to print ('' for nothing). Output that is
 * not one JSON object is dropped, so a stray log line cannot reach Claude.
 */
export function runHook(event, stdin, env = process.env) {
  if (!EVENTS.has(event) || env.PRISM_HARNESS_CHILD === '1') return '';
  const r = spawnSync(cliCommand(prismCli(env)), ['codewatch', 'hook', '--client', 'claude', '--event', event], {
    input: stdin, encoding: 'utf8', env, timeout: CLI_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, shell: isWin, windowsHide: true,
  });
  if (r.error || r.status !== 0) {
    const why = r.error ? String(r.error.message).split('\n')[0] : `exit ${r.status}`;
    process.stderr.write(`prism plugin harness: prism-cli codewatch hook failed (${why.slice(0, 200)}); needs prism-cli 1.11.0 or later. No decision.\n`);
    return '';
  }
  const out = (r.stdout || '').trim();
  if (!out) return '';
  try {
    const v = JSON.parse(out);
    return v && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : '';
  } catch {
    return '';
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const isMain = () => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } };
if (process.argv[1] && isMain()) {
  readStdin()
    .then((raw) => { const out = runHook(process.argv[2], raw); if (out) process.stdout.write(out + '\n'); })
    .catch((e) => { process.stderr.write(`prism plugin harness: ${String(e?.message || e).split('\n')[0].slice(0, 300)}\n`); });
}
