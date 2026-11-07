/**
 * `prism-cli aws check`: read-only account checks on the audit framework
 * (utils/audit.ts), in pluggable sections. A section is a name, a heading,
 * the check ids it can return, and a run function; SECTIONS is the registry.
 *
 * Every AWS call here is a read. INDETERMINATE (a denied or failed read) is
 * never counted as a pass.
 */
import { aws, type AwsResult, type AwsTarget } from '../utils/aws.js';
import { severityRank, type Finding, type Severity } from '../utils/audit.js';
import { auditAccount, ACCOUNT_AUDIT_IDS } from '../utils/audit-account.js';
import { configuredSyncUrl } from '../commands/enable/codeburn.js';
import {
  collectSecurityStatus, PIPELINE_STACK, type Ctx, type Deps, type Resolved, type StatusRow,
} from '../security/setup.js';

export interface CheckContext {
  target: AwsTarget;
  account: string;
  region: string;
  home: string;
  /** A read-only enable-security context, for the Security Agent rows. */
  security: Ctx;
}

export interface CheckSection {
  name: string;
  heading: string;
  /** Every check id run() can return (without the section prefix). */
  ids: readonly string[];
  run(c: CheckContext): Finding[];
}

/** `<section>.<id>`: one id space across sections (a check appears in one section only). */
export const checkId = (section: string, id: string): string => `${section}.${id}`;

const call = (c: CheckContext, args: string[], region = c.region): AwsResult => aws([...args, '--region', region], c.target);
const why = (r: AwsResult) => r.errorCode || r.raw.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'unknown error';

type Base = Omit<Finding, 'status' | 'detail' | 'remediation'>;
const pass = (b: Base, detail: string): Finding => ({ ...b, status: 'PASS', detail });
const fail = (b: Base, detail: string, remediation: string): Finding => ({ ...b, status: 'FAIL', detail, remediation });
/** A read that did not answer. `action` is the IAM action the check needs, when known. */
const unknown = (b: Base, r: AwsResult | string, action?: string): Finding => ({
  ...b, status: 'INDETERMINATE',
  detail: `Could not check (${typeof r === 'string' ? r : why(r)}).${action ? ` Needs ${action}.` : ''}`,
  remediation: action ? `Grant ${action} (read-only) and re-run prism-cli aws check.` : undefined,
});

// ---------------------------------------------------------------------------
// bedrock: the bedrock-protection scan-account checks, unchanged
// ---------------------------------------------------------------------------
export const bedrockSection: CheckSection = {
  name: 'bedrock',
  heading: 'Bedrock protection (the bedrock-protection scan-account checks)',
  ids: ACCOUNT_AUDIT_IDS,
  run(c) {
    // generateCredentialReport false: aws check never calls iam generate-credential-report.
    return auditAccount(c.target, c.account, c.region, { maxKeyAge: 90, unusedDays: 90, runIam: true, runBedrock: true, generateCredentialReport: false })
      .map((f) => ({ ...f, id: checkId('bedrock', f.id), category: 'bedrock' }));
  },
};

// ---------------------------------------------------------------------------
// prism-setup
// ---------------------------------------------------------------------------
const PS = (id: string, title: string, severity: Severity): Base => ({ id: checkId('prism-setup', id), category: 'prism-setup', title, severity });
const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
/** Role names bootstrapper setup-github-oidc / setup-gitlab-oidc create. */
const CI_ROLE = /^(GitHubActions|GitLabCI)-/;

export function metricsPipeline(c: CheckContext): Finding {
  const b = PS('metrics-pipeline', `PRISM metrics pipeline stack (${PIPELINE_STACK})`, 'MEDIUM');
  const r = call(c, ['cloudformation', 'describe-stacks', '--stack-name', PIPELINE_STACK]);
  const fix = `Deploy the metrics pipeline (infra/, cdk deploy ${PIPELINE_STACK}); see the PRISM workshop setup guide.`;
  if (!r.ok) return /does not exist/.test(r.raw) ? fail(b, `${PIPELINE_STACK} is not deployed in ${c.region}.`, fix) : unknown(b, r, 'cloudformation:DescribeStacks');
  const status = String(r.json?.Stacks?.[0]?.StackStatus || 'UNKNOWN');
  if (/_COMPLETE$/.test(status) && !/ROLLBACK_COMPLETE$|^DELETE_COMPLETE$/.test(status)) return pass(b, `${PIPELINE_STACK} is ${status} in ${c.region}.`);
  return fail(b, `${PIPELINE_STACK} is ${status} in ${c.region}.`, fix);
}

