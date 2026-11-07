/**
 * The account checks behind `bedrock-protection scan-account`, as one callable
 * function so `aws check` (its bedrock section) runs exactly the same checks.
 * scan-account still owns its flags, header and report layout.
 */
import type { AwsTarget } from './aws.js';
import type { Finding } from './audit.js';
import { accountChangeWarning, configuredRegion, connectionDefaults, type SavedConnection } from '../aws/connection.js';
import { resolveRegion } from '../security/setup.js';
import { auditRoot, auditPasswordPolicy, auditUsers, auditUserPolicies } from './audit-iam.js';
import { auditBudgets, auditBudgetAlerting, auditDetection, auditAiProtection, auditCommitments, auditForensics } from './audit-bedrock.js';

export interface AccountAuditOptions {
  maxKeyAge: number;
  unusedDays: number;
  runIam: boolean;
  runBedrock: boolean;
  /** false: never call iam generate-credential-report (strictly read-only callers). */
  generateCredentialReport?: boolean;
}

/** Report headings, in order, keyed by Finding.category. */
export const ACCOUNT_AUDIT_GROUPS: Array<[string, string]> = [
  ['root', 'Root user — unconstrainable by design'],
  ['users', 'IAM users and access keys'],
  ['policy', 'Account-wide policy'],
  ['budget', 'Spend ceilings — both billing surfaces'],
  ['detection', 'Detection speed — how fast you find out'],
  ['commitment', 'Standing commitments'],
  ['forensics', 'Forensics — can you answer "who?"'],
];

/** Every check id auditAccount can return. A test keeps this in step with the audit modules. */
export const ACCOUNT_AUDIT_IDS = [
  'root-mfa', 'root-access-keys', 'password-policy', 'access-key-age', 'console-user-no-mfa', 'unused-credentials',
  'user-admin-policy', 'bedrock-budget', 'marketplace-budget', 'budget-alerting', 'cost-explorer-enabled',
  'anomaly-monitor', 'bedrock-invocation-alarm', 'guardduty-ai-protection', 'provisioned-throughput', 'model-invocation-logging',
] as const;

export function auditAccount(target: AwsTarget, accountId: string, region: string, o: AccountAuditOptions): Finding[] {
  // auditBudgets returns the covering budget names so the alerting check can
  // scope its per-notification calls to them rather than every budget.
  const budgets = o.runBedrock ? auditBudgets(target, accountId) : null;
  return [
    ...(o.runIam ? [
      ...auditRoot(target),
      auditPasswordPolicy(target),
      ...auditUsers(target, o.maxKeyAge, o.unusedDays, o.generateCredentialReport ?? true),
      auditUserPolicies(target),
    ] : []),
    ...(o.runBedrock && budgets ? [
      ...budgets.findings,
      auditBudgetAlerting(target, accountId, budgets.coveringBudgets, budgets.listError),
      ...auditDetection(target, region),
      auditAiProtection(target, region),
      auditCommitments(target, region),
      auditForensics(target, region),
    ] : []),
  ];
}

export interface AuditDefaults {
  profile?: string;
  region: string;
  connection?: SavedConnection;
  /** One stderr line when the saved connection chose the profile or region, else null. */
  note: string | null;
}

/**
 * Profile and region for the bedrock-protection commands, through the shared
 * resolver. Notes go to stderr so the report on stdout keeps its exact shape.
 *
 * shortcut: these commands always ran in us-west-2 when given no --region, so
 * that stays the last fallback instead of refusing like the newer commands;
 * drop it when bedrock-protection is folded into aws check.
 */
export function auditDefaults(opts: { profile?: string; region?: string }, fallbackRegion: string, env?: NodeJS.ProcessEnv): AuditDefaults {
  const o = connectionDefaults({ profile: opts.profile || undefined, region: opts.region || undefined }, env);
  const r = resolveRegion(o, { env: env ?? process.env, configRegion: configuredRegion });
  const region = r?.region ?? fallbackRegion;
  const fromSaved = o.profileSource?.startsWith('aws connect') || r?.source.startsWith('aws connect');
  const note = fromSaved
    ? `Using ${o.profile ? `profile ${o.profile} (${o.profileSource})` : 'the default credential chain'}, region ${region} (${r?.source ?? 'default'}).`
    : null;
  return { profile: o.profile, region, connection: o.connection, note };
}

export { accountChangeWarning };

export const AUDIT_PROFILE_OPTION = {
  flags: '--profile <name>',
  description: 'AWS CLI profile to audit (default: AWS_PROFILE or env credentials, else the one saved by prism-cli aws connect, else the default chain)',
};

export const auditRegionOption = (what: string) => ({
  flags: '--region <region>',
  description: `${what} (default: AWS_REGION, AWS_DEFAULT_REGION, the aws connect region, the profile's region, else us-west-2)`,
});
