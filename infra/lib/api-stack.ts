import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

import * as kms from 'aws-cdk-lib/aws-kms';

export interface ApiStackProps extends cdk.StackProps {
  eventBus: events.EventBus;
  eventsTable: dynamodb.Table;
  metadataTable: dynamodb.Table;
  kmsKey: kms.IKey;
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // -------------------------------------------------------
    // Dead-letter queue for Lambda failures
    // -------------------------------------------------------
    const apiHandlerDlq = new sqs.Queue(this, 'ApiHandlerDLQ', {
      queueName: 'prism-d1-api-handler-dlq',
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    NagSuppressions.addResourceSuppressions(apiHandlerDlq, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This is a dead-letter queue itself; a DLQ on a DLQ is not needed.',
      },
    ]);

    // -------------------------------------------------------
    // API handler Lambda
    // -------------------------------------------------------
    const apiHandler = new lambda.Function(this, 'ApiHandler', {
      functionName: 'prism-d1-api-handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'api-handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda'), {
        bundling: {
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            'bash', '-c',
            [
              'npm init -y > /dev/null 2>&1',
              'npm install --save @aws-sdk/client-eventbridge @aws-sdk/client-dynamodb esbuild > /dev/null 2>&1',
              'npx esbuild api-handler.ts --bundle --platform=node --target=node22 --outfile=/asset-output/api-handler.js --external:@aws-sdk/*',
            ].join(' && '),
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                const { execSync } = require('child_process');
                execSync(
                  `npx esbuild ${path.join(__dirname, 'lambda', 'api-handler.ts')} --bundle --platform=node --target=node22 --outfile=${path.join(outputDir, 'api-handler.js')} --external:@aws-sdk/*`,
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
      reservedConcurrentExecutions: 10,
      deadLetterQueue: apiHandlerDlq,
      environment: {
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        EVENTS_TABLE: props.eventsTable.tableName,
        METADATA_TABLE: props.metadataTable.tableName,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: 'Handles PRISM D1 Velocity API requests',
    });

    // -------------------------------------------------------
    // IAM permissions
    // -------------------------------------------------------
    props.eventBus.grantPutEventsTo(apiHandler);
    props.eventsTable.grantReadData(apiHandler);
    props.metadataTable.grantReadWriteData(apiHandler);

    // -------------------------------------------------------
    // API Gateway access log group
    // -------------------------------------------------------
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: '/aws/apigateway/prism-d1-api-access',
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey: props.kmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -------------------------------------------------------
    // Request validator
    // -------------------------------------------------------

    // -------------------------------------------------------
    // API Gateway REST API
    // -------------------------------------------------------
    this.api = new apigateway.RestApi(this, 'PrismD1Api', {
      restApiName: 'PRISM D1 Velocity API',
      description: 'Metric ingestion and query API for PRISM D1 Velocity platform',
      deployOptions: {
        stageName: 'v1',
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
      },
    });

    const requestValidator = new apigateway.RequestValidator(this, 'RequestValidator', {
      restApi: this.api,
      requestValidatorName: 'prism-d1-body-validator',
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    // -------------------------------------------------------
    // API Key + Usage Plan
    // -------------------------------------------------------
    const apiKey = this.api.addApiKey('PrismD1ApiKey', {
      apiKeyName: 'prism-d1-velocity-key',
      description: 'API key for PRISM D1 Velocity metric ingestion',
    });

    const usagePlan = this.api.addUsagePlan('PrismD1UsagePlan', {
      name: 'prism-d1-standard',
      description: 'Standard usage plan for PRISM D1 API',
      throttle: {
        rateLimit: 50,
        burstLimit: 100,
      },
      quota: {
        limit: 100_000,
        period: apigateway.Period.MONTH,
      },
    });

    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: this.api.deploymentStage });

    // -------------------------------------------------------
    // Request model for POST /metrics
    // -------------------------------------------------------
    const metricsModel = new apigateway.Model(this, 'MetricsModel', {
      restApi: this.api,
      contentType: 'application/json',
      modelName: 'MetricsPayload',
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['detail-type', 'detail'],
        properties: {
          'detail-type': { type: apigateway.JsonSchemaType.STRING },
          detail: {
            type: apigateway.JsonSchemaType.OBJECT,
            required: ['team_id', 'repo', 'timestamp'],
            properties: {
              team_id: { type: apigateway.JsonSchemaType.STRING },
              repo: { type: apigateway.JsonSchemaType.STRING },
              timestamp: { type: apigateway.JsonSchemaType.STRING },
            },
          },
        },
      },
    });

    // -------------------------------------------------------
    // Lambda integration
    // -------------------------------------------------------
    const lambdaIntegration = new apigateway.LambdaIntegration(apiHandler, {
      proxy: true,
    });

    // POST /metrics
    const metricsResource = this.api.root.addResource('metrics');
    metricsResource.addMethod('POST', lambdaIntegration, {
      apiKeyRequired: true,
      requestValidator,
      requestModels: { 'application/json': metricsModel },
    });

    // GET /metrics/{team_id}
    const teamMetricsResource = metricsResource.addResource('{team_id}');
    teamMetricsResource.addMethod('GET', lambdaIntegration, {
      apiKeyRequired: true,
      requestValidator,
    });

    // POST /assessment
    const assessmentResource = this.api.root.addResource('assessment');
    assessmentResource.addMethod('POST', lambdaIntegration, {
      apiKeyRequired: true,
      requestValidator,
      requestModels: { 'application/json': metricsModel },
    });

    // POST /security-findings (Security Agent webhook)
    const securityResource = this.api.root.addResource('security-findings');
    securityResource.addMethod('POST', lambdaIntegration, {
      apiKeyRequired: true,
    });

    // GET /security-findings/{team_id}
    const teamSecurityResource = securityResource.addResource('{team_id}');
    teamSecurityResource.addMethod('GET', lambdaIntegration, {
      apiKeyRequired: true,
    });

    // -------------------------------------------------------
    // cdk-nag suppressions
    // -------------------------------------------------------

    NagSuppressions.addResourceSuppressions(
      this.api,
      [
        {
          id: 'AwsSolutions-APIG2',
          reason: 'Request validation is configured on individual methods via requestValidator.',
        },
      ],
      true,
    );

    // API Gateway uses API key auth; Cognito/IAM auth not required for this internal tool
    NagSuppressions.addResourceSuppressions(
      this.api,
      [
        {
          id: 'AwsSolutions-APIG4',
          reason:
            'API key authentication is used for this internal metrics ingestion API. ' +
            'Cognito/IAM authorization is not required for this use case.',
        },
        {
          id: 'AwsSolutions-COG4',
          reason:
            'This API uses API key auth, not Cognito. Cognito authorizer is not applicable.',
        },
      ],
      true,
    );

    // WAF is not attached — acceptable for an internal metrics API behind API keys
    NagSuppressions.addResourceSuppressions(
      this.api,
      [
        {
          id: 'AwsSolutions-APIG3',
          reason:
            'WAF is not required for this internal metrics API. ' +
            'Access is controlled via API keys and usage plans.',
        },
      ],
      true,
    );

    // Lambda IAM wildcard from CDK-generated policies (DynamoDB index ARNs)
    NagSuppressions.addResourceSuppressions(
      apiHandler,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Wildcard in DynamoDB index ARN is auto-generated by CDK grantReadData/grantReadWriteData ' +
            'to cover GSI access. The table ARN itself is scoped.',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AWSLambdaBasicExecutionRole is required for Lambda CloudWatch Logs access. ' +
            'This is the standard CDK-managed execution role.',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
        },
      ],
      true,
    );

    // cdk-nag: LogRetention and API GW CloudWatch role use CDK-managed IAM
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'CDK-internal constructs (LogRetention, API GW CloudWatch role) require AWS managed policies. ' +
          'These are not user-configurable.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'LogRetention custom resource requires wildcard permissions to manage log groups. ' +
          'This is a CDK-internal construct.',
        appliesTo: ['Resource::*'],
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'Lambda uses nodejs22.x which is the latest Node.js runtime available in CDK',
      },
    ]);

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'PRISM D1 Velocity API endpoint',
      exportName: 'PrismD1ApiUrl',
    });

    new cdk.CfnOutput(this, 'ApiKeyId', {
      value: apiKey.keyId,
      description: 'API Key ID (retrieve value from AWS Console or CLI)',
      exportName: 'PrismD1ApiKeyId',
    });
  }
}
