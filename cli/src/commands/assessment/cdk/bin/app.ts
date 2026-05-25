#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AssessmentWebStack } from '../lib/assessment-web-stack';

const app = new cdk.App();

const hostedZone = app.node.tryGetContext('hostedZone');
const subdomain = app.node.tryGetContext('subdomain') || 'assessment';
const certificateArn = app.node.tryGetContext('certificateArn');

new AssessmentWebStack(app, 'PrismAssessmentWeb', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  hostedZone,
  subdomain,
  certificateArn,
  description: 'PRISM Assessment Web - ECS Fargate with Cognito auth and ALB',
  tags: { Project: 'PRISM', Component: 'AssessmentWeb' },
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
app.synth();
