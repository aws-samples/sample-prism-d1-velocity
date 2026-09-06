import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { run } from '../../utils/exec.js';
import { withPrivateTemp } from '../../utils/tempfile.js';
import {
  Finding, renderReport, parseFailOn, applyFailOn,
  FAIL_ON_OPTION, JSON_OPTION,
} from '../../utils/audit.js';

/**
 * Audit a git repository for credentials, using gitleaks for all detection.
 *
 * The account-side companion is `bedrock-protection scan-account`, which audits
 * IAM credential hygiene and Bedrock spend guardrails. This command answers a
 * different question: is a credential already sitting in a repository?
 *
 * Detection is gitleaks-only by design: this command contains no credential
 * patterns of its own. The filename and .gitignore checks below inspect
 * *hygiene* (is `.env` ignored? is a scanner wired into the hook?) and never
 * attempt to recognise a secret.
 *
 * Three ARCC requirements shape this (SAX-03 Outcome 4, "Policy Engine Risk
 * Detection for Credential Violations", plus the metadata-leak recommendation):
 *
 *   - "Not scanning Git history for previously committed credentials" is a named
 *     pitfall, so history is scanned in full rather than a PR range. This is the
 *     opposite trade-off from the CI eval gate, which scans only BASE..HEAD so
 *     the gate can go green on a repo with pre-existing findings.
 *   - "Check the git history of every branch of your repo" -- satisfied by
 *     gitleaks' default, verified rather than assumed: a `gitleaks git` scan
 *     reported a finding in a commit NOT reachable from HEAD, and adding
 *     `--log-opts=--all` changed nothing.
 *   - "Do not put sensitive data into any metadata such as git commit messages."
 *     gitleaks does NOT scan commit messages -- measured: a commit whose message
 *     contained a valid AWS key id produced zero findings from both a default and
 *     an --all scan. That gap is closed by `auditCommitMessages` below, still
 *     using gitleaks for the matching.
 *
 * Also measured: `gitleaks dir` does NOT honour .gitignore, which is what makes
 * the working-tree scan worth running separately -- an ignored `.env` is absent
 * from history but present on disk.
 *
 * Audit-only. Nothing is written to the repository.
 */

/** Filenames that should never be tracked. A name check, not secret detection. */
const CREDENTIAL_FILENAMES = [
  '.env', '.env.local', '.env.production', '.env.development',
  'credentials', '.npmrc', '.pypirc', '.netrc',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
];

/** Patterns a .gitignore should carry to keep the above from being added. */
const EXPECTED_IGNORES = ['.env', '*.pem', '*.key', 'credentials', 'id_rsa'];

function findGitleaks(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  if (process.env.GITLEAKS_PATH && existsSync(process.env.GITLEAKS_PATH)) return process.env.GITLEAKS_PATH;
  const which = run('which', ['gitleaks']);
  if (which.ok && which.stdout) return which.stdout.trim();
  return null;
}

interface ScanOutcome {
  /** -1 signals "the scan produced no verdict" and maps to INDETERMINATE. */
  count: number;
  /** RuleID / location pairs. Never carries Secret, Match or commit Message. */
  hits: string[];
  error?: string;
}

/**
 * Run gitleaks and summarise its report.
 *
 * `--redact` is mandatory, not stylistic: without it gitleaks prints the matched
 * secret into its own report and stdout, so a tool run to find an exposure would
 * become a second copy of it -- on a terminal, in scrollback, and in whatever
 * captures this command's output.
 *
 * The clean/leaks/failed distinction keys on the REPORT rather than the exit
 * code. gitleaks exits 1 both for "leaks found" and, combined with other
 * failures, for conditions that establish nothing -- and `run()` collapses every
 * non-zero exit into ok:false. The report is the actual evidence: findings
 * present means findings, while a missing or unparseable report alongside a
 * non-zero exit means the scan produced no verdict, which is INDETERMINATE and
 * must never read as clean.
 */
