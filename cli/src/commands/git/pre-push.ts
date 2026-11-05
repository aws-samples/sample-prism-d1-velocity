import { readFileSync } from 'node:fs';
import { run } from '../../utils/exec.js';
import { runPrePush } from '../../security/prepush.js';

/**
 * Called by the pre-push hook installed by `prism-cli enable security`.
 * Report only: exits 0 whatever happens.
 */
export default {
  description: 'pre-push hook: report-only code review of the branch diff (never blocks; installed by enable security)',
  options: [{ flags: '--remote <name>', description: 'Remote being pushed to (git passes it to the hook)' }],
  action(opts: { remote?: string }) {
    try {
      const top = run('git', ['rev-parse', '--show-toplevel']);
      if (top.ok) {
        let stdin = '';
        try { stdin = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
        runPrePush({ repoRoot: top.stdout, stdin, remote: opts.remote || null });
      }
    } catch (e: any) {
      try { process.stderr.write(`prism: pre-push review failed (${e?.message || e}). Push continues.\n`); } catch { /* ignore */ }
    }
    process.exit(0);
  },
};
