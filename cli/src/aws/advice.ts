/**
 * The fixed mapping behind `prism-cli aws recommend`: one entry per check id
 * aws check can return. A test fails when a check id has no entry.
 *
 * effort: quick = one command or console toggle; medium = a setup step that
 * takes some decisions; large = a project (migrating users, redesigning access).
 */
export type Effort = 'quick' | 'medium' | 'large';

export interface Advice {
  title: string;
  why: string;
  steps: string[];
  /** The prism-cli command that fixes it, when there is one. */
  command?: string;
  doc: string;
  effort: Effort;
  /** IAM actions the check reads; shown when the check was INDETERMINATE. */
  needs?: string[];
  /** Replaces the generic "grant read access" item when INDETERMINATE means something else. */
  indeterminate?: string;
  /** Checks with the same key are one fix in aws recommend (default: the check id). */
  key?: string;
  /** The key of a fix this check can only be judged after (INDETERMINATE for that reason points at it). */
  prerequisite?: string;
}

/** Title and wording for a key that several checks share. `first` names the fix when another check waits on it. */
export const GROUPS: Record<string, { title: string; why: string; first: string }> = {
  budgets: {
    title: 'Create AWS Budgets: one for all spend, plus filters for Bedrock and AWS Marketplace',
    why: 'Without budgets unexpected spend raises no alert, and Bedrock\'s third-party models bill under Marketplace, so a Bedrock-only filter misses them.',
    first: 'Create the budgets',
  },
};

const IAM = 'https://docs.aws.amazon.com/IAM/latest/UserGuide';
const COST = 'https://docs.aws.amazon.com/cost-management/latest/userguide';
const BEDROCK = 'https://docs.aws.amazon.com/bedrock/latest/userguide';
const GUIDE = 'https://github.com/aws-samples/sample-prism-d1-velocity/blob/main/USER_GUIDE.md';
const CREDENTIAL_REPORT = ['iam:GetCredentialReport (the report must exist: run aws iam generate-credential-report once, or prism-cli bedrock-protection scan-account)'];

const rootMfa: Advice = {
  title: 'Add MFA to the root user', why: 'Root cannot be limited by SCPs or permission boundaries; without MFA a leaked root password is a full account takeover.',
  steps: [
    'Sign in as the root user.', 'Security credentials > Assign MFA device; prefer a FIDO2 security key.',
    'In some managed or organization accounts the root user is controlled centrally; check with your account owner.',
  ],
  doc: `${IAM}/enable-mfa-for-root.html`, effort: 'quick', needs: ['iam:GetAccountSummary'],
};