/** Maps the enable security --status rows to findings. A row that never appeared (the report stopped) is INDETERMINATE. */
export function securityAgent(c: CheckContext): Finding[] {
  const { rows } = collectSecurityStatus(c.security);
  const row = (label: string) => rows.find((r) => r[1] === label);
  const stopped = rows.find((r) => r[1] === 'Stopped' || (r[1] === 'Credentials' && r[0] !== 'ok'));
  const fix = 'Run prism-cli enable security (it shows a diff and asks before any change).';
  const one = (b: Base, r: StatusRow | undefined): Finding => {
    if (!r) return unknown(b, stopped ? stopped[2] : 'not reached', undefined);
    if (r[0] === 'ok') return pass(b, r[2]);
    if (r[0] === 'unknown') return unknown(b, r[2]);
    return fail(b, r[2], fix);
  };
  const ssm = ['SSM agent-space-id', 'SSM scan-bucket', 'SSM service-role-arn'].map(row);
  const ssmB = PS('security-agent-ssm', 'Security Agent SSM parameters (/prism/continuum/*)', 'MEDIUM');
  const ssmF = ssm.some((r) => !r) ? one(ssmB, undefined)
    : ssm.every((r) => r![0] === 'ok') ? pass(ssmB, ssm.map((r) => r![2]).join('; '))
      : fail(ssmB, ssm.filter((r) => r![0] !== 'ok').map((r) => r![2]).join('; '), fix);
  return [
    one(PS('security-agent-stack', 'Security Agent stack (PrismD1SecurityAgent or pipeline-hosted)', 'MEDIUM'), row('Stack')),
    ssmF,
    one(PS('scan-bucket-listed', 'Scan bucket listed on the Security Agent space', 'LOW'), row('Scan bucket on agent space')),
  ];
}

export function ciOidcRole(c: CheckContext): Finding {
  const b = PS('ci-oidc-role', 'GitHub/GitLab OIDC provider and CI role', 'MEDIUM');
  const fix = 'Run prism-cli bootstrapper setup-github-oidc (or setup-gitlab-oidc) for the repo whose CI publishes PRISM metrics.';
  const p = call(c, ['iam', 'list-open-id-connect-providers']);
  if (!p.ok) return unknown(b, p, 'iam:ListOpenIDConnectProviders');
  const arns: string[] = (p.json?.OpenIDConnectProviderList || []).map((x: any) => String(x?.Arn || ''));
  const providers = arns.filter((a) => a.endsWith(`/${GITHUB_OIDC_HOST}`) || /gitlab/i.test(a)).map((a) => a.split('oidc-provider/')[1]);
  const r = call(c, ['iam', 'list-roles', '--query', 'Roles[].RoleName']);
  if (!r.ok) return unknown(b, r, 'iam:ListRoles');
  const roles = (Array.isArray(r.json) ? r.json : []).map(String).filter((n: string) => CI_ROLE.test(n));
  if (providers.length && roles.length) return pass(b, `OIDC provider ${providers.join(', ')}; CI role ${roles.slice(0, 3).join(', ')}${roles.length > 3 ? ` and ${roles.length - 3} more` : ''}.`);
  const missing = [providers.length ? '' : 'no GitHub or GitLab OIDC provider', roles.length ? '' : 'no GitHubActions-* or GitLabCI-* role'].filter(Boolean);
  return fail(b, `${missing.join(' and ')}, so CI cannot publish PRISM metrics with short-lived credentials.`, fix);
}

/** Local only: the endpoint codeburn syncs to (~/.config/codeburn/sync.json). No AWS call. */
export function codeburnSync(c: CheckContext): Finding {
  const b = PS('codeburn-sync', 'codeburn sync endpoint configured on this machine', 'LOW');
  const url = configuredSyncUrl(c.home);
  if (url === null) return fail(b, 'codeburn sync is not set up here, so this machine sends no usage telemetry to the PRISM collector.', 'Run prism-cli enable codeburn.');
  if (!url) return unknown(b, 'the codeburn sync config could not be read');
  return pass(b, `codeburn syncs to ${url}.`);
}

export const prismSetupSection: CheckSection = {
  name: 'prism-setup',
  heading: 'PRISM setup',
  ids: ['metrics-pipeline', 'security-agent-stack', 'security-agent-ssm', 'scan-bucket-listed', 'ci-oidc-role', 'codeburn-sync'],
  run: (c) => [metricsPipeline(c), ...securityAgent(c), ciOidcRole(c), codeburnSync(c)],
};

// ---------------------------------------------------------------------------
// baseline
// ---------------------------------------------------------------------------
const BL = (id: string, title: string, severity: Severity): Base => ({ id: checkId('baseline', id), category: 'baseline', title, severity });

