import { PERSISTED_SECTIONS, validateEventShape } from './event-schema';
import {
  DynamoDBClient,
  PutItemCommand,
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
  /**
   * Per-PR failure-fix label (title matched revert|hotfix|rollback). This is the
   * change-failure-rate NUMERATOR as a fact; the rate and MTTR are computed at
   * query time by the dashboard widgets over the selected window. Emitting a
   * pre-computed rate per PR was meaningless (0% or 100%) and a pre-computed
   * weekly rate hardcoded a 7-day window the dashboard could not override.
   */
  is_failure_fix?: boolean;
}

/**
 * Per-PR facts from prism-ai-metrics.yml. Persisted so the dashboard can
 * aggregate at query time and resolve AI origin by joining commit_shas against
 * the attribution store.
 */
interface PrDetail {
  number: number;
  author: string;
  reviews_approved: number;
  reviews_changes_requested: number;
  total_commits?: number;
  commit_shas?: string[];
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
  /**
   * Trailer-derived origin. Legacy — emitters now send `commit_shas` instead
   * and dashboards resolve origin at render time against the attribution
   * store. Retained so events emitted before the cutover still parse.
   */
  ai_origin?: string;
  /**
   * Commit SHAs the finding's PR introduced. Immutable facts — the deferred
   * join reads these at query time, which is correct even when the PR merged
   * before `codeburn sync --attribution` had run for those commits.
   */
  commit_shas?: string[];
  pr_number?: number;
  spec_ref: string | null;
  found_at: string;
  remediated_at: string | null;
}

