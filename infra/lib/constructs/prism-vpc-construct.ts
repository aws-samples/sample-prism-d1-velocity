import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

/**
 * Creates a VPC with private subnets for PRISM Lambda functions.
 * Includes VPC endpoints for all required AWS services so Lambdas
 * can operate without internet access (data residency / IP protection).
 */
export class PrismVpcConstruct extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'PrismVpc', {
      vpcName: 'prism-d1-vpc',
      maxAzs: 2,
      natGateways: 0, // No internet access — all traffic through VPC endpoints
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'prism-private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
      flowLogs: {
        default: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(),
          trafficType: ec2.FlowLogTrafficType.ALL,
        },
      },
    });

    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSG', {
      vpc: this.vpc,
      securityGroupName: 'prism-d1-lambda-sg',
      description: 'Security group for PRISM D1 Lambda functions',
      allowAllOutbound: true, // Safe: VPC has no NAT/IGW, traffic only reaches AWS via endpoints
    });

    // --- Gateway endpoint: DynamoDB ---
    this.vpc.addGatewayEndpoint('DynamoDBEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // --- Gateway endpoint: S3 (free; used by the OTEL receiver archive writes) ---
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // --- Interface endpoints ---
    const interfaceEndpoints = [
      { id: 'EventBridgeEndpoint', service: ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE },
      { id: 'CloudWatchEndpoint', service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING },
      { id: 'CloudWatchLogsEndpoint', service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS },
      { id: 'KMSEndpoint', service: ec2.InterfaceVpcEndpointAwsService.KMS },
      { id: 'BedrockRuntimeEndpoint', service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME },
    ];

    for (const ep of interfaceEndpoints) {
      this.vpc.addInterfaceEndpoint(ep.id, {
        service: ep.service,
        privateDnsEnabled: true,
        securityGroups: [this.lambdaSecurityGroup],
      });
    }

    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      exportName: 'PrismD1VpcId',
    });

    NagSuppressions.addResourceSuppressions(this.lambdaSecurityGroup, [
      { id: 'CdkNagValidationFailure', reason: 'SG egress uses Fn::GetAtt for VPC CIDR which cannot be statically validated' },
    ]);
  }
}
