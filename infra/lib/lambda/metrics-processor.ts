import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  CloudWatchClient,
  PutMetricDataCommand,
  MetricDatum,
  StandardUnit,
} from '@aws-sdk/client-cloudwatch';

// ---- Types ----

interface AiContext {
  tool: string;
  model: string;
  origin: string;
}

interface DoraMetrics {
  deployment_frequency: number | null;
  lead_time_seconds: number | null;
  change_failure_rate: number | null;
  mttr_seconds: number | null;
}

interface AiDoraMetrics {
  ai_acceptance_rate: number | null;
  ai_to_merge_ratio: number | null;
  spec_to_code_hours: number | null;
  post_merge_defect_rate: number | null;
  eval_gate_pass_rate: number | null;
  ai_test_coverage_delta: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cost_usd: number | null;
}

interface EvalDetail {
  eval_id: string;
  rubric: string;
  result: 'PASS' | 'FAIL';
  score: number;
  input_file: string;
  pr_number?: number;
  criterion_scores?: Array<{ name: string; score: number; max_score: number; reasoning: string }>;
}

interface GuardrailTriggerDetail {
  guardrail_id: string;
  guardrail_name: string;
  trigger_category: 'CONTENT_FILTER' | 'DENIED_TOPIC' | 'WORD_FILTER' | 'SENSITIVE_INFO' | 'CONTEXTUAL_GROUNDING';
  trigger_type: string;
  action_taken: 'BLOCK' | 'ANONYMIZE' | 'WARN';
  agent_name: string;
  invocation_id: string;
}

interface MCPToolCallDetail {
  session_id: string;
  client_id: string;
  tool_name: string;
  scopes_used: string[];
  authorized: boolean;
  risk_level: string;
  duration_ms: number;
  result_status: 'success' | 'error' | 'denied';
}


interface QualityDetail {
  deployment_id: string;
  ai_defect_rate: number;
  human_defect_rate: number;
  total_ai_commits: number;
  total_human_commits: number;
}

interface SecurityDetail {
  alert_type: string;
  table_name: string;
  principal_arn: string;
  read_count: number;
  window_start: string;
  window_end: string;
}

interface SecurityAgentFinding {
  finding_id: string;
  phase: 'design_review' | 'code_review' | 'pen_test';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL';
  cvss_score: number | null;
  title: string;
  category: string;
  cwe_id: string | null;
  exploit_validated: boolean;
  compliance_mappings: string[];
  ai_origin: string;
  spec_ref: string | null;
  found_at: string;
  remediated_at: string | null;
}

interface SecurityRemediationDetail {
  finding_id: string;
  severity: string;
  remediation_time_hours: number;
  remediated_by_origin: string;
  finding_phase: string;
}

interface MetricDetail {
  team_id: string;
  repo: string;
  timestamp: string;
  prism_level: number | string;
  metric: { name: string; value: number; unit: string };
  ai_context?: AiContext;
  dora?: DoraMetrics;
  ai_dora?: AiDoraMetrics;
  agent?: {
    agent_name: string;
    steps_taken: number;
    tools_invoked: number;
    duration_ms: number;
    tokens_used: number;
    status: string;
    guardrails_triggered: number;
  };
  eval?: EvalDetail;
  guardrail?: GuardrailTriggerDetail;
  mcp_tool_call?: MCPToolCallDetail;
  quality?: QualityDetail;
  security?: SecurityDetail;
  security_agent_finding?: SecurityAgentFinding;
  security_remediation?: SecurityRemediationDetail;
}

interface EventBridgeEvent {
  source: string;
  'detail-type': string;
  detail: MetricDetail;
}

// ---- Clients (reused across invocations) ----

const dynamoClient = new DynamoDBClient({});
const cloudwatchClient = new CloudWatchClient({});