interface SecurityRemediationDetail {
  finding_id: string;
  severity: string;
  remediation_time_hours: number;
  /**
   * Trailer-derived verdict for who fixed the finding. Legacy — reads 'human'
   * for everything once git hooks are removed. Dashboards prefer
   * `fix_commit_shas` and only fall back to this. See the deferred-join note
   * on SecurityAgentFinding.commit_shas.
   */
  remediated_by_origin: string;
  remediated_by_origin_source?: string;
  /** Fix PR's commit SHAs — joined against the attribution store at render time. */
  fix_commit_shas?: string[];
  fix_pr_number?: number | null;
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
  pr?: PrDetail;
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
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE ?? 'PRISM/D1/Velocity';
// Optional: when set, PR events seed the attribution store with default-human
// COMMIT# items so that commits not yet pushed by codeburn are visible as human
// rather than absent. The otel-receiver's condition expression allows a later
// codeburn push to upgrade human → ai-generated, so ordering does not matter.
const AI_USAGE_TABLE = process.env.AI_USAGE_TABLE;


// ---- Handler ----

export async function handler(event: EventBridgeEvent): Promise<void> {
  const detailType = event['detail-type'];
  const detail = event.detail;

  console.log(`[metrics-processor] detail-type=${detailType} team_id=${detail?.team_id} repo=${detail?.repo} timestamp=${detail?.timestamp}`);

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
    seedCommitAttribution(detailType, detail),
  ]);

  const labels = ['writeEventToDynamo', 'writeMetadataToDynamo', 'publishCloudWatchMetrics', 'seedCommitAttribution'];
  results.forEach((result, idx) => {
    if (result.status === 'rejected') {
      console.error(`[metrics-processor] ${labels[idx]} FAILED:`, result.reason);
    }
  });

  // Only DynamoDB write failures are retryable — the events table is the
  // source of truth and DDB writes are idempotent (same pk/sk overwrites).
  // CloudWatch metric publishing is best-effort: retrying a whole invocation
  // because PutMetricData throttled creates a self-amplifying retry storm
  // (more retries -> more PutMetricData calls -> more throttling). This
  // exact loop ran at ~108M invocations/day in July 2026 and wrote 445 GB
  // of logs before stopping. Metrics lost to throttling are an acceptable
  // gap; events lost from DDB are not.
  const ddbFailures = results.slice(0, 2).filter((r) => r.status === 'rejected');
  if (ddbFailures.length > 0) {
    throw new Error(`${ddbFailures.length} DynamoDB write(s) failed — retrying event`);
  }

  console.log(`[metrics-processor] Processed ${detailType} for ${detail.team_id}/${detail.repo}`);
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

  // Persist every payload section — the events table is the source of truth
  // for DDB-backed dashboard panels and replay. (Previously only the first
  // four were stored, silently dropping eval/guardrail/mcp/agent/security
  // payloads from the durable record.)
  // Shape validation: logs field drift instead of letting it vanish. See
  // event-schema.ts for the failures that motivated this.
  for (const w of validateEventShape(detail as unknown as Record<string, unknown>)) {
    console.warn(`[schema] ${w.message}`);
  }

  const sections = PERSISTED_SECTIONS;
  for (const key of sections) {
    if ((detail as Record<string, unknown>)[key]) {
      data[key] = (detail as Record<string, unknown>)[key];
    }
  }

  // Sort key. Events that fan out PER FINDING (security findings, and one
  // remediation per finding resolved by a merged PR) all carry the SAME
  // timestamp — the scan time or the PR merge time. With sk = timestamp alone
  // they collide on (pk, sk) and silently overwrite each other: a PR fixing
  // three findings stored exactly one remediation event. Appending the
  // finding id disambiguates them while preserving the timestamp prefix, so
  // `sk BETWEEN :from AND :to` range queries and lexicographic time ordering
  // still work. Follows the existing `SPAN#${ts}#${spanId}` convention in
  // otel-receiver.ts. Pre-existing items keep bare-timestamp sks; readers
  // split on '#', which is a no-op for those.
  const findingDiscriminator =
    detail.security_agent_finding?.finding_id ?? detail.security_remediation?.finding_id;
  const sortKey = findingDiscriminator
    ? `${detail.timestamp}#${findingDiscriminator}`
    : detail.timestamp;

  const item: Record<string, { S?: string; N?: string }> = {
    pk: { S: `${detail.team_id}#${detail.repo}` },
    sk: { S: sortKey },
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
    // Change-failure NUMERATOR as a counter. The CFR alarm divides this by
    // DeploymentFrequency via metric math, so the ratio is evaluated over the
    // alarm's own window instead of a window baked in at emit time. Emitted on
    // every merged PR (0 or 1) so the alarm sees a real zero during healthy
    // periods rather than sitting in INSUFFICIENT_DATA.
    if (detail.dora.is_failure_fix != null) {
      metricData.push({
        MetricName: 'ChangeFailureCount',
        Value: detail.dora.is_failure_fix ? 1 : 0,
        Unit: StandardUnit.Count,
        Dimensions: sharedDimensions,
        Timestamp: metricTimestamp,
      });
    }
  }

  // AI-DORA metrics — scale 0–1 ratios to 0–100 for CloudWatch Percent unit
  if (detail.ai_dora) {
    // AIAcceptanceRate and AIToMergeRatio were removed: neither had any
    // consumer. No widget read them, and the dashboards' AI-vs-human graphs are
    // driven by attribution metrics (AICommits / MergedAICommits / ...) via
    // metric math instead. AIAcceptanceRate was additionally unsalvageable —
    // gated on a trailer-derived ai_ratio, and defaulting to 100% whenever a PR
    // had no reviews, which rewarded skipping review.
    const aiDoraMap: Array<[string, number | null, StandardUnit, boolean]> = [
      // EvalGatePassRate is the only survivor: it has a live producer
      // (prism-agent-eval.yml) and a live consumer (the eval-gate alarm).
      // SpecToCodeHours and PostMergeDefectRate were emitted by the
      // spec-to-code-calculator and defect-correlator Lambdas, both now deleted
      // as permanent no-ops. AITestCoverageDelta never had a producer at all.
      ['EvalGatePassRate', detail.ai_dora.eval_gate_pass_rate, StandardUnit.Percent, true],
    ];

    // Token & cost metrics come from git-trailer PR sums by default. When the
    // OTEL collector is enabled (OTEL_ENABLED=true), the otel-metrics-publisher
    // Lambda owns AIInputTokens / AIOutputTokens / AICostUSD (higher-fidelity
    // per-span data via `codeburn sync`) — publishing both would double-count.
    if (process.env.OTEL_ENABLED !== 'true') {
      aiDoraMap.push(
        ['AIInputTokens', detail.ai_dora.total_input_tokens, StandardUnit.Count, false],
        ['AIOutputTokens', detail.ai_dora.total_output_tokens, StandardUnit.Count, false],
        ['AICostUSD', detail.ai_dora.total_cost_usd, StandardUnit.None, false],
      );
    }

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
    // NOTE: the AIOrigin dimension here is trailer-derived and therefore
    // legacy — dashboards resolve "who fixed it" from fix_commit_shas via the
    // deferred attribution join instead. It is kept, and kept UNCONDITIONAL,
    // on purpose: emitting this metric sometimes with AIOrigin and sometimes
    // without would create a partial dimension set, which is exactly the
    // failure that left three CISO widgets permanently empty. Full set or
    // nothing. The dimensionless copy below is what the SLA panels read.
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

  // CloudWatch accepts max 1000 metric data points per call; batch in chunks of 25
  const batchSize = 25;
  for (let i = 0; i < metricData.length; i += batchSize) {
    const batch = metricData.slice(i, i + batchSize);
    try {
      await cloudwatchClient.send(
        new PutMetricDataCommand({
          Namespace: METRIC_NAMESPACE,
          MetricData: batch,
        }),
      );
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


// ---- Commit attribution seeding ----

/**
 * When a prism.d1.pr event arrives with commit_shas, seed a COMMIT# item for
 * each SHA in the attribution store with ai_origin=human and in_main=true.
 *
 * This ensures human commits are explicitly represented rather than invisible.
 * The otel-receiver's condition expression allows a later codeburn push to
 * upgrade human → ai-generated:
 *
 *   OR (ai_origin = :human AND :ao = :ai)
 *
 * So ordering between PR merge and codeburn sync does not matter:
 * - If codeburn pushed first: item already has ai_origin=ai-generated, this
 *   write is rejected by the condition (never downgrade ai→human). ✓
 * - If PR merges first: item is written as human, codeburn upgrades later. ✓
 * - Simultaneous: DDB conditional write is atomic, one wins. ✓
 *
 * The repo format from the CI workflow is bare (owner/name), but codeburn
 * stores with a host prefix (github.com/owner/name). We write under the bare
 * form because the /v1/repos and /v1/productivity endpoints scan ALL COMMIT#
 * items regardless of repo format, and repoKeyCandidates() in the security
 * processor already handles both forms for point lookups.
 */
async function seedCommitAttribution(detailType: string, detail: any): Promise<void> {
  // Only process prism.d1.pr events that carry commit SHAs
  if (detailType !== 'prism.d1.pr') return;
  if (!AI_USAGE_TABLE) return;

  const pr = detail.pr as PrDetail | undefined;
  const shas = pr?.commit_shas;
  if (!shas || shas.length === 0) return;

  const authors: string[] = (pr as any)?.commit_authors ?? [];
  const repo = detail.repo as string;
  // CI workflows now emit fully-qualified repo names (github.com/owner/repo
  // or gitlab.com/group/project) matching codeburn's convention. No
  // normalization needed — the ConditionExpression hits existing items directly.
  const timestamp = detail.timestamp as string ?? new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 365 * 86400; // 1 year

  let seeded = 0;
  for (let i = 0; i < shas.length; i++) {
    const sha = shas[i];
    const author = authors[i] ?? ''; // parallel array; may be shorter or absent
    try {
      await dynamoClient.send(new PutItemCommand({
        TableName: AI_USAGE_TABLE,
        Item: {
          pk: { S: `REPO#${repo}` },
          sk: { S: `COMMIT#${sha}` },
          record_type: { S: 'OTEL_ATTR_COMMIT' },
          ai_origin: { S: 'human' },
          ai_tool: { S: 'none' },
          ai_model: { S: '' },
          origin_source: { S: 'ci-seeded' },
          in_main: { BOOL: true },
          was_reverted: { BOOL: false },
          timestamp: { S: timestamp },
          updated_at: { S: new Date().toISOString() },
          ttl: { N: String(ttl) },
          // Author email from git log --format='%ae'. Enables per-developer
          // attribution in /v1/productivity even before codeburn syncs.
          ...(author ? {
            user: { S: author },
            gsi_user: { S: `USER#${author}` },
            gsi_user_sk: { S: `COMMIT#${timestamp}` },
          } : {}),
        },
        // Only write if the item does NOT already exist. If codeburn already
        // pushed this commit (with ai_origin=ai-generated), do not overwrite.
        // If the metrics-processor already seeded it on a prior invocation
        // (retry), this is idempotent.
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
      seeded++;
    } catch (err: any) {
      // ConditionalCheckFailedException means item already exists — expected
      // when codeburn pushed first or on retry. Not an error.
      if (err.name !== 'ConditionalCheckFailedException') {
        console.error(`[seedCommitAttribution] Failed to seed ${sha}:`, err);
        throw err;
      }
    }
  }

  if (seeded > 0) {
    console.log(`[seedCommitAttribution] Seeded ${seeded}/${shas.length} commits as human for ${repo}`);
  }
}