function runGitleaks(bin: string, args: string[], reportPath: string): ScanOutcome {
  const res = run(bin, [...args, '--no-banner', '--redact', '--report-format=json', `--report-path=${reportPath}`]);

  let parsed: any[] | null = null;
  if (existsSync(reportPath)) {
    try {
      const body = readFileSync(reportPath, 'utf8').trim();
      parsed = body ? JSON.parse(body) : [];
    } catch {
      parsed = null;
    }
  }

  if (parsed === null) {
    // No usable report. Exit 0 with no report is a clean scan on some gitleaks
    // paths; a non-zero exit with no report is a failure.
    if (res.ok) return { count: 0, hits: [] };
    return { count: -1, hits: [], error: (res.stderr || 'gitleaks failed and wrote no report').split('\n')[0] };
  }

  const hits = parsed.map((f) => {
    const where = f.File ? `${f.File}:${f.StartLine}` : `line ${f.StartLine}`;
    const commit = f.Commit ? ` @${String(f.Commit).slice(0, 8)}` : '';
    return `[${f.RuleID}] ${where}${commit}`;
  });
  return { count: parsed.length, hits };
}

const ROTATE_FIRST =
  'Rotate the credential FIRST. ARCC names "assuming removal from source code is sufficient" as a pitfall — rewriting history does not un-expose anything already cloned, forked or mirrored.';

/**
 * Extra args aligning this command with the CI eval gate's tuning surface.
 *
 * `.gitleaks.toml` needs no flag: gitleaks auto-loads it from the SCANNED path,
 * verified rather than assumed -- a scan run from an unrelated cwd still
 * honoured a config sitting in the target repo, in both `dir` and `git` mode.
 * A baseline does need an explicit flag.
 *
 * Both are surfaced in the report, because a silently applied allowlist is
 * indistinguishable from a clean repo, and "0 findings" means something quite
 * different when a suppression file is in play.
 */
function tuningArgs(repo: string): { args: string[]; notes: string[] } {
  const args: string[] = [];
  const notes: string[] = [];
  if (existsSync(join(repo, '.gitleaks.toml'))) notes.push('.gitleaks.toml (auto-loaded)');
  const baseline = join(repo, '.prism', 'gitleaks-baseline.json');
  if (existsSync(baseline)) {
    args.push(`--baseline-path=${baseline}`);
    notes.push('.prism/gitleaks-baseline.json');
  }
  return { args, notes };
}

function auditHistory(bin: string, repo: string, reportDir: string, tuning: string[]): Finding {
  // gitleaks scans every ref by default (verified), so this covers commits on
  // branches other than the checked-out one.
  const r = runGitleaks(bin, ['git', repo, ...tuning], join(reportDir, 'history.json'));
  if (r.count < 0) {
    return {
      id: 'history-secrets', category: 'detection', title: 'Credentials in git history (all refs)',
      status: 'INDETERMINATE', severity: 'CRITICAL',
      detail: `The history scan produced no verdict (${r.error ?? 'unknown error'}), so this repository is NOT cleared.`,
    };
  }
  return {
    id: 'history-secrets', category: 'detection', title: 'Credentials in git history (all refs)',
    status: r.count ? 'FAIL' : 'PASS',
    severity: 'CRITICAL',
    detail: r.count
      ? `${r.count} credential(s) committed at some point in this repository's history: ${r.hits.slice(0, 10).join(', ')}${r.count > 10 ? `, … (+${r.count - 10})` : ''}. A deleted file does not remove the blob — it stays reachable in history.`
      : 'No credentials found in any commit on any ref.',
    remediation: r.count ? ROTATE_FIRST : undefined,
  };
}