const EVENTS_TABLE = process.env.EVENTS_TABLE!;
const METADATA_TABLE = process.env.METADATA_TABLE!;
const AI_USAGE_TABLE = process.env.AI_USAGE_TABLE!;
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE ?? 'PRISM/D1/Velocity';

// ---- AI-Summary (per-user global usage) ----

/** Parse the AI-Summary trailer "tool=in/out/cost;tool2=..." into structured usage. */
function parseAiSummary(s: string): Array<{ tool: string; input: number; output: number; cost: number }> {
  const out: Array<{ tool: string; input: number; output: number; cost: number }> = [];
  for (const part of s.split(';')) {
    const m = part.trim().match(/^([a-z0-9-]+)=(\d+)\/(\d+)\/([0-9.]+)$/i);
    if (m) out.push({ tool: m[1]!, input: Number(m[2]), output: Number(m[3]), cost: Number(m[4]) });
  }
  return out;
}

/**
 * Consume the AI-Summary trailer: the author's GLOBAL per-tool ABSOLUTE cumulative
 * usage. We compute the per-user period delta server-side against the last stored
 * cumulative (keyed by user+tool), write a SUMMARY# delta row, and advance the
 * CUM# state item. Reset/first-observation unified: delta = cur-last when monotonic,
 * else cur (handles first PR + machine reinstall where the cumulative regresses).
 * Attributed to the PR author (per scope decision). Raw email key — no HMAC (this is
 * a public sample deployed in the customer's own account, not Amazon-internal).
 */
async function writeAiSummaryToDynamo(detail: MetricDetail): Promise<void> {
  // When the OTEL collector is enabled, codeburn sync is the authoritative
  // per-user usage source — the AI-Summary trailer is ignored entirely
  // (commit-level trailers are unaffected; only the per-user store switches).
  if (process.env.OTEL_ENABLED === 'true') {
    console.log('[writeAiSummary] OTEL_ENABLED — skipping AI-Summary trailer processing');
    return;
  }
  const summary = (detail as any).ai_summary as string | undefined;
  const author = (detail as any).pr?.author as string | undefined;
  if (!summary || !author) {
    console.log('[writeAiSummary] no ai_summary or author — skipping');
    return;
  }
  const user = author.trim().toLowerCase();
  const tools = parseAiSummary(summary);
  const ttl = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

  for (const t of tools) {
    let lastIn = 0, lastOut = 0, lastCost = 0;
    try {
      const got = await dynamoClient.send(new GetItemCommand({
        TableName: AI_USAGE_TABLE,
        Key: { pk: { S: `USER#${user}` }, sk: { S: `CUM#${t.tool}` } },
      }));
      if (got.Item) {
        lastIn = Number(got.Item.last_input?.N ?? '0');
        lastOut = Number(got.Item.last_output?.N ?? '0');
        lastCost = Number(got.Item.last_cost?.N ?? '0');
      }
    } catch (e) {
      console.error('[writeAiSummary] GetItem(CUM) failed:', e);
    }

    // Monotonic delta; regression (reset/reinstall) or first-obs (last=0) counts cur.
    const dIn = t.input >= lastIn ? t.input - lastIn : t.input;
    const dOut = t.output >= lastOut ? t.output - lastOut : t.output;
    const dCost = t.cost >= lastCost ? t.cost - lastCost : t.cost;

    // SUMMARY delta row (keyed by user; no repo/PR/commit dimension by design).
    await dynamoClient.send(new PutItemCommand({
      TableName: AI_USAGE_TABLE,
      Item: {
        pk: { S: `USER#${user}` },
        sk: { S: `SUMMARY#${detail.timestamp}#${t.tool}` },
        record_type: { S: 'SUMMARY' },
        tool: { S: t.tool },
        input_tokens: { N: String(dIn) },
        output_tokens: { N: String(dOut) },
        cost_usd: { N: String(dCost) },
        cumulative_input: { N: String(t.input) },
        cumulative_output: { N: String(t.output) },
        cumulative_cost: { N: String(t.cost) },
        gsi_date: { S: `DATE#${detail.timestamp.slice(0, 10)}` },
        gsi_date_sk: { S: `${detail.timestamp}#${user}#${t.tool}` },
        timestamp: { S: detail.timestamp },
        ttl: { N: ttl.toString() },
      },
    }));

    // Advance the server-side cumulative baseline for this (user, tool).
    await dynamoClient.send(new PutItemCommand({
      TableName: AI_USAGE_TABLE,
      Item: {
        pk: { S: `USER#${user}` },
        sk: { S: `CUM#${t.tool}` },
        record_type: { S: 'CUM_STATE' },
        tool: { S: t.tool },
        last_input: { N: String(t.input) },
        last_output: { N: String(t.output) },
        last_cost: { N: String(t.cost) },
        updated_at: { S: detail.timestamp },
      },
    }));
  }
  console.log(`[writeAiSummary] wrote ${tools.length} summary delta row(s) for USER#${user}`);
}

