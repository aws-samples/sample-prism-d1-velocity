import { extractReviewJson, normalizeReview, OUTPUT_CONTRACT, type ReviewerAdapter } from './types.js';

/** Read-only tools: the reviewer may look at surrounding code, never change it or run anything. */
const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'];
const DISALLOWED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'];

/**
 * Claude Code headless review (`claude -p --output-format json`).
 *
 * The rules and the diff go in the prompt on stdin (no argv length limit, no
 * file outside the working dir to grant access to). Needs no kiro-cli.
 */
export const claudeAdapter: ReviewerAdapter = {
  id: 'claude',
  binary: 'claude',
  displayName: 'Claude Code',
  invocation(req) {
    const args = [
      '-p',
      '--output-format', 'json',
      '--allowed-tools', ALLOWED_TOOLS.join(','),
      '--disallowed-tools', DISALLOWED_TOOLS.join(','),
    ];
    if (req.model) args.push('--model', req.model);
    const input =
      'You are a code reviewer. Review ONLY the changes in the diff below, for code quality and security, ' +
      'against these rules. You may read files in the repository for context but must not modify anything.\n\n' +
      `<rules>\n${req.rulesText}\n</rules>\n\n<diff>\n${req.diff}\n</diff>\n\n${OUTPUT_CONTRACT}`;
    return { args, input };
  },
  parse(stdout) {
    // Envelope: {"type":"result","is_error":false,"result":"<text>","modelUsage":{"<model>":{...}},...}
    let env: any;
    try {
      env = JSON.parse(stdout.trim());
    } catch {
      throw new Error('Claude Code output is not JSON (expected --output-format json)');
    }
    if (env?.is_error) throw new Error(`Claude Code reported an error: ${String(env.result ?? env.subtype ?? 'unknown').slice(0, 300)}`);
    if (typeof env?.result !== 'string') throw new Error('Claude Code JSON has no "result" text');
    const models = env.modelUsage && typeof env.modelUsage === 'object' ? Object.keys(env.modelUsage) : [];
    // modelUsage can list a small helper model too; the one with the most output tokens did the review.
    models.sort((a, b) => (env.modelUsage[b]?.outputTokens ?? 0) - (env.modelUsage[a]?.outputTokens ?? 0));
    return normalizeReview(extractReviewJson(env.result), models[0] ?? null);
  },
};
