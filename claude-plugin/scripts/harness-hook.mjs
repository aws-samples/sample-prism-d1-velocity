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
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EVENTS = new Set(['session-start', 'pre-tool', 'post-tool', 'stop', 'pre-push', 'bash-guard', 'session-end']);
/** The first prism-cli with `codewatch hook`. */
export const MIN_CLI = '1.11.0';
export const UPGRADE = 'Run npm i -g @prism-d1/cli@latest.';
/** Above prism-cli's own worst case (two 120 s reviewer attempts plus gitleaks), under the 300 s hook timeout. */
const CLI_TIMEOUT_MS = 290_000;
const VERSION_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const CHECK_NAME = { 'pre-tool': 'PRISM push and finish checks', 'post-tool': 'PRISM push and finish checks', 'pre-push': 'PRISM push check', 'bash-guard': 'PRISM push check', stop: 'PRISM finish check', 'session-start': 'PRISM push and finish checks', 'session-end': 'PRISM push and finish checks' };

const isWin = process.platform === 'win32';
/** $PRISM_CLI (an absolute path, for nvm installs Claude Code cannot see), else prism-cli on PATH. Same rule as session-start.mjs. */
export const prismCli = (env = process.env) => env.PRISM_CLI || (isWin ? 'prism-cli.cmd' : 'prism-cli');
const cliCommand = (cli) => (isWin ? `"${cli.replace(/"/g, '')}"` : cli);
const spawnOpts = { shell: isWin, windowsHide: true };

/** [major, minor, patch] from "1.10.1" or "prism-cli 1.10.1", or null. */
export function parseVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function older(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** The one line the person sees when the adapter could not run. */
export function inactiveMessage(event, r, env = process.env) {
  const name = CHECK_NAME[event] || 'PRISM harness check';
  const is = name.endsWith('checks') ? 'are' : 'is';
  if (r.error?.code === 'ENOENT') return `${name} ${is} off: prism-cli is not on the PATH Claude Code sees (set PRISM_CLI to its absolute path, or install it). ${UPGRADE}`;
  if (r.error?.code === 'ETIMEDOUT') return `${name} did not finish: prism-cli codewatch hook timed out, so no decision was made this time.`;
  const v = spawnSync(cliCommand(prismCli(env)), ['--version'], { ...spawnOpts, encoding: 'utf8', env, timeout: VERSION_TIMEOUT_MS });
  const found = v.status === 0 ? parseVersion(v.stdout) : null;
  if (!found) return `${name} ${is} off: prism-cli could not be run (${r.error ? String(r.error.message).split('\n')[0].slice(0, 120) : `exit ${r.status}`}). prism-cli ${MIN_CLI} or later is needed. ${UPGRADE}`;
  if (older(found, parseVersion(MIN_CLI))) return `${name} ${is} off: prism-cli ${MIN_CLI} or later is needed (found ${found.join('.')}). ${UPGRADE}`;
  return `${name} ${is} off: prism-cli codewatch hook failed (exit ${r.status}), so no decision was made.`;
}

/**
 * True the first time it is called for this session and reason, false after:
 * so the warning shows once per session, not on every Stop and push. State is
 * one empty marker file under the plugin's data dir (or the OS temp dir).
 * Without a session id there is nothing to key on, so it always shows.
 */
export function firstTime(stdin, reason, env = process.env) {
  let sid = '';
  try { sid = String(JSON.parse(stdin || '{}')?.session_id ?? ''); } catch { /* no session */ }
  sid = sid.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
  if (!sid) return true;
  const base = env.CLAUDE_PLUGIN_DATA || join(tmpdir(), `prism-plugin-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`);
  const dir = join(base, 'harness-notices');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${sid}-${reason}`), '', { flag: 'wx', mode: 0o600 });
    return true;
  } catch (e) {
    return e?.code !== 'EEXIST'; // a state dir that cannot be written shows the warning rather than hiding it
  }
}

/**
 * Runs the adapter and returns what to print ('' for nothing). Output that is
 * not one JSON object is dropped, so a stray log line cannot reach Claude.
 * When prism-cli is missing, too old or fails, it still makes no decision, and
 * tells the person once per session in a systemMessage.
 */
export function runHook(event, stdin, env = process.env) {
  if (!EVENTS.has(event) || env.PRISM_HARNESS_CHILD === '1') return '';
  const r = spawnSync(cliCommand(prismCli(env)), ['codewatch', 'hook', '--client', 'claude', '--event', event], {
    ...spawnOpts, input: stdin, encoding: 'utf8', env, timeout: CLI_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (r.error || r.status !== 0) {
    const msg = inactiveMessage(event, r, env);
    process.stderr.write(`prism plugin harness: ${msg}\n`);
    return firstTime(stdin, 'cli-unavailable', env) ? JSON.stringify({ systemMessage: msg }) : '';
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