// ---- Handler ----

export async function handler(event: EventBridgeEvent): Promise<void> {
  console.log('[metrics-processor] Received event:', JSON.stringify(event, null, 2));

  const detailType = event['detail-type'];
  const detail = event.detail;

  console.log(`[metrics-processor] detail-type=${detailType} team_id=${detail?.team_id} repo=${detail?.repo} timestamp=${detail?.timestamp}`);
  console.log(`[metrics-processor] dora=${JSON.stringify(detail?.dora)} ai_dora=${JSON.stringify(detail?.ai_dora)} metric=${JSON.stringify(detail?.metric)}`);

  if (!detail.team_id) {
    console.log('[metrics-processor] No team_id provided, defaulting to "no_team"');
    detail.team_id = 'no_team';
  }

  if (!detail.repo || !detail.timestamp) {
    console.error('[metrics-processor] VALIDATION FAILED: Missing required fields: repo or timestamp');
    throw new Error('Event missing required fields');
  }

  const results = await Promise.allSettled([
    writeEventToDynamo(detailType, detail),
    writeMetadataToDynamo(detailType, detail),
    publishCloudWatchMetrics(detailType, detail),
    writeAiSummaryToDynamo(detail),
  ]);

  results.forEach((result, idx) => {
    const labels = ['writeEventToDynamo', 'writeMetadataToDynamo', 'publishCloudWatchMetrics', 'writeAiSummaryToDynamo'];
    if (result.status === 'fulfilled') {
      console.log(`[metrics-processor] ${labels[idx]} succeeded`);
    } else {
      console.error(`[metrics-processor] ${labels[idx]} FAILED:`, result.reason);
    }
  });

  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(`${failures.length} operation(s) failed — check logs above`);
  }

  console.log(`[metrics-processor] Successfully processed ${detailType} for ${detail.team_id}/${detail.repo}`);
}

// ---- DynamoDB events ----

async function writeEventToDynamo(
  detailType: string,
  detail: MetricDetail,
): Promise<void> {
  console.log(`[writeEventToDynamo] Writing event: pk=${detail.team_id}#${detail.repo} sk=${detail.timestamp} type=${detailType}`);
  const ttl = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60; // 365 days from now

  const data: Record<string, unknown> = {
    team_id: detail.team_id,
    repo: detail.repo,
    prism_level: detail.prism_level ?? '1',
  };

  if (detail.metric) {
    data.metric = detail.metric;
  }
  if (detail.ai_context) {
    data.ai_context = detail.ai_context;
  }
  if (detail.dora) {
    data.dora = detail.dora;
  }
  if (detail.ai_dora) {
    data.ai_dora = detail.ai_dora;
  }

  const item: Record<string, { S?: string; N?: string }> = {
    pk: { S: `${detail.team_id}#${detail.repo}` },
    sk: { S: detail.timestamp },
    detail_type: { S: detailType },
    data: { S: JSON.stringify(data) },
    ttl: { N: ttl.toString() },
  };

  // Store spec_ref as a top-level attribute for GSI queries (spec-to-code calculation)
  const specRef = (detail.ai_context as any)?.spec_ref
    ?? (detail as any).spec_ref;
  if (specRef && typeof specRef === 'string') {
    item.spec_ref = { S: specRef };
  }

  // Store eval rubric as a top-level attribute for per-rubric queries
  if (detail.eval?.rubric) {
    item.eval_rubric = { S: detail.eval.rubric };
  }

  // Store finding_id for Security Agent finding queries
  if (detail.security_agent_finding?.finding_id) {
    item.finding_id = { S: detail.security_agent_finding.finding_id };
  }
  if (detail.security_remediation?.finding_id) {
    item.finding_id = { S: detail.security_remediation.finding_id };
  }

  await dynamoClient.send(
    new PutItemCommand({
      TableName: EVENTS_TABLE,
      Item: item,
    }),
  );
}

