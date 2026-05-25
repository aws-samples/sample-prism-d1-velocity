import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as elbv2actions from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import * as path from 'path';

export interface AssessmentWebStackProps extends cdk.StackProps {
  hostedZone: string;
  subdomain: string;
  certificateArn?: string;
}

export class AssessmentWebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AssessmentWebStackProps) {
    super(scope, id, props);

    const domainName = `${props.subdomain}.${props.hostedZone}`;

    // VPC
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // VPC Flow Logs
    vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'VpcFlowLogs', { retention: logs.RetentionDays.ONE_MONTH }),
      ),
    });

    // Hosted Zone lookup
    const zone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: props.hostedZone,
    });

    // Certificate
    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn)
      : new acm.Certificate(this, 'Cert', {
          domainName,
          validation: acm.CertificateValidation.fromDns(zone),
        });

    // Cognito User Pool
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      advancedSecurityMode: cognito.AdvancedSecurityMode.ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolDomain = userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `prism-assessment-${cdk.Aws.ACCOUNT_ID}` },
    });

    const userPoolClient = userPool.addClient('AlbClient', {
      generateSecret: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`https://${domainName}/oauth2/idpresponse`],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });

    // ALB access logs bucket
    const accessLogsBucket = new s3.Bucket(this, 'AlbAccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
    });

    NagSuppressions.addResourceSuppressions(accessLogsBucket, [
      { id: 'AwsSolutions-S1', reason: 'Access log destination bucket would create infinite loop' },
    ]);

    // ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
    });
    alb.logAccessLogs(accessLogsBucket);

    NagSuppressions.addResourceSuppressions(alb, [
      { id: 'AwsSolutions-EC23', reason: 'Public ALB required for internet-facing web app with Cognito auth' },
    ], true);

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsights: true,
    });

    // Store config in SSM for container env
    const ecsModeSsm = new ssm.StringParameter(this, 'EcsModeParam', {
      parameterName: '/prism/assessment/ecs-mode',
      stringValue: 'true',
    });

    const portSsm = new ssm.StringParameter(this, 'PortParam', {
      parameterName: '/prism/assessment/port',
      stringValue: '3120',
    });

    // Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
    });

    const container = taskDef.addContainer('web', {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../web-app')),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'assessment-web',
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      secrets: {
        PRISM_ECS_MODE: ecs.Secret.fromSsmParameter(ecsModeSsm),
        PORT: ecs.Secret.fromSsmParameter(portSsm),
      },
      portMappings: [{ containerPort: 3120 }],
    });

    // ECS Service
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: false,
      minHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
    });

    // Grant SSM read
    ecsModeSsm.grantRead(taskDef.taskRole);
    portSsm.grantRead(taskDef.taskRole);

    // Grant Bedrock access for AI interview
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: ['arn:aws:bedrock:*:*:inference-profile/*', 'arn:aws:bedrock:*::foundation-model/*'],
    }));

    // Target Group
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TG', {
      vpc,
      port: 3120,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200,302',
      },
    });

    // HTTPS Listener with Cognito auth
    const httpsListener = alb.addListener('Https', {
      port: 443,
      certificates: [certificate],
      defaultAction: new elbv2actions.AuthenticateCognitoAction({
        userPool,
        userPoolClient,
        userPoolDomain,
        next: elbv2.ListenerAction.forward([targetGroup]),
      }),
    });

    // HTTP redirect to HTTPS
    alb.addListener('Http', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // DNS Record
    new route53.ARecord(this, 'DnsRecord', {
      zone,
      recordName: props.subdomain,
      target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(alb)),
    });

    // CDK-nag suppressions
    NagSuppressions.addResourceSuppressions(taskDef, [
      { id: 'AwsSolutions-IAM5', reason: 'ECS task execution role requires wildcard for ECR and logs' },
      { id: 'AwsSolutions-ECS2', reason: 'Environment variables injected via SSM Parameter Store secrets' },
    ], true);

    NagSuppressions.addResourceSuppressions(userPool, [
      { id: 'AwsSolutions-COG2', reason: 'MFA not required for internal assessment tool' },
      { id: 'AwsSolutions-COG8', reason: 'Plus tier not needed without MFA' },
    ]);

    // Outputs
    new cdk.CfnOutput(this, 'Url', { value: `https://${domainName}` });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'AlbDns', { value: alb.loadBalancerDnsName });
  }
}
