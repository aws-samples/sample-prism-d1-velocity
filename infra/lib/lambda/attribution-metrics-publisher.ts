/**
 * PRISM D1 — Attribution metrics publisher.
 *
 * Consumes the prism-d1-ai-usage DynamoDB stream (filtered to COMMIT# items
 * under REPO# pk) and publishes commit attribution metrics to CloudWatch.
 *
 * AI-Origin: prefers the verdict the receiver froze on the item at ingest
 * (ai_origin / ai_tool). Falls back to joining commit → usage spans via traceId
 * for legacy items written before write-time resolution existed. Re-deriving
 * unconditionally was a bug: spans TTL at 90 days, commit facts at 365.
 *
 * Metrics published (namespace: PRISM/D1/Velocity):
 *   AICommits        — count of ai-generated commits (dimensionless + by Tool)
 *   HumanCommits     — count of human commits (dimensionless only)
 *   RevertedAICommits — ai-generated commits that were later reverted
 *   CommitsTotal     — all tracked commits regardless of origin
 *
 * A commit seeded by CI as `human` and later upgraded to `ai-generated` by
 * codeburn attribution publishes the AI counts and RETRACTS the superseded
 * human counts with a -1 datum, so Sum-aggregated consumers stay correct.
 */

import {
  CloudWatchClient,
  PutMetricDataCommand,
  MetricDatum,
  StandardUnit,
} from '@aws-sdk/client-cloudwatch';
import {
  DynamoDBClient,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';

const cloudwatch = new CloudWatchClient({});
const dynamoClient = new DynamoDBClient({});

const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE || 'PRISM/D1/Velocity';
const AI_USAGE_TABLE = process.env.AI_USAGE_TABLE || 'prism-d1-ai-usage';
const PUT_METRIC_BATCH_SIZE = 1000;

// ---- Types ----

interface AttributeValue {
  S?: string;
  N?: string;
  BOOL?: boolean;
}

interface StreamImage {
  pk?: AttributeValue;
  sk?: AttributeValue;
  trace_id?: AttributeValue;
  user?: AttributeValue;
  tool?: AttributeValue;
  model?: AttributeValue;
  in_main?: AttributeValue;
  was_reverted?: AttributeValue;
  timestamp?: AttributeValue;
  record_type?: AttributeValue;
  /** Origin verdict frozen by the receiver at ingest. Absent on legacy items. */
  ai_origin?: AttributeValue;
  /** Tool frozen alongside ai_origin. Absent on legacy items. */
  ai_tool?: AttributeValue;
}

interface StreamRecord {
  eventName?: string;
  dynamodb?: {
    Keys?: { pk?: AttributeValue; sk?: AttributeValue };
    NewImage?: StreamImage;
    OldImage?: StreamImage;
  };
}

interface StreamEvent {
  Records?: StreamRecord[];
}

// ---- Helpers ----

/**
 * Resolve a commit's AI origin and tool.
 *
 * Prefers the verdict the receiver froze on the item. That verdict was computed
 * while the usage spans were still alive, whereas this re-derivation runs
 * whenever the stream fires: spans TTL at 90 days and commit facts at 365, so
 * re-deriving an aging commit silently reclassifies it as human. The receiver
 * moved to write-time resolution for exactly that reason (see
 * writeCommitAttribution) — this consumer was still re-deriving, so the two
 * disagreed on the same item.
 *
 * The span join remains as a fallback for legacy items that carry no ai_origin.
 */
async function resolveOrigin(
  storedOrigin: string,
  storedTool: string,
  user: string,
  traceId: string,
): Promise<{ tool: string; isAi: boolean }> {
  if (storedOrigin === 'ai-generated') {
    return { tool: storedTool || 'unknown', isAi: true };
  }
  if (storedOrigin === 'human') {
    return { tool: 'none', isAi: false };
  }
  return resolveAiTool(user, traceId);
}

/** Resolve the AI tool for a commit by joining with usage spans via traceId. */
async function resolveAiTool(user: string, traceId: string): Promise<{ tool: string; isAi: boolean }> {
  if (!user || !traceId) return { tool: 'none', isAi: false };

  try {
    // NOTE: DynamoDB applies `Limit` BEFORE `FilterExpression` — `Limit: 1`
    // would evaluate exactly one span and almost always miss the match,
    // resolving every commit as human. Paginate the user's spans and stop at
    // the first trace_id hit. Page size bounds per-call read cost; the loop
    // bounds total pages defensively (a user with >50k spans and no match
    // resolves as human rather than scanning forever).
    let lastKey: import('@aws-sdk/client-dynamodb').QueryCommandOutput['LastEvaluatedKey'];
    for (let page = 0; page < 50; page++) {
      const result = await dynamoClient.send(new QueryCommand({
        TableName: AI_USAGE_TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        FilterExpression: 'trace_id = :tid',
        ExpressionAttributeValues: {
          ':pk': { S: `USER#${user}` },
          ':prefix': { S: 'SPAN#' },
          ':tid': { S: traceId },
        },
        Limit: 1000,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));

      if ((result.Items?.length ?? 0) > 0) {
        const tool = result.Items![0].tool?.S ?? 'unknown';
        return { tool, isAi: true };
      }
      lastKey = result.LastEvaluatedKey;
      if (!lastKey) break;
    }
  } catch (e) {
    console.warn(`[attribution-metrics] Failed to resolve tool for trace=${traceId}: ${e}`);
  }

  return { tool: 'none', isAi: false };
}

/**
 * Parse a stream record into commit metadata. Only processes COMMIT# items.
 *
 * Exported for the transition guard in scripts/check-commit-transitions.ts —
 * the handler builds its CloudWatch client at module scope, so the transition
 * logic is only reachable in a test through this function.
 */
export function parseCommitRecord(record: StreamRecord): {
  user: string;
  traceId: string;
  wasReverted: boolean;
  inMain: boolean;
  timestamp: string;
  /** Origin frozen on the item by the receiver. Empty for legacy items. */
  storedOrigin: string;
  /** Tool frozen alongside storedOrigin. Empty when unknown. */
  storedTool: string;
  /** Which state transitions this event represents. INSERT = 'new'. A MODIFY
   * can flip in_main and/or was_reverted (receiver writes only when one of
   * them changed). */
  isNew: boolean;
  mergedNow: boolean;   // in_main flipped false → true
  revertedNow: boolean; // was_reverted flipped false → true
  /** ai_origin flipped human → ai-generated (codeburn attribution arrived
   * after CI already seeded the commit). */
  originUpgraded: boolean;
} | null {
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') return null;

  const newImage = record.dynamodb?.NewImage;
  if (!newImage) return null;

  const recordType = newImage.record_type?.S;
  if (recordType !== 'OTEL_ATTR_COMMIT') return null;

  const inMain = newImage.in_main?.BOOL ?? false;
  const wasReverted = newImage.was_reverted?.BOOL ?? false;
  const storedOrigin = newImage.ai_origin?.S ?? '';
  const storedTool = newImage.ai_tool?.S ?? '';

  const isNew = record.eventName === 'INSERT';
  let mergedNow = false;
  let revertedNow = false;
  let originUpgraded = false;

  if (record.eventName === 'MODIFY') {
    const oldImage = record.dynamodb?.OldImage;
    const oldInMain = oldImage?.in_main?.BOOL ?? false;
    const oldReverted = oldImage?.was_reverted?.BOOL ?? false;
    const oldOrigin = oldImage?.ai_origin?.S ?? '';
    mergedNow = inMain && !oldInMain;
    revertedNow = wasReverted && !oldReverted;
    // The human → ai-generated upgrade. metrics-processor seeds CI-observed
    // commits as `human` because it cannot know origin; codeburn attribution
    // arrives later and the receiver upgrades them (its ConditionExpression
    // permits exactly `ai_origin = :human AND :ao = :ai`).
    //
    // This used to fall into the `return null` below, because the receiver's
    // Write 1 sets in_main/was_reverted with if_not_exists and therefore
    // changes neither. So the upgrade reached DynamoDB but never CloudWatch:
    // AICommits stayed unemitted and MergedAICommits stayed at zero forever,
    // which blanks the "AI Defect Trend (reverted / merged)" widget since its
    // MathExpression is guarded on `mergedAi2 > 0`.
    originUpgraded = oldOrigin === 'human' && storedOrigin === 'ai-generated';
    if (!mergedNow && !revertedNow && !originUpgraded) return null; // no meaningful transition
  }

  return {
    user: newImage.user?.S ?? '',
    traceId: newImage.trace_id?.S ?? '',
    wasReverted,
    inMain,
    timestamp: newImage.timestamp?.S ?? new Date().toISOString(),
    storedOrigin,
    storedTool,
    isNew,
    mergedNow,
    revertedNow,
    originUpgraded,
  };
}

// ---- Handler ----

export async function handler(event: StreamEvent): Promise<void> {
  const now = new Date();
  const datums: MetricDatum[] = [];
  let aiCommits = 0;
  let humanCommits = 0;
  let mergedAi = 0;
  let revertedAi = 0;
  let upgraded = 0;

  /** Push a Count=1 datum, dimensionless plus an optional Tool-dimensioned twin. */
  const emit = (name: string, ts: Date, tool?: string): void => {
    datums.push({ MetricName: name, Value: 1, Unit: StandardUnit.Count, Timestamp: ts, Dimensions: [] });
    if (tool) {
      datums.push({ MetricName: name, Value: 1, Unit: StandardUnit.Count, Timestamp: ts, Dimensions: [{ Name: 'Tool', Value: tool }] });
    }
  };

  /**
   * Retract a previously-published Count by emitting -1.
   *
   * PutMetricData accepts negative values and every consumer of these metrics
   * aggregates with Sum, so a -1 makes the running total correct rather than
   * leaving a permanent over-count. The retraction is emitted at the SAME
   * timestamp basis as the original datum so the pair falls inside or outside
   * any dashboard time range together — retracting at `now` instead would let
   * a range catch the -1 without the +1 and render a negative count.
   */
  const retract = (name: string, ts: Date): void => {
    datums.push({ MetricName: name, Value: -1, Unit: StandardUnit.Count, Timestamp: ts, Dimensions: [] });
  };

  for (const record of event.Records ?? []) {
    const commit = parseCommitRecord(record);
    if (!commit) continue;

    const { tool, isAi } = await resolveOrigin(
      commit.storedOrigin, commit.storedTool, commit.user, commit.traceId,
    );
    const timestamp = new Date(commit.timestamp);
    // CloudWatch rejects PutMetricData timestamps older than 2 weeks (and one
    // bad member rejects the whole batch, wedging the stream in a retry loop).
    // Use the commit's own time when it's inside the window so live traffic
    // charts at commit time; clamp backfilled history to ingest time.
    const OLDEST_ALLOWED_MS = 13 * 24 * 60 * 60 * 1000; // 13d — safety margin inside CW's 14d limit
    const metricTimestamp =
      isNaN(timestamp.getTime()) || now.getTime() - timestamp.getTime() > OLDEST_ALLOWED_MS
        ? now
        : timestamp;

    if (commit.isNew) {
      // New commit: CommitsTotal always, then AI/Human split.
      emit('CommitsTotal', metricTimestamp);
      if (isAi) {
        aiCommits++;
        emit('AICommits', metricTimestamp, tool);
        // States already true at INSERT time (backfill of an old commit whose
        // merge/revert happened before codeburn first synced it).
        if (commit.inMain) {
          mergedAi++;
          emit('MergedAICommits', metricTimestamp, tool);
        }
        if (commit.wasReverted) {
          revertedAi++;
          emit('RevertedAICommits', metricTimestamp);
        }
      } else {
        humanCommits++;
        emit('HumanCommits', metricTimestamp);
        if (commit.inMain) emit('MergedHumanCommits', metricTimestamp);
      }
      continue;
    }

    // MODIFY — state transition(s). The receiver writes only when in_main,
    // was_reverted or ai_origin actually changed, and a single MODIFY can carry
    // more than one.

    // human → ai-generated. The INSERT already published this commit as human,
    // so the AI counts are published AND the superseded human counts retracted.
    // Without the retraction HumanCommits keeps a phantom that no later event
    // clears, and AI share reads low forever.
    if (commit.originUpgraded) {
      upgraded++;
      aiCommits++;
      retract('HumanCommits', metricTimestamp);
      emit('AICommits', metricTimestamp, tool);
      if (commit.inMain) {
        // in_main was already true at INSERT (CI seeds merged commits), so
        // mergedNow is false and this is the only chance to move the merged
        // count onto the AI series — the one the AI Defect Trend widget reads.
        mergedAi++;
        retract('MergedHumanCommits', metricTimestamp);
        emit('MergedAICommits', metricTimestamp, tool);
      }
      if (commit.wasReverted) {
        revertedAi++;
        emit('RevertedAICommits', metricTimestamp, tool);
      }
    }

    if (commit.mergedNow) {
      if (isAi) {
        // Already counted by the originUpgraded branch above when both fired in
        // the same event; counting twice would double the denominator.
        if (!commit.originUpgraded) {
          mergedAi++;
          emit('MergedAICommits', metricTimestamp, tool);
        }
      } else {
        emit('MergedHumanCommits', metricTimestamp);
      }
    }
    if (commit.revertedNow && isAi && !commit.originUpgraded) {
      revertedAi++;
      emit('RevertedAICommits', metricTimestamp, tool);
    }
  }

  // Publish in batches
  for (let i = 0; i < datums.length; i += PUT_METRIC_BATCH_SIZE) {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: METRIC_NAMESPACE,
      MetricData: datums.slice(i, i + PUT_METRIC_BATCH_SIZE),
    }));
  }

  console.log(
    `[attribution-metrics-publisher] records=${event.Records?.length ?? 0} ` +
    `ai=${aiCommits} human=${humanCommits} merged=${mergedAi} reverted=${revertedAi} ` +
    `upgraded=${upgraded} datums=${datums.length}`,
  );
}
