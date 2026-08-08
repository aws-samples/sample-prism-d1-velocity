import * as cdk from 'aws-cdk-lib';
import * as securityagent from 'aws-cdk-lib/aws-securityagent';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export interface SecurityAgentProps {
  /**
   * Name for the agent space.
   */
  agentSpaceName: string;

  /**
   * Description of the agent space.
   */
  description?: string;

  /**
   * KMS key for encrypting Security Agent data.
   * If not provided, the PRISM KMS key should be passed in.
   */
  kmsKey?: kms.IKey;

  /**
   * Target domains to register for pen testing.
   * Each domain requires ownership verification.
   */
  targetDomains?: Array<{
    domainName: string;
    verificationMethod: 'DNS_TXT' | 'HTTP_ROUTE';
  }>;

  /**
   * VPC configuration for pen tests that need network access.
   */
  vpcConfig?: {
    securityGroupIds: string[];
    subnetIds: string[];
  };

  /**
   * Risk types to exclude from pen testing.
   * Example: ['DENIAL_OF_SERVICE']
   */
  excludeRiskTypes?: string[];

  /**
   * Whether to enable automatic code remediation.
   * @default 'DISABLED'
   */
  codeRemediationStrategy?: 'AUTOMATIC' | 'DISABLED';

  /**
   * SSM Parameter Store prefix for CI/CD config retrieval.
   * Stores agent space ID, code review ID, and scan bucket name.
   * @default '/prism/continuum'
   */
  ssmParameterPrefix?: string;

  /**
   * Tags applied to all Security Agent resources.
   */
  tags?: Record<string, string>;
}

/**
 * CDK construct that provisions AWS Security Agent resources:
 * - AgentSpace: defines scope, integrations, and settings
 * - TargetDomains: registers domains for pen testing
 * - Service role with least-privilege permissions
 *
 * Pentests are triggered on-demand via API or the GitHub Actions workflow,
 * not provisioned statically via CloudFormation.
 */
export class SecurityAgentConstruct extends Construct {
  public readonly agentSpaceId: string;
  public readonly serviceRole: iam.Role;
  public readonly targetDomainIds: string[];
  public readonly scanBucket: s3.Bucket;
  public readonly codeReviewId: string;

