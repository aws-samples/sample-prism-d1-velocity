/**
 * gitleaks: shared starter config, report parsing, and the pre-commit scan.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { GITLEAKS_BASELINE_PATH, GITLEAKS_CONFIG_PATH } from './config.js';
import { makeResult, REASON_GITLEAKS_MISSING, writeResult, type Finding, type PrismResult } from './results.js';
import { run } from '../utils/exec.js';
import { toolVersion } from './reviewers/index.js';

/**
 * Starter gitleaks config, written only when the repo has none.
 *
 * The secret-scan step in the workflow runs with or without this file --
 * gitleaks ships usable defaults. What the defaults do not know is which
 * credential-shaped strings in THIS repo are deliberate, so the first PR that
 * touches a test fixture fails the gate on a fake key. A team that hits that
 * with no obvious place to record the exception tends to delete the gate rather
 * than tune it, so the tuning surface ships up front and is documented inline.
 *
 * `useDefault = true` is what keeps this additive: without it, declaring a
 * config REPLACES the entire default ruleset and the gate silently stops
 * detecting anything it does not name explicitly.
 */
export const GITLEAKS_STARTER_CONFIG = `# gitleaks configuration for the PRISM eval gate.
#
# The gate scans only the commits a PR introduces, so anything flagged here is
# something this PR added. Two ways to handle a false positive:
#
#   1. Allowlist the path or pattern below (preferred -- reviewable, and it
#      keeps working as the file changes).
#   2. Add an inline "gitleaks:allow" comment on the offending line.
#
# A real exposure is NOT a false positive: rotate the credential first, because
# deleting it from the branch does not un-expose what was already pushed.

[extend]
# Keep gitleaks' built-in ruleset. Removing this line replaces the defaults
# entirely rather than adding to them, which turns the gate into a no-op for
# every credential type not restated in this file.
useDefault = true

[[allowlists]]
description = "Test fixtures and documented examples"
paths = [
  '''(^|/)tests?/''',
  '''(^|/)__fixtures__/''',
  '''(^|/)__tests__/''',
  '''\\.example($|\\.)''',
]
`;

/**
 * One-line, platform-specific gitleaks install hint. Never a curl-piped-to-shell.
 * Single source for the installer, the pre-commit warning and the dashboard.
 */
export function gitleaksInstallHint(platform: NodeJS.Platform = process.platform): string {
  const release = 'a release binary from https://github.com/gitleaks/gitleaks/releases';
  if (platform === 'darwin') return `brew install gitleaks (or ${release})`;
  if (platform === 'win32') return `scoop install gitleaks (or ${release})`;
  return `${release} on your PATH, or: go install github.com/zricethezav/gitleaks/v8@latest`;
}

/** Writes the starter config unless the repo already has one. Returns true when written. */
export function installGitleaksConfig(gitRoot: string): boolean {
  const dest = resolve(gitRoot, GITLEAKS_CONFIG_PATH);
  if (existsSync(dest)) return false;
  writeFileSync(dest, GITLEAKS_STARTER_CONFIG);
  return true;
}

/**
 * Converts a gitleaks JSON report to schema findings.
 *
 * Only location and rule fields are projected. `Secret` and `Match` are never
 * read, so a result file cannot carry the credential even if --redact was lost.
 */
export function parseGitleaksReport(json: string): Finding[] {
  const arr = JSON.parse(json);
  if (!Array.isArray(arr)) throw new Error('gitleaks report is not a JSON array');
  return arr.map((l: any) => ({
    severity: 'high' as const,
    category: 'security' as const,
    rule: String(l?.RuleID || 'gitleaks'),
    file: String(l?.File || ''),
    line: Number.isFinite(l?.StartLine) && l.StartLine > 0 ? l.StartLine : null,
    message: `${String(l?.Description || 'Secret detected').slice(0, 300)} (value redacted)`,
  }));
}

export interface PreCommitOutcome {
  /** Process exit code for the hook: 1 blocks the commit. */
  exitCode: number;
  result: PrismResult;
  resultPath: string | null;
}

function currentBranch(): string | null {
  const r = run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.ok && r.stdout ? r.stdout : null;
}

/**
 * `gitleaks protect --staged` against the repo config and baseline.
 *
 * Blocks (exit 1) on a finding and when gitleaks runs but cannot produce a
 * verdict (bad config, unreadable report): a broken secret scan should be
 * fixed, not silently passed. A MISSING gitleaks does not block -- it warns and
 * records a `skipped` result with reason `gitleaks-missing`; CI's gitleaks
 * step remains the backstop.
 */