export function cloudTrail(c: CheckContext): Finding {
  const b = BL('cloudtrail-multiregion', 'CloudTrail: a multi-region trail that is logging', 'HIGH');
  const fix = 'Create a multi-region trail (aws cloudtrail create-trail --is-multi-region-trail, then start-logging), or an organization trail from the management account.';
  const r = call(c, ['cloudtrail', 'describe-trails']);
  if (!r.ok) return unknown(b, r, 'cloudtrail:DescribeTrails');
  const multi: any[] = (r.json?.trailList || []).filter((t: any) => t?.IsMultiRegionTrail);
  if (!multi.length) return fail(b, 'No multi-region trail, so API activity in other regions is not recorded.', fix);
  let readable = 0;
  for (const t of multi) {
    const s = call(c, ['cloudtrail', 'get-trail-status', '--name', String(t.TrailARN || t.Name)], String(t.HomeRegion || c.region));
    if (!s.ok) continue;
    readable++;
    if (s.json?.IsLogging) return pass(b, `${t.Name} is multi-region and logging.`);
  }
  if (!readable) return unknown(b, 'get-trail-status was denied for every multi-region trail', 'cloudtrail:GetTrailStatus');
  return fail(b, `Multi-region trail(s) ${multi.map((t) => t.Name).join(', ')} exist but none is logging.`, 'Start logging: aws cloudtrail start-logging --name <trail>.');
}

export function guardDuty(c: CheckContext): Finding {
  const b = BL('guardduty', `GuardDuty detector enabled in ${c.region}`, 'HIGH');
  const fix = `Enable GuardDuty in ${c.region} (aws guardduty create-detector --enable), ideally org-wide from a delegated administrator.`;
  const r = call(c, ['guardduty', 'list-detectors']);
  if (!r.ok) return unknown(b, r, 'guardduty:ListDetectors');
  const ids: string[] = r.json?.DetectorIds || [];
  if (!ids.length) return fail(b, `No GuardDuty detector in ${c.region}.`, fix);
  const d = call(c, ['guardduty', 'get-detector', '--detector-id', ids[0]]);
  if (!d.ok) return unknown(b, d, 'guardduty:GetDetector');
  return d.json?.Status === 'ENABLED' ? pass(b, `Detector ${ids[0]} is enabled.`) : fail(b, `Detector ${ids[0]} is ${d.json?.Status || 'not enabled'}.`, fix);
}

export function securityHub(c: CheckContext): Finding {
  const b = BL('securityhub', `Security Hub enabled in ${c.region}`, 'MEDIUM');
  const r = call(c, ['securityhub', 'describe-hub']);
  if (r.ok) return pass(b, `Security Hub is enabled${r.json?.SubscribedAt ? ` (since ${r.json.SubscribedAt})` : ''}.`);
  if (/^(InvalidAccessException|ResourceNotFoundException)$/.test(r.errorCode)) {
    return fail(b, `Security Hub is not enabled in ${c.region}.`, `Enable Security Hub in ${c.region} with the AWS Foundational Security Best Practices standard.`);
  }
  return unknown(b, r, 'securityhub:DescribeHub');
}

export function accessAnalyzer(c: CheckContext): Finding {
  const b = BL('access-analyzer', `IAM Access Analyzer in ${c.region}`, 'MEDIUM');
  const r = call(c, ['accessanalyzer', 'list-analyzers']);
  if (!r.ok) return unknown(b, r, 'access-analyzer:ListAnalyzers');
  const active: any[] = (r.json?.analyzers || []).filter((a: any) => a?.status === 'ACTIVE');
  return active.length ? pass(b, `Analyzer ${active[0].name} (${active[0].type}) is active.`)
    : fail(b, `No active Access Analyzer in ${c.region}, so resources shared outside the account are not flagged.`, `Create one: aws accessanalyzer create-analyzer --analyzer-name prism --type ACCOUNT --region ${c.region}.`);
}

// Root MFA is not repeated here: the bedrock section's bedrock.root-mfa reads the same
// iam get-account-summary, and a second copy listed the same fix twice.

export function budget(c: CheckContext): Finding {
  const b = BL('budget', 'At least one AWS Budget', 'MEDIUM');
  const r = call(c, ['budgets', 'describe-budgets', '--account-id', c.account]);
  if (!r.ok) return unknown(b, r, 'budgets:ViewBudget');
  const n = (r.json?.Budgets || []).length;
  return n ? pass(b, `${n} budget(s) defined.`) : fail(b, 'No budgets, so unexpected spend raises no alert.', 'Create a monthly cost budget with 80% and 100% alerts (Billing console > Budgets).');
}