  constructor(scope: Construct, id: string, props: SecurityAgentProps) {
    super(scope, id);

    // Service role for Security Agent pen tests
    this.serviceRole = new iam.Role(this, 'SecurityAgentRole', {
      roleName: `prism-d1-security-agent-${props.agentSpaceName}`,
      assumedBy: new iam.ServicePrincipal('securityagent.amazonaws.com'),
      description: 'Service role for AWS Security Agent pen tests in PRISM D1',
    });

    // Grant Security Agent permissions scoped to this agent space
    this.serviceRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['securityagent:*'],
        resources: [
          `arn:aws:securityagent:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:agent-space/*`,
        ],
      }),
    );

    // Grant KMS permissions for encrypted agent spaces
    if (props.kmsKey) {
      props.kmsKey.grantEncryptDecrypt(this.serviceRole);
    }

    // Grant CloudWatch Logs access for pen test logging
    this.serviceRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: ['arn:aws:logs:*:*:log-group:/aws/securityagent/*'],
      }),
    );

    // cdk-nag suppressions for Security Agent role
    NagSuppressions.addResourceSuppressions(
      this.serviceRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Security Agent service requires securityagent:* as individual actions are not yet documented in IAM service authorization reference',
          appliesTo: ['Action::securityagent:*'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Agent space ID is generated at deploy time; wildcard required for the service role to operate on its own space',
          appliesTo: [`Resource::arn:aws:securityagent:<AWS::Region>:<AWS::AccountId>:agent-space/*`],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Security Agent creates log groups dynamically at /aws/securityagent/<space>/pt-<id>; wildcard required',
          appliesTo: ['Resource::arn:aws:logs:*:*:log-group:/aws/securityagent/*'],
        },
      ],
      true,
    );

    // If VPC config provided, grant network interface permissions
    if (props.vpcConfig) {
      this.serviceRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ec2:DescribeNetworkInterfaces'],
          resources: ['*'],
        }),
      );
      this.serviceRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ec2:CreateNetworkInterface', 'ec2:DeleteNetworkInterface'],
          resources: [
            `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:network-interface/*`,
            ...props.vpcConfig.subnetIds.map(s => `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:subnet/${s}`),
            ...props.vpcConfig.securityGroupIds.map(sg => `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:security-group/${sg}`),
          ],
        }),
      );
    }

    // Agent Space
    const agentSpace = new securityagent.CfnAgentSpace(this, 'AgentSpace', {
      name: props.agentSpaceName,
      description: props.description ?? `PRISM D1 Security Agent space: ${props.agentSpaceName}`,
      ...(props.kmsKey && {
        kmsKeyId: props.kmsKey.keyArn,
      }),
      awsResources: {
        iamRoles: [this.serviceRole.roleArn],
      },
      tags: [
        { key: 'prism:component', value: 'security-agent' },
        { key: 'prism:agent-space', value: props.agentSpaceName },
        ...Object.entries(props.tags ?? {}).map(([key, value]) => ({ key, value })),
      ],
    });

    this.agentSpaceId = agentSpace.attrAgentSpaceId;

    // Target Domains
    this.targetDomainIds = [];
    for (const domain of props.targetDomains ?? []) {
      const targetDomain = new securityagent.CfnTargetDomain(this, `Domain-${domain.domainName.replace(/\./g, '-')}`, {
        targetDomainName: domain.domainName,
        verificationMethod: domain.verificationMethod,
        tags: [
          { key: 'prism:component', value: 'security-agent' },
          { key: 'prism:domain', value: domain.domainName },
        ],
      });
      this.targetDomainIds.push(targetDomain.attrTargetDomainId);
    }

    // Associate target domains with agent space if any were created
    if (this.targetDomainIds.length > 0) {
      // Update the agent space with target domain IDs
      // Note: This requires the domains to be verified first
      (agentSpace as any).targetDomainIds = this.targetDomainIds;
    }

    // Log group for pen test results (Security Agent writes to /aws/securityagent/<space>/pt-<id>)
    // Note: we do NOT set logGroupName to avoid conflicts with pre-existing log groups
    // created by prism-cli securityagent setup or the Security Agent service itself.
    const pentestLogGroup = logs.LogGroup.fromLogGroupName(
      this, 'PentestLogGroup',
      `/aws/securityagent/${props.agentSpaceName}`,
    );

    // Outputs
    new cdk.CfnOutput(this, 'AgentSpaceIdOutput', {
      value: this.agentSpaceId,
      description: `Security Agent space ID for ${props.agentSpaceName}`,
      exportName: `PrismD1SecurityAgentSpaceId`,
    });

    new cdk.CfnOutput(this, 'ServiceRoleArnOutput', {
      value: this.serviceRole.roleArn,
      description: 'Security Agent service role ARN',
      exportName: `PrismD1SecurityAgentRoleArn`,
    });

    if (this.targetDomainIds.length > 0) {
      new cdk.CfnOutput(this, 'TargetDomainIdsOutput', {
        value: this.targetDomainIds.join(','),
        description: 'Registered target domain IDs',
        exportName: `PrismD1SecurityAgentDomainIds`,
      });
    }

    // -------------------------------------------------------
    // S3 Scan Bucket — stores repo ZIPs and diff files for
    // API-triggered code reviews (diff scans from CI/CD).
    // -------------------------------------------------------
    this.scanBucket = new s3.Bucket(this, 'ScanBucket', {
      bucketName: `security-agent-scans-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      lifecycleRules: [
        {
          id: 'expire-scan-artifacts',
          expiration: cdk.Duration.days(30),
          enabled: true,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Grant Security Agent service role read access to the scan bucket
    this.scanBucket.grantRead(this.serviceRole);

    // Suppress cdk-nag for S3 read grant wildcards (grantRead expands to s3:GetObject*, s3:GetBucket*, s3:List*)
    NagSuppressions.addResourceSuppressions(
      this.serviceRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'grantRead() generates s3:GetObject*, s3:GetBucket*, s3:List* — standard CDK pattern for bucket read access',
          appliesTo: ['Action::s3:GetObject*', 'Action::s3:GetBucket*', 'Action::s3:List*'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Scan bucket objects are dynamic (SHA-named diffs); wildcard on objects required',
          appliesTo: ['Resource::<SecurityAgentScanBucketB752F4A9.Arn>/*'],
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      this.scanBucket,
      [
        {
          id: 'AwsSolutions-S1',
          reason: 'Access logging not required for ephemeral scan artifacts (30-day lifecycle, auto-deleted)',
        },
      ],
      true,
    );

    // -------------------------------------------------------
    // Code Review resource — created via SDK Custom Resource
    // since CloudFormation does not yet have a CfnCodeReview.
    // The code review points to the S3 scan bucket so CI
    // workflows can call StartCodeReviewJob with diffSource.
    // -------------------------------------------------------
    const codeReviewProviderFn = new cdk.aws_lambda.Function(this, 'CodeReviewProvider', {
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(60),
      code: cdk.aws_lambda.Code.fromInline(`
const { SecurityAgentClient, CreateCodeReviewCommand, ListCodeReviewsCommand } = require('@aws-sdk/client-securityagent');

exports.handler = async (event) => {
  const client = new SecurityAgentClient();
  const props = event.ResourceProperties;

  if (event.RequestType === 'Delete') {
    // Code reviews cannot be deleted via API — no-op
    return { PhysicalResourceId: event.PhysicalResourceId, Data: {} };
  }

  const findExisting = async () => {
    try {
      const list = await client.send(new ListCodeReviewsCommand({ agentSpaceId: props.AgentSpaceId }));
      const match = (list.codeReviews || []).find((c) => c.name === props.Name || c.title === props.Title);
      return match ? (match.codeReviewId || match.id) : null;
    } catch (e) {
      return null;
    }
  };

  try {
    const resp = await client.send(new CreateCodeReviewCommand({
      agentSpaceId: props.AgentSpaceId,
      name: props.Name,
      title: props.Title,
      sourceConfig: { s3: { bucketName: props.BucketName, keyPrefix: props.KeyPrefix } },
    }));
    const id = resp.codeReviewId || resp.id;
    return { PhysicalResourceId: id, Data: { CodeReviewId: id } };
  } catch (err) {
    if (err.name === 'ConflictException') {
      const existingId = await findExisting();
      if (existingId) {
        return { PhysicalResourceId: existingId, Data: { CodeReviewId: existingId } };
      }
    }
    throw err;
  }
};
        `),
      initialPolicy: [
        new iam.PolicyStatement({
          actions: [
            'securityagent:CreateCodeReview',
            'securityagent:BatchGetCodeReviews',
            'securityagent:ListCodeReviews',
          ],
          resources: [`arn:aws:securityagent:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:agent-space/*`],
        }),
      ],
    });

    const codeReviewProvider = new cr.Provider(this, 'CodeReviewProviderFramework', {
      onEventHandler: codeReviewProviderFn,
    });

    NagSuppressions.addResourceSuppressions(
      codeReviewProviderFn,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CodeReview provider needs securityagent actions on agent-space/* because the space ID is dynamic',
          appliesTo: ['Resource::arn:aws:securityagent:<AWS::Region>:<AWS::AccountId>:agent-space/*'],
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Lambda basic execution role is required for CloudWatch Logs access',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        },
      ],
      true,
    );

    // Suppress nag on the Provider framework's own Lambda + role
    NagSuppressions.addResourceSuppressions(
      codeReviewProvider,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'CDK Provider framework Lambda uses the managed basic execution role',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK Provider framework grants lambda:InvokeFunction to its own onEvent handler with a wildcard version suffix',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'CDK Provider framework manages its own Lambda runtime version',
        },
      ],
      true,
    );

    const codeReviewCr = new cdk.CustomResource(this, 'CodeReview', {
      serviceToken: codeReviewProvider.serviceToken,
      properties: {
        AgentSpaceId: this.agentSpaceId,
        Name: `${props.agentSpaceName}-ci-scan`,
        Title: `${props.agentSpaceName} CI diff scan`,
        BucketName: this.scanBucket.bucketName,
        KeyPrefix: 'repo/',
      },
    });
    codeReviewCr.node.addDependency(agentSpace);

    this.codeReviewId = codeReviewCr.getAttString('CodeReviewId');

    new cdk.CfnOutput(this, 'CodeReviewIdOutput', {
      value: this.codeReviewId,
      description: 'Code Review ID for CI/CD diff scans',
      exportName: 'PrismD1ContinuumCodeReviewId',
    });

    new cdk.CfnOutput(this, 'ScanBucketOutput', {
      value: this.scanBucket.bucketName,
      description: 'S3 bucket for scan artifacts (repo ZIPs + diffs)',
      exportName: 'PrismD1ContinuumScanBucket',
    });

    // -------------------------------------------------------
    // SSM Parameter Store — non-sensitive CI/CD config.
    // GitHub Actions workflows read these at runtime so no
    // hardcoded IDs are needed in the repository.
    // -------------------------------------------------------
    const prefix = props.ssmParameterPrefix ?? '/prism/continuum';

    new ssm.StringParameter(this, 'ParamAgentSpaceId', {
      parameterName: `${prefix}/agent-space-id`,
      stringValue: this.agentSpaceId,
      description: 'AWS Continuum Agent Space ID for PRISM D1',
      tier: ssm.ParameterTier.STANDARD,
    });

    new ssm.StringParameter(this, 'ParamCodeReviewId', {
      parameterName: `${prefix}/code-review-id`,
      stringValue: this.codeReviewId,
      description: 'AWS Continuum Code Review ID for CI diff scans',
      tier: ssm.ParameterTier.STANDARD,
    });

    new ssm.StringParameter(this, 'ParamScanBucket', {
      parameterName: `${prefix}/scan-bucket`,
      stringValue: this.scanBucket.bucketName,
      description: 'S3 bucket name for uploading repo/diff scan artifacts',
      tier: ssm.ParameterTier.STANDARD,
    });
  }

  /**
   * Creates a CfnPentest resource for on-demand pen testing.
   * Call this method to define a pen test configuration that can be
   * triggered via the AWS CLI or API.
   */
  createPentestConfig(
    id: string,
    props: {
      title: string;
      endpoints: Array<{ uri: string }>;
      serviceRole?: iam.IRole;
      vpcConfig?: { securityGroupArns: string[]; subnetArns: string[] };
      excludeRiskTypes?: string[];
      codeRemediationStrategy?: 'AUTOMATIC' | 'DISABLED';
    },
  ): securityagent.CfnPentest {
    return new securityagent.CfnPentest(this, id, {
      agentSpaceId: this.agentSpaceId,
      serviceRole: (props.serviceRole ?? this.serviceRole).roleArn,
      title: props.title,
      assets: {
        endpoints: props.endpoints.map((ep) => ({
          uri: ep.uri,
        })),
      },
      ...(props.excludeRiskTypes && { excludeRiskTypes: props.excludeRiskTypes }),
      ...(props.codeRemediationStrategy && { codeRemediationStrategy: props.codeRemediationStrategy }),
      ...(props.vpcConfig && {
        vpcConfig: {
          securityGroupArns: props.vpcConfig.securityGroupArns,
          subnetArns: props.vpcConfig.subnetArns,
        },
      }),
      logConfig: {
        logGroup: `/prism/security-agent/${this.node.id}`,
      },
    });
  }
}