// ---- DynamoDB metadata ----

async function writeMetadataToDynamo(
  detailType: string,
  detail: MetricDetail,
): Promise<void> {
  console.log(`[writeMetadataToDynamo] Writing metadata: team_id=${detail.team_id} repo=${detail.repo} type=${detailType}`);
  const item: Record<string, { S?: string; N?: string }> = {
    team_id: { S: detail.team_id },
    repo: { S: detail.repo },
    last_event_type: { S: detailType },
    last_updated: { S: detail.timestamp },
    prism_level: { N: String(detail.prism_level ?? 1) },
  };

  if (detail.ai_context?.tool) {
    item.ai_tool = { S: detail.ai_context.tool };
  }
  if (detail.ai_context?.origin) {
    item.ai_origin = { S: detail.ai_context.origin };
  }

  // For assessment events, store the full PRISM level and primary metric
  if (detailType === 'prism.d1.assessment' && detail.metric) {
    item.assessment_metric = { S: detail.metric.name };
    item.assessment_value = { N: detail.metric.value.toString() };
  }

  // Store latest DORA snapshot — only numeric fields as N attributes
  if (detail.dora) {
    for (const [key, val] of Object.entries(detail.dora)) {
      if (val == null) continue;
      if (typeof val === 'number') {
        item[`dora_${key}`] = { N: val.toString() };
      } else if (typeof val === 'string' && !isNaN(Number(val))) {
        item[`dora_${key}`] = { N: val };
      }
      // Skip non-numeric values (e.g. deploy_sha) — they don't belong in N attributes
    }
  }

  // Store latest AI-DORA snapshot — only numeric fields
  if (detail.ai_dora) {
    for (const [key, val] of Object.entries(detail.ai_dora)) {
      if (val == null) continue;
      if (typeof val === 'object') continue; // Skip nested objects like tool_breakdown
      if (typeof val === 'number') {
        item[`ai_dora_${key}`] = { N: val.toString() };
      } else if (typeof val === 'string' && !isNaN(Number(val))) {
        item[`ai_dora_${key}`] = { N: val };
      }
    }
  }

  await dynamoClient.send(
    new PutItemCommand({
      TableName: METADATA_TABLE,
      Item: item,
    }),
  );
}

// ---- CloudWatch custom metrics ----

