import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';

/**
 * Creates a Lambda Layer containing a guardrail enforcement client.
 * Any Lambda or agent can use this layer to check input/output
 * against the deployed Bedrock Guardrail before returning to the user.
 */
export class GuardrailEnforcerConstruct extends Construct {
  public readonly layer: lambda.LayerVersion;
  public readonly guardrailId: string;
  public readonly guardrailVersion: string;

  constructor(
    scope: Construct,
    id: string,
    props: { guardrailId: string; guardrailVersion: string },
  ) {
    super(scope, id);

    this.guardrailId = props.guardrailId;
    this.guardrailVersion = props.guardrailVersion;

    // The layer provides a simple guardrail enforcement utility
    this.layer = new lambda.LayerVersion(this, 'GuardrailEnforcerLayer', {
      layerVersionName: 'prism-d1-guardrail-enforcer',
      description: 'PRISM D1 Bedrock Guardrail enforcement client',
      compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'layers', 'guardrail-enforcer')),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'LayerArn', {
      value: this.layer.layerVersionArn,
      exportName: 'PrismD1GuardrailEnforcerLayerArn',
    });
  }

  /**
   * Grants a Lambda function permission to invoke the Bedrock Guardrail
   * and adds the layer + environment variables.
   */
  attachToFunction(fn: lambda.Function): void {
    fn.addLayers(this.layer);
    fn.addEnvironment('GUARDRAIL_ID', this.guardrailId);
    fn.addEnvironment('GUARDRAIL_VERSION', this.guardrailVersion);

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:ApplyGuardrail'],
        resources: ['*'],
      }),
    );
  }
}
