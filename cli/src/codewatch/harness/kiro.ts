/**
 * `prism-cli codewatch hook --client kiro`: the harness loop for Kiro CLI V3
 * (and the Kiro IDE, which uses the same hook files), installed as
 * `.kiro/hooks/prism-harness.json` by `prism-cli enable agent-hooks --client kiro`
 * (docs/DESIGN-harness-loop.md section 8.3).
 *
 * Kiro's contract differs from Claude Code's in ways this adapter must follow
 * (verified against kiro-cli 3.3.0):
 * - PreToolUse denies ONLY with exit 2; stderr goes to the model. A JSON
 *   `permissionDecision: "deny"` is ignored, and any other non-zero exit (a
 *   crash, a kill on timeout) lets the command run. So every error on a
 *   command that is a `git push` exits 2 here: the push check fails closed.
 * - PreToolUse stdout on exit 0 is dropped, so review findings at a push have
 *   no channel there. They are kept for the session and handed to the agent
 *   by the Stop hook at the end of the same prompt.
 * - Stop continues the agent with exit 0 and `{"decision":"block","reason"}`.
 *   Kiro runs Stop hooks once per user prompt, so the finish gate gets one
 *   fix round per prompt; prism-cli's round counter stays the session limit.
 * - There is no channel to the person: what Claude Code shows as a
 *   systemMessage goes in the agent's reason and the result file.
 *
 * Events: session-start (baseline), pre-push (PreToolUse, matcher `shell`:
 * every shell command; non-pushes exit 0 after a tokenize), stop (finish gate,
 * opt-in, plus push findings), session-end (deletes the state).
 */
import { readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readHarnessConfig } from '../config.js';
import { gitIn } from './diff.js';
import { agentText, bypassReason, capBytes, clip, finishGateOn, HOOK_BUDGET_MS, isGitPush, MAX_FINDING_CHARS, MAX_REASON_BYTES, noticeOnce, oneLine, parsePushTarget, personText, pushGateOn } from './claude.js';
import { HARNESS_CHILD_ENV, runHarnessReview, type HarnessOptions, type HarnessVerdict } from './engine.js';
import { deleteState, ensureHarnessDir, harnessDir, loadState, recordBaseline, sanitizeSession } from './state.js';

export const KIRO_EVENTS = ['session-start', 'pre-push', 'stop', 'session-end'] as const;
export type KiroEvent = typeof KIRO_EVENTS[number];

/** Exit code Kiro reads as "block this tool call". */
export const KIRO_DENY_EXIT = 2;
/** Kiro's shell tool id; the `shell` matcher selects it. */
export const KIRO_SHELL_TOOL = 'execute_bash';
/** Last line of every push deny: who blocked it. */
export const KIRO_DENY_TAIL = 'This was blocked by the PRISM push check: the PRISM Kiro hook (.kiro/hooks/prism-harness.json), which runs prism-cli codewatch hook. Stop and tell the user that this hook blocked the command and why; do not attribute it to anyone else.';
/** Kiro has no message channel to the person, so the agent relays it. */
export const KIRO_PERSON_NOTE = 'Kiro has no message channel from this hook to the person, so tell the person this yourself.';
/** Kiro runs Stop hooks once per prompt: the next review is at the end of the next prompt. */
export const KIRO_ROUND_NOTE = 'Kiro runs this check once per prompt: after you fix these, say what you changed and finish; PRISM reviews again when your next prompt finishes.';
export const FAIL_CLOSED = 'PRISM push check failed closed';

export interface KiroHookResult { exit: 0 | 2; stdout: string; stderr: string }

export interface KiroHookDeps {
  env?: NodeJS.ProcessEnv;
  engine?: Partial<HarnessOptions>;
}

interface KiroInput {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: { command?: unknown; cwd?: unknown };
}

const ok = (stderr = ''): KiroHookResult => ({ exit: 0, stdout: '', stderr });
const short = (v: unknown) => clip(oneLine(v), MAX_FINDING_CHARS);

/** Room for the reason before the deny tail, within the 4 KB cap. */
const DENY_TEXT_BYTES = MAX_REASON_BYTES - Buffer.byteLength(KIRO_DENY_TAIL) - 1;

function deny(text: string): KiroHookResult {
  return { exit: KIRO_DENY_EXIT, stdout: '', stderr: `${capBytes(text, DENY_TEXT_BYTES)}\n${KIRO_DENY_TAIL}\n` };
}

