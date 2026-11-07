import { AwsTarget, resolveAccount } from '../../utils/aws.js';
import { DEFAULT_REGION } from '../../utils/region.js';
import { validateAwsRegion } from '../../utils/validate.js';
import {
  Finding, renderReport, parseFailOn, applyFailOn,
  FAIL_ON_OPTION, JSON_OPTION,
} from '../../utils/audit.js';
import { auditAccount, auditDefaults, accountChangeWarning, ACCOUNT_AUDIT_GROUPS, AUDIT_PROFILE_OPTION, auditRegionOption } from '../../utils/audit-account.js';

/**
 * Audit the AWS account side of Bedrock protection.
 *
 * LLMjacking is credential theft aimed at model inference: an attacker obtains a
 * long-lived AWS key and burns it on Bedrock, where the marginal cost per request
 * is high enough that one compromised key can run five figures in days. The
 * account-side exposure is therefore two-sided, and both halves are audited here
 * because a finding in either one alone understates the risk:
 *
 *   - the way in       -- IAM credential hygiene (audit-iam.ts): what can be
 *                         stolen, and how long it has been sitting there
 *   - the blast radius -- Bedrock spend guardrails (audit-bedrock.ts): what
 *                         bounds the damage, how fast you find out, and whether
 *                         you can attribute it afterwards
 *
 * Perfect hygiene with no spend ceiling still permits an unbounded bill from a
 * key leaked any other way; a tight budget over a decade-old idle admin key
 * still invites the incident. Reporting them together is the point.
 *
 * The repository side -- whether a credential is already committed -- is
 * `bedrock-protection scan-repo`.
 *
 * Audit-only. Every AWS call is a read except the one documented at
 * `credentialReport()` in audit-iam.ts, which generates an IAM report artifact
 * and modifies no resource.
 */

export default {
  description: 'Audit the AWS account for LLMjacking exposure: IAM credential hygiene plus Bedrock spend guardrails, detection speed and invocation logging',
  options: [
    auditRegionOption('Region for Bedrock, CloudWatch and Provisioned Throughput checks'),
    AUDIT_PROFILE_OPTION,
    { flags: '--max-key-age <days>', description: 'Flag active access keys older than this', default: '90' },
    { flags: '--unused-days <days>', description: 'Flag credentials idle longer than this', default: '90' },
    { flags: '--iam-only', description: 'Only run the IAM credential hygiene checks' },
    { flags: '--bedrock-only', description: 'Only run the Bedrock spend guardrail and forensics checks' },
    JSON_OPTION,
    FAIL_ON_OPTION,
  ],
  async action(opts: {
    region?: string; profile?: string; maxKeyAge?: string; unusedDays?: string;
    iamOnly?: boolean; bedrockOnly?: boolean; json?: boolean; failOn?: string;
  }) {
    const defaults = auditDefaults(opts, DEFAULT_REGION);
    const region = validateAwsRegion(defaults.region);
    const failOn = parseFailOn(opts.failOn);

    if (opts.iamOnly && opts.bedrockOnly) {
      throw new Error('--iam-only and --bedrock-only are mutually exclusive; omit both to run everything');
    }

    const maxKeyAge = Number.parseInt(opts.maxKeyAge ?? '90', 10);
    const unusedDays = Number.parseInt(opts.unusedDays ?? '90', 10);
    if (!Number.isFinite(maxKeyAge) || maxKeyAge < 1) throw new Error('--max-key-age must be a positive integer');
    if (!Number.isFinite(unusedDays) || unusedDays < 1) throw new Error('--unused-days must be a positive integer');

    // One target for every check; scan-org supplies assumed-role creds instead.
    const target: AwsTarget = { profile: defaults.profile };
    if (defaults.note) console.error(defaults.note);
    const accountId = resolveAccount(target);
    if (!accountId) { process.exitCode = 2; return; }
    const changed = accountChangeWarning(defaults.connection, accountId);
    if (changed) console.error(changed);

    const runIam = !opts.bedrockOnly;
    const runBedrock = !opts.iamOnly;

    const findings: Finding[] = auditAccount(target, accountId, region, { maxKeyAge, unusedDays, runIam, runBedrock });

    const scope = runIam && runBedrock ? '' : runIam ? '    Scope: IAM only' : '    Scope: Bedrock only';

    renderReport(findings, {
      title: '🛡️  Bedrock protection — account audit',
      subtitle: `Account: ${accountId}    Region: ${region}${scope}`,
      groups: ACCOUNT_AUDIT_GROUPS,
      json: Boolean(opts.json),
      jsonContext: {
        account: accountId,
        region,
        scope: runIam && runBedrock ? 'full' : runIam ? 'iam-only' : 'bedrock-only',
      },
    });

    applyFailOn(findings, failOn, Boolean(opts.json));
  },
};
