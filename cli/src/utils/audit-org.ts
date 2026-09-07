import { aws, AwsTarget } from './aws.js';
import { Finding } from './audit.js';

/**
 * Organization-level preventive and detective guardrails.
 *
 * The account checks elsewhere in this group are all *descriptive*: they read
 * the current state and report it. These two families are different in kind, and
 * ARCC frames the pairing directly (SAX-08 Outcome 2, preventative/detective
 * control symmetry):
 *
 *   - **SCPs are preventive.** They stop the action before it happens, and they
 *     bind even a compromised admin, which is the one thing IAM hygiene cannot
 *     promise. For LLMjacking specifically, a region-scoped deny is the single
 *     highest-leverage control available: a stolen key can call `InvokeModel` in
 *     any enabled region, so restricting Bedrock to the regions you actually use
 *     shrinks the reachable surface by an order of magnitude at no running cost.
 *
 *   - **Config rules are detective and continuous.** `scan-account` and
 *     `scan-org` are point-in-time samples; a rule evaluates on every
 *     configuration change. Without them, a key created the day after an audit
 *     goes unnoticed until the next one.
 *
 * ## What these checks can and cannot establish
 *
 * They detect that a policy **exists and is attached**. They do NOT prove
 * enforcement. SCP evaluation involves inheritance from every ancestor, implicit
 * deny, `NotAction`, condition keys and principal-tag exemptions, so a
 * structural read can be satisfied by a policy that exempts the very principals
 * that matter. ARCC names "insufficient testing leading to unexpected blocking"
 * and supplies a live test-script pattern for exactly this reason. Every finding
 * here therefore says "appears to" and points at live verification -- reporting
 * an SCP as proof of enforcement would be a worse failure than reporting none.
 */