/** The push deny for an error inside the check: never let a push through unchecked (Kiro fails open on a crash). */
export function failClosed(why: string): KiroHookResult {
  return deny(`${FAIL_CLOSED}: ${short(why)}. The push was not run, because the secret check could not complete. Tell the person; they can fix the cause (prism-cli codewatch review shows the same check) or push from their own terminal.`);
}

const block = (reason: string): KiroHookResult => ({ exit: 0, stdout: JSON.stringify({ decision: 'block', reason: capBytes(reason, MAX_REASON_BYTES) }), stderr: '' });

// ------------------------------------------------------------ push findings, handed over at Stop

/** `.prism/harness/<session>.push-notice.json`: the push findings the agent has not seen yet. */
const noticePath = (repoRoot: string, session: string) => join(harnessDir(repoRoot), `${session}.push-notice.json`);

/** Several pushes in one prompt: each one's findings are kept, newest last; over the reason cap, only the newest. */
function savePushNotice(repoRoot: string, session: string, text: string): void {
  ensureHarnessDir(repoRoot);
  const p = noticePath(repoRoot, session);
  const prev = readPushNotice(repoRoot, session);
  const joined = prev ? `${prev}\n\nA later push:\n${text}` : text;
  const all = Buffer.byteLength(joined, 'utf8') <= MAX_REASON_BYTES ? joined : text;
  writeFileSync(`${p}.${process.pid}.tmp`, JSON.stringify({ version: 1, text: all }) + '\n', { mode: 0o600 });
  renameSync(`${p}.${process.pid}.tmp`, p);
}

/** The pending push notice, or null. It is deleted only once a Stop hook has handed it over (clearPushNotice). */
function readPushNotice(repoRoot: string, session: string): string | null {
  try {
    const v = JSON.parse(readFileSync(noticePath(repoRoot, session), 'utf8'));
    return v && typeof v.text === 'string' && v.text ? v.text : null;
  } catch { return null; }
}

const clearPushNotice = (repoRoot: string, session: string) => rmSync(noticePath(repoRoot, session), { force: true });

// ------------------------------------------------------------ events

/** The repo the hook runs for: the shell call's own cwd, else the session's, else the process cwd. */
function repoOf(input: KiroInput): string | null {
  const dir = typeof input.tool_input?.cwd === 'string' && input.tool_input.cwd ? input.tool_input.cwd
    : typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const top = gitIn(dir, ['rev-parse', '--show-toplevel']);
  return top.ok && top.stdout ? top.stdout : null;
}

function prePush(cmd: string, input: KiroInput, deps: KiroHookDeps, env: NodeJS.ProcessEnv): KiroHookResult {
  const repoRoot = repoOf(input);
  // A push PRISM cannot place in a repository is a push whose target it does not know (D4).
  if (!repoRoot) return deny('PRISM harness: the push runs outside a git repository the hook can see, so it cannot check what the push sends. Run git push with the repository as the working directory.');
  const session = sanitizeSession(input.session_id);
  const cfg = readHarnessConfig(repoRoot);
  const v = runHarnessReview({
    deadlineMs: Date.now() + HOOK_BUDGET_MS, noticeOnce: (k) => noticeOnce(session, k, env),
    ...deps.engine, repoRoot, session, client: 'kiro', event: 'pre-push', scope: 'branch',
    push: parsePushTarget(cmd) ?? undefined, aiReview: pushGateOn(cfg, env),
  });
  const text = () => agentText(v, { push: true, maxBytes: DENY_TEXT_BYTES });
  if (v.verdict === 'fix') return deny(text());
  if (v.verdict === 'stop' && (v.secrets.length || v.commit_secrets.length || ['tamper', 'secrets-scan-failed', 'push-unknown'].includes(v.human_why ?? ''))) return deny(text());
  // D4: findings never deny. Kiro drops PreToolUse stdout, so the Stop hook hands them over.
  let note = '';
  if (v.findings.length && !session) note = `PRISM harness: Kiro sent no session id, so the push findings cannot be handed to the agent at Stop; they are only in ${v.result_path ?? 'the result file'}.\n`;
  if (v.findings.length && session) {
    try { savePushNotice(repoRoot, session, `${agentText(v, { includeNonBlocking: true, push: true })}\n${KIRO_PERSON_NOTE} Offer the follow-up change; do not change code or push again unless the person asks.`); } catch (e: any) { // any: fs error, message only
      note = `PRISM harness: could not keep the push findings for the Stop hook (${short(e?.message || e)}); they are only in ${v.result_path ?? 'the result file'}.\n`;
    }
  }
  return ok(`${v.findings.length || v.warnings.length ? `${personText(v)}\n` : ''}${note}`);
}

