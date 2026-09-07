import { aws, AwsTarget, assumeRole, resolveAccount, PROFILE_OPTION } from '../../utils/aws.js';
import { DEFAULT_REGION } from '../../utils/region.js';
import { validateAwsRegion } from '../../utils/validate.js';
import {
  Finding, Severity, severityRank, parseFailOn, applyFailOn,
  FAIL_ON_OPTION, JSON_OPTION,
} from '../../utils/audit.js';
import { auditRoot, auditPasswordPolicy, auditUsers, auditUserPolicies } from '../../utils/audit-iam.js';
import { auditBudgets, auditBudgetAlerting, auditDetection, auditCommitments, auditForensics } from '../../utils/audit-bedrock.js';
import { auditServiceControlPolicies, auditConfigRules } from '../../utils/audit-org.js';

/**
 * Audit an AWS Organization -- or one or more OUs within it -- for LLMjacking
 * exposure.
 *
 * The two halves of the account audit belong at DIFFERENT scopes, and running
 * both per account would be wrong in opposite directions:
 *
 *   - IAM credential hygiene is genuinely per account. Every member account has
 *     its own users, keys and password policy, and a single stale key anywhere
 *     in the org is a way in. These checks run in each account via an assumed
 *     role.
 *
 *   - Bedrock spend guardrails are naturally payer-level. Under consolidated
 *     billing the management account's budgets, Cost Explorer and anomaly
 *     monitors bound the spend of every linked account. Running them per member
 *     account would report "no budget" for every account in an org that is in
 *     fact fully covered by one consolidated budget -- N false FAILs. They
 *     therefore run ONCE, against the management account, and are labelled as
 *     org-wide.
 *
 * A member account can still hold its own budget, so a payer-level FAIL does not
 * strictly prove no ceiling exists anywhere. That limitation is stated in the
 * output rather than papered over.
 *
 * Audit-only. Every call is a read except `sts:AssumeRole`, which mints a
 * temporary session, and `iam:GenerateCredentialReport` in each account.
 */

interface OrgAccount {
  id: string;
  name: string;
  status: string;
  /** OU the account sits directly under, for reporting. */
  parent: string;
}

interface AccountResult {
  account: OrgAccount;
  findings: Finding[];
  /** Set when the account could not be audited at all. */
  unreachable?: string;
}

/**
 * Walk a parent (root or OU) collecting ACTIVE accounts.
 *
 * Always recurses into nested OUs. `list-accounts-for-parent` returns only
 * direct children, so a non-recursive walk of an OU containing sub-OUs would
 * silently report on a fraction of it and look complete -- the dangerous
 * direction for an audit, so recursion is not optional.
 */
function collectAccounts(
  parentId: string,
  parentName: string,
  target: AwsTarget,
  seen: Set<string>,
  out: OrgAccount[],
  errors: string[],
): void {
  const accts = aws(['organizations', 'list-accounts-for-parent', '--parent-id', parentId], target);
  if (!accts.ok) {
    errors.push(`${parentId}: could not list accounts (${accts.errorCode || 'unknown error'})`);
  } else {
    for (const a of accts.json?.Accounts ?? []) {
      if (seen.has(a.Id)) continue;
      seen.add(a.Id);
      out.push({ id: a.Id, name: a.Name ?? '(unnamed)', status: a.Status ?? 'UNKNOWN', parent: parentName });
    }
  }

  const ous = aws(['organizations', 'list-organizational-units-for-parent', '--parent-id', parentId], target);
  if (!ous.ok) {
    errors.push(`${parentId}: could not list child OUs (${ous.errorCode || 'unknown error'})`);
    return;
  }
  for (const ou of ous.json?.OrganizationalUnits ?? []) {
    collectAccounts(ou.Id, `${parentName}/${ou.Name ?? ou.Id}`, target, seen, out, errors);
  }
}

