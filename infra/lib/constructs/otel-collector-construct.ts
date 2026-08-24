/**
 * PRISM D1 — OTEL Collector construct (on by default).
 *
 * Server side of `codeburn sync`: an HTTP API serving the codeburn discovery
 * doc and an OTLP/HTTP traces endpoint, authorized by OIDC JWT.
 *
 * Skip with:     cdk deploy -c skipOtelCollector=true
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
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
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
  /** Machine-to-machine client used by the coding agent's telemetry emitter. */
  public readonly agentClient?: cognito.UserPoolClient;
  /** Its credentials, read in CI with the ephemeral OIDC role. */
  public readonly agentSecret?: secretsmanager.Secret;
  /** ARN of the CloudWatch custom-widget Lambda (Developer Productivity table). */
  public productivityWidgetArn?: string;
  /** The otel-receiver Lambda — other constructs may grant themselves invoke
   *  for direct aggregation queries (single implementation, no drift). */
  public receiverFunction!: lambda.Function;

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
    let domainPrefix = '';
    let agentClientId = '';
    let machineIdentities = '';
    let tokenEndpoint = '';

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
      domainPrefix = `prism-d1-otel-${cdk.Aws.ACCOUNT_ID}`;
      this.userPool.addDomain('Domain', {
        cognitoDomain: { domainPrefix },
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

      // -----------------------------------------------------------------
      // Machine-to-machine path, for the coding agent's own telemetry
      // -----------------------------------------------------------------
      // The agent runs in CI, so there is no human to complete an
      // authorization-code flow. SAX-02 Outcome 3 names Cognito's
      // client-credentials flow as the machine-to-machine pattern, with a
      // resource server carrying fine-grained scopes; the alternative — a
      // Cognito user password in a repository secret — is what Outcome 1 lists
      // as "hardcoding credentials in application code or environment
      // variables".
      //
      // Client credentials require a resource server: Cognito rejects the grant
      // for a client whose only scopes are the standard openid/email/profile.
      const resourceServer = this.userPool.addResourceServer('PrismResourceServer', {
        identifier: 'prism',
        scopes: [{ scopeName: 'emit', scopeDescription: 'Emit usage and attribution spans' }],
      });

      this.agentClient = this.userPool.addClient('CodingAgentClient', {
        userPoolClientName: 'prism-coding-agent',
        generateSecret: true,
        // No authorization-code or SRP flow: this identity is never a person, and
        // leaving a human flow enabled on it would be a second way in.
        authFlows: {},
        oAuth: {
          flows: { clientCredentials: true, authorizationCodeGrant: false },
          scopes: [cognito.OAuthScope.resourceServer(resourceServer, {
            scopeName: 'emit',
            scopeDescription: 'Emit usage and attribution spans',
          })],
        },
        accessTokenValidity: cdk.Duration.hours(1),
        enableTokenRevocation: true,
        preventUserExistenceErrors: true,
      });

      // The credentials the CI job reads with its ephemeral OIDC role. Named
      // under prism-d1- because setup-github-oidc grants GetSecretValue scoped
      // to that prefix rather than to '*' — the role is assumed by a workflow
      // that runs agent-authored code.
      this.agentSecret = new secretsmanager.Secret(this, 'CodingAgentOidcSecret', {
        secretName: 'prism-d1-agent-oidc',
        description: 'Cognito client credentials for the PRISM coding agent telemetry emitter',
        secretObjectValue: {
          client_id: cdk.SecretValue.unsafePlainText(this.agentClient.userPoolClientId),
          // unsafePlainText names the risk accurately and it does not apply here:
          // the value is a CloudFormation reference resolved at deploy time, not a
          // literal in source. The client id is not sensitive; the secret is, and
          // it never leaves CloudFormation except into this secret.
          client_secret: this.agentClient.userPoolClientSecret,
        },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      // Cognito app-client secrets cannot be rotated in place — you would recreate
      // the client, which invalidates every outstanding token and every copy of the
      // old secret. The suppression documents why rotation is not configured rather
      // than silently ignoring the rule.
      NagSuppressions.addResourceSuppressions(this.agentSecret, [
        {
          id: 'AwsSolutions-SMG4',
          reason:
            'Cognito app-client secrets are immutable: rotating requires replacing the ' +
            'client, which invalidates all outstanding tokens. Rotation would be a ' +
            'client-replacement Lambda on a 90-day schedule, acceptable for a workshop ' +
            'sample but not implemented here. The secret is scoped to one user pool and ' +
            'grants only the prism/emit scope.',
        },
      ]);

      agentClientId = this.agentClient.userPoolClientId;
      // A client-credentials token has no username, no email, and a `sub` equal to
      // the app client id — so identity has to be mapped rather than read. Mapped
      // here, at deploy time, precisely so it is NOT caller-supplied: a payload
      // that could name its own author would let any holder of any token post as
      // anyone.
      machineIdentities = JSON.stringify({ [agentClientId]: 'prism-coding-agent' });
      tokenEndpoint = `https://${domainPrefix}.auth.${cdk.Aws.REGION}.amazoncognito.com/oauth2/token`;
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
        // clientId -> identity, for tokens that carry no username. Deploy-time
        // config so the author of a span is never caller-supplied.
        MACHINE_IDENTITIES: machineIdentities,
        MAX_BATCH_SIZE: '1000',
        SPAN_TTL_DAYS: '90',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: 'Receives codeburn sync OTLP traces: S3 archive + per-user span/daily-aggregate rows',
    });

    props.aiUsageTable.grantReadWriteData(receiver);
    this.archiveBucket.grantPut(receiver);
    props.kmsKey.grantEncryptDecrypt(receiver);
    this.receiverFunction = receiver;

    // -------------------------------------------------------
    // CloudWatch Custom Widget: Developer Productivity
    // Invoked by CloudWatch dashboards with the VIEWING user's IAM creds
    // (access = lambda:InvokeFunction on this function). Delegates
    // aggregation to the receiver's /v1/productivity handler via direct
    // invoke so there is a single aggregation implementation.
    // -------------------------------------------------------
    const productivityWidget = new lambda.Function(this, 'ProductivityWidget', {
      functionName: 'prism-d1-productivity-widget',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'productivity-widget.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda'), {
        bundling: {
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            'bash', '-c',
            [
              'npm init -y > /dev/null 2>&1',
              'npm install --save @aws-sdk/client-lambda esbuild > /dev/null 2>&1',
              'npx esbuild productivity-widget.ts --bundle --platform=node --target=node22 --outfile=/asset-output/productivity-widget.js --external:@aws-sdk/*',
            ].join(' && '),
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                const { execSync } = require('child_process');
                execSync(
                  `npx esbuild ${path.join(__dirname, '..', 'lambda', 'productivity-widget.ts')} --bundle --platform=node --target=node22 --outfile=${path.join(outputDir, 'productivity-widget.js')} --external:@aws-sdk/*`,
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
        RECEIVER_FUNCTION: receiver.functionName,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: 'CloudWatch custom widget: per-developer productivity table from the attribution store',
    });
    receiver.grantInvoke(productivityWidget);
    NagSuppressions.addResourceSuppressions(productivityWidget, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'lambda.grantInvoke scopes to the receiver function ARN plus its versions/aliases (<fn-arn>:*) — a single-function grant, not a broad wildcard.',
        appliesTo: [{ regex: '/^Resource::<OtelCollectorReceiver.*\\.Arn>:\\*$/' }],
      },
    ], true);
    this.productivityWidgetArn = productivityWidget.functionArn;

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
    // Both client ids: API Gateway validates `aud`, or `client_id` for Cognito
    // access tokens, and a client-credentials token carries the M2M client id.
    // Listing only the codeburn client would reject every agent span with a 401
    // that looks like a bad token rather than a missing audience entry.
    const authorizer = new HttpJwtAuthorizer('OtelJwtAuthorizer', issuer, {
      jwtAudience: agentClientId ? [clientId, agentClientId] : [clientId],
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
    // Logical IDs are overridden so the deploy output keys match the
    // README verbatim (construct nesting would otherwise mangle them to
    // OtelCollectorOtelCollectorUrl<hash>).
    // -------------------------------------------------------
    const urlOutput = new cdk.CfnOutput(this, 'OtelCollectorUrl', {
      value: this.httpApi.apiEndpoint,
      description: 'Run: codeburn sync setup <this URL>',
    });
    urlOutput.overrideLogicalId('OtelCollectorUrl');
    if (this.userPool) {
      const poolOutput = new cdk.CfnOutput(this, 'OtelUserPoolId', {
        value: this.userPool.userPoolId,
        description: 'Create users: aws cognito-idp admin-create-user --user-pool-id <this> --username <email>',
      });
      poolOutput.overrideLogicalId('OtelUserPoolId');
    }
    if (this.agentSecret) {
      // SSM parameters: the workflow reads these at run time instead of requiring
      // GitHub org variables. One source of truth, written by CDK at deploy time,
      // cannot drift from what's actually deployed.
      const ssmPrefix = '/prism/d1';
      new ssm.StringParameter(this, 'ParamCollectorUrl', {
        parameterName: `${ssmPrefix}/collector-url`,
        stringValue: this.httpApi.apiEndpoint,
        description: 'OTEL collector URL — read by the coding agent workflow',
        tier: ssm.ParameterTier.STANDARD,
      });
      new ssm.StringParameter(this, 'ParamTokenEndpoint', {
        parameterName: `${ssmPrefix}/token-endpoint`,
        stringValue: tokenEndpoint,
        description: 'Cognito token endpoint — read by the coding agent workflow',
        tier: ssm.ParameterTier.STANDARD,
      });
      new ssm.StringParameter(this, 'ParamAgentSecretId', {
        parameterName: `${ssmPrefix}/agent-secret-id`,
        stringValue: this.agentSecret.secretName,
        description: 'Secrets Manager id for the M2M client credentials',
        tier: ssm.ParameterTier.STANDARD,
      });

      // Outputs kept for discoverability — printed by `cdk deploy`, but no longer
      // need to be manually copied into GitHub.
      new cdk.CfnOutput(this, 'PrismAgentTokenEndpoint', {
        value: tokenEndpoint,
        description: 'Also available as SSM /prism/d1/token-endpoint',
      }).overrideLogicalId('PrismAgentTokenEndpoint');
      new cdk.CfnOutput(this, 'PrismAgentSecretId', {
        value: this.agentSecret.secretName,
        description: 'Also available as SSM /prism/d1/agent-secret-id',
      }).overrideLogicalId('PrismAgentSecretId');
    }
  }
}