export const ADVICE: Record<string, Advice> = {
  // -- bedrock (bedrock-protection scan-account) ---------------------------------
  'bedrock.root-mfa': rootMfa,
  'bedrock.root-access-keys': {
    title: 'Delete the root access keys', why: 'Root keys are long-lived and unconstrainable: the worst credential to leak.',
    steps: ['Sign in as root > Security credentials > Access keys > Delete.', 'Move any automation that used them to an IAM role.'],
    doc: `${IAM}/root-user-best-practices.html`, effort: 'quick', needs: ['iam:GetAccountSummary'],
  },
  'bedrock.password-policy': {
    title: 'Set an account password policy', why: 'Without one only the AWS defaults apply (8 characters, no reuse rules).',
    steps: ['aws iam update-account-password-policy --minimum-password-length 14 --require-symbols --require-numbers --password-reuse-prevention 24', 'Better: move console users to IAM Identity Center.'],
    doc: `${IAM}/id_credentials_passwords_account-policy.html`, effort: 'quick', needs: ['iam:GetAccountPasswordPolicy'],
  },
  'bedrock.access-key-age': {
    title: 'Rotate or remove long-lived access keys', why: 'Old static keys are what LLMjacking attackers steal and burn on Bedrock.',
    steps: ['List the flagged keys (prism-cli bedrock-protection scan-account).', 'Replace each with a role (SSO, OIDC, instance profile), or rotate and delete the old key.'],
    doc: `${IAM}/id_credentials_access-keys.html`, effort: 'medium', needs: CREDENTIAL_REPORT,
  },
  'bedrock.console-user-no-mfa': {
    title: 'Require MFA for console users', why: 'A console password without MFA falls to phishing or reuse.',
    steps: ['Assign an MFA device to each flagged user, or move them to IAM Identity Center.'],
    doc: `${IAM}/id_credentials_mfa_enable.html`, effort: 'medium', needs: CREDENTIAL_REPORT,
  },
  'bedrock.unused-credentials': {
    title: 'Remove unused credentials', why: 'Idle passwords and keys are attack surface nobody watches.',
    steps: ['Deactivate the flagged passwords and keys, wait a week, then delete them.'],
    doc: `${IAM}/id_credentials_finding-unused.html`, effort: 'quick', needs: CREDENTIAL_REPORT,
  },
  'bedrock.user-admin-policy': {
    title: 'Take AdministratorAccess off IAM users', why: 'Any access key of such a user is an unbounded credential.',
    steps: ['Create an admin role gated on MFA (or an Identity Center permission set).', 'Detach AdministratorAccess from the users.'],
    doc: `${IAM}/best-practices.html`, effort: 'large', needs: ['iam:ListUsers', 'iam:ListAttachedUserPolicies'],
  },
  'bedrock.bedrock-budget': {
    title: 'Add a budget that covers Bedrock', why: 'Runaway inference from a stolen key has no ceiling and raises no alert.',
    steps: ['Billing > Budgets > Create a monthly COST budget filtered on Service contains "Bedrock".', 'Alert at 50/80/100% to an SNS topic.'],
    doc: `${COST}/budgets-create.html`, effort: 'quick', needs: ['budgets:ViewBudget'], key: 'budgets',
  },
  'bedrock.marketplace-budget': {
    title: 'Add a budget that covers AWS Marketplace (Bedrock Edition models)', why: 'Third-party models bill under Marketplace, so a Bedrock-only budget misses them.',
    steps: ['Create a second COST budget filtered on Service = AWS Marketplace, or one Cost Category covering both.'],
    doc: `${COST}/budgets-create.html`, effort: 'quick', needs: ['budgets:ViewBudget'], key: 'budgets',
  },
  'bedrock.budget-alerting': {
    title: 'Make the Bedrock budgets notify someone', why: 'A budget with no subscriber records the overspend without telling anyone.',
    steps: ['Add 50/80/100% notification thresholds with an SNS topic (or email) subscriber to each covering budget.'],
    doc: `${COST}/budgets-sns-policy.html`, effort: 'quick', needs: ['budgets:ViewBudget'], prerequisite: 'budgets',
  },
  'bedrock.cost-explorer-enabled': {
    title: 'Enable Cost Explorer', why: 'Anomaly detection and cost checks need it, and it stays off until someone turns it on.',
    steps: ['Billing > Cost Explorer > Enable (data appears within 24 hours).'],
    doc: `${COST}/ce-enable.html`, effort: 'quick', needs: ['ce:GetAnomalyMonitors'],
  },
  'bedrock.anomaly-monitor': {
    title: 'Add a cost anomaly monitor with an alert subscription', why: 'It catches spend spikes a fixed budget threshold misses.',
    steps: ['Billing > Cost Anomaly Detection > Create an AWS services monitor.', 'Add an alert subscription (SNS or email).'],
    doc: `${COST}/getting-started-ad.html`, effort: 'quick', needs: ['ce:GetAnomalyMonitors', 'ce:GetAnomalySubscriptions'],
  },
  'bedrock.bedrock-invocation-alarm': {
    title: 'Alarm on Bedrock invocation volume', why: 'Cost data lags up to a day; the AWS/Bedrock metrics are the only fast signal.',
    steps: ['Create CloudWatch alarms on AWS/Bedrock Invocations and InputTokenCount above normal peak.'],
    doc: `${BEDROCK}/monitoring.html`, effort: 'medium', needs: ['cloudwatch:DescribeAlarms'],
  },
  'bedrock.guardduty-ai-protection': {
    title: 'Enable GuardDuty AI Protection', why: 'It detects cost-harvesting patterns against Bedrock.',
    steps: ['Enable GuardDuty in the region if needed, then the AI_PROTECTION feature on the detector (org-wide from the delegated administrator if you can).'],
    doc: 'https://docs.aws.amazon.com/guardduty/latest/ug/what-is-guardduty.html', effort: 'quick', needs: ['guardduty:ListDetectors', 'guardduty:GetDetector'],
  },
  'bedrock.provisioned-throughput': {
    title: 'Review Provisioned Throughput commitments', why: 'A commitment bills whether or not it is used, and is a target for misuse.',
    steps: ['Check each commitment is expected and owned; delete the ones nobody uses when their term allows.'],
    doc: `${BEDROCK}/prov-throughput.html`, effort: 'medium', needs: ['bedrock:ListProvisionedModelThroughputs'],
  },
  'bedrock.model-invocation-logging': {
    title: 'Turn on Bedrock model invocation logging', why: 'Without it you can see spend rose but not who or what caused it.',
    steps: ['Bedrock console > Settings > Model invocation logging > CloudWatch Logs or S3.', 'Treat the destination as sensitive: it holds prompts and completions.'],
    doc: `${BEDROCK}/model-invocation-logging.html`, effort: 'quick', needs: ['bedrock:GetModelInvocationLoggingConfiguration'],
  },

  // -- prism-setup -------------------------------------------------------------
  'prism-setup.metrics-pipeline': {
    title: 'Deploy the PRISM metrics pipeline', why: 'Without it CI and codeburn have nowhere to send PRISM metrics.',
    steps: ['From the repo: cd infra && npm ci && npx cdk deploy PrismD1MetricsPipeline (see the workshop setup guide).'],
    doc: `${GUIDE}`, effort: 'medium', needs: ['cloudformation:DescribeStacks'],
  },
  'prism-setup.security-agent-stack': {
    title: 'Set up AWS Security Agent', why: 'The CI eval gate and the security commands need its stack.',
    steps: ['Run the command below; it shows a diff and asks before any change.'], command: 'prism-cli enable security',
    doc: `${GUIDE}#security-agent-setup-enable-security`, effort: 'quick', needs: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
  },
  'prism-setup.security-agent-ssm': {
    title: 'Restore the Security Agent SSM parameters', why: 'The CI gate and security commands find the agent space and scan bucket through /prism/continuum/*.',
    steps: ['Run the command below (the stack owns these parameters; do not edit them by hand).'], command: 'prism-cli enable security',
    doc: `${GUIDE}#security-agent-setup-enable-security`, effort: 'quick', needs: ['ssm:GetParameter', 'securityagent:ListAgentSpaces'],
  },
  'prism-setup.scan-bucket-listed': {
    title: 'List the scan bucket on the Security Agent space', why: 'security threat-model fails when the agent space does not list the scan bucket.',
    steps: ['Run the command below to update the stack.'], command: 'prism-cli enable security',
    doc: `${GUIDE}#security-agent-setup-enable-security`, effort: 'quick', needs: ['securityagent:BatchGetAgentSpaces'],
  },
  'prism-setup.ci-oidc-role': {
    title: 'Create the CI OIDC provider and role', why: 'CI should publish PRISM metrics with short-lived OIDC credentials, not stored keys.',
    steps: ['Run the command below (or bootstrapper setup-gitlab-oidc for GitLab).', 'Set PRISM_METRICS_ROLE_ARN in the CI settings to the role it prints.'],
    command: 'prism-cli bootstrapper setup-github-oidc', doc: GUIDE, effort: 'quick', needs: ['iam:ListOpenIDConnectProviders', 'iam:ListRoles'],
  },
  'prism-setup.codeburn-sync': {
    title: 'Connect codeburn to the PRISM collector', why: 'This machine sends no AI usage telemetry to PRISM until codeburn sync is set up.',
    steps: ['Run the command below; it installs codeburn if missing and schedules the sync.'], command: 'prism-cli enable codeburn',
    doc: GUIDE, effort: 'quick', indeterminate: 'The codeburn sync config (~/.config/codeburn/sync.json) could not be read; check the file or re-run prism-cli enable codeburn.',
  },

  // -- baseline ----------------------------------------------------------------
  'baseline.cloudtrail-multiregion': {
    title: 'Log API activity in every region with a multi-region trail', why: 'Without it activity in other regions leaves no record for an investigation.',
    steps: ['aws cloudtrail create-trail --name prism-audit --s3-bucket-name <bucket> --is-multi-region-trail', 'aws cloudtrail start-logging --name prism-audit', 'In an organization, prefer one organization trail from the management account.'],
    doc: 'https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-create-and-update-a-trail.html', effort: 'medium', needs: ['cloudtrail:DescribeTrails', 'cloudtrail:GetTrailStatus'],
  },
  'baseline.guardduty': {
    title: 'Enable GuardDuty', why: 'It is the managed threat detection for compromised credentials and instances.',
    steps: ['aws guardduty create-detector --enable --region <region>', 'In an organization, enable it from a delegated administrator with auto-enable.'],
    doc: 'https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_settingup.html', effort: 'quick', needs: ['guardduty:ListDetectors', 'guardduty:GetDetector'],
  },
  'baseline.securityhub': {
    title: 'Enable Security Hub', why: 'It runs the AWS Foundational Security Best Practices checks continuously and collects findings in one place.',
    steps: ['Security Hub console > Enable, with the AWS Foundational Security Best Practices standard.'],
    doc: 'https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-settingup.html', effort: 'quick', needs: ['securityhub:DescribeHub'],
  },
  'baseline.access-analyzer': {
    title: 'Create an IAM Access Analyzer', why: 'It flags buckets, roles and keys shared outside the account.',
    steps: ['aws accessanalyzer create-analyzer --analyzer-name prism --type ACCOUNT --region <region>'],
    doc: `${IAM}/access-analyzer-getting-started.html`, effort: 'quick', needs: ['access-analyzer:ListAnalyzers'],
  },
  'baseline.budget': {
    title: 'Create an AWS Budget', why: 'Without a budget, unexpected spend raises no alert.',
    steps: ['Billing > Budgets > Create a monthly cost budget for all services with 80% and 100% alerts.'],
    doc: `${COST}/budgets-create.html`, effort: 'quick', needs: ['budgets:ViewBudget'], key: 'budgets',
  },
  'baseline.s3-account-bpa': {
    title: 'Turn on S3 Block Public Access for the account', why: 'One misconfigured bucket policy or ACL is otherwise enough to publish data.',
    steps: ['aws s3control put-public-access-block --account-id <account> --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true', 'First check no bucket needs public access on purpose.'],
    doc: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html', effort: 'quick', needs: ['s3:GetAccountPublicAccessBlock'],
  },
  'baseline.ebs-default-encryption': {
    title: 'Encrypt new EBS volumes by default', why: 'Unencrypted volumes and snapshots can expose data when shared or copied.',
    steps: ['aws ec2 enable-ebs-encryption-by-default --region <region> (applies to new volumes only).'],
    doc: 'https://docs.aws.amazon.com/ebs/latest/userguide/ebs-encryption.html', effort: 'quick', needs: ['ec2:GetEbsEncryptionByDefault'],
  },

  // -- startup-advisor ---------------------------------------------------------
  'startup-advisor.not-integrated': {
    title: 'Startup Advisor checks', why: 'Planned: PRISM will reuse Startup Advisor\'s account checks once how to consume them, and the license, are settled.',
    steps: ['Nothing to do yet.'], doc: 'https://github.com/aws-samples/sample-prism-d1-velocity/blob/main/docs/PRISM-CLI-STATUS.md', effort: 'quick',
    indeterminate: 'Not integrated yet; nothing to grant or fix.',
  },
};
