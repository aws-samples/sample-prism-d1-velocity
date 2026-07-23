import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

const METRIC_NAMESPACE = 'PRISM/D1/Velocity';
const DEFAULT_PERIOD = cdk.Duration.hours(1);

export class DashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // cdk-nag: CloudWatch alarms in this stack are for observability dashboards.
    // SNS alarm actions are configured by operators post-deployment.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-SNS2',
        reason: 'Alarm notification topics are configured post-deployment by operators.',
      },
      {
        id: 'AwsSolutions-SNS3',
        reason: 'Alarm notification topics are configured post-deployment by operators.',
      },
    ]);

    // =======================================================
    // Dashboard 1: Team Velocity
    // =======================================================
    const teamDashboard = new cloudwatch.Dashboard(this, 'TeamVelocityDashboard', {
      dashboardName: 'PRISM-D1-Team-Velocity',
      defaultInterval: cdk.Duration.days(7),
    });

    // --- AI Acceptance Rate (time series) ---
    const aiAcceptanceMetric = new cloudwatch.Metric({
      namespace: METRIC_NAMESPACE,
      metricName: 'AIAcceptanceRate',
      statistic: 'Average',
      period: DEFAULT_PERIOD,
      label: 'AI Acceptance Rate (%)',
    });

    teamDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# PRISM D1 - Team Velocity Dashboard\nReal-time AI-enhanced DORA metrics for engineering teams.',
        width: 24,
        height: 1,
      }),
    );

    teamDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'AI Acceptance Rate',
        left: [aiAcceptanceMetric],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, max: 100, label: 'Percent' },
        statistic: 'Average',
        period: DEFAULT_PERIOD,
      }),
      new cloudwatch.GraphWidget({
        title: 'Deployment Frequency',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'DeploymentFrequency',
            statistic: 'Sum',
            period: cdk.Duration.days(1),
            label: 'Deploys / Day',
          }),
        ],
        width: 12,
        height: 6,
        view: cloudwatch.GraphWidgetView.BAR,
        leftYAxis: { min: 0, label: 'Deployments' },
      }),
    );

    teamDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lead Time for Changes',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'LeadTimeForChanges',
            statistic: 'Average',
            period: DEFAULT_PERIOD,
            label: 'Lead Time (seconds)',
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, label: 'Seconds' },
      }),
      new cloudwatch.GaugeWidget({
        title: 'Eval Gate Pass Rate',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'EvalGatePassRate',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'Eval Pass Rate (%)',
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, max: 100 },
      }),
      new cloudwatch.GraphWidget({
        title: 'AI Test Coverage Delta',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AITestCoverageDelta',
            statistic: 'Average',
            period: DEFAULT_PERIOD,
            label: 'Coverage Delta (%)',
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: { label: 'Percent' },
      }),
    );

    // --- Additional team metrics row ---
    teamDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Change Failure Rate',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'ChangeFailureRate',
            statistic: 'Average',
            period: DEFAULT_PERIOD,
            label: 'Change Failure Rate (%)',
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, max: 100, label: 'Percent' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Mean Time to Recovery',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'MTTR',
            statistic: 'Average',
            period: DEFAULT_PERIOD,
            label: 'MTTR (seconds)',
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, label: 'Seconds' },
      }),
      new cloudwatch.GraphWidget({
        title: 'AI to Merge Ratio',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AIToMergeRatio',
            statistic: 'Average',
            period: DEFAULT_PERIOD,
            label: 'AI-to-Merge Ratio (%)',
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, max: 100, label: 'Percent' },
      }),
    );

    // --- Agent Metrics Row ---
    const teamId = 'ALL';
    const repository = 'ALL';

    teamDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### AI Token Usage & Cost',
        width: 24,
        height: 1,
      }),
    );

    teamDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'AI Input Tokens',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AIInputTokens',
            statistic: 'Sum',
            period: DEFAULT_PERIOD,
            label: 'Input Tokens',
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, label: 'Tokens' },
      }),
      new cloudwatch.GraphWidget({
        title: 'AI Output Tokens',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AIOutputTokens',
            statistic: 'Sum',
            period: DEFAULT_PERIOD,
            label: 'Output Tokens',
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, label: 'Tokens' },
      }),
      new cloudwatch.GraphWidget({
        title: 'AI Cost (USD)',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AICostUSD',
            statistic: 'Sum',
            period: DEFAULT_PERIOD,
            label: 'Cost (USD)',
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, label: 'USD' },
      }),
    );

    // Cost breakdowns by Tool and Model. SEARCH expressions auto-discover
    // every dimension value, so new tools/models appear without dashboard
    // changes. These series are populated by the otel-metrics-publisher
    // (requires -c enableOtelCollector=true); the trailer path has no
    // per-tool/per-model breakdown and leaves these widgets empty.
    teamDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'AI Cost by Tool (USD)',
        left: [
          new cloudwatch.MathExpression({
            expression: `SEARCH('{${METRIC_NAMESPACE},Tool} MetricName="AICostUSD"', 'Sum')`,
            usingMetrics: {},
            // Dynamic label: each discovered series is legend-labeled with
            // its Tool dimension value (e.g. "claude-code").
            label: "${PROP('Dim.Tool')}",
            period: DEFAULT_PERIOD,
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'USD' },
        legendPosition: cloudwatch.LegendPosition.RIGHT,
      }),
      new cloudwatch.GraphWidget({
        title: 'AI Cost by Model (USD)',
        left: [
          new cloudwatch.MathExpression({
            expression: `SEARCH('{${METRIC_NAMESPACE},Model} MetricName="AICostUSD"', 'Sum')`,
            usingMetrics: {},
            // Dynamic label: each discovered series is legend-labeled with
            // its Model dimension value (e.g. "claude-sonnet-4-5-20250929").
            label: "${PROP('Dim.Model')}",
            period: DEFAULT_PERIOD,
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'USD' },
        legendPosition: cloudwatch.LegendPosition.RIGHT,
      }),
    );

    teamDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### Agent Operations',
        width: 24,
        height: 1,
      }),
    );

    teamDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Agent Invocations',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AgentInvocationCount',
            dimensionsMap: { TeamId: teamId, Repository: repository },
            statistic: 'Sum',
            period: DEFAULT_PERIOD,
            label: 'Invocations',
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Agent Success Rate',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AgentSuccessRate',
            dimensionsMap: { TeamId: teamId, Repository: repository },
            statistic: 'Average',
            period: DEFAULT_PERIOD,
            label: 'Success Rate (%)',
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, max: 100, label: 'Percent' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Agent Avg Duration',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AgentDurationMs',
            dimensionsMap: { TeamId: teamId, Repository: repository },
            statistic: 'Average',
            period: DEFAULT_PERIOD,
            label: 'Duration (ms)',
          }),
        ],
        width: 8,
        height: 6,
      }),
    );

    // =======================================================
    // Dashboard 2: Executive Readout
    // =======================================================
    const execDashboard = new cloudwatch.Dashboard(this, 'ExecutiveReadoutDashboard', {
      dashboardName: 'PRISM-D1-Executive-Readout',
      defaultInterval: cdk.Duration.days(30),
    });

    execDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# PRISM D1 - Executive Readout\nLeadership view of AI-assisted engineering velocity and DORA performance.',
        width: 24,
        height: 1,
      }),
    );

    // --- PRISM Level Progress + Enhanced DORA Summary row ---
    execDashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'PRISM Level Progress',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'PRISMLevel',
            statistic: 'Maximum',
            period: cdk.Duration.days(1),
            label: 'Current PRISM Level',
          }),
        ],
        width: 6,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Enhanced DORA Summary',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'DeploymentFrequency',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Deploy Freq (7d)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'LeadTimeForChanges',
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'Avg Lead Time (s)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'ChangeFailureRate',
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'Change Fail Rate (%)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'MTTR',
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'Avg MTTR (s)',
          }),
        ],
        width: 12,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'AI Cost & Cycle Time',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AICostUSD',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Total AI Cost (7d, USD)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SpecToCodeHours',
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'Avg Spec-to-Code (hrs)',
          }),
        ],
        width: 6,
        height: 4,
      }),
    );

    // --- AI Contribution Trend + Feature Cycle Time Trend ---
    execDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'AI Contribution Trend',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AIAcceptanceRate',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'AI Acceptance Rate (%)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AIToMergeRatio',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'AI-to-Merge Ratio (%)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AITestCoverageDelta',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'AI Test Coverage Delta (%)',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, max: 100, label: 'Percent' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Feature Cycle Time Trend',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SpecToCodeHours',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'Spec-to-Code (hrs)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'LeadTimeForChanges',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'Lead Time (seconds)',
          }),
        ],
        width: 12,
        height: 6,
      }),
    );

    // --- Eval gate, quality, and cost trend row ---
    execDashboard.addWidgets(
      new cloudwatch.GaugeWidget({
        title: 'Eval Gate Pass Rate',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'EvalGatePassRate',
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'Eval Pass Rate (%)',
          }),
        ],
        width: 6,
        height: 6,
        leftYAxis: { min: 0, max: 100 },
      }),
      new cloudwatch.GraphWidget({
        title: 'Post-Merge Defect Rate',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'PostMergeDefectRate',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'Defect Rate (%)',
          }),
        ],
        width: 6,
        height: 6,
        leftYAxis: { min: 0, label: 'Percent' },
      }),
      new cloudwatch.GraphWidget({
        title: 'AI Cost Trend (Weekly)',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AICostUSD',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Total Cost (USD)',
          }),
        ],
        width: 6,
        height: 6,
        leftYAxis: { min: 0, label: 'USD' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Deployment Frequency (Weekly)',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'DeploymentFrequency',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Deploys / Week',
          }),
        ],
        width: 6,
        height: 6,
        view: cloudwatch.GraphWidgetView.BAR,
        leftYAxis: { min: 0, label: 'Deployments' },
      }),
    );

    // =======================================================
    // CloudWatch Alarms
    // =======================================================

    // Alarm: AI acceptance rate dropping below 20%
    new cloudwatch.Alarm(this, 'AiAcceptanceRateLowAlarm', {
      alarmName: 'PRISM-D1-AIAcceptanceRate-Low',
      alarmDescription: 'AI acceptance rate has dropped below 20%, indicating potential issues with AI-generated code quality or review friction.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'AIAcceptanceRate',
        statistic: 'Average',
        period: cdk.Duration.hours(6),
      }),
      threshold: 20,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: Eval gate pass rate dropping below 70%
    new cloudwatch.Alarm(this, 'EvalGatePassRateLowAlarm', {
      alarmName: 'PRISM-D1-EvalGatePassRate-Low',
      alarmDescription: 'Eval gate pass rate has dropped below 70%, indicating degraded quality in AI-generated outputs.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'EvalGatePassRate',
        statistic: 'Average',
        period: cdk.Duration.hours(6),
      }),
      threshold: 70,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: Change failure rate exceeding 20%
    new cloudwatch.Alarm(this, 'ChangeFailureRateHighAlarm', {
      alarmName: 'PRISM-D1-ChangeFailureRate-High',
      alarmDescription: 'Change failure rate exceeds 20%, indicating deployment quality regression.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'ChangeFailureRate',
        statistic: 'Average',
        period: cdk.Duration.hours(6),
      }),
      threshold: 20,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // =======================================================
    // Team Dashboard: Eval Gate by Rubric (Pillar 2)
    // =======================================================
    teamDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### Eval Gate Quality by Rubric',
        width: 24,
        height: 1,
      }),
    );

    const rubricNames = ['code-quality', 'api-response-quality', 'agent-quality', 'security-compliance', 'spec-compliance'];
    teamDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Eval Pass Rate by Rubric',
        left: rubricNames.map((rubric) =>
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'EvalGatePassRateByRubric',
            dimensionsMap: { RubricName: rubric },
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: rubric,
          }),
        ),
        width: 12,
        height: 6,
        leftYAxis: { min: 0, max: 100, label: 'Pass Rate (%)' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Eval Score Trend',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'EvalScore',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'Avg Eval Score',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, max: 1, label: 'Score (0-1)' },
      }),
    );

    // =======================================================
    // Team Dashboard: Guardrails & Safety (Pillar 4)
    // =======================================================
    teamDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### Guardrails & Safety',
        width: 24,
        height: 1,
      }),
    );

    const guardrailCategories = ['CONTENT_FILTER', 'DENIED_TOPIC', 'SENSITIVE_INFO', 'WORD_FILTER'];
    teamDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Guardrail Triggers by Category',
        left: guardrailCategories.map((category) =>
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'GuardrailTriggerCount',
            dimensionsMap: { TriggerCategory: category },
            statistic: 'Sum',
            period: DEFAULT_PERIOD,
            label: category,
          }),
        ),
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Triggers' },
        view: cloudwatch.GraphWidgetView.BAR,
      }),
      new cloudwatch.GraphWidget({
        title: 'Guardrail Actions: Block vs Anonymize',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'GuardrailBlockCount',
            statistic: 'Sum',
            period: DEFAULT_PERIOD,
            label: 'Blocked',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'GuardrailAnonymizeCount',
            statistic: 'Sum',
            period: DEFAULT_PERIOD,
            label: 'Anonymized',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Count' },
      }),
    );

    // =======================================================
    // Team Dashboard: MCP Tool Governance (Pillar 3)
    // =======================================================
    teamDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### MCP Tool Governance',
        width: 24,
        height: 1,
      }),
    );

    teamDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'MCP Tool Call Volume',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'MCPToolCallCount',
            statistic: 'Sum',
            period: DEFAULT_PERIOD,
            label: 'Tool Calls',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Calls' },
      }),
      new cloudwatch.GraphWidget({
        title: 'MCP Auth Denied Rate',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'MCPAuthDeniedCount',
            statistic: 'Sum',
            period: DEFAULT_PERIOD,
            label: 'Denied Calls',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Denied' },
      }),
    );

    // =======================================================
    // Team Dashboard: Cost Intelligence (Pillar 5)
    // =======================================================
    teamDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### Cost Intelligence',
        width: 24,
        height: 1,
      }),
    );

    teamDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Bedrock Cost (USD)',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'BedrockCostUSD',
            statistic: 'Sum',
            period: cdk.Duration.days(1),
            label: 'Daily Cost ($)',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'USD' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Token Efficiency',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'TokenEfficiency',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'Tokens per Line Changed',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Tokens/Line' },
      }),
    );

    // =======================================================
    // Team Dashboard: AI Attribution (Pillar 7)
    // =======================================================
    teamDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### AI Attribution & Quality',
        width: 24,
        height: 1,
      }),
    );

    teamDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Defect Rate: AI vs Human Code',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'PostMergeDefectRateAI',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'AI Code Defect Rate (%)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'PostMergeDefectRateHuman',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'Human Code Defect Rate (%)',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Defect Rate (%)' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Spec-to-Code Hours',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SpecToCodeHours',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'Avg Hours',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Hours' },
      }),
    );

    // =======================================================
    // Team Dashboard: Security Agent Findings
    // =======================================================
    teamDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### Security Agent Findings',
        width: 24,
        height: 1,
      }),
    );

    teamDashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Open Critical/High Findings',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityCriticalFindingCount',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Critical + High',
          }),
        ],
        width: 6,
        height: 4,
      }),
      new cloudwatch.GraphWidget({
        title: 'Finding Trend by Severity',
        left: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((severity) =>
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityFindingCount',
            dimensionsMap: { Severity: severity },
            statistic: 'Sum',
            period: cdk.Duration.days(1),
            label: severity,
          }),
        ),
        width: 8,
        height: 4,
        leftYAxis: { min: 0, label: 'Findings' },
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Avg Remediation (hrs)',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityRemediationTimeHours',
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'Hours',
          }),
        ],
        width: 4,
        height: 4,
      }),
    );

    teamDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Findings: AI vs Human Code',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityFindingByOrigin',
            dimensionsMap: { AIOrigin: 'ai-assisted' },
            statistic: 'Sum',
            period: cdk.Duration.days(1),
            label: 'AI Code',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityFindingByOrigin',
            dimensionsMap: { AIOrigin: 'human' },
            statistic: 'Sum',
            period: cdk.Duration.days(1),
            label: 'Human Code',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Findings' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Remediation Time: AI vs Human',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityRemediationTimeHours',
            dimensionsMap: { AIOrigin: 'ai-assisted' },
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'AI Code Fix Time (hrs)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityRemediationTimeHours',
            dimensionsMap: { AIOrigin: 'human' },
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'Human Code Fix Time (hrs)',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Hours' },
      }),
    );

    teamDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Findings by Phase',
        left: ['design_review', 'code_review', 'pen_test'].map((phase) =>
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityFindingCount',
            dimensionsMap: { Phase: phase },
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: phase.replace('_', ' '),
          }),
        ),
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Findings' },
        view: cloudwatch.GraphWidgetView.BAR,
      }),
      new cloudwatch.GraphWidget({
        title: 'Security Scan Volume',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityScanCount',
            statistic: 'Sum',
            period: cdk.Duration.days(1),
            label: 'Scans / Day',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Scans' },
      }),
    );

    // =======================================================
    // Executive Dashboard: Security & Compliance section
    // =======================================================
    execDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### Security & Compliance',
        width: 24,
        height: 1,
      }),
    );

    execDashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Guardrail Blocks (7d)',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'GuardrailBlockCount',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Blocks',
          }),
        ],
        width: 6,
        height: 4,
      }),
      new cloudwatch.GraphWidget({
        title: 'Guardrail Trigger Trend',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'GuardrailTriggerCount',
            statistic: 'Sum',
            period: cdk.Duration.days(1),
            label: 'Daily Triggers',
          }),
        ],
        width: 9,
        height: 4,
        leftYAxis: { min: 0, label: 'Count' },
      }),
      new cloudwatch.SingleValueWidget({
        title: 'MCP Auth Denied (7d)',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'MCPAuthDeniedCount',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Denied',
          }),
        ],
        width: 3,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Exfiltration Alerts (7d)',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'ExfiltrationAlertCount',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Alerts',
          }),
        ],
        width: 6,
        height: 4,
      }),
    );

    // =======================================================
    // Executive Dashboard: Cost Intelligence
    // =======================================================
    execDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### Cost Intelligence',
        width: 24,
        height: 1,
      }),
    );

    execDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Weekly Bedrock Cost',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'BedrockCostUSD',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Weekly Cost ($)',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'USD' },
        view: cloudwatch.GraphWidgetView.BAR,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'AI vs Human Defect Rate',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'PostMergeDefectRateAI',
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'AI Defect Rate (%)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'PostMergeDefectRateHuman',
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'Human Defect Rate (%)',
          }),
        ],
        width: 6,
        height: 6,
      }),
    );

    // =======================================================
    // Dashboard 3: CISO Compliance
    // =======================================================
    const cisoDashboard = new cloudwatch.Dashboard(this, 'CISOComplianceDashboard', {
      dashboardName: 'PRISM-D1-CISO-Compliance',
      defaultInterval: cdk.Duration.days(30),
    });

    cisoDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# PRISM D1 - CISO Compliance Dashboard\nSecurity posture, remediation SLAs, and AI code risk profile across all teams.',
        width: 24,
        height: 1,
      }),
    );

    cisoDashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Open Critical Findings',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityCriticalFindingCount',
            statistic: 'Sum',
            period: cdk.Duration.days(30),
            label: 'Critical + High (30d)',
          }),
        ],
        width: 6,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Avg Remediation Time',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityRemediationTimeHours',
            statistic: 'Average',
            period: cdk.Duration.days(30),
            label: 'Hours (30d avg)',
          }),
        ],
        width: 6,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Security Scans Run',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityScanCount',
            statistic: 'Sum',
            period: cdk.Duration.days(30),
            label: 'Scans (30d)',
          }),
        ],
        width: 6,
        height: 4,
      }),
    );

    cisoDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### AI Code Risk Profile',
        width: 24,
        height: 1,
      }),
    );

    cisoDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Security Findings: AI vs Human Code',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityFindingByOrigin',
            dimensionsMap: { AIOrigin: 'ai-assisted' },
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'AI Code Findings',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityFindingByOrigin',
            dimensionsMap: { AIOrigin: 'human' },
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Human Code Findings',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Findings' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Remediation Time by Code Origin',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityRemediationTimeHours',
            dimensionsMap: { AIOrigin: 'ai-assisted' },
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'AI Code (hrs)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityRemediationTimeHours',
            dimensionsMap: { AIOrigin: 'human' },
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'Human Code (hrs)',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Hours' },
      }),
    );

    cisoDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### Shift-Left Effectiveness',
        width: 24,
        height: 1,
      }),
    );

    cisoDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Findings by Phase (Monthly Trend)',
        left: ['design_review', 'code_review', 'pen_test'].map((phase) =>
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityFindingCount',
            dimensionsMap: { Phase: phase },
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: phase.replace('_', ' '),
          }),
        ),
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Findings' },
        view: cloudwatch.GraphWidgetView.BAR,
      }),
      new cloudwatch.GraphWidget({
        title: 'Guardrail + Exfiltration Trends',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'GuardrailBlockCount',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Guardrail Blocks',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'ExfiltrationAlertCount',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Exfiltration Alerts',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'MCPAuthDeniedCount',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'MCP Auth Denied',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Count' },
      }),
    );

    new cdk.CfnOutput(this, 'CISODashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=PRISM-D1-CISO-Compliance`,
      description: 'CISO Compliance Dashboard URL',
    });

    // =======================================================
    // Security Agent Alarms
    // =======================================================

    new cloudwatch.Alarm(this, 'SecurityCriticalFindingAlarm', {
      alarmName: 'PRISM-D1-SecurityCriticalFinding',
      alarmDescription: 'Critical or High security finding detected by AWS Security Agent.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'SecurityCriticalFindingCount',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'SecurityRemediationSLAAlarm', {
      alarmName: 'PRISM-D1-SecurityRemediationSLA',
      alarmDescription: 'Average security finding remediation time exceeds 72 hours.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'SecurityRemediationTimeHours',
        statistic: 'Average',
        period: cdk.Duration.days(1),
      }),
      threshold: 72,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'SecurityFindingRateHighAlarm', {
      alarmName: 'PRISM-D1-SecurityFindingRate-High',
      alarmDescription: 'Security finding count exceeds 50 in 6 hours — systemic quality issue.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'SecurityFindingCount',
        statistic: 'Sum',
        period: cdk.Duration.hours(6),
      }),
      threshold: 50,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // =======================================================
    // Existing Alarms
    // =======================================================

    // Alarm: Guardrail block rate exceeding threshold
    new cloudwatch.Alarm(this, 'GuardrailBlockRateHighAlarm', {
      alarmName: 'PRISM-D1-GuardrailBlockRate-High',
      alarmDescription: 'Guardrail block count exceeds 50 per hour, indicating potential prompt attack or misconfiguration.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'GuardrailBlockCount',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 50,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: Daily Bedrock cost exceeding budget
    new cloudwatch.Alarm(this, 'BedrockDailyCostHighAlarm', {
      alarmName: 'PRISM-D1-BedrockDailyCost-High',
      alarmDescription: 'Daily Bedrock cost exceeds $100 threshold.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'BedrockCostUSD',
        statistic: 'Sum',
        period: cdk.Duration.days(1),
      }),
      threshold: 100,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: Token efficiency below threshold
    new cloudwatch.Alarm(this, 'TokenEfficiencyLowAlarm', {
      alarmName: 'PRISM-D1-TokenEfficiency-Low',
      alarmDescription: 'Token efficiency is low — high token consumption relative to code output.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'TokenEfficiency',
        statistic: 'Average',
        period: cdk.Duration.hours(6),
      }),
      threshold: 500,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: Exfiltration detection
    new cloudwatch.Alarm(this, 'ExfiltrationAlertAlarm', {
      alarmName: 'PRISM-D1-ExfiltrationAlert',
      alarmDescription: 'Data exfiltration pattern detected — anomalous read volume on PRISM tables.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'ExfiltrationAlertCount',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: Agent success rate dropping below 80%
    new cloudwatch.Alarm(this, 'AgentSuccessRateAlarm', {
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'AgentSuccessRate',
        dimensionsMap: { TeamId: teamId, Repository: repository },
        statistic: 'Average',
        period: cdk.Duration.hours(1),
      }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      alarmDescription: 'Agent success rate below 80% for 3 consecutive hours',
      alarmName: `prism-d1-${teamId}-agent-success-rate`,
    });

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'TeamDashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=PRISM-D1-Team-Velocity`,
      description: 'Team Velocity Dashboard URL',
    });

    new cdk.CfnOutput(this, 'ExecDashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=PRISM-D1-Executive-Readout`,
      description: 'Executive Readout Dashboard URL',
    });
  }
}
