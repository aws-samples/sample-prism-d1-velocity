/**
 * PRISM D1 — OTEL Collector construct (opt-in).
 *
 * Server side of `codeburn sync`: an HTTP API serving the codeburn discovery
 * doc and an OTLP/HTTP traces endpoint, authorized by OIDC JWT.
 *
 * Enable with:   cdk deploy -c enableOtelCollector=true
 * BYO IdP with:  -c otelIssuer=... -c otelClientId=... [-c otelIdentityClaim=email]
 *
 * Default mode provisions a Cognito User Pool (admin-create-user only,
 * username = email, PKCE public client) with loopback callback URLs matching
 * codeburn's fixed callback ports (19876-19878). BYO mode skips Cognito and
 * wires the JWT authorizer to the external issuer.
 *
 * Data flow: codeburn sync push → API Gateway (JWT authorizer) → receiver
 * Lambda → S3 raw OTLP archive (external contract) + DynamoDB span/aggregate
 * rows (PRISM dashboards).
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as path from 'path';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

/** codeburn sync fixed loopback callback ports (see codeburn src/sync/auth.ts). */
const CODEBURN_CALLBACK_PORTS = [19876, 19877, 19878];

export interface OtelCollectorConstructProps {
  /** The prism-d1-ai-usage table — receiver writes SPAN# and OTEL#DAY# items. */
  aiUsageTable: dynamodb.Table;
  /** KMS key for the S3 archive bucket. */
  kmsKey: kms.IKey;
  /** VPC props spread applied to the receiver Lambda (matches stack pattern). */
  lambdaVpcProps?: { vpc?: cdk.aws_ec2.IVpc; securityGroups?: cdk.aws_ec2.ISecurityGroup[] };
  /** BYO IdP: OIDC issuer URL. When set, Cognito is NOT provisioned. */
  externalIssuer?: string;
  /** BYO IdP: OAuth client ID registered for codeburn (public client + PKCE). */
  externalClientId?: string;
  /** JWT claim used as the user identity key (default: username for Cognito, sub for BYO). */
  identityClaim?: string;
}

