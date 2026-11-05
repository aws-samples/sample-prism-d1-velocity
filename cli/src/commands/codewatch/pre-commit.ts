import { run } from '../../utils/exec.js';
import { runPreCommit } from '../../codewatch/gitleaks.js';

/** Called by the pre-commit hook installed by `prism-cli enable codewatch`. */
export default {
  description: 'pre-commit hook: gitleaks scan of staged changes (blocks on a finding; installed by enable codewatch)',
  action() {
    const top = run('git', ['rev-parse', '--show-toplevel']);
    if (!top.ok) process.exit(0);
    const out = runPreCommit(top.stdout);
    const r = out.result;
    if (r.status === 'findings') {
      console.error(`prism: gitleaks found ${r.findings.length} secret(s) in the staged changes. Commit blocked.`);
      for (const f of r.findings.slice(0, 10)) console.error(`  [${f.rule}] ${f.file}${f.line ? `:${f.line}` : ''}`);
      console.error('prism: remove it (and rotate it if it is real), allowlist a false positive in .gitleaks.toml,');
      console.error('       or bypass once with git commit --no-verify (recorded as skipped at push time).');
    } else if (r.status === 'error') {
      console.error(`prism: ${r.reason}${out.exitCode ? ' Commit blocked; fix the scan or bypass with --no-verify.' : ''}`);
    }
    process.exit(out.exitCode);
  },
};