function stop(input: KiroInput, deps: KiroHookDeps, env: NodeJS.ProcessEnv): KiroHookResult {
  const repoRoot = repoOf(input);
  if (!repoRoot) return ok();
  const session = sanitizeSession(input.session_id);
  const pushNotice = session ? readPushNotice(repoRoot, session) : null;
  const r = finishCheck(repoRoot, session, pushNotice, deps, env);
  // Every output that blocks carries the notice, so it is handed over; an error above keeps it for the next Stop.
  if (pushNotice && r.stdout) clearPushNotice(repoRoot, session!);
  return r;
}

function finishCheck(repoRoot: string, session: string | null, pushNotice: string | null, deps: KiroHookDeps, env: NodeJS.ProcessEnv): KiroHookResult {
  const cfg = readHarnessConfig(repoRoot);
  if (!finishGateOn(cfg.finish_gate, env)) return pushNotice ? block(pushNotice) : ok();

  const before = session ? loadState(repoRoot, session) : null;
  const v: HarnessVerdict = runHarnessReview({ deadlineMs: Date.now() + HOOK_BUDGET_MS, ...deps.engine, repoRoot, session, client: 'kiro', event: 'stop', mode: 'working' });
  const withNotice = (s: string) => (pushNotice ? `${s}\n\nAlso, from your earlier push:\n${pushNotice}` : s);
  if (v.verdict === 'fix') return block(withNotice(`${agentText(v)}\n${KIRO_ROUND_NOTE}`));
  if (v.verdict === 'stop') {
    // The same stop again: the agent already reported it, so let the prompt end.
    if (before?.last?.verdict === 'stop' && before.last.hash === v.diff.hash) return pushNotice ? block(pushNotice) : ok(`${personText(v)}\n`);
    return block(withNotice(`${agentText(v)}\n${KIRO_PERSON_NOTE} Tell the person what remains and why (${personText(v)}), then finish. Do not try to fix it again in this session.`));
  }
  // pass: Kiro has no channel to the person; the result file holds any warnings and non-blocking findings.
  return pushNotice ? block(pushNotice) : ok(v.warnings.length || v.findings.length ? `${personText(v)}\n` : '');
}

/**
 * Runs one Kiro hook event and returns the exit code and output. Never
 * throws. Non-push shell commands return exit 0 before any git call; on a
 * push every internal error is a deny (fail closed); on other events an
 * error is exit 0 with a note on stderr.
 */
export function runKiroHook(event: KiroEvent, stdin: string | null, deps: KiroHookDeps = {}): KiroHookResult {
  const env = deps.env ?? process.env;
  if (env[HARNESS_CHILD_ENV] === '1') return ok();
  // Kiro always sends a JSON object. No input, unreadable input, or a shell call without a command
  // cannot be told apart from a push, so the push check holds it (D5); other events go on.
  let input: KiroInput;
  try {
    if (!stdin || !stdin.trim()) throw new Error('empty');
    input = JSON.parse(stdin);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('not an object');
  } catch {
    return event === 'pre-push' ? failClosed('the hook input from Kiro was missing or not a JSON object') : ok();
  }
  if (event === 'pre-push') {
    if (typeof input.tool_name === 'string' && input.tool_name !== KIRO_SHELL_TOOL && input.tool_name !== 'shell') return ok();
    if (typeof input.tool_input?.command !== 'string') return failClosed('the shell call in the hook input has no command');
    const cmd = input.tool_input.command;
    let push: boolean;
    try {
      const bypass = bypassReason(cmd);
      if (bypass) return deny(`PRISM harness: ${bypass}. Do not bypass or reconfigure the hooks.`);
      push = isGitPush(cmd);
    } catch (e: any) { // any: an internal error; only its message is shown
      return failClosed(`the command could not be parsed (${e?.message || e})`);
    }
    if (!push) return ok();
    try { return prePush(cmd, input, deps, env); } catch (e: any) { // any: as above
      return failClosed(String(e?.message || e));
    }
  }
  try {
    const repoRoot = event === 'stop' ? null : repoOf(input);
    const session = sanitizeSession(input.session_id);
    if (event === 'session-start') { if (repoRoot && session) recordBaseline(repoRoot, session, 'kiro'); return ok(); }
    if (event === 'session-end') {
      if (repoRoot && session) { deleteState(repoRoot, session); clearPushNotice(repoRoot, session); }
      return ok();
    }
    return stop(input, deps, env);
  } catch (e: any) { // any: a PRISM bug must not trap the agent at the finish
    return ok(`PRISM harness: internal error (${short(e?.message || e)}); no decision was made. The git pre-push review and the CI gate still run.\n`);
  }
}
