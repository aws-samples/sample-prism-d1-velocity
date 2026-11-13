import { run } from '../../utils/exec.js';
import { exitCodeFor, runHarnessReview, SCOPES, type HarnessOptions, type HarnessVerdict, type Scope } from '../../codewatch/harness/engine.js';
import { sanitizeSession } from '../../codewatch/harness/state.js';

interface Opts {
  working?: boolean;
  staged?: boolean;
  since?: string;
  session?: string;
  scope?: string;
  maxRounds?: string;
  timeout?: string;
  review?: boolean;
  json?: boolean;
}

function human(v: HarnessVerdict): string {
  const lines = [`prism harness: ${v.verdict} (round ${v.round} of ${v.max_rounds}, scope ${v.scope}, ${v.diff.files} file(s), ${v.diff.added_lines} added line(s)${v.diff.cached ? ', cached review' : ''})`];
  if (v.next_action) lines.push(`  next: ${v.next_action}`);
  for (const s of v.secrets) lines.push(`  [secret] ${s.file}:${s.line ?? '?'} ${s.rule}${s.committed ? ' (committed)' : ''}`);
  for (const f of v.findings.slice(0, 20)) lines.push(`  [${f.severity}${f.blocking ? ', blocking' : ''}] ${f.file}${f.line ? `:${f.line}` : ''} ${f.message.replace(/\s+/g, ' ').slice(0, 160)}`);
  for (const w of v.warnings) lines.push(`  warning: ${w}`);
  if (v.result_path) lines.push(`  result: ${v.result_path}`);
  return lines.join('\n');
}

/**
 * The harness loop engine. Exit 0 pass, 3 fix, 4 stop, 1 usage or internal
 * error. Exit 2 is never used: hooks read it as "block".
 */
export default {
  description: 'Agent harness loop: review the changes an AI agent made (gitleaks first, then the AI review) and answer pass, fix or stop. Exit 0 pass, 3 fix, 4 stop, 1 error',
  options: [
    { flags: '--working', description: 'Review the working tree (tracked and untracked) against the session baseline (default with --session)' },
    { flags: '--staged', description: 'Review the index against HEAD' },
    { flags: '--since <ref>', description: 'Review <ref>...HEAD plus uncommitted changes (default: the upstream, else the remote default branch)' },
    { flags: '--session <id>', description: 'Use the baseline and round counter of this agent session' },
    { flags: '--scope <scope>', description: `Which findings count: ${SCOPES.join(' | ')} (default new-lines with --session, else branch)` },
    { flags: '--max-rounds <n>', description: 'Fix rounds before stop (default harness.max_rounds, 2; ceiling 3)' },
    { flags: '--timeout <s>', description: 'Per-attempt reviewer timeout in seconds (default harness.timeout_seconds, 120)' },
    { flags: '--no-review', description: 'gitleaks and the tamper check only, no AI review' },
    { flags: '--json', description: 'Print the verdict JSON (schema prism.harness.verdict) on stdout, nothing else' },
  ],
  action(opts: Opts) {
    const fail = (msg: string): never => { process.stderr.write(`Error: ${msg}\n`); process.exit(1); };
    const modes = [opts.working, opts.staged, opts.since !== undefined].filter(Boolean).length;
    if (modes > 1) fail('pass only one of --working, --staged, --since');
    if (opts.scope !== undefined && !(SCOPES as string[]).includes(opts.scope)) fail(`--scope must be one of: ${SCOPES.join(', ')}`);
    const int = (v: string | undefined, name: string, max: number): number | undefined => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > max) fail(`${name} must be a whole number from 1 to ${max}`);
      return n;
    };
    const maxRounds = int(opts.maxRounds, '--max-rounds', 3);
    const timeout = int(opts.timeout, '--timeout', 3600);
    if (opts.since !== undefined && (opts.since.startsWith('-') || !/^[A-Za-z0-9._/~^@{}-]{1,200}$/.test(opts.since))) fail('--since must be a ref such as origin/main or HEAD~3');
    let session: string | null = null;
    if (opts.session !== undefined) {
      session = sanitizeSession(opts.session);
      if (!session) fail('--session must contain letters, digits, _ or -');
    }

    const top = run('git', ['rev-parse', '--show-toplevel']);
    if (!top.ok) fail('not a git repository');
    const o: HarnessOptions = {
      repoRoot: top.stdout, session, maxRounds, timeoutSeconds: timeout, noReview: opts.review === false,
      mode: opts.staged ? 'staged' : opts.since !== undefined ? 'since' : 'working', since: opts.since,
      scope: opts.scope as Scope | undefined, event: 'manual',
    };
    let v: HarnessVerdict;
    try {
      v = runHarnessReview(o);
    } catch (e: any) { // any: internal error, message only
      return fail(`harness review failed: ${String(e?.message || e).split('\n')[0]}`);
    }
    process.stdout.write(opts.json ? JSON.stringify(v, null, 2) + '\n' : human(v) + '\n');
    // exitCode, not exit(): a piped stdout may still be flushing.
    process.exitCode = exitCodeFor(v);
  },
};