export function runPreCommit(repoRoot: string, gitleaksBin = 'gitleaks'): PreCommitOutcome {
  const started = new Date().toISOString();
  const treeR = run('git', ['write-tree']);
  const tree = treeR.ok ? treeR.stdout : null;
  const branch = currentBranch();
  const base = { kind: 'secrets' as const, hook: 'pre-commit' as const, tool: 'gitleaks', tree, branch, started_at: started };

  const version = toolVersion(gitleaksBin);
  if (!version) {
    // Allowed, not blocked (decided): recorded as skipped so the dashboard can
    // count commits that were never secret-scanned.
    const result = makeResult({ ...base, status: 'skipped', finished_at: new Date().toISOString(), reason: REASON_GITLEAKS_MISSING });
    return { exitCode: 0, result, resultPath: safeWrite(repoRoot, result) };
  }

  const dir = mkdtempSync(join(tmpdir(), 'prism-gitleaks-'));
  const report = join(dir, 'report.json');
  try {
    const args = ['protect', '--staged', '--redact', '--no-banner', '--exit-code=1',
      '--report-format=json', `--report-path=${report}`];
    if (existsSync(resolve(repoRoot, GITLEAKS_CONFIG_PATH))) args.push(`--config=${GITLEAKS_CONFIG_PATH}`);
    if (existsSync(resolve(repoRoot, GITLEAKS_BASELINE_PATH))) args.push(`--baseline-path=${GITLEAKS_BASELINE_PATH}`);
    const r = spawnSync(gitleaksBin, args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });

    let findings: Finding[] | null = null;
    try { findings = parseGitleaksReport(readFileSync(report, 'utf8')); } catch { findings = null; }

    if (r.status === 0 && (findings === null || findings.length === 0)) {
      const result = makeResult({ ...base, tool_version: version, status: 'ok', finished_at: new Date().toISOString() });
      return { exitCode: 0, result, resultPath: safeWrite(repoRoot, result) };
    }
    if (findings && findings.length > 0) {
      const result = makeResult({ ...base, tool_version: version, status: 'findings', findings, finished_at: new Date().toISOString(), summary: `${findings.length} secret(s) in staged changes` });
      return { exitCode: 1, result, resultPath: safeWrite(repoRoot, result) };
    }
    const why = (r.error?.message || r.stderr || '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
    const result = makeResult({ ...base, tool_version: version, status: 'error', finished_at: new Date().toISOString(), reason: `gitleaks exited ${r.status} without a readable report: ${why}` });
    return { exitCode: 1, result, resultPath: safeWrite(repoRoot, result) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A result that cannot be written must never change the hook's verdict. */
export function safeWrite(repoRoot: string, r: PrismResult): string | null {
  try { return writeResult(repoRoot, r); } catch { return null; }
}

/** `gitleaks dir` arrived in 8.19; older versions count as missing for the working-tree scan. */
export const GITLEAKS_MIN_DIR_VERSION: [number, number] = [8, 19];

/** "v8.28.0" / "gitleaks version 8.28.0" -> [8, 28]; null when there is no version. */
export function parseGitleaksVersion(v: string | null): [number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.\d+)?/.exec(v || '');
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export interface FileToScan {
  /** Repo-relative path, as git reports it. */
  path: string;
  content: Buffer;
}

export interface FileScan {
  /** missing: no usable gitleaks; error: it ran but gave no verdict. */
  status: 'ok' | 'findings' | 'missing' | 'error';
  findings: Finding[];
  version: string | null;
  reason: string | null;
  /** Paths left out of the scan because they are not safe relative paths. */
  skipped: string[];
}

/** A repo-relative path that cannot leave the scan dir: not absolute, no `..` segment, no NUL. */
export function isSafeRelPath(p: string): boolean {
  return !!p && !p.startsWith('/') && !p.includes('\0') && !p.split('/').includes('..');
}

/** Default cap on one `gitleaks dir` run. */
export const GITLEAKS_SCAN_TIMEOUT_MS = 120_000;

/** Scanner config contents to use instead of the working tree's; null means "absent". */
export interface ScannerConfigOverride {
  config?: Buffer | null;
  ignore?: Buffer | null;
  baseline?: Buffer | null;
}

export interface ScanOptions {
  timeoutMs?: number;
  /**
   * Use these versions of `.gitleaks.toml`, `.gitleaksignore` and the baseline
   * (the base branch's) instead of the working tree's, so a change under review
   * cannot widen its own allowlist.
   */
  override?: ScannerConfigOverride;
}

/**
 * `gitleaks dir` over the given file contents, with the repo's own
 * `.gitleaks.toml`, `.gitleaksignore` and baseline (or `opts.override`). The
 * contents are copied to a private temp dir (mode 0700, removed afterwards)
 * and scanned from there, so report paths are repo-relative and the repo's
 * allowlist paths still match. `--redact`, and only location and rule fields
 * are read (parseGitleaksReport). A path that is not a safe relative path is
 * not scanned and is listed in `skipped`.
 */
export function scanFiles(repoRoot: string, files: FileToScan[], gitleaksBin = 'gitleaks', opts: ScanOptions = {}): FileScan {
  const version = toolVersion(gitleaksBin, ['version']);
  const parsed = parseGitleaksVersion(version);
  if (!parsed) return { status: 'missing', findings: [], version: null, reason: 'gitleaks is not installed', skipped: [] };
  const [maj, min] = parsed;
  if (maj < GITLEAKS_MIN_DIR_VERSION[0] || (maj === GITLEAKS_MIN_DIR_VERSION[0] && min < GITLEAKS_MIN_DIR_VERSION[1])) {
    return { status: 'missing', findings: [], version, reason: `gitleaks ${version} has no dir command (needs ${GITLEAKS_MIN_DIR_VERSION.join('.')} or later)`, skipped: [] };
  }
  const skipped = files.filter((f) => !isSafeRelPath(f.path)).map((f) => f.path);
  const safe = files.filter((f) => isSafeRelPath(f.path));
  if (!safe.length) return { status: 'ok', findings: [], version, reason: null, skipped };

  const dir = mkdtempSync(join(tmpdir(), 'prism-harness-gl-'));
  try {
    const src = join(dir, 'src');
    const cfgDir = join(dir, 'cfg');
    const empty = join(dir, 'empty');
    for (const d of [src, cfgDir, empty]) mkdirSync(d, { mode: 0o700 });
    for (const f of safe) {
      const dest = join(src, f.path);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, f.content, { mode: 0o600 });
    }
    /** The file gitleaks reads for one config: the override (written to cfgDir), the repo's own file, or none. */
    const pick = (key: keyof ScannerConfigOverride, repoPath: string, name: string): string | null => {
      if (opts.override && key in opts.override) {
        const c = opts.override[key];
        if (!c) return null;
        const p = join(cfgDir, name);
        writeFileSync(p, c, { mode: 0o600 });
        return p;
      }
      const p = resolve(repoRoot, repoPath);
      return existsSync(p) ? p : null;
    };
    const report = join(dir, 'report.json');
    const args = ['dir', '.', '--redact', '--no-banner', '--exit-code=1', '--report-format=json', `--report-path=${report}`];
    const cfg = pick('config', GITLEAKS_CONFIG_PATH, 'gitleaks.toml');
    if (cfg) args.push(`--config=${cfg}`);
    const baseline = pick('baseline', GITLEAKS_BASELINE_PATH, 'baseline.json');
    if (baseline) args.push(`--baseline-path=${baseline}`);
    // Only the repo's own .gitleaksignore (or its override) counts, never one in the scanned copy.
    const ignore = pick('ignore', '.gitleaksignore', '.gitleaksignore');
    args.push(`--gitleaks-ignore-path=${ignore ?? empty}`);
    const r = spawnSync(gitleaksBin, args, { cwd: src, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutMs ?? GITLEAKS_SCAN_TIMEOUT_MS });
    let findings: Finding[] | null = null;
    try { findings = parseGitleaksReport(readFileSync(report, 'utf8')); } catch { findings = null; }
    if (findings) findings = findings.map((f) => ({ ...f, file: f.file.replace(/^\.\//, '') }));
    if (r.status === 0 && findings !== null && findings.length === 0) return { status: 'ok', findings: [], version, reason: null, skipped };
    if (r.status === 1 && findings && findings.length > 0) return { status: 'findings', findings, version, reason: null, skipped };
    const why = (r.error?.message || r.stderr || '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
    return { status: 'error', findings: [], version, reason: `gitleaks exited ${r.status} without a readable report: ${why}`, skipped };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
