/**
 * The Security Agent resources and the CI access to them, shared by the two
 * places they can live:
 *
 * - PrismD1MetricsPipeline, with context enableSecurityAgent=true (the
 *   original layout; existing accounts keep it);
 * - PrismD1SecurityAgent, the standalone stack (context
 *   securityAgentStandalone=true), for accounts that want Security Agent
 *   without the metrics pipeline.
 *
 * Construct ids are relative to the given scope, so the pipeline's logical ids
 * are unchanged by moving this code here. Both layouts use the same fixed names
 * (role, managed policy, bucket, SSM parameters, exports), so CloudFormation
 * refuses a second copy in the same account and region.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { SecurityAgentConstruct } from './constructs/security-agent-construct';

export function addSecurityAgentResources(scope: Construct, kmsKey: kms.IKey): SecurityAgentConstruct {
  const securityAgent = new SecurityAgentConstruct(scope, 'SecurityAgent', {
    agentSpaceName: 'prism-d1-security',
    description: 'PRISM D1 Continuum space for design review, code review, and pen testing',
    kmsKey: kmsKey,
    codeRemediationStrategy: 'DISABLED',
    tags: {
      'prism:pillar': 'security',
    },
  });

  // Grant GitHub OIDC roles access to scan bucket and Continuum APIs.
  // The OIDC role is created by `prism-cli bootstrapper setup-github-oidc`
  // with name pattern prism-d1-github-oidc-*.
  securityAgent.scanBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ArnPrincipal(`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:root`)],
      actions: ['s3:PutObject', 's3:GetObject'],
      resources: [securityAgent.scanBucket.arnForObjects('*')],
      conditions: {
        ArnLike: {
          'aws:PrincipalArn': `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/prism-d1-github-oidc-*`,
        },
      },
    }),
  );

  // Create a managed policy for Continuum scan API access.
  // Attached to the OIDC role by the bootstrapper setup script.
  const continuumCiPolicy = new iam.ManagedPolicy(scope, 'ContinuumCiPolicy', {
    managedPolicyName: 'prism-d1-continuum-ci-scan',
    description: 'Grants GitHub Actions workflows access to Continuum diff scan APIs and SSM config',
    statements: [
      new iam.PolicyStatement({
        sid: 'ContinuumScanAPIs',
        effect: iam.Effect.ALLOW,
        actions: [
          'securityagent:StartCodeReviewJob',
          'securityagent:BatchGetCodeReviewJobs',
          'securityagent:BatchGetCodeReviewJobTasks',
          'securityagent:ListFindings',
          'securityagent:BatchGetFindings',
          'securityagent:CreateCodeReview',
          'securityagent:ListCodeReviews',
        ],
        resources: [
          `arn:aws:securityagent:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:agent-space/*`,
        ],
      }),
      new iam.PolicyStatement({
        sid: 'PassRoleForCodeReview',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [securityAgent.serviceRole.roleArn],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'securityagent.amazonaws.com' },
        },
      }),
      new iam.PolicyStatement({
        sid: 'ScanBucketWrite',
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject', 's3:GetObject', 's3:ListBucket'],
        resources: [
          securityAgent.scanBucket.bucketArn,
          securityAgent.scanBucket.arnForObjects('*'),
        ],
      }),
      new iam.PolicyStatement({
        sid: 'KMSForScanBucket',
        effect: iam.Effect.ALLOW,
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: [kmsKey.keyArn],
      }),
      new iam.PolicyStatement({
        sid: 'SSMReadConfig',
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:PutParameter'],
        resources: [
          `arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/prism/continuum/*`,
        ],
      }),
    ],
  });

  NagSuppressions.addResourceSuppressions(
    continuumCiPolicy,
    [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Agent space ID is dynamic; wildcard scoped to securityagent service resources only',
        appliesTo: [`Resource::arn:aws:securityagent:<AWS::Region>:<AWS::AccountId>:agent-space/*`],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Scan bucket objects include dynamic diff filenames (SHA-based); wildcard on objects only',
        appliesTo: ['Resource::<SecurityAgentScanBucketB752F4A9.Arn>/*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'SSM parameters under /prism/continuum/ are all non-sensitive config values (IDs and bucket names)',
        appliesTo: ['Resource::arn:aws:ssm:<AWS::Region>:<AWS::AccountId>:parameter/prism/continuum/*'],
      },
    ],
    true,
  );

  new cdk.CfnOutput(scope, 'ContinuumCiPolicyArn', {
    value: continuumCiPolicy.managedPolicyArn,
    description: 'Attach this policy to your GitHub OIDC role for Continuum CI scans',
  });

  return securityAgent;
}
