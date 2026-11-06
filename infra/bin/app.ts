#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { MetricsPipelineStack } from '../lib/metrics-pipeline-stack';
import { ApiStack } from '../lib/api-stack';
import { DashboardStack } from '../lib/dashboard-stack';
import { SecurityAgentStack } from '../lib/security-agent-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2',
};

// securityAgentStandalone=true builds ONLY PrismD1SecurityAgent: AWS Security
// Agent without the metrics pipeline (what `prism-cli enable security` deploys
// in an account that does not host it in the pipeline). It and
// enableSecurityAgent=true (Security Agent inside PrismD1MetricsPipeline) use
// the same resource and export names, so one account can only have one.
const standalone = app.node.tryGetContext('securityAgentStandalone') === 'true';
if (standalone && app.node.tryGetContext('enableSecurityAgent') === 'true') {
  throw new Error('securityAgentStandalone=true and enableSecurityAgent=true are exclusive: Security Agent lives either in PrismD1SecurityAgent or in PrismD1MetricsPipeline, never both.');
}

if (standalone) {
  new SecurityAgentStack(app, 'PrismD1SecurityAgent', {
    env,
    description: 'PRISM D1 Velocity - AWS Security Agent (standalone, without the metrics pipeline)',
    kmsKeyArn: app.node.tryGetContext('securityAgentKmsKeyArn') as string | undefined,
    tags: {
      'prism:project': 'PRISM',
      'prism:domain': 'D1-Velocity',
      'prism:component': 'SecurityAgent',
    },
  });
} else {
  const pipelineStack = new MetricsPipelineStack(app, 'PrismD1MetricsPipeline', {
    env,
    description: 'PRISM D1 Velocity - Core metrics event pipeline (EventBridge, DynamoDB)',
    tags: {
      'prism:project': 'PRISM',
      'prism:domain': 'D1-Velocity',
      'prism:component': 'MetricsPipeline',
    },
  });

  const apiStack = new ApiStack(app, 'PrismD1Api', {
    env,
    description: 'PRISM D1 Velocity - Metric ingestion and query API',
    eventBus: pipelineStack.eventBus,
    eventsTable: pipelineStack.eventsTable,
    metadataTable: pipelineStack.metadataTable,
    kmsKey: pipelineStack.kmsKey,
    tags: {
      'prism:project': 'PRISM',
      'prism:domain': 'D1-Velocity',
      'prism:component': 'Api',
    },
  });

  const dashboardStack = new DashboardStack(app, 'PrismD1Dashboard', {
    env,
    description: 'PRISM D1 Velocity - CloudWatch dashboards and alarms',
    productivityWidgetArn: pipelineStack.otelCollector?.productivityWidgetArn,
    velocityWidgetArn: pipelineStack.velocityWidgetArn,
    tags: {
      'prism:project': 'PRISM',
      'prism:domain': 'D1-Velocity',
      'prism:component': 'Dashboard',
    },
  });

  apiStack.addDependency(pipelineStack);
}

// Enable cdk-nag AWS Solutions checks on all stacks
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

app.synth();