function orgScopeAccounts(
  target: AwsTarget,
  ous: string[],
): { accounts: OrgAccount[]; errors: string[]; scopeLabel: string } {
  const errors: string[] = [];
  const seen = new Set<string>();
  const accounts: OrgAccount[] = [];

  if (ous.length === 0) {
    const roots = aws(['organizations', 'list-roots'], target);
    if (!roots.ok) {
      return { accounts, errors: [`list-roots failed (${roots.errorCode || 'unknown error'})`], scopeLabel: 'org' };
    }
    for (const r of roots.json?.Roots ?? []) {
      collectAccounts(r.Id, r.Name ?? r.Id, target, seen, accounts, errors);
    }
    return { accounts, errors, scopeLabel: 'entire organization' };
  }

  for (const ou of ous) {
    // Resolve the name for readable output; fall back to the id.
    const desc = aws(['organizations', 'describe-organizational-unit', '--organizational-unit-id', ou], target);
    const name = desc.ok ? (desc.json?.OrganizationalUnit?.Name ?? ou) : ou;
    if (!desc.ok) errors.push(`${ou}: could not describe OU (${desc.errorCode || 'unknown error'})`);
    collectAccounts(ou, name, target, seen, accounts, errors);
  }
  return { accounts, errors, scopeLabel: `OU(s) ${ous.join(', ')}` };
}

/** Mark every IAM check for an account we could not get into. */
function unreachableFindings(reason: string): Finding[] {
  return [
    ['root-mfa', 'Root account MFA', 'CRITICAL'],
    ['root-access-keys', 'Root access keys', 'CRITICAL'],
    ['password-policy', 'Account password policy', 'MEDIUM'],
    ['access-key-age', 'Long-lived access keys', 'HIGH'],
    ['console-user-no-mfa', 'Console users without MFA', 'HIGH'],
    ['unused-credentials', 'Unused credentials', 'MEDIUM'],
    ['user-admin-policy', 'AdministratorAccess on IAM users', 'HIGH'],
  ].map(([id, title, severity]) => ({
    id, category: 'iam', title,
    status: 'INDETERMINATE' as const, severity: severity as Severity,
    detail: `Account could not be audited: ${reason}.`,
    remediation: 'Ensure the audit role exists in this account and is assumable from the management account, then re-run.',
  }));
}