function auditWorkingTree(bin: string, repo: string, reportDir: string, tuning: string[]): Finding {
  // `gitleaks dir` does NOT honour .gitignore (verified), which is the point:
  // an ignored .env never enters history but sits on disk, and leaks through
  // backups, screen shares, bundled archives and stray `docker build` contexts.
  const r = runGitleaks(bin, ['dir', repo, ...tuning], join(reportDir, 'worktree.json'));
  if (r.count < 0) {
    return {
      id: 'worktree-secrets', category: 'detection', title: 'Credentials in the working tree (including ignored files)',
      status: 'INDETERMINATE', severity: 'HIGH',
      detail: `The working-tree scan produced no verdict (${r.error ?? 'unknown error'}).`,
    };
  }
  return {
    id: 'worktree-secrets', category: 'detection', title: 'Credentials in the working tree (including ignored files)',
    status: r.count ? 'FAIL' : 'PASS',
    severity: 'HIGH',
    detail: r.count
      ? `${r.count} credential(s) present on disk: ${r.hits.slice(0, 10).join(', ')}${r.count > 10 ? `, … (+${r.count - 10})` : ''}. This scan ignores .gitignore, so some of these may never have been committed — still exposed via backups, archives and build contexts.`
      : 'No credentials on disk, including files excluded by .gitignore.',
    remediation: r.count ? 'Move each value into Secrets Manager or Parameter Store and read it at runtime. If any is also in history, rotate first.' : undefined,
  };
}

/**
 * Commit messages, which gitleaks does not scan.
 *
 * Measured: a commit whose message contained a valid AWS key id produced zero
 * findings from both a default `gitleaks git` scan and an `--log-opts=--all`
 * one. ARCC explicitly calls this out ("Do not put sensitive data into any
 * metadata such as git commit messages ... This type of data is difficult to
 * wipe ... and are going to stay forever in the repository").
 *
 * Detection stays with gitleaks: the messages are written to a private temp file
 * and gitleaks scans that. No pattern matching happens here. The temp file holds
 * real credentials, so it goes through `withPrivateTemp` -- mode 0600 inside a
 * mkdtemp directory, removed on every path including throws.
 */
function auditCommitMessages(bin: string, repo: string): Finding {
  const log = run('git', ['-C', repo, 'log', '--all', '--format=%H%n%B%n']);
  if (!log.ok) {
    return {
      id: 'commit-message-secrets', category: 'detection', title: 'Credentials in commit messages',
      status: 'INDETERMINATE', severity: 'HIGH',
      detail: `Could not read the commit log (${(log.stderr || '').split('\n')[0] || 'unknown error'}).`,
    };
  }

  const body = log.stdout || '';
  const lines = body.split('\n');

  return withPrivateTemp('commit-messages.txt', body, (file): Finding => {
    const r = runGitleaks(bin, ['dir', file], join(dirname(file), 'messages.json'));
    if (r.count < 0) {
      return {
        id: 'commit-message-secrets', category: 'detection', title: 'Credentials in commit messages',
        status: 'INDETERMINATE', severity: 'HIGH',
        detail: `The commit-message scan produced no verdict (${r.error ?? 'unknown error'}).`,
      };
    }
    if (r.count === 0) {
      return {
        id: 'commit-message-secrets', category: 'detection', title: 'Credentials in commit messages',
        status: 'PASS', severity: 'HIGH',
        detail: 'No credentials in any commit message. Worth checking separately because gitleaks scans patch content, not message text.',
      };
    }

    // Map each hit back to a commit: walk backwards from the reported line to
    // the nearest 40-hex SHA, which is the %H written before each message.
    const commits = new Set<string>();
    for (const hit of r.hits) {
      const m = /line (\d+)/.exec(hit) ?? /:(\d+)/.exec(hit);
      if (!m) continue;
      const lineNo = Number.parseInt(m[1], 10);
      for (let i = Math.min(lineNo, lines.length) - 1; i >= 0; i--) {
        if (/^[0-9a-f]{40}$/.test(lines[i].trim())) { commits.add(lines[i].trim().slice(0, 8)); break; }
      }
    }

    return {
      id: 'commit-message-secrets', category: 'detection', title: 'Credentials in commit messages',
      status: 'FAIL', severity: 'HIGH',
      detail: `${r.count} credential(s) in commit message text${commits.size ? `, in commit(s): ${[...commits].join(', ')}` : ''}. Message text is not part of any diff, so neither this repo's CI gate nor a plain gitleaks run would report it — and a message cannot be edited without rewriting every descendant commit.`,
      remediation: ROTATE_FIRST,
    };
  });
}

