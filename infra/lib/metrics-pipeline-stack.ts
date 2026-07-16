import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';
import { BedrockGuardrailConstruct, createDefaultPrismGuardrailProps } from './constructs/bedrock-guardrail-construct';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { PrismVpcConstruct } from './constructs/prism-vpc-construct';
import { GuardrailEnforcerConstruct } from './constructs/guardrail-enforcer-construct';
import { SecurityAgentConstruct } from './constructs/security-agent-construct';
import { OtelCollectorConstruct } from './constructs/otel-collector-construct';
import { NagSuppressions } from 'cdk-nag';

export class MetricsPipelineStack extends cdk.Stack {
  public readonly eventBus: events.EventBus;
  public readonly eventsTable: dynamodb.Table;
  public readonly aiUsageTable: dynamodb.Table;
  public readonly metadataTable: dynamodb.Table;
  public readonly kmsKey: kms.Key;
  public readonly guardrail: BedrockGuardrailConstruct;
  public readonly securityAgent?: SecurityAgentConstruct;
  public readonly otelCollector?: OtelCollectorConstruct;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------
    // KMS encryption key (Pillar 6 — IP & Data Protection)
    // -------------------------------------------------------
    const prismKmsKey = new kms.Key(this, 'PrismDataKey', {
      alias: 'alias/prism-d1-data-key',
      description: 'Encryption key for PRISM D1 data at rest',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.kmsKey = prismKmsKey;

    // Grant Security Agent service access to KMS key for agent space encryption
    prismKmsKey.grantEncryptDecrypt(new iam.ServicePrincipal('securityagent.amazonaws.com'));
    // Grant CloudWatch Logs access to KMS key for encrypted log groups
    prismKmsKey.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('logs.amazonaws.com')],
      actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'kms:EncryptionContext:aws:logs:arn': [
            `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/securityagent/*`,
            `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/apigateway/prism-d1-*`,
          ],
        },
      },
    }));

    // -------------------------------------------------------
    // EventBridge custom event bus
    // -------------------------------------------------------
    this.eventBus = new events.EventBus(this, 'PrismMetricsBus', {
      eventBusName: 'prism-d1-metrics',
    });

    // -------------------------------------------------------
    // EventBridge resource policy — restrict PutEvents callers
    // -------------------------------------------------------
    new events.CfnEventBusPolicy(this, 'PrismBusPolicy', {
      eventBusName: this.eventBus.eventBusName,
      statementId: 'AllowOnlyPrismCallers',
      statement: {
        Effect: 'Allow',
        Principal: { AWS: cdk.Aws.ACCOUNT_ID },
        Action: 'events:PutEvents',
        Resource: this.eventBus.eventBusArn,
        Condition: {
          ArnLike: {
            'aws:PrincipalArn': [
              `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/prism-d1-github-oidc-*`,
              `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/${this.stackName}-*`,
            ],
          },
        },
      },
    });

    // -------------------------------------------------------
    // DynamoDB events table — KMS encrypted
    // -------------------------------------------------------
    this.eventsTable = new dynamodb.Table(this, 'EventsTable', {
      tableName: 'prism-d1-events',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: prismKmsKey,
    });

    this.eventsTable.addGlobalSecondaryIndex({
      indexName: 'by-detail-type',
      partitionKey: { name: 'detail_type', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.eventsTable.addGlobalSecondaryIndex({
      indexName: 'by-finding-id',
      partitionKey: { name: 'finding_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // -------------------------------------------------------
    // DynamoDB metadata table
    // -------------------------------------------------------
    this.metadataTable = new dynamodb.Table(this, 'TeamMetadataTable', {
      tableName: 'prism-team-metadata',
      partitionKey: { name: 'team_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: prismKmsKey,
    });

    // -------------------------------------------------------
    // DynamoDB AI-usage table — user-keyed, KMS encrypted
    // pk = USER#<email>
    // sk = COMMIT#<ts>#<sha>#<tool> | SUMMARY#<ts>#<tool> | AGG#<yyyy-mm>#<tool>
    // Sparse GSIs (only commit-level items set them) invert the user key so the
    // same table answers by-repo / by-PR / by-commit / global-by-date.
    // -------------------------------------------------------
    this.aiUsageTable = new dynamodb.Table(this, 'AiUsageTable', {
      tableName: 'prism-d1-ai-usage',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: prismKmsKey,
    });
    for (const [indexName, pkAttr, skAttr] of [
      ['by-repo', 'gsi_repo', 'gsi_repo_sk'],
      ['by-pr', 'gsi_pr', 'gsi_pr_sk'],
      ['by-commit', 'gsi_commit', 'gsi_commit_sk'],
      ['by-date', 'gsi_date', 'gsi_date_sk'],
    ] as const) {
      this.aiUsageTable.addGlobalSecondaryIndex({
        indexName,
        partitionKey: { name: pkAttr, type: dynamodb.AttributeType.STRING },
        sortKey: { name: skAttr, type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
    }

    // -------------------------------------------------------
    // VPC for Lambda isolation (Pillar 6)
    // Opt out with: cdk deploy -c skipVpc=true
    // Use existing VPC: cdk deploy -c vpcId=vpc-0123456789abcdef0
    // -------------------------------------------------------
    const skipVpc = this.node.tryGetContext('skipVpc') === 'true';
    const existingVpcId = this.node.tryGetContext('vpcId') as string | undefined;
    const vpcConstruct = skipVpc
      ? undefined
      : existingVpcId
        ? undefined
        : new PrismVpcConstruct(this, 'VPC');
    const lambdaVpcProps = skipVpc
      ? {}
      : existingVpcId
        ? { vpc: ec2.Vpc.fromLookup(this, 'ExistingVpc', { vpcId: existingVpcId }) }
        : { vpc: vpcConstruct!.vpc, securityGroups: [vpcConstruct!.lambdaSecurityGroup] };

    // -------------------------------------------------------
    // Metrics processor Lambda
    // -------------------------------------------------------
    const metricsProcessor = new lambda.Function(this, 'MetricsProcessor', {
      functionName: 'prism-d1-metrics-processor',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'metrics-processor.handler',
      ...lambdaVpcProps,
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda'), {
        bundling: {
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            'bash', '-c',
            [
              'npm init -y > /dev/null 2>&1',
              'npm install --save @aws-sdk/client-dynamodb @aws-sdk/client-cloudwatch esbuild > /dev/null 2>&1',
              'npx esbuild metrics-processor.ts --bundle --platform=node --target=node22 --outfile=/asset-output/metrics-processor.js --external:@aws-sdk/*',
            ].join(' && '),
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              // Local bundling via esbuild if available
              try {
                const { execSync } = require('child_process');
                execSync(
                  `npx esbuild ${path.join(__dirname, 'lambda', 'metrics-processor.ts')} --bundle --platform=node --target=node22 --outfile=${path.join(outputDir, 'metrics-processor.js')} --external:@aws-sdk/*`,
                  { stdio: 'pipe' },
                );
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        EVENTS_TABLE: this.eventsTable.tableName,
        METADATA_TABLE: this.metadataTable.tableName,
        METRIC_NAMESPACE: 'PRISM/D1/Velocity',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: 'Processes PRISM D1 metric events from EventBridge into DynamoDB and CloudWatch',
    });

    // -------------------------------------------------------
    // IAM permissions for the processor
    // -------------------------------------------------------
    this.eventsTable.grantWriteData(metricsProcessor);
    this.metadataTable.grantWriteData(metricsProcessor);

    metricsProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'cloudwatch:namespace': 'PRISM/D1/Velocity',
          },
        },
      }),
    );

    // -------------------------------------------------------
    // EventBridge rules — one per detail-type category
    // -------------------------------------------------------
    const detailTypes = [
      'prism.d1.commit',
      'prism.d1.pr',
      'prism.d1.deploy',
      'prism.d1.eval',
      'prism.d1.incident',
      'prism.d1.assessment',
      'prism.d1.agent',
      'prism.d1.agent.eval',
      'prism.d1.guardrail',
      'prism.d1.mcp.tool_call',
      'prism.d1.security',
      'prism.d1.security.design_review',
      'prism.d1.security.code_review',
      'prism.d1.security.pen_test',
      'prism.d1.security.remediation',
      'prism.d1.quality',
    ];

    for (const detailType of detailTypes) {
      const ruleName = detailType.replace(/\./g, '-');
      new events.Rule(this, `Rule-${ruleName}`, {
        ruleName: `prism-d1-${ruleName}`,
        eventBus: this.eventBus,
        eventPattern: {
          source: ['prism.d1.velocity'],
          detailType: [detailType],
        },
        targets: [new targets.LambdaFunction(metricsProcessor)],
        description: `Routes ${detailType} events to the metrics processor`,
      });
    }

    // -------------------------------------------------------
    // -------------------------------------------------------
    // Bedrock Guardrail (Pillar 4)
    // -------------------------------------------------------
    this.guardrail = new BedrockGuardrailConstruct(this, 'PrismGuardrail', createDefaultPrismGuardrailProps());

    // -------------------------------------------------------
    // OTEL Collector (opt-in — server side of `codeburn sync`)
    // Enable with: npx cdk deploy --context enableOtelCollector=true
    // BYO IdP:     -c otelIssuer=... -c otelClientId=... [-c otelIdentityClaim=email]
    // Per-user AI usage flows directly from codeburn sync to the
    // ai-usage table (spans + daily aggregates).
    // -------------------------------------------------------
    const enableOtelCollector = this.node.tryGetContext('enableOtelCollector') === 'true';
    if (enableOtelCollector) {
      this.otelCollector = new OtelCollectorConstruct(this, 'OtelCollector', {
        aiUsageTable: this.aiUsageTable,
        kmsKey: prismKmsKey,
        lambdaVpcProps,
        externalIssuer: this.node.tryGetContext('otelIssuer') as string | undefined,
        externalClientId: this.node.tryGetContext('otelClientId') as string | undefined,
        identityClaim: this.node.tryGetContext('otelIdentityClaim') as string | undefined,
      });
    }

    // -------------------------------------------------------
    // AWS Security Agent (opt-in — requires Security Agent access)
    // Enable with: npx cdk deploy --context enableSecurityAgent=true
    // -------------------------------------------------------
    const enableSecurityAgent = this.node.tryGetContext('enableSecurityAgent') === 'true';
    if (enableSecurityAgent) {
      this.securityAgent = new SecurityAgentConstruct(this, 'SecurityAgent', {
        agentSpaceName: 'prism-d1-security',
        description: 'PRISM D1 Security Agent space for design review, code review, and pen testing',
        kmsKey: prismKmsKey,
        codeRemediationStrategy: 'DISABLED',
        tags: {
          'prism:pillar': 'security',
        },
      });
    }

    // -------------------------------------------------------
    // Guardrail Enforcer Layer (Pillar 6)
    // -------------------------------------------------------
    const guardrailEnforcer = new GuardrailEnforcerConstruct(this, 'GuardrailEnforcer', {
      guardrailId: this.guardrail.guardrailId,
      guardrailVersion: this.guardrail.guardrailVersion,
    });

    // Attach guardrail enforcer to the metrics processor
    guardrailEnforcer.attachToFunction(metricsProcessor);

    // -------------------------------------------------------
    // Exfiltration Detector (Pillar 6)
    // -------------------------------------------------------
    const exfiltrationDetector = new lambda.Function(this, 'ExfiltrationDetector', {
      functionName: 'prism-d1-exfiltration-detector',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'exfiltration-detector.handler',
      ...lambdaVpcProps,
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda'), {
        bundling: {
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            'bash', '-c',
            [
              'npm init -y > /dev/null 2>&1',
              'npm install --save @aws-sdk/client-eventbridge esbuild > /dev/null 2>&1',
              'npx esbuild exfiltration-detector.ts --bundle --platform=node --target=node22 --outfile=/asset-output/exfiltration-detector.js --external:@aws-sdk/*',
            ].join(' && '),
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                const { execSync } = require('child_process');
                execSync(
                  `npx esbuild ${path.join(__dirname, 'lambda', 'exfiltration-detector.ts')} --bundle --platform=node --target=node22 --outfile=${path.join(outputDir, 'exfiltration-detector.js')} --external:@aws-sdk/*`,
                  { stdio: 'pipe' },
                );
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      environment: {
        EVENT_BUS_NAME: this.eventBus.eventBusName,
        ALERT_THRESHOLD_READS: '100',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: 'Detects anomalous read patterns on PRISM DynamoDB tables',
    });

    this.eventBus.grantPutEventsTo(exfiltrationDetector);

    // CloudTrail → EventBridge rule for DynamoDB read events on PRISM tables
    new events.Rule(this, 'DynamoDBReadDetectorRule', {
      ruleName: 'prism-d1-dynamodb-read-detector',
      eventPattern: {
        source: ['aws.dynamodb'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['dynamodb.amazonaws.com'],
          eventName: ['Query', 'Scan', 'GetItem', 'BatchGetItem'],
        },
      },
      targets: [new targets.LambdaFunction(exfiltrationDetector)],
      description: 'Routes DynamoDB read events to the exfiltration detector',
    });

    // -------------------------------------------------------
    // Defect Correlator (Pillar 7)
    // -------------------------------------------------------
    const defectCorrelator = new lambda.Function(this, 'DefectCorrelator', {
      functionName: 'prism-d1-defect-correlator',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'defect-correlator.handler',
      ...lambdaVpcProps,
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda'), {
        bundling: {
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            'bash', '-c',
            [
              'npm init -y > /dev/null 2>&1',
              'npm install --save @aws-sdk/client-dynamodb @aws-sdk/client-eventbridge esbuild > /dev/null 2>&1',
              'npx esbuild defect-correlator.ts --bundle --platform=node --target=node22 --outfile=/asset-output/defect-correlator.js --external:@aws-sdk/*',
            ].join(' && '),
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                const { execSync } = require('child_process');
                execSync(
                  `npx esbuild ${path.join(__dirname, 'lambda', 'defect-correlator.ts')} --bundle --platform=node --target=node22 --outfile=${path.join(outputDir, 'defect-correlator.js')} --external:@aws-sdk/*`,
                  { stdio: 'pipe' },
                );
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        EVENTS_TABLE: this.eventsTable.tableName,
        EVENT_BUS_NAME: this.eventBus.eventBusName,
        LOOKBACK_HOURS: '24',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: 'Correlates deployment failures with AI vs human commit origins',
    });

    this.eventsTable.grantReadData(defectCorrelator);
    this.eventBus.grantPutEventsTo(defectCorrelator);

    // Trigger defect correlator on failed deploy events
    new events.Rule(this, 'DeployToDefectCorrelatorRule', {
      ruleName: 'prism-d1-deploy-to-defect-correlator',
      eventBus: this.eventBus,
      eventPattern: {
        source: ['prism.d1.velocity'],
        detailType: ['prism.d1.deploy'],
      },
      targets: [new targets.LambdaFunction(defectCorrelator)],
      description: 'Triggers defect correlation on deployment events',
    });

    // -------------------------------------------------------
    // Spec-to-Code Calculator (Pillar 7)
    // -------------------------------------------------------
    const specToCodeCalc = new lambda.Function(this, 'SpecToCodeCalculator', {
      functionName: 'prism-d1-spec-to-code-calculator',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'spec-to-code-calculator.handler',
      ...lambdaVpcProps,
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda'), {
        bundling: {
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            'bash', '-c',
            [
              'npm init -y > /dev/null 2>&1',
              'npm install --save @aws-sdk/client-dynamodb @aws-sdk/client-eventbridge esbuild > /dev/null 2>&1',
              'npx esbuild spec-to-code-calculator.ts --bundle --platform=node --target=node22 --outfile=/asset-output/spec-to-code-calculator.js --external:@aws-sdk/*',
            ].join(' && '),
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                const { execSync } = require('child_process');
                execSync(
                  `npx esbuild ${path.join(__dirname, 'lambda', 'spec-to-code-calculator.ts')} --bundle --platform=node --target=node22 --outfile=${path.join(outputDir, 'spec-to-code-calculator.js')} --external:@aws-sdk/*`,
                  { stdio: 'pipe' },
                );
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        EVENTS_TABLE: this.eventsTable.tableName,
        EVENT_BUS_NAME: this.eventBus.eventBusName,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: 'Calculates spec-to-code hours for merged PRs with spec references',
    });

    this.eventsTable.grantReadData(specToCodeCalc);
    this.eventBus.grantPutEventsTo(specToCodeCalc);

    // Trigger spec-to-code calculator on merged PR events
    new events.Rule(this, 'PrToSpecCalcRule', {
      ruleName: 'prism-d1-pr-to-spec-calc',
      eventBus: this.eventBus,
      eventPattern: {
        source: ['prism.d1.velocity'],
        detailType: ['prism.d1.pr'],
      },
      targets: [new targets.LambdaFunction(specToCodeCalc)],
      description: 'Triggers spec-to-code calculation on merged PR events',
    });

    // -------------------------------------------------------
    // AWS Security Agent Integration
    // -------------------------------------------------------
    const securityAgentProcessor = new lambda.Function(this, 'SecurityAgentProcessor', {
      functionName: 'prism-d1-security-agent-processor',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'security-agent-processor.handler',
      ...lambdaVpcProps,
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda'), {
        bundling: {
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            'bash', '-c',
            [
              'npm init -y > /dev/null 2>&1',
              'npm install --save @aws-sdk/client-dynamodb @aws-sdk/client-eventbridge esbuild > /dev/null 2>&1',
              'npx esbuild security-agent-processor.ts --bundle --platform=node --target=node22 --outfile=/asset-output/security-agent-processor.js --external:@aws-sdk/*',
            ].join(' && '),
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                const { execSync } = require('child_process');
                execSync(
                  `npx esbuild ${path.join(__dirname, 'lambda', 'security-agent-processor.ts')} --bundle --platform=node --target=node22 --outfile=${path.join(outputDir, 'security-agent-processor.js')} --external:@aws-sdk/*`,
                  { stdio: 'pipe' },
                );
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      }),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        EVENTS_TABLE: this.eventsTable.tableName,
        METADATA_TABLE: this.metadataTable.tableName,
        EVENT_BUS_NAME: this.eventBus.eventBusName,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: 'Normalizes AWS Security Agent findings and emits to PRISM pipeline',
    });

    this.eventsTable.grantReadData(securityAgentProcessor);
    this.metadataTable.grantReadData(securityAgentProcessor);
    this.eventBus.grantPutEventsTo(securityAgentProcessor);

    // Security Remediation Tracker
    const securityRemediationTracker = new lambda.Function(this, 'SecurityRemediationTracker', {
      functionName: 'prism-d1-security-remediation-tracker',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'security-remediation-tracker.handler',
      ...lambdaVpcProps,
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda'), {
        bundling: {
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            'bash', '-c',
            [
              'npm init -y > /dev/null 2>&1',
              'npm install --save @aws-sdk/client-dynamodb @aws-sdk/client-eventbridge esbuild > /dev/null 2>&1',
              'npx esbuild security-remediation-tracker.ts --bundle --platform=node --target=node22 --outfile=/asset-output/security-remediation-tracker.js --external:@aws-sdk/*',
            ].join(' && '),
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                const { execSync } = require('child_process');
                execSync(
                  `npx esbuild ${path.join(__dirname, 'lambda', 'security-remediation-tracker.ts')} --bundle --platform=node --target=node22 --outfile=${path.join(outputDir, 'security-remediation-tracker.js')} --external:@aws-sdk/*`,
                  { stdio: 'pipe' },
                );
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        EVENTS_TABLE: this.eventsTable.tableName,
        EVENT_BUS_NAME: this.eventBus.eventBusName,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: 'Tracks Security Agent finding remediation via merged PRs',
    });

    this.eventsTable.grantReadData(securityRemediationTracker);
    this.eventBus.grantPutEventsTo(securityRemediationTracker);

    // Trigger remediation tracker on PR merge events
    new events.Rule(this, 'PrToRemediationTrackerRule', {
      ruleName: 'prism-d1-pr-to-remediation-tracker',
      eventBus: this.eventBus,
      eventPattern: {
        source: ['prism.d1.velocity'],
        detailType: ['prism.d1.pr'],
      },
      targets: [new targets.LambdaFunction(securityRemediationTracker)],
      description: 'Triggers security remediation tracking on merged PR events',
    });

    // Security Response Automator
    const securityResponseAutomator = new lambda.Function(this, 'SecurityResponseAutomator', {
      functionName: 'prism-d1-security-response-automator',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'security-response-automator.handler',
      ...lambdaVpcProps,
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda'), {
        bundling: {
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            'bash', '-c',
            [
              'npm init -y > /dev/null 2>&1',
              'npm install --save @aws-sdk/client-dynamodb @aws-sdk/client-eventbridge esbuild > /dev/null 2>&1',
              'npx esbuild security-response-automator.ts --bundle --platform=node --target=node22 --outfile=/asset-output/security-response-automator.js --external:@aws-sdk/*',
            ].join(' && '),
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                const { execSync } = require('child_process');
                execSync(
                  `npx esbuild ${path.join(__dirname, 'lambda', 'security-response-automator.ts')} --bundle --platform=node --target=node22 --outfile=${path.join(outputDir, 'security-response-automator.js')} --external:@aws-sdk/*`,
                  { stdio: 'pipe' },
                );
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        EVENTS_TABLE: this.eventsTable.tableName,
        EVENT_BUS_NAME: this.eventBus.eventBusName,
        GUARDRAIL_ID: this.guardrail.guardrailId,
        GUARDRAIL_VERSION: this.guardrail.guardrailVersion,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: 'Auto-responds to critical Security Agent findings (guardrail tightening, alerts)',
    });

    this.eventsTable.grantWriteData(securityResponseAutomator);
    this.eventBus.grantPutEventsTo(securityResponseAutomator);

    // Trigger automator on critical security findings
    new events.Rule(this, 'SecurityFindingToAutomatorRule', {
      ruleName: 'prism-d1-security-finding-to-automator',
      eventBus: this.eventBus,
      eventPattern: {
        source: ['prism.d1.velocity'],
        detailType: ['prism.d1.security.code_review', 'prism.d1.security.pen_test'],
      },
      targets: [new targets.LambdaFunction(securityResponseAutomator)],
      description: 'Triggers automated response on code review and pen test findings',
    });

    // -------------------------------------------------------
    // Data Residency Controls (Pillar 6)
    // -------------------------------------------------------
    metricsProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ['dynamodb:*'],
        resources: ['*'],
        conditions: {
          StringNotEquals: {
            'aws:RequestedRegion': cdk.Aws.REGION,
          },
        },
      }),
    );

    // -------------------------------------------------------
    // CDK-nag suppressions
    // -------------------------------------------------------
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is required for Lambda CloudWatch Logs access',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaVPCAccessExecutionRole is required for VPC-attached Lambdas to manage ENIs',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CDK grantWriteData/grantReadData generates wildcard for DynamoDB GSI index ARNs (table/*/index/*)',
        appliesTo: ['Resource::arn:<AWS::Partition>:dynamodb:<AWS::Region>:<AWS::AccountId>:table/prism-d1-events/index/*',
                    'Resource::arn:<AWS::Partition>:dynamodb:<AWS::Region>:<AWS::AccountId>:table/prism-team-metadata/index/*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CloudWatch PutMetricData does not support resource-level permissions',
        appliesTo: ['Resource::*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CDK KMS grant generates kms:GenerateDataKey* and kms:ReEncrypt* wildcard actions which are required for envelope encryption',
        appliesTo: ['Action::kms:GenerateDataKey*', 'Action::kms:ReEncrypt*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CDK grantReadData on DynamoDB generates wildcard for GSI index ARNs via token reference',
        appliesTo: ['Resource::<EventsTableD24865E5.Arn>/index/*', 'Resource::<AiUsageTable79F37CE0.Arn>/index/*'],
      },
      { id: 'AwsSolutions-L1', reason: 'All Lambdas use nodejs22.x which is the latest Node.js runtime available' },
    ]);

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'EventBusArn', {
      value: this.eventBus.eventBusArn,
      description: 'PRISM D1 Metrics EventBridge bus ARN',
      exportName: 'PrismD1EventBusArn',
    });

    new cdk.CfnOutput(this, 'EventsTableName', {
      value: this.eventsTable.tableName,
      exportName: 'PrismD1EventsTable',
    });

    new cdk.CfnOutput(this, 'MetadataTableName', {
      value: this.metadataTable.tableName,
      exportName: 'PrismD1MetadataTable',
    });
  }
}