export default {
  description: 'Audit an AWS Organization or specific OUs: per-account IAM credential hygiene plus org-wide Bedrock spend guardrails',
  options: [
    { flags: '--ou <ids>', description: 'Comma-separated OU ids to scope to (default: the entire organization, recursing from every root)' },
    { flags: '--role-name <name>', description: 'Role to assume in each member account', default: 'OrganizationAccountAccessRole' },
    { flags: '--region <region>', description: 'Region for Bedrock, CloudWatch and Provisioned Throughput checks', default: DEFAULT_REGION },
    PROFILE_OPTION,
    { flags: '--max-accounts <n>', description: 'Stop after this many accounts (each costs ~10 AWS API calls)', default: '50' },
    { flags: '--session-duration <seconds>', description: 'AssumeRole session length', default: '3600' },
    { flags: '--max-key-age <days>', description: 'Flag active access keys older than this', default: '90' },
    { flags: '--unused-days <days>', description: 'Flag credentials idle longer than this', default: '90' },
    { flags: '--skip-bedrock', description: 'Skip the org-wide Bedrock spend guardrail checks' },
    { flags: '--skip-guardrails', description: 'Skip the SCP and AWS Config organization guardrail checks' },
    JSON_OPTION,
    FAIL_ON_OPTION,
  ],
  async action(opts: {
    ou?: string; roleName?: string; region?: string; profile?: string;
    maxAccounts?: string; sessionDuration?: string;
    maxKeyAge?: string; unusedDays?: string; skipBedrock?: boolean; skipGuardrails?: boolean;
    json?: boolean; failOn?: string;
  }) {
    const region = validateAwsRegion(opts.region || DEFAULT_REGION);
    const failOn = parseFailOn(opts.failOn);
    const roleName = opts.roleName || 'OrganizationAccountAccessRole';
    if (!/^[\w+=,.@-]{1,64}$/.test(roleName)) {
      throw new Error(`--role-name must be a valid IAM role name (got "${roleName}")`);
    }

    const maxAccounts = Number.parseInt(opts.maxAccounts ?? '50', 10);
    const sessionDuration = Number.parseInt(opts.sessionDuration ?? '3600', 10);
    const maxKeyAge = Number.parseInt(opts.maxKeyAge ?? '90', 10);
    const unusedDays = Number.parseInt(opts.unusedDays ?? '90', 10);
    for (const [name, v, min] of [['--max-accounts', maxAccounts, 1], ['--session-duration', sessionDuration, 900], ['--max-key-age', maxKeyAge, 1], ['--unused-days', unusedDays, 1]] as Array<[string, number, number]>) {
      if (!Number.isFinite(v) || v < min) throw new Error(`${name} must be an integer >= ${min}`);
    }

    const ous = (opts.ou ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const ou of ous) {
      if (!/^ou-[0-9a-z]{4,32}-[a-z0-9]{8,32}$/.test(ou)) {
        throw new Error(`"${ou}" is not a valid OU id (expected ou-xxxx-xxxxxxxx)`);
      }
    }

    const mgmt: AwsTarget = { profile: opts.profile };
    const callerAccount = resolveAccount(mgmt);
    if (!callerAccount) { process.exitCode = 2; return; }

    // Confirm we are actually in the management account (or a delegated admin).
    // Running from a member account silently returns only that account, which
    // would look like a one-account org rather than a permissions problem.
    const org = aws(['organizations', 'describe-organization'], mgmt);
    if (!org.ok) {
      console.error(`\n❌ Cannot read the organization (${org.errorCode || 'unknown error'}).`);
      console.error(`   Run this from the management account or a delegated admin, with organizations:Describe*/List* granted.\n`);
      process.exitCode = 2;
      return;
    }
    const orgId: string = org.json?.Organization?.Id ?? 'unknown';
    const payerId: string = org.json?.Organization?.MasterAccountId ?? '';
    if (payerId && payerId !== callerAccount) {
      console.log(`\n⚠️  Running from ${callerAccount}, which is not the management account (${payerId}).`);
      console.log(`   Org-wide Bedrock guardrails are evaluated against the CALLER, so budget findings may not reflect the payer.\n`);
    }

    const { accounts, errors, scopeLabel } = orgScopeAccounts(mgmt, ous);

    // Attachment is judged against the audited scope, not the org at large: an
    // SCP attached to an unrelated OU does not constrain these accounts.
    const scopeTargetIds = ous.length
      ? ous
      : (aws(['organizations', 'list-roots'], mgmt).json?.Roots ?? []).map((r: any) => r.Id);
    const active = accounts.filter((a) => a.status === 'ACTIVE');
    const suspended = accounts.filter((a) => a.status !== 'ACTIVE');
    const selected = active.slice(0, maxAccounts);
    const truncated = active.length - selected.length;

    if (!opts.json) {
      console.log(`\n🏛️  Bedrock protection — organization audit`);
      console.log(`   Org: ${orgId}    Scope: ${scopeLabel}    Region: ${region}`);
      console.log(`   ${active.length} active account(s)${suspended.length ? `, ${suspended.length} non-active skipped` : ''}${truncated > 0 ? `, ${truncated} beyond --max-accounts` : ''}`);
      console.log(`   Audit only — this command makes no changes.\n`);
      for (const e of errors) console.log(`   ⚠️  ${e}`);
      if (errors.length) console.log('');
    }

    // ---- per-account IAM hygiene ----
    const results: AccountResult[] = [];
    for (const acct of selected) {
      let target: AwsTarget;
      if (acct.id === callerAccount) {
        // Cannot assume into ourselves via the org role; use ambient creds.
        target = mgmt;
      } else {
        const assumed = assumeRole(acct.id, roleName, 'prism-bedrock-protection', sessionDuration, mgmt, region);
        if ('error' in assumed) {
          results.push({ account: acct, findings: unreachableFindings(`${roleName} not assumable (${assumed.error})`), unreachable: assumed.error });
          if (!opts.json) console.log(`   ❓ ${acct.id} ${acct.name} — unreachable: ${assumed.error}`);
          continue;
        }
        target = { env: assumed.env };

        // Confirm the session really landed in the intended account before
        // attributing any finding to it. Misattribution is the worst failure
        // available here -- a stale AWS_PROFILE or a mis-set env var would
        // report the caller's own posture under a member account's name, and
        // every number would be wrong in a way no reader could detect. Cheap
        // insurance: one extra GetCallerIdentity per account.
        const landed = aws(['sts', 'get-caller-identity'], target);
        const landedId = landed.ok ? landed.json?.Account : null;
        if (landedId !== acct.id) {
          const why = landed.ok
            ? `session resolved to ${landedId ?? 'unknown'}, not ${acct.id}`
            : `could not confirm identity after assuming (${landed.errorCode || 'unknown error'})`;
          results.push({ account: acct, findings: unreachableFindings(why), unreachable: why });
          if (!opts.json) console.log(`   ❓ ${acct.id} ${acct.name} — ${why}`);
          continue;
        }
      }

      const findings: Finding[] = [
        ...auditRoot(target),
        auditPasswordPolicy(target),
        ...auditUsers(target, maxKeyAge, unusedDays),
        auditUserPolicies(target),
      ];
      results.push({ account: acct, findings });

      if (!opts.json) {
        const f = findings.filter((x) => x.status === 'FAIL');
        const i = findings.filter((x) => x.status === 'INDETERMINATE');
        const pass = findings.length - f.length - i.length;
        const worst = f.length ? f.reduce((a, b) => (severityRank(b.severity) > severityRank(a.severity) ? b : a)).severity : '—';
        // Absence of failures is NOT a pass. An account where every check came
        // back indeterminate established nothing, and a green tick there is the
        // same laundering this audit exists to prevent.
        const icon = f.some((x) => x.severity === 'CRITICAL') ? '❌'
          : f.length ? '⚠️ '
          : pass === 0 ? '❓'
          : i.length ? '⚠️ '
          : '✅';
        console.log(`   ${icon} ${acct.id} ${acct.name.padEnd(24).slice(0, 24)} ${pass}/${findings.length} pass, ${f.length} fail (worst ${worst})${i.length ? `, ${i.length} INDETERMINATE` : ''}`);
      }
    }

    // ---- org-wide Bedrock guardrails, evaluated once at the payer ----
    const orgFindings: Finding[] = [];
    if (!opts.skipBedrock) {
      const budgets = auditBudgets(mgmt, callerAccount);
      orgFindings.push(
        ...budgets.findings,
        auditBudgetAlerting(mgmt, callerAccount, budgets.coveringBudgets),
        ...auditDetection(mgmt, region),
        auditCommitments(mgmt, region),
        auditForensics(mgmt, region),
      );
    }

    if (!opts.skipGuardrails) {
      orgFindings.push(
        ...auditServiceControlPolicies(mgmt, scopeTargetIds),
        ...auditConfigRules(mgmt),
      );
    }

    const allFindings = [...results.flatMap((r) => r.findings), ...orgFindings];

    if (opts.json) {
      console.log(JSON.stringify({
        organization: orgId,
        scope: scopeLabel,
        region,
        caller_account: callerAccount,
        management_account: payerId || null,
        role_name: roleName,
        accounts_active: active.length,
        accounts_audited: selected.length,
        accounts_truncated: truncated,
        enumeration_errors: errors,
        generated_at: new Date().toISOString(),
        per_account: results.map((r) => ({
          account_id: r.account.id,
          account_name: r.account.name,
          ou_path: r.account.parent,
          unreachable: r.unreachable ?? null,
          findings: r.findings,
        })),
        org_wide_findings: orgFindings,
      }, null, 2));
      applyFailOn(allFindings, failOn, true);
      return;
    }

    // ---- org-wide section ----
    const printGroup = (heading: string, note: string[], cats: string[]) => {
      const rows = orgFindings.filter((f) => cats.includes(f.category));
      if (!rows.length) return;
      console.log(`\n── ${heading} ──\n`);
      for (const n of note) console.log(`   ${n}`);
      if (note.length) console.log('');
      for (const f of rows.slice().sort((a, b) => severityRank(b.severity) - severityRank(a.severity))) {
        const icon = f.status === 'PASS' ? '✅' : f.status === 'FAIL' ? '❌' : '❓';
        console.log(`  ${icon} [${f.severity}] ${f.title}`);
        console.log(`     ${f.detail}`);
        if (f.status !== 'PASS' && f.remediation) console.log(`     → ${f.remediation}`);
        console.log('');
      }
    };

    printGroup(`Org-wide Bedrock guardrails (evaluated once at ${callerAccount})`, [
      'Under consolidated billing these bound every linked account, so they are',
      'reported once rather than per account. A member account may still hold its',
      'own budget, so a FAIL here does not prove no ceiling exists anywhere.',
    ], ['budget', 'detection', 'commitment', 'forensics']);

    printGroup('Preventive guardrails — Service Control Policies', [
      'SCPs refuse the action rather than reporting it, and bind even a compromised',
      'admin. Detected structurally: presence and attachment, NOT enforcement.',
    ], ['preventive']);

    printGroup('Detective guardrails — AWS Config organization rules', [
      'This audit is a point-in-time sample. Config rules evaluate on every',
      'configuration change, which is what catches drift between runs.',
    ], ['detective']);

    // ---- rollup ----
    const fail = allFindings.filter((f) => f.status === 'FAIL');
    const indet = allFindings.filter((f) => f.status === 'INDETERMINATE');
    const bySev = (s: Severity) => fail.filter((f) => f.severity === s).length;
    const unreachableAccounts = results.filter((r) => r.unreachable);

    console.log('── Organization rollup ──\n');
    console.log(`  ${selected.length} account(s) audited, ${allFindings.length} checks: ${allFindings.length - fail.length - indet.length} pass, ${fail.length} fail, ${indet.length} indeterminate`);
    console.log(`  Findings by severity: CRITICAL ${bySev('CRITICAL')}, HIGH ${bySev('HIGH')}, MEDIUM ${bySev('MEDIUM')}, LOW ${bySev('LOW')}\n`);

    // Rank accounts so the worst is actionable first rather than buried.
    const ranked = results
      .map((r) => ({
        r,
        crit: r.findings.filter((f) => f.status === 'FAIL' && f.severity === 'CRITICAL').length,
        high: r.findings.filter((f) => f.status === 'FAIL' && f.severity === 'HIGH').length,
      }))
      .filter((x) => x.crit + x.high > 0)
      .sort((a, b) => b.crit - a.crit || b.high - a.high);

    if (ranked.length) {
      console.log(`  Accounts with CRITICAL or HIGH findings, worst first:`);
      for (const x of ranked) {
        console.log(`    ${x.r.account.id} ${x.r.account.name}  [${x.r.account.parent}]  CRITICAL ${x.crit}, HIGH ${x.high}`);
      }
      console.log('');
    }

    const establishedNothing = results.filter((r) => !r.unreachable
      && r.findings.every((f) => f.status === 'INDETERMINATE'));
    if (establishedNothing.length) {
      console.log(`  ❓ ${establishedNothing.length} reachable account(s) produced NO usable checks (every result indeterminate):`);
      for (const r of establishedNothing) console.log(`    ${r.account.id} ${r.account.name} — likely missing IAM read permissions on the assumed role`);
      console.log('');
    }

    if (unreachableAccounts.length) {
      console.log(`  ❓ ${unreachableAccounts.length} account(s) could not be audited and are NOT passes:`);
      for (const r of unreachableAccounts) console.log(`    ${r.account.id} ${r.account.name} — ${r.unreachable}`);
      console.log(`     Their IAM posture is unknown. Org coverage is ${selected.length - unreachableAccounts.length}/${selected.length}.\n`);
    }
    if (truncated > 0) {
      console.log(`  ⚠️  ${truncated} active account(s) were not audited because of --max-accounts ${maxAccounts}.`);
      console.log(`     Raise it to cover the whole scope; the result is a floor until you do.\n`);
    }

    applyFailOn(allFindings, failOn, false);
  },
};