function auditTrackedFiles(repo: string): Finding {
  const ls = run('git', ['-C', repo, 'ls-files']);
  if (!ls.ok) {
    return {
      id: 'tracked-credential-files', category: 'hygiene', title: 'Credential-bearing files tracked in git',
      status: 'INDETERMINATE', severity: 'HIGH',
      detail: `Could not list tracked files (${(ls.stderr || '').split('\n')[0] || 'unknown error'}).`,
    };
  }
  const tracked = (ls.stdout || '').split('\n').filter(Boolean);
  const bad = tracked.filter((f) => {
    const base = f.split('/').pop() ?? f;
    return CREDENTIAL_FILENAMES.includes(base) || base.endsWith('.pem');
  });
  return {
    id: 'tracked-credential-files', category: 'hygiene', title: 'Credential-bearing files tracked in git',
    status: bad.length ? 'FAIL' : 'PASS', severity: 'HIGH',
    detail: bad.length
      ? `${bad.length} file(s) of a kind that normally holds credentials are tracked: ${bad.slice(0, 10).join(', ')}. Flagged by filename — whether each actually contains a live credential is answered by the history and working-tree scans above.`
      : `None of ${tracked.length} tracked file(s) has a credential-bearing filename.`,
    remediation: bad.length ? 'Untrack each file, add it to .gitignore, and rotate anything it contained — it is in history regardless.' : undefined,
  };
}

function auditGitignore(repo: string): Finding {
  const path = join(repo, '.gitignore');
  if (!existsSync(path)) {
    return {
      id: 'gitignore-hygiene', category: 'hygiene', title: '.gitignore covers credential file patterns',
      status: 'FAIL', severity: 'MEDIUM',
      detail: 'No .gitignore at the repository root, so nothing stops a .env or private key from being staged by an ordinary `git add -A`.',
      remediation: `Add a .gitignore covering at least: ${EXPECTED_IGNORES.join(', ')}.`,
    };
  }
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const missing = EXPECTED_IGNORES.filter((pat) => !lines.some((l) => l === pat || l === `/${pat}` || l === `**/${pat}`));
  return {
    id: 'gitignore-hygiene', category: 'hygiene', title: '.gitignore covers credential file patterns',
    status: missing.length ? 'FAIL' : 'PASS', severity: 'MEDIUM',
    detail: missing.length
      ? `.gitignore does not cover: ${missing.join(', ')}. Each is a pattern a credential commonly arrives under, and an uncovered one gets staged by a routine \`git add -A\`.`
      : 'All expected credential file patterns are ignored.',
    remediation: missing.length ? `Add the missing patterns: ${missing.join(', ')}.` : undefined,
  };
}

function auditPreCommitHook(repo: string): Finding {
  // Look in both the default hooks dir and core.hooksPath, since a repo using
  // pre-commit or husky relocates it and .git/hooks would look empty.
  const candidates: string[] = [];
  const hooksPath = run('git', ['-C', repo, 'config', '--get', 'core.hooksPath']);
  if (hooksPath.ok && hooksPath.stdout.trim()) candidates.push(resolvePath(repo, hooksPath.stdout.trim()));
  candidates.push(join(repo, '.git', 'hooks'));

  let wired = false;
  const inspected: string[] = [];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    inspected.push(dir);
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith('pre-commit')) continue;
      try {
        if (/gitleaks/i.test(readFileSync(join(dir, entry), 'utf8'))) { wired = true; break; }
      } catch { /* unreadable hook — treat as not wired */ }
    }
    if (wired) break;
  }

  // A pre-commit config that references gitleaks also counts.
  const preCommitCfg = join(repo, '.pre-commit-config.yaml');
  if (!wired && existsSync(preCommitCfg)) {
    try { wired = /gitleaks/i.test(readFileSync(preCommitCfg, 'utf8')); } catch { /* ignore */ }
  }

  return {
    id: 'pre-commit-scanner', category: 'hygiene', title: 'gitleaks wired as a pre-commit hook',
    status: wired ? 'PASS' : 'FAIL', severity: 'LOW',
    detail: wired
      ? 'A pre-commit hook or .pre-commit-config.yaml invokes gitleaks, so a credential is caught before it becomes a commit.'
      : `No pre-commit hook invokes gitleaks${inspected.length ? ` (checked ${inspected.join(', ')})` : ''}. Without one, the earliest catch is CI — by which point the credential is already in history and, on a push, already off the machine.`,
    remediation: wired ? undefined : 'Install `gitleaks protect --staged --redact` as a pre-commit hook. Severity is LOW only because a hook is advisory: it is trivially bypassed with --no-verify and is not a control.',
  };
}

