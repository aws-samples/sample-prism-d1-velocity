import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { SecurityAgentConstruct } from './constructs/security-agent-construct';
import { addSecurityAgentResources } from './security-agent-resources';

export interface SecurityAgentStackProps extends cdk.StackProps {
  /**
   * ARN of an existing KMS key to encrypt the agent space with. Its key policy
   * must already allow securityagent.amazonaws.com to encrypt and decrypt; an
   * imported key's policy cannot be changed from here. Default: a new key.
   */
  kmsKeyArn?: string;
}

/**
 * PrismD1SecurityAgent: AWS Security Agent for PRISM without the metrics
 * pipeline. Same resources, names and exports as the pipeline's
 * enableSecurityAgent=true path, plus its own KMS key. Only for accounts that
 * do not host Security Agent in PrismD1MetricsPipeline; the fixed resource
 * and export names make CloudFormation refuse a second copy.
 *
 * Not here: the security-agent-processor and remediation tracker Lambdas,
 * which read the pipeline's tables and stay in PrismD1MetricsPipeline.
 */
export class SecurityAgentStack extends cdk.Stack {
  public readonly securityAgent: SecurityAgentConstruct;

  constructor(scope: Construct, id: string, props: SecurityAgentStackProps = {}) {
    super(scope, id, props);

    let key: kms.IKey;
    if (props.kmsKeyArn) {
      key = kms.Key.fromKeyArn(this, 'SecurityAgentKey', props.kmsKeyArn);
    } else {
      // The same grants the pipeline's PrismDataKey gives Security Agent.
      const k = new kms.Key(this, 'SecurityAgentKey', {
        alias: 'alias/prism-d1-security-agent-key',
        description: 'Encryption key for the PRISM D1 Security Agent space',
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      k.grantEncryptDecrypt(new iam.ServicePrincipal('securityagent.amazonaws.com'));
      k.addToResourcePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('logs.amazonaws.com')],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/securityagent/*`,
          },
        },
      }));
      key = k;
    }

    this.securityAgent = addSecurityAgentResources(this, key);

    // The pipeline stack carries the same suppression stack-wide.
    NagSuppressions.addStackSuppressions(this, [{
      id: 'AwsSolutions-IAM5',
      reason: 'CDK KMS grant generates kms:GenerateDataKey* and kms:ReEncrypt* wildcard actions which are required for envelope encryption',
      appliesTo: ['Action::kms:GenerateDataKey*', 'Action::kms:ReEncrypt*'],
    }]);
  }
}
