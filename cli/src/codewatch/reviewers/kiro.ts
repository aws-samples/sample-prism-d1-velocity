import { extractReviewJson, normalizeReview, OUTPUT_CONTRACT, stripAnsi, type ReviewerAdapter } from './types.js';

/**
 * kiro-cli headless review.
 *
 * Same shape as the CI gate (prism-eval-gate.yml): a short argv prompt that
 * points kiro at files on disk, because kiro-cli has had a bug putting long
 * stdin into HTTP headers. The rule set is passed as context by path -- kiro
 * reads it with fs_read before reviewing.
 *
 * Only fs_read is trusted (`--trust-tools=fs_read`), so in --no-interactive
 * mode any write or shell tool call is refused rather than run.
 */
export const kiroAdapter: ReviewerAdapter = {
  id: 'kiro',
  binary: 'kiro-cli',
  displayName: 'kiro-cli',
  invocation(req) {
    const prompt =
      `You are a code reviewer. First read the review rules in ${req.rulesPath} and follow them. ` +
      `Then read the diff at ${req.diffPath} and review only the changes it introduces, for code quality and security. ` +
      OUTPUT_CONTRACT;
    return {
      args: ['chat', '--no-interactive', '--trust-tools=fs_read', '--model', req.model || 'auto', prompt],
    };
  },
  parse(stdout) {
    const text = stripAnsi(stdout);
    // kiro-cli prints no machine-readable model; leave it to the caller's
    // requested model.
    return normalizeReview(extractReviewJson(text), null);
  },
};
