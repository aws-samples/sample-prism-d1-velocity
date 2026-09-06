/**
 * Shared result model and reporter for the audit commands
 * (`scan-account`, `bedrock-protection`, `scan-repo`).
 *
 * This lives under utils/ rather than alongside the commands because
 * `commands/<category>/*.js` is the command auto-discovery path -- every file in
 * a category directory is registered as a subcommand, so a shared module placed
 * there would appear in `--help` as a bogus command.
 */

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

/**
 * INDETERMINATE is a first-class outcome, not an error case.
 *
 * A check that could not run has told you nothing, and folding it into the pass
 * count is how an audit ends up certifying an account or repo it never
 * examined. Cost Explorer being switched off, a missing IAM permission, or an
 * absent gitleaks binary all produce INDETERMINATE -- never PASS.
 */
export type Status = 'PASS' | 'FAIL' | 'INDETERMINATE';

export interface Finding {
  id: string;
  /** Report grouping key; each command supplies its own headings. */
  category: string;
  title: string;
  status: Status;
  severity: Severity;
  detail: string;
  remediation?: string;
}

export const SEVERITY_ORDER: Severity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const ICON: Record<Status, string> = { PASS: '✅', FAIL: '❌', INDETERMINATE: '❓' };

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

export interface ReportOptions {
  title: string;
  /** Rendered under the title, e.g. "Account: 1234    Region: us-west-2". */
  subtitle: string;
  /** Ordered [categoryKey, heading] pairs. Categories not listed are omitted. */
  groups: Array<[string, string]>;
  json: boolean;
  /** Extra fields merged into the JSON envelope alongside `findings`. */
  jsonContext?: Record<string, unknown>;
}

export function renderReport(findings: Finding[], opts: ReportOptions): void {
  if (opts.json) {
    console.log(JSON.stringify({
      ...(opts.jsonContext ?? {}),
      generated_at: new Date().toISOString(),
      findings,
    }, null, 2));
    return;
  }

  console.log(`\n${opts.title}`);
  if (opts.subtitle) console.log(`   ${opts.subtitle}`);
  console.log(`   Audit only — this command makes no changes.\n`);

  for (const [key, heading] of opts.groups) {
    const rows = findings.filter((f) => f.category === key);
    if (!rows.length) continue;
    console.log(`── ${heading} ──\n`);
    rows.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    for (const f of rows) {
      console.log(`  ${ICON[f.status]} [${f.severity}] ${f.title}`);
      console.log(`     ${f.detail}`);
      if (f.status !== 'PASS' && f.remediation) console.log(`     → ${f.remediation}`);
      console.log('');
    }
  }

  const fail = findings.filter((f) => f.status === 'FAIL');
  const indet = findings.filter((f) => f.status === 'INDETERMINATE');
  const bySev = (s: Severity) => fail.filter((f) => f.severity === s).length;

  console.log('── Summary ──\n');
  console.log(`  ${findings.length} checks: ${findings.length - fail.length - indet.length} pass, ${fail.length} fail, ${indet.length} indeterminate`);
  console.log(`  Findings by severity: CRITICAL ${bySev('CRITICAL')}, HIGH ${bySev('HIGH')}, MEDIUM ${bySev('MEDIUM')}, LOW ${bySev('LOW')}\n`);

  if (indet.length) {
    console.log(`  ❓ ${indet.length} check(s) could not run and are NOT passes: ${indet.map((f) => f.id).join(', ')}`);
    console.log(`     Treat the result as a floor, not a clean bill of health.\n`);
  }
}

/** Parse and validate a --fail-on value. Returns null for "none". */
export function parseFailOn(value: string | undefined): Severity | null {
  const v = (value ?? 'none').toUpperCase();
  if (v === 'NONE') return null;
  if (!SEVERITY_ORDER.includes(v as Severity)) {
    throw new Error(`--fail-on must be one of CRITICAL, HIGH, MEDIUM, LOW, none (got "${value}")`);
  }
  return v as Severity;
}

/**
 * Apply --fail-on to the findings, setting process.exitCode when breached.
 * Only FAIL counts -- an INDETERMINATE check has not established a violation,
 * and exiting non-zero on it would make a missing permission indistinguishable
 * from a real finding.
 */
export function applyFailOn(findings: Finding[], failOn: Severity | null, quiet: boolean): void {
  if (!failOn) return;
  const threshold = severityRank(failOn);
  const breaching = findings.filter((f) => f.status === 'FAIL' && severityRank(f.severity) >= threshold);
  if (!breaching.length) return;
  if (!quiet) {
    console.error(`❌ ${breaching.length} finding(s) at or above ${failOn}: ${breaching.map((f) => f.id).join(', ')}\n`);
  }
  process.exitCode = 1;
}

export const FAIL_ON_OPTION = {
  flags: '--fail-on <severity>',
  description: 'Exit non-zero if any finding is at or above this severity (CRITICAL|HIGH|MEDIUM|LOW|none)',
  default: 'none',
};

export const JSON_OPTION = {
  flags: '--json',
  description: 'Emit machine-readable JSON instead of the report',
};