export class OtelCollectorConstruct extends Construct {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly archiveBucket: s3.Bucket;
  public readonly userPool?: cognito.UserPool;
  public readonly userPoolClient?: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: OtelCollectorConstructProps) {
    super(scope, id);

    const byoIdp = !!props.externalIssuer;
    if (byoIdp && !props.externalClientId) {
      throw new Error('otelClientId is required when otelIssuer is set');
    }

    // -------------------------------------------------------
    // OIDC provider — Cognito (default) or BYO issuer
    // -------------------------------------------------------
    let issuer: string;
    let clientId: string;
    let identityClaim: string;

    if (byoIdp) {
      issuer = props.externalIssuer!.replace(/\/$/, '');
      clientId = props.externalClientId!;
      identityClaim = props.identityClaim ?? 'sub';
    } else {
      // Admin-create-user only (no self-signup); username = email so DDB keys
      // line up with the USER#<email> key convention. We do NOT use
      // signInAliases: { email: true } because that generates a random UUID
      // as the internal username — the access token's `username` claim would
      // carry the UUID, not the email. Instead, admins create users with
      // --username dev@example.com and the `username` claim = the email.
      this.userPool = new cognito.UserPool(this, 'UserPool', {
        userPoolName: 'prism-d1-otel-users',
        selfSignUpEnabled: false,
        passwordPolicy: {
          minLength: 12,
          requireLowercase: true,
          requireUppercase: true,
          requireDigits: true,
          requireSymbols: true,
        },
        advancedSecurityMode: cognito.AdvancedSecurityMode.ENFORCED,
        featurePlan: cognito.FeaturePlan.PLUS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      // Hosted UI domain — prefix must be globally unique per region.
      this.userPool.addDomain('Domain', {
        cognitoDomain: { domainPrefix: `prism-d1-otel-${cdk.Aws.ACCOUNT_ID}` },
      });

      // Public client (no secret) — codeburn does Authorization Code + PKCE
      // with loopback redirects. Cognito allows http:// for localhost, 127.0.0.1,
      // and [::1] (per CreateUserPoolClient API docs). codeburn uses 127.0.0.1.
      const callbackUrls = CODEBURN_CALLBACK_PORTS.map(
        (port) => `http://127.0.0.1:${port}/callback`,
      );
      this.userPoolClient = this.userPool.addClient('CodeburnClient', {
        userPoolClientName: 'codeburn-sync',
        generateSecret: false,
        authFlows: { userSrp: true },
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
          callbackUrls,
        },
        preventUserExistenceErrors: true,
        accessTokenValidity: cdk.Duration.hours(1),
        refreshTokenValidity: cdk.Duration.days(30),
      });

      issuer = `https://cognito-idp.${cdk.Aws.REGION}.amazonaws.com/${this.userPool.userPoolId}`;
      clientId = this.userPoolClient.userPoolClientId;
      // Cognito ACCESS tokens carry `username` (no email claim) — with
      // email-alias sign-in and admin-created users, username == email.
      identityClaim = props.identityClaim ?? 'username';
    }

    // -------------------------------------------------------
    // S3 archive — raw OTLP batches, the external consumption contract
    // -------------------------------------------------------
    this.archiveBucket = new s3.Bucket(this, 'ArchiveBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{
        id: 'expire-raw-otlp',
        expiration: cdk.Duration.days(365),
      }],
    });

    // -------------------------------------------------------
    // Receiver Lambda — discovery doc + OTLP traces ingestion
    // -------------------------------------------------------
    const receiver = new lambda.Function(this, 'Receiver', {
      functionName: 'prism-d1-otel-receiver',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'otel-receiver.handler',
      ...(props.lambdaVpcProps ?? {}),
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda'), {
        bundling: {
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            'bash', '-c',
            [
              'npm init -y > /dev/null 2>&1',
              'npm install --save @aws-sdk/client-dynamodb @aws-sdk/client-s3 esbuild > /dev/null 2>&1',
              'npx esbuild otel-receiver.ts --bundle --platform=node --target=node22 --outfile=/asset-output/otel-receiver.js --external:@aws-sdk/*',
            ].join(' && '),
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                const { execSync } = require('child_process');
                execSync(
                  `npx esbuild ${path.join(__dirname, '..', 'lambda', 'otel-receiver.ts')} --bundle --platform=node --target=node22 --outfile=${path.join(outputDir, 'otel-receiver.js')} --external:@aws-sdk/*`,
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
      memorySize: 512,
      environment: {
        AI_USAGE_TABLE: props.aiUsageTable.tableName,
        ARCHIVE_BUCKET: this.archiveBucket.bucketName,
        IDENTITY_CLAIM: identityClaim,
        OIDC_ISSUER: issuer,
        OIDC_CLIENT_ID: clientId,
        MAX_BATCH_SIZE: '1000',
        SPAN_TTL_DAYS: '90',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: 'Receives codeburn sync OTLP traces: S3 archive + per-user span/daily-aggregate rows',
    });

    props.aiUsageTable.grantReadWriteData(receiver);
    this.archiveBucket.grantPut(receiver);
    props.kmsKey.grantEncryptDecrypt(receiver);

    // -------------------------------------------------------
    // HTTP API — discovery (public) + traces (JWT)
    // -------------------------------------------------------
    this.httpApi = new apigwv2.HttpApi(this, 'Api', {
      apiName: 'prism-d1-otel-collector',
      description: 'PRISM D1 OTEL collector for codeburn sync',
    });

    const integration = new HttpLambdaIntegration('ReceiverIntegration', receiver);

    // HTTP API JWT authorizers validate the `aud` claim, or `client_id` for
    // Cognito access tokens — both paths work with jwtAudience = [clientId].
    const authorizer = new HttpJwtAuthorizer('OtelJwtAuthorizer', issuer, {
      jwtAudience: [clientId],
    });

    // Discovery doc — unauthenticated by design (it only exposes issuer +
    // client_id, both public values in an OAuth public-client flow).
    this.httpApi.addRoutes({
      path: '/.well-known/codeburn-export.json',
      methods: [apigwv2.HttpMethod.GET],
      integration,
    });

    this.httpApi.addRoutes({
      path: '/v1/traces',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer,
    });

    // Access logging on the default stage (AwsSolutions-APIG1).
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: '/aws/apigateway/prism-d1-otel-collector',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const defaultStage = this.httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    defaultStage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        httpMethod: '$context.httpMethod',
        path: '$context.path',
        status: '$context.status',
        responseLength: '$context.responseLength',
        userAgent: '$context.identity.userAgent',
      }),
    };

    // -------------------------------------------------------
    // cdk-nag suppressions (with evidence)
    // -------------------------------------------------------
    NagSuppressions.addResourceSuppressions(receiver, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'grantPut generates s3:Abort* + bucket/* wildcard scoped to the single OTLP archive bucket',
        appliesTo: ['Action::s3:Abort*', { regex: '/^Resource::<OtelCollectorArchiveBucket.*\\.Arn>\\/\\*$/g' }],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'grantReadWriteData generates a wildcard for the AI-usage table GSI index ARNs',
        appliesTo: [{ regex: '/^Resource::<AiUsageTable.*\\.Arn>\\/index\\/\\*$/g' }],
      },
    ], true);
    NagSuppressions.addResourceSuppressions(this.httpApi, [
      {
        id: 'AwsSolutions-APIG4',
        reason: 'The codeburn discovery doc route is unauthenticated by design — it only publishes the OIDC issuer and public client_id (both non-secret in an OAuth public-client PKCE flow). The traces route is JWT-authorized.',
      },
    ], true);
    NagSuppressions.addResourceSuppressions(this.archiveBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'Telemetry archive bucket for a sample project; access is limited to the receiver Lambda (put) and account principals. Enable S3 server access logging or CloudTrail data events for production hardening.',
      },
    ]);
    if (this.userPool) {
      NagSuppressions.addResourceSuppressions(this.userPool, [
        {
          id: 'AwsSolutions-COG2',
          reason: 'MFA is not required for the codeburn telemetry-push user pool: users are admin-created, the client is scoped to telemetry writes only, and MFA on a CLI OIDC device flow adds friction disproportionate to the data sensitivity. Enable MFA for production hardening.',
        },
      ]);
    }

    // -------------------------------------------------------
    // Outputs — everything needed to run `codeburn sync setup <url>`
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'OtelCollectorUrl', {
      value: this.httpApi.apiEndpoint,
      description: 'Run: codeburn sync setup <this URL>',
    });
    if (this.userPool) {
      new cdk.CfnOutput(this, 'OtelUserPoolId', {
        value: this.userPool.userPoolId,
        description: 'Create users: aws cognito-idp admin-create-user --user-pool-id <this> --username <email>',
      });
    }
  }
}