async function publishCloudWatchMetrics(
  detailType: string,
  detail: MetricDetail,
): Promise<void> {
  console.log(`[publishCloudWatchMetrics] Starting for ${detailType}, namespace=${METRIC_NAMESPACE}`);
  console.log(`[publishCloudWatchMetrics] dora fields: deployment_frequency=${detail.dora?.deployment_frequency} lead_time_seconds=${detail.dora?.lead_time_seconds} change_failure_rate=${detail.dora?.change_failure_rate} mttr_seconds=${detail.dora?.mttr_seconds}`);
  console.log(`[publishCloudWatchMetrics] ai_dora fields: ai_acceptance_rate=${detail.ai_dora?.ai_acceptance_rate} ai_to_merge_ratio=${detail.ai_dora?.ai_to_merge_ratio} eval_gate_pass_rate=${detail.ai_dora?.eval_gate_pass_rate}`);

  const sharedDimensions = [
    { Name: 'TeamId', Value: detail.team_id },
    { Name: 'Repository', Value: detail.repo },
  ];

  // Add AIOrigin dimension when available — enables dashboard filtering
  // by ai-generated vs ai-assisted vs human
  const aiOrigin = detail.ai_context?.origin;
  const dimensionsWithOrigin = aiOrigin
    ? [...sharedDimensions, { Name: 'AIOrigin', Value: aiOrigin }]
    : sharedDimensions;

  // Clamp timestamp: CloudWatch rejects timestamps >2h in the future
  const eventTime = new Date(detail.timestamp);
  const metricTimestamp = eventTime.getTime() > Date.now() ? new Date() : eventTime;

  const metricData: MetricDatum[] = [];

  // Primary metric — published with both dimension sets for flexibility:
  // 1. With AIOrigin: allows filtering by origin type
  // 2. Without AIOrigin: allows aggregate queries across all origins
  if (detail.metric?.value != null) {
    metricData.push({
      MetricName: detail.metric.name,
      Value: detail.metric.value,
      Unit: mapUnit(detail.metric.unit),
      Dimensions: sharedDimensions,
      Timestamp: metricTimestamp,
    });
    if (aiOrigin) {
      metricData.push({
        MetricName: detail.metric.name,
        Value: detail.metric.value,
        Unit: mapUnit(detail.metric.unit),
        Dimensions: dimensionsWithOrigin,
        Timestamp: metricTimestamp,
      });
    }
  }

  // DORA metrics — published with AIOrigin dimension when available
  if (detail.dora) {
    const doraDims = aiOrigin ? dimensionsWithOrigin : sharedDimensions;
    if (detail.dora.deployment_frequency != null) {
      metricData.push({
        MetricName: 'DeploymentFrequency',
        Value: detail.dora.deployment_frequency,
        Unit: StandardUnit.Count,
        Dimensions: sharedDimensions,
        Timestamp: metricTimestamp,
      });
      if (aiOrigin) {
        metricData.push({
          MetricName: 'DeploymentFrequency',
          Value: detail.dora.deployment_frequency,
          Unit: StandardUnit.Count,
          Dimensions: doraDims,
          Timestamp: metricTimestamp,
        });
      }
    }
    if (detail.dora.lead_time_seconds != null) {
      metricData.push({
        MetricName: 'LeadTimeForChanges',
        Value: detail.dora.lead_time_seconds,
        Unit: StandardUnit.Seconds,
        Dimensions: sharedDimensions,
        Timestamp: metricTimestamp,
      });
      if (aiOrigin) {
        metricData.push({
          MetricName: 'LeadTimeForChanges',
          Value: detail.dora.lead_time_seconds,
          Unit: StandardUnit.Seconds,
          Dimensions: doraDims,
          Timestamp: metricTimestamp,
        });
      }
    }
    if (detail.dora.change_failure_rate != null) {
      const cfrValue = detail.dora.change_failure_rate <= 1 ? detail.dora.change_failure_rate * 100 : detail.dora.change_failure_rate;
      metricData.push({
        MetricName: 'ChangeFailureRate',
        Value: cfrValue,
        Unit: StandardUnit.Percent,
        Dimensions: sharedDimensions,
        Timestamp: metricTimestamp,
      });
    }
    if (detail.dora.mttr_seconds != null) {
      metricData.push({
        MetricName: 'MTTR',
        Value: detail.dora.mttr_seconds,
        Unit: StandardUnit.Seconds,
        Dimensions: sharedDimensions,
        Timestamp: metricTimestamp,
      });
    }
  }

  // AI-DORA metrics — scale 0–1 ratios to 0–100 for CloudWatch Percent unit
  if (detail.ai_dora) {
    const aiDoraMap: Array<[string, number | null, StandardUnit, boolean]> = [
      ['AIAcceptanceRate', detail.ai_dora.ai_acceptance_rate, StandardUnit.Percent, true],
      ['AIToMergeRatio', detail.ai_dora.ai_to_merge_ratio, StandardUnit.Percent, true],
      ['SpecToCodeHours', detail.ai_dora.spec_to_code_hours, StandardUnit.Count, false],
      ['PostMergeDefectRate', detail.ai_dora.post_merge_defect_rate, StandardUnit.Percent, true],
      ['EvalGatePassRate', detail.ai_dora.eval_gate_pass_rate, StandardUnit.Percent, true],
      ['AITestCoverageDelta', detail.ai_dora.ai_test_coverage_delta, StandardUnit.Percent, true],
      ['AIInputTokens', detail.ai_dora.total_input_tokens, StandardUnit.Count, false],
      ['AIOutputTokens', detail.ai_dora.total_output_tokens, StandardUnit.Count, false],
      ['AICostUSD', detail.ai_dora.total_cost_usd, StandardUnit.None, false],
    ];

    for (const [name, value, unit, scaleToPercent] of aiDoraMap) {
      if (value != null) {
        const publishValue = scaleToPercent && value <= 1 ? value * 100 : value;
        metricData.push({
          MetricName: name,
          Value: publishValue,
          Unit: unit,
          Dimensions: sharedDimensions,
          Timestamp: metricTimestamp,
        });
      }
    }
  }

  // Agent metrics
  if (detail.agent) {
    const agent = detail.agent;
    const agentDimensions = [
      ...sharedDimensions,
      { Name: 'AgentName', Value: agent.agent_name ?? 'unknown' },
    ];

    const agentMetrics: Array<[string, number | null, StandardUnit]> = [
      ['AgentInvocationCount', 1, StandardUnit.Count],
      ['AgentStepCount', agent.steps_taken ?? null, StandardUnit.Count],
      ['AgentDurationMs', agent.duration_ms ?? null, StandardUnit.Milliseconds],
      ['AgentTokensUsed', agent.tokens_used ?? null, StandardUnit.Count],
      ['AgentToolInvocationCount', agent.tools_invoked ?? null, StandardUnit.Count],
      ['AgentGuardrailTriggerCount', agent.guardrails_triggered ?? null, StandardUnit.Count],
      ['AgentSuccessRate', agent.status === 'success' ? 100 : 0, StandardUnit.Percent],
    ];

    for (const [name, value, unit] of agentMetrics) {
      if (value != null) {
        // Publish with AgentName dimension (for per-agent drill-down)
        metricData.push({
          MetricName: name,
          Value: value,
          Unit: unit,
          Dimensions: agentDimensions,
          Timestamp: metricTimestamp,
        });
        // Also publish without AgentName (for aggregate dashboard queries)
        metricData.push({
          MetricName: name,
          Value: value,
          Unit: unit,
          Dimensions: sharedDimensions,
          Timestamp: metricTimestamp,
        });
      }
    }
  }

  // Eval metrics — per-rubric pass rate
  if (detail.eval) {
    const rubricDimensions = [
      ...sharedDimensions,
      { Name: 'RubricName', Value: detail.eval.rubric ?? 'unknown' },
    ];
    metricData.push({
      MetricName: 'EvalGatePassRateByRubric',
      Value: detail.eval.result === 'PASS' ? 100 : 0,
      Unit: StandardUnit.Percent,
      Dimensions: rubricDimensions,
      Timestamp: metricTimestamp,
    });
    metricData.push({
      MetricName: 'EvalScore',
      Value: detail.eval.score ?? 0,
      Unit: StandardUnit.None,
      Dimensions: rubricDimensions,
      Timestamp: metricTimestamp,
    });
  }

  // Guardrail metrics — per-category trigger tracking
  if (detail.guardrail) {
    const guardrailDimensions = [
      ...sharedDimensions,
      { Name: 'TriggerCategory', Value: detail.guardrail.trigger_category },
      { Name: 'AgentName', Value: detail.guardrail.agent_name ?? 'unknown' },
    ];
    metricData.push({
      MetricName: 'GuardrailTriggerCount',
      Value: 1,
      Unit: StandardUnit.Count,
      Dimensions: guardrailDimensions,
      Timestamp: metricTimestamp,
    });
    if (detail.guardrail.action_taken === 'BLOCK') {
      metricData.push({
        MetricName: 'GuardrailBlockCount',
        Value: 1,
        Unit: StandardUnit.Count,
        Dimensions: sharedDimensions,
        Timestamp: metricTimestamp,
      });
    }
    if (detail.guardrail.action_taken === 'ANONYMIZE') {
      metricData.push({
        MetricName: 'GuardrailAnonymizeCount',
        Value: 1,
        Unit: StandardUnit.Count,
        Dimensions: sharedDimensions,
        Timestamp: metricTimestamp,
      });
    }
  }

  // MCP tool call metrics
  if (detail.mcp_tool_call) {
    const mcpDimensions = [
      ...sharedDimensions,
      { Name: 'ToolName', Value: detail.mcp_tool_call.tool_name },
    ];
    metricData.push({
      MetricName: 'MCPToolCallCount',
      Value: 1,
      Unit: StandardUnit.Count,
      Dimensions: mcpDimensions,
      Timestamp: metricTimestamp,
    });
    if (!detail.mcp_tool_call.authorized) {
      metricData.push({
        MetricName: 'MCPAuthDeniedCount',
        Value: 1,
        Unit: StandardUnit.Count,
        Dimensions: mcpDimensions,
        Timestamp: metricTimestamp,
      });
    }
    if (detail.mcp_tool_call.duration_ms != null) {
      metricData.push({
        MetricName: 'MCPToolCallDurationMs',
        Value: detail.mcp_tool_call.duration_ms,
        Unit: StandardUnit.Milliseconds,
        Dimensions: mcpDimensions,
        Timestamp: metricTimestamp,
      });
    }
  }



  // Quality / defect rate metrics
  if (detail.quality) {
    metricData.push(
      {
        MetricName: 'PostMergeDefectRateAI',
        Value: detail.quality.ai_defect_rate,
        Unit: StandardUnit.Percent,
        Dimensions: sharedDimensions,
        Timestamp: metricTimestamp,
      },
      {
        MetricName: 'PostMergeDefectRateHuman',
        Value: detail.quality.human_defect_rate,
        Unit: StandardUnit.Percent,
        Dimensions: sharedDimensions,
        Timestamp: metricTimestamp,
      },
    );
  }

  // Security / exfiltration metrics
  if (detail.security) {
    metricData.push({
      MetricName: 'ExfiltrationAlertCount',
      Value: 1,
      Unit: StandardUnit.Count,
      Dimensions: sharedDimensions,
      Timestamp: metricTimestamp,
    });
  }

  // AWS Security Agent finding metrics
  if (detail.security_agent_finding) {
    const finding = detail.security_agent_finding;
    const phaseDimensions = [
      ...sharedDimensions,
      { Name: 'Phase', Value: finding.phase },
      { Name: 'Severity', Value: finding.severity },
    ];
    metricData.push({
      MetricName: 'SecurityFindingCount',
      Value: 1,
      Unit: StandardUnit.Count,
      Dimensions: phaseDimensions,
      Timestamp: metricTimestamp,
    });
    if (finding.severity === 'CRITICAL' || finding.severity === 'HIGH') {
      metricData.push({
        MetricName: 'SecurityCriticalFindingCount',
        Value: 1,
        Unit: StandardUnit.Count,
        Dimensions: sharedDimensions,
        Timestamp: metricTimestamp,
      });
    }
    if (finding.ai_origin) {
      metricData.push({
        MetricName: 'SecurityFindingByOrigin',
        Value: 1,
        Unit: StandardUnit.Count,
        Dimensions: [
          ...sharedDimensions,
          { Name: 'AIOrigin', Value: finding.ai_origin },
        ],
        Timestamp: metricTimestamp,
      });
    }
    if (finding.cvss_score != null) {
      metricData.push({
        MetricName: 'SecurityFindingCVSS',
        Value: finding.cvss_score,
        Unit: StandardUnit.None,
        Dimensions: phaseDimensions,
        Timestamp: metricTimestamp,
      });
    }
    metricData.push({
      MetricName: 'SecurityScanCount',
      Value: 1,
      Unit: StandardUnit.Count,
      Dimensions: [
        ...sharedDimensions,
        { Name: 'Phase', Value: finding.phase },
      ],
      Timestamp: metricTimestamp,
    });
  }

  // Security remediation metrics
  if (detail.security_remediation) {
    const remediation = detail.security_remediation;
    metricData.push({
      MetricName: 'SecurityRemediationTimeHours',
      Value: remediation.remediation_time_hours,
      Unit: StandardUnit.Count,
      Dimensions: [
        ...sharedDimensions,
        { Name: 'Severity', Value: remediation.severity },
        { Name: 'AIOrigin', Value: remediation.remediated_by_origin },
      ],
      Timestamp: metricTimestamp,
    });
  }

  // Also publish all metrics WITHOUT dimensions for aggregate dashboard views.
  // CloudWatch treats dimensioned and dimensionless metrics as separate time series.
  // The dashboard-stack.ts widgets query without dimensions, so we need both.
  const dimensionlessMetrics: MetricDatum[] = metricData
    .filter((m) => m.Dimensions && m.Dimensions.length > 0)
    .map((m) => ({
      ...m,
      Dimensions: [],
    }));
  metricData.push(...dimensionlessMetrics);

  if (metricData.length === 0) {
    console.log('[publishCloudWatchMetrics] No metrics to publish — metricData is empty');
    return;
  }

  console.log(`[publishCloudWatchMetrics] Publishing ${metricData.length} metric data points`);
  metricData.forEach((m, i) => {
    console.log(`[publishCloudWatchMetrics]   [${i}] ${m.MetricName}=${m.Value} unit=${m.Unit} dims=${JSON.stringify(m.Dimensions)}`);
  });

  // CloudWatch accepts max 1000 metric data points per call; batch in chunks of 25
  const batchSize = 25;
  for (let i = 0; i < metricData.length; i += batchSize) {
    const batch = metricData.slice(i, i + batchSize);
    console.log(`[publishCloudWatchMetrics] Sending batch ${Math.floor(i / batchSize) + 1} with ${batch.length} metrics`);
    try {
      await cloudwatchClient.send(
        new PutMetricDataCommand({
          Namespace: METRIC_NAMESPACE,
          MetricData: batch,
        }),
      );
      console.log(`[publishCloudWatchMetrics] Batch ${Math.floor(i / batchSize) + 1} sent successfully`);
    } catch (err) {
      console.error(`[publishCloudWatchMetrics] Batch ${Math.floor(i / batchSize) + 1} FAILED:`, err);
      throw err;
    }
  }
}

function mapUnit(unit: string): StandardUnit {
  const unitMap: Record<string, StandardUnit> = {
    count: StandardUnit.Count,
    percent: StandardUnit.Percent,
    seconds: StandardUnit.Seconds,
    milliseconds: StandardUnit.Milliseconds,
    bytes: StandardUnit.Bytes,
    none: StandardUnit.None,
  };
  return unitMap[unit?.toLowerCase()] ?? StandardUnit.None;
}