export function s3PublicAccess(c: CheckContext): Finding {
  const b = BL('s3-account-bpa', 'S3 Block Public Access at the account level', 'HIGH');
  const fix = `Turn on all four settings: aws s3control put-public-access-block --account-id ${c.account} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true.`;
  const r = call(c, ['s3control', 'get-public-access-block', '--account-id', c.account]);
  if (!r.ok) return r.errorCode === 'NoSuchPublicAccessBlockConfiguration' ? fail(b, 'No account-level Block Public Access configuration.', fix) : unknown(b, r, 's3:GetAccountPublicAccessBlock');
  const cfg = r.json?.PublicAccessBlockConfiguration ?? {};
  const off = ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'].filter((k) => cfg[k] !== true);
  return off.length ? fail(b, `Off: ${off.join(', ')}.`, fix) : pass(b, 'All four account-level settings are on.');
}

export function ebsEncryption(c: CheckContext): Finding {
  const b = BL('ebs-default-encryption', `EBS encryption by default in ${c.region}`, 'MEDIUM');
  const r = call(c, ['ec2', 'get-ebs-encryption-by-default']);
  if (!r.ok) return unknown(b, r, 'ec2:GetEbsEncryptionByDefault');
  return r.json?.EbsEncryptionByDefault === true ? pass(b, 'New EBS volumes are encrypted by default.')
    : fail(b, `New EBS volumes in ${c.region} are not encrypted by default.`, `aws ec2 enable-ebs-encryption-by-default --region ${c.region}.`);
}

export const baselineSection: CheckSection = {
  name: 'baseline',
  heading: 'Account baseline',
  ids: ['cloudtrail-multiregion', 'guardduty', 'securityhub', 'access-analyzer', 'budget', 's3-account-bpa', 'ebs-default-encryption'],
  run: (c) => [cloudTrail(c), guardDuty(c), securityHub(c), accessAnalyzer(c), budget(c), s3PublicAccess(c), ebsEncryption(c)],
};

// ---------------------------------------------------------------------------
// startup-advisor: placeholder until how it is consumed (and its license) is known
// ---------------------------------------------------------------------------
export const startupAdvisorSection: CheckSection = {
  name: 'startup-advisor',
  heading: 'Startup Advisor',
  ids: ['not-integrated'],
  run: () => [{
    id: checkId('startup-advisor', 'not-integrated'), category: 'startup-advisor', title: 'Startup Advisor account checks',
    status: 'INDETERMINATE', severity: 'INFO',
    detail: 'Not integrated yet: how PRISM consumes Startup Advisor, and under what license, is still open.',
  }],
};

export const SECTIONS: CheckSection[] = [bedrockSection, prismSetupSection, baselineSection, startupAdvisorSection];

/** Every full check id any section can return. */
export const ALL_CHECK_IDS: string[] = SECTIONS.flatMap((s) => s.ids.map((id) => checkId(s.name, id)));

/** The sections named by --section (all when none), or an error naming the valid ones. */
export function selectSections(names: string[] | undefined): CheckSection[] | { error: string } {
  if (!names?.length) return SECTIONS;
  const bad = names.filter((n) => !SECTIONS.some((s) => s.name === n));
  if (bad.length) return { error: `unknown --section ${bad.join(', ')}; choose from ${SECTIONS.map((s) => s.name).join(', ')}` };
  return SECTIONS.filter((s) => names.includes(s.name));
}

export interface SectionCounts { pass: number; fail: number; indeterminate: number }

export function countFindings(findings: Finding[]): SectionCounts {
  return {
    pass: findings.filter((f) => f.status === 'PASS').length,
    fail: findings.filter((f) => f.status === 'FAIL').length,
    indeterminate: findings.filter((f) => f.status === 'INDETERMINATE').length,
  };
}

export function failBySeverity(findings: Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const f of findings) if (f.status === 'FAIL') out[f.severity]++;
  return out;
}

/** FAIL findings at or above `failOn` (none when failOn is null). */
export function breaching(findings: Finding[], failOn: Severity | null): Finding[] {
  if (!failOn) return [];
  return findings.filter((f) => f.status === 'FAIL' && severityRank(f.severity) >= severityRank(failOn));
}

/** A read-only enable-security context for collectSecurityStatus. Repo rows are skipped (git reports no repo). */
export function securityContext(opts: Resolved, aws: Deps['aws'], env: NodeJS.ProcessEnv, awsVersion: () => string | null, log: (l?: string) => void): Ctx {
  const unused = () => { throw new Error('internal: not available in aws check'); };
  const deps: Deps = {
    aws, env, awsVersion, log,
    configRegion: () => null,
    cdk: { synth: unused, diff: unused, deploy: unused },
    git: () => ({ ok: false, stdout: '', stderr: 'not used by aws check' }),
    makeTempDir: unused,
    isTTY: false,
    ask: async () => '',
    now: () => new Date(),
  };
  return { opts, deps, cliVersion: awsVersion(), readOnly: true };
}