interface Statement {
  Effect?: string;
  Action?: string | string[];
  NotAction?: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

function asArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * IAM action glob matching. `bedrock:*` covers
 * `bedrock:CreateProvisionedModelThroughput`; a bare `*` covers everything.
 * Without this, a broad deny would read as no coverage at all.
 */
function actionMatches(pattern: string, action: string): boolean {
  if (pattern === '*') return true;
  const rx = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return rx.test(action);
}

function parseStatements(content: string): Statement[] {
  try {
    const doc = JSON.parse(content);
    const st = doc?.Statement;
    if (!st) return [];
    return Array.isArray(st) ? st : [st];
  } catch {
    return [];
  }
}

/** Names of policies containing a Deny that covers any of `actions`. */
export function policiesDenying(
  policies: Array<{ name: string; statements: Statement[] }>,
  actions: string[],
): string[] {
  return policies.filter((p) => p.statements.some((s) => {
    if (s.Effect !== 'Deny') return false;
    const pats = asArray(s.Action);
    return actions.some((a) => pats.some((pat) => actionMatches(pat, a)));
  })).map((p) => p.name);
}

/**
 * Names of policies whose Deny is region-conditioned in a way that would
 * constrain Bedrock.
 *
 * The common shape is a broad `Deny *` with
 * `StringNotEquals: { "aws:RequestedRegion": [...] }` -- everything outside the
 * listed regions is refused. A Bedrock-specific variant denies `bedrock:*` under
 * the same condition. Both count; a region condition that cannot reach Bedrock
 * (e.g. `Action: s3:*`) does not.
 */
export function policiesRestrictingBedrockRegion(
  policies: Array<{ name: string; statements: Statement[] }>,
): string[] {
  return policies.filter((p) => p.statements.some((s) => {
    if (s.Effect !== 'Deny') return false;
    const cond = s.Condition ?? {};
    const mentionsRegion = Object.values(cond).some((kv) =>
      Object.keys(kv).some((k) => k.toLowerCase() === 'aws:requestedregion'));
    if (!mentionsRegion) return false;
    const pats = asArray(s.Action);
    // Must be able to reach a Bedrock call to be relevant here.
    return pats.some((pat) => actionMatches(pat, 'bedrock:InvokeModel'));
  })).map((p) => p.name);
}

const ENFORCEMENT_CAVEAT =
  'Detected structurally, not proven: inheritance, NotAction and principal-tag exemptions can neutralise a policy that reads correctly. Confirm with a live call from a representative role.';

/**
 * Expand each audited target to itself plus every ancestor up to the root.
 *
 * SCPs INHERIT downward: a policy attached to the root constrains every account
 * in every OU beneath it. Judging attachment against the audited OU alone
 * therefore ignores the most common place guardrails actually live, and would
 * report a root-attached Bedrock region deny as absent -- a false FAIL on the
 * highest-leverage control in this file. Verified against a live org where two
 * of four customer SCPs sat at the root and were invisible to the OU-only view.
 */
export function expandToAncestors(
  target: AwsTarget | undefined,
  scopeTargetIds: string[],
): { ids: string[]; errors: string[] } {
  const ids = new Set<string>(scopeTargetIds);
  const errors: string[] = [];

  for (const start of scopeTargetIds) {
    let child = start;
    // Bounded rather than while(true): OU nesting is capped at 5 levels, and a
    // cycle here would otherwise hang the audit.
    for (let depth = 0; depth < 10; depth++) {
      if (/^r-/.test(child)) break;
      const parents = aws(['organizations', 'list-parents', '--child-id', child], target);
      if (!parents.ok) {
        errors.push(`${child}: could not resolve parents (${parents.errorCode || 'unknown error'}), so inherited SCPs may be missed`);
        break;
      }
      const p = (parents.json?.Parents ?? [])[0];
      if (!p?.Id) break;
      ids.add(p.Id);
      child = p.Id;
    }
  }
  return { ids: [...ids], errors };
}

/**
 * Managed Config rule identifiers that continuously assert what the IAM checks
 * in this audit only sample. Keyed by the check they correspond to, so the
 * output can name the gap in terms the reader already recognises.
 */
const IAM_CONFIG_RULES: Array<[string, string]> = [
  ['ACCESS_KEYS_ROTATED', 'access-key-age'],
  ['IAM_USER_UNUSED_CREDENTIALS_CHECK', 'unused-credentials'],
  ['ROOT_ACCOUNT_MFA_ENABLED', 'root-mfa'],
  ['MFA_ENABLED_FOR_IAM_CONSOLE_ACCESS', 'console-user-no-mfa'],
  ['IAM_PASSWORD_POLICY', 'password-policy'],
  ['IAM_USER_NO_POLICIES_CHECK', 'user-admin-policy'],
];

/**
 * @param scopeTargetIds Root and OU ids in scope, so attachment is judged
 *        against what is actually being audited rather than the org at large.
 */
export function auditServiceControlPolicies(
  target: AwsTarget | undefined,
  scopeTargetIds: string[],
): Finding[] {
  const out: Finding[] = [];

  // SCPs must be enabled on the root before any can take effect. This gates the
  // rest, the same way Cost Explorer gates the anomaly check.
  const roots = aws(['organizations', 'list-roots'], target);
  if (!roots.ok) {
    return [{
      id: 'scp-enabled', category: 'preventive', title: 'Service Control Policies enabled',
      status: 'INDETERMINATE', severity: 'HIGH',
      detail: `Could not read organization roots (${roots.errorCode || 'unknown error'}).`,
      remediation: 'Grant organizations:ListRoots and re-run.',
    }];
  }
  const rootList: any[] = roots.json?.Roots ?? [];
  const scpEnabled = rootList.some((r) => (r.PolicyTypes ?? [])
    .some((p: any) => p.Type === 'SERVICE_CONTROL_POLICY' && p.Status === 'ENABLED'));

  out.push({
    id: 'scp-enabled', category: 'preventive', title: 'Service Control Policies enabled',
    status: scpEnabled ? 'PASS' : 'FAIL', severity: 'HIGH',
    detail: scpEnabled
      ? 'SERVICE_CONTROL_POLICY is enabled on the organization root.'
      : 'SERVICE_CONTROL_POLICY is not enabled, so no preventive guardrail can exist at any level. Every control in this organization is therefore detective — it can tell you a stolen key was used, never refuse the call.',
    remediation: scpEnabled ? undefined : 'Enable the SERVICE_CONTROL_POLICY type on the root (Organizations → Policies). Enabling it alone changes nothing: FullAWSAccess stays attached and no action is newly denied.',
  });

  if (!scpEnabled) {
    for (const [id, title] of [
      ['scp-attached', 'SCPs attached to the audited scope'],
      ['scp-bedrock-region', 'SCP restricting which regions Bedrock can be used in'],
      ['scp-bedrock-provisioned-throughput', 'SCP denying Provisioned Throughput creation'],
      ['scp-detection-tamper', 'SCP preventing tampering with detection'],
    ]) {
      out.push({
        id, category: 'preventive', title,
        status: 'INDETERMINATE', severity: 'MEDIUM',
        detail: 'Cannot be evaluated while Service Control Policies are disabled.',
      });
    }
    return out;
  }

  // Include every ancestor: SCPs attached above the audited OU still apply to it.
  const { ids: effectiveTargets, errors: ancestorErrors } = expandToAncestors(target, scopeTargetIds);

  const list = aws(['organizations', 'list-policies', '--filter', 'SERVICE_CONTROL_POLICY'], target);
  if (!list.ok) {
    for (const [id, title] of [
      ['scp-attached', 'SCPs attached to the audited scope'],
      ['scp-bedrock-region', 'SCP restricting which regions Bedrock can be used in'],
      ['scp-bedrock-provisioned-throughput', 'SCP denying Provisioned Throughput creation'],
      ['scp-detection-tamper', 'SCP preventing tampering with detection'],
    ]) {
      out.push({
        id, category: 'preventive', title,
        status: 'INDETERMINATE', severity: 'MEDIUM',
        detail: `Could not list SCPs (${list.errorCode || 'unknown error'}).`,
        remediation: 'Grant organizations:ListPolicies, DescribePolicy and ListTargetsForPolicy, then re-run.',
      });
    }
    return out;
  }

  // FullAWSAccess is attached everywhere by default and allows everything, so it
  // is never evidence of a guardrail. Excluding it keeps the attachment check
  // from passing on AWS's own default.
  const customer: any[] = (list.json?.Policies ?? []).filter((p: any) => p.AwsManaged !== true);

  const policies: Array<{ name: string; id: string; statements: Statement[]; targets: string[] }> = [];
  let unreadable = 0;
  for (const p of customer) {
    const desc = aws(['organizations', 'describe-policy', '--policy-id', p.Id], target);
    const targets = aws(['organizations', 'list-targets-for-policy', '--policy-id', p.Id], target);
    if (!desc.ok || !targets.ok) { unreadable++; continue; }
    policies.push({
      name: p.Name ?? p.Id,
      id: p.Id,
      statements: parseStatements(desc.json?.Policy?.Content ?? ''),
      targets: (targets.json?.Targets ?? []).map((t: any) => t.TargetId),
    });
  }

  // An SCP attached nowhere in the audited scope constrains nothing there --
  // the same shape as a budget with no subscriber, and just as easy to mistake
  // for protection.
  const inScope = policies.filter((p) => p.targets.some((t) => effectiveTargets.includes(t)));
  out.push({
    id: 'scp-attached', category: 'preventive', title: 'SCPs attached to the audited scope',
    status: inScope.length ? 'PASS' : 'FAIL', severity: 'HIGH',
    detail: inScope.length
      ? `${inScope.length} customer-managed SCP(s) apply to the audited scope (including inheritance from ${effectiveTargets.length - scopeTargetIds.length} ancestor target(s)): ${inScope.map((p) => p.name).join(', ')}.`
      : customer.length === 0
        ? 'No customer-managed SCPs exist. Only AWS\'s default FullAWSAccess is attached, which allows everything.'
        : `${customer.length} customer-managed SCP(s) exist but none is attached to the audited target(s) or any ancestor, so none constrains the accounts in scope.`,
    remediation: inScope.length ? undefined : 'Attach the relevant SCP to the root or the OUs being audited. An unattached policy is inert.',
  });

  // Region restriction: the highest-leverage preventive control for LLMjacking.
  const regionScoped = policiesRestrictingBedrockRegion(inScope);
  out.push({
    id: 'scp-bedrock-region', category: 'preventive', title: 'SCP restricting which regions Bedrock can be used in',
    status: regionScoped.length ? 'PASS' : 'FAIL', severity: 'MEDIUM',
    detail: regionScoped.length
      ? `${regionScoped.join(', ')} denies Bedrock-reaching actions outside an allowed region set. ${ENFORCEMENT_CAVEAT}`
      : 'No in-scope SCP constrains Bedrock by region. A stolen credential can call InvokeModel in every enabled region, so spend is not bounded by the regions you actually operate in — and per-region CloudWatch alarms and Provisioned Throughput checks all miss activity elsewhere.',
    remediation: regionScoped.length ? undefined : 'Add a Deny on `*` (or `bedrock:*`) with StringNotEquals on aws:RequestedRegion listing only the regions you use. This is the cheapest large reduction in blast radius available, and it costs nothing to run.',
  });

  const ptDenied = policiesDenying(inScope, ['bedrock:CreateProvisionedModelThroughput']);
  out.push({
    id: 'scp-bedrock-provisioned-throughput', category: 'preventive', title: 'SCP denying Provisioned Throughput creation',
    status: ptDenied.length ? 'PASS' : 'FAIL', severity: 'MEDIUM',
    detail: ptDenied.length
      ? `${ptDenied.join(', ')} denies bedrock:CreateProvisionedModelThroughput. ${ENFORCEMENT_CAVEAT}`
      : 'No in-scope SCP denies bedrock:CreateProvisionedModelThroughput. It is the largest single commitment available in Bedrock — billed monthly whether used or not — and one API call creates it.',
    remediation: ptDenied.length ? undefined : 'Deny bedrock:CreateProvisionedModelThroughput org-wide and exempt only the accounts that genuinely need it. Most organizations need it nowhere.',
  });

  // Protecting the detection layer the rest of this audit depends on.
  const tamperActions = ['cloudtrail:StopLogging', 'config:DeleteConfigRule', 'guardduty:DeleteDetector'];
  const tamperDenied = policiesDenying(inScope, tamperActions);
  out.push({
    id: 'scp-detection-tamper', category: 'preventive', title: 'SCP preventing tampering with detection',
    status: tamperDenied.length ? 'PASS' : 'FAIL', severity: 'HIGH',
    detail: tamperDenied.length
      ? `${tamperDenied.join(', ')} denies at least one of CloudTrail/Config/GuardDuty teardown. ${ENFORCEMENT_CAVEAT}`
      : 'No in-scope SCP prevents stopping CloudTrail, deleting Config rules or disabling GuardDuty. An attacker who reaches an admin credential can therefore remove the evidence trail before running up spend, which defeats every detective control this audit recommends.',
    remediation: tamperDenied.length ? undefined : 'Deny cloudtrail:StopLogging/DeleteTrail, config:Delete*, guardduty:DeleteDetector org-wide. Nothing legitimate needs them from a member account.',
  });

  for (const e of ancestorErrors) {
    out.push({
      id: 'scp-inheritance-resolved', category: 'preventive', title: 'SCP inheritance fully resolved',
      status: 'INDETERMINATE', severity: 'MEDIUM',
      detail: e,
      remediation: 'Grant organizations:ListParents and re-run; without it an inherited guardrail can read as absent.',
    });
  }

  if (unreadable > 0) {
    out.push({
      id: 'scp-readable', category: 'preventive', title: 'All SCPs readable',
      status: 'INDETERMINATE', severity: 'MEDIUM',
      detail: `${unreadable} of ${customer.length} customer-managed SCP(s) could not be read, so the SCP findings above are based on a partial view.`,
      remediation: 'Grant organizations:DescribePolicy and ListTargetsForPolicy, then re-run.',
    });
  }

  return out;
}

export function auditConfigRules(target: AwsTarget | undefined): Finding[] {
  const rules = aws(['configservice', 'describe-organization-config-rules'], target);

  if (!rules.ok) {
    // Config not being enabled for the org is a legitimate state, and distinct
    // from a permissions problem. Both are reported, neither as a pass.
    const notEnabled = /OrganizationAccessDenied|NoAvailableOrganization|AccessDenied/i.test(rules.errorCode || rules.raw);
    return [{
      id: 'config-org-rules', category: 'detective', title: 'Organization Config rules deployed',
      status: 'INDETERMINATE', severity: 'MEDIUM',
      detail: notEnabled
        ? `Could not read organization Config rules (${rules.errorCode || 'access denied'}). Either AWS Config is not enabled for the organization, or trusted access / delegated administration is not configured.`
        : `Could not read organization Config rules (${rules.errorCode || 'unknown error'}).`,
      remediation: 'Enable trusted access for config.amazonaws.com in Organizations, or grant config:DescribeOrganizationConfigRules, then re-run.',
    }, {
      id: 'config-iam-coverage', category: 'detective', title: 'Continuous coverage of the IAM hygiene checks',
      status: 'INDETERMINATE', severity: 'MEDIUM',
      detail: 'Cannot be evaluated without the organization Config rule list.',
    }];
  }

  const list: any[] = rules.json?.OrganizationConfigRules ?? [];
  const out: Finding[] = [];

  out.push({
    id: 'config-org-rules', category: 'detective', title: 'Organization Config rules deployed',
    status: list.length ? 'PASS' : 'FAIL', severity: 'MEDIUM',
    detail: list.length
      ? `${list.length} organization Config rule(s) deployed.`
      : 'No organization Config rules. This audit is a point-in-time sample; without continuous rules, a key created the day after a run goes unnoticed until the next one.',
    remediation: list.length ? undefined : 'Deploy an Organization Conformance Pack with the IAM managed rules. They evaluate on every configuration change rather than when someone remembers to audit.',
  });

  // Which of this audit's own IAM checks have a continuous equivalent deployed.
  const deployed = new Set<string>();
  for (const r of list) {
    const id = r?.OrganizationManagedRuleMetadata?.RuleIdentifier;
    if (id) deployed.add(String(id).toUpperCase());
  }
  const missing = IAM_CONFIG_RULES.filter(([ruleId]) => !deployed.has(ruleId));
  const present = IAM_CONFIG_RULES.filter(([ruleId]) => deployed.has(ruleId));

  out.push({
    id: 'config-iam-coverage', category: 'detective', title: 'Continuous coverage of the IAM hygiene checks',
    status: missing.length === 0 ? 'PASS' : list.length === 0 ? 'FAIL' : 'FAIL',
    severity: 'MEDIUM',
    detail: missing.length === 0
      ? `All ${IAM_CONFIG_RULES.length} IAM hygiene checks have a continuously-evaluating Config rule: ${present.map(([r]) => r).join(', ')}.`
      : `${missing.length} of ${IAM_CONFIG_RULES.length} IAM checks in this audit have no continuous equivalent. Sampled here but not monitored: ${missing.map(([, check]) => check).join(', ')}.${present.length ? ` Covered: ${present.map(([, check]) => check).join(', ')}.` : ''}`,
    remediation: missing.length === 0 ? undefined
      : `Deploy the matching managed rules org-wide: ${missing.map(([r]) => r).join(', ')}. Note the ordering pitfall — a Config rule evaluates nothing until the configuration recorder is running in the target accounts.`,
  });

  return out;
}