export default {
  description: 'Scan a git repository for credentials with gitleaks: full history across all refs, working tree, commit messages, and ignore-file hygiene',
  options: [
    { flags: '--repo <path>', description: 'Repository to scan', default: '.' },
    { flags: '--gitleaks <path>', description: 'Path to the gitleaks binary (default: $GITLEAKS_PATH, then PATH)' },
    { flags: '--skip-history', description: 'Skip the full-history scan (it is the slow one on a large repo)' },
    JSON_OPTION,
    FAIL_ON_OPTION,
  ],
  async action(opts: {
    repo?: string; gitleaks?: string; skipHistory?: boolean; json?: boolean; failOn?: string;
  }) {
    const failOn = parseFailOn(opts.failOn);
    const repo = resolvePath(opts.repo || '.');

    if (!existsSync(join(repo, '.git'))) {
      console.error(`\n❌ ${repo} is not a git repository (no .git directory).\n`);
      process.exitCode = 2;
      return;
    }

    // Deliberately not auto-downloaded. The CI eval gate fetches a
    // version-pinned, checksum-verified binary because it runs in a disposable
    // container; a developer CLI silently pulling an executable onto a
    // workstation is a different risk, so this reports and stops.
    const bin = findGitleaks(opts.gitleaks);
    const tuning = tuningArgs(repo);
    const findings: Finding[] = [];

    if (!bin) {
      for (const [id, title, sev] of [
        ['history-secrets', 'Credentials in git history (all refs)', 'CRITICAL'],
        ['worktree-secrets', 'Credentials in the working tree (including ignored files)', 'HIGH'],
        ['commit-message-secrets', 'Credentials in commit messages', 'HIGH'],
      ] as Array<[string, string, Finding['severity']]>) {
        findings.push({
          id, category: 'detection', title,
          status: 'INDETERMINATE', severity: sev,
          detail: 'gitleaks is not installed, so no credential detection ran. This repository is NOT cleared.',
          remediation: 'Install gitleaks (`brew install gitleaks`, or a release binary from github.com/gitleaks/gitleaks), or pass --gitleaks <path>.',
        });
      }
    } else {
      // One temp dir holds every gitleaks report; reports can name files but
      // never contain secret values, because --redact is always passed.
      withPrivateTemp('.keep', '', (keep) => {
        const reportDir = dirname(keep);
        if (opts.skipHistory) {
          findings.push({
            id: 'history-secrets', category: 'detection', title: 'Credentials in git history (all refs)',
            status: 'INDETERMINATE', severity: 'CRITICAL',
            detail: 'Skipped via --skip-history. The check most likely to find an already-leaked credential did not run.',
          });
        } else {
          findings.push(auditHistory(bin, repo, reportDir, tuning.args));
        }
        findings.push(auditWorkingTree(bin, repo, reportDir, tuning.args));
        findings.push(auditCommitMessages(bin, repo));
      });
    }

    findings.push(auditTrackedFiles(repo));
    findings.push(auditGitignore(repo));
    findings.push(auditPreCommitHook(repo));

    renderReport(findings, {
      title: '🔍 Repository credential scan',
      subtitle: `Repo: ${repo}${bin ? `    gitleaks: ${bin}` : '    gitleaks: NOT FOUND'}`
        + (tuning.notes.length ? `\n   Suppression in effect: ${tuning.notes.join(', ')} — "0 findings" is relative to these.` : ''),
      groups: [
        ['detection', 'Credential detection (gitleaks)'],
        ['hygiene', 'Repository hygiene — what stops the next one'],
      ],
      json: Boolean(opts.json),
      jsonContext: { repo, gitleaks: bin, suppression: tuning.notes },
    });

    applyFailOn(findings, failOn, Boolean(opts.json));
  },
};
