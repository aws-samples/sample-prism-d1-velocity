/**
 * PRISM D1 — Attribution metrics publisher.
 *
 * Consumes the prism-d1-ai-usage DynamoDB stream (filtered to COMMIT# items
 * under REPO# pk) and publishes commit attribution metrics to CloudWatch.
 *
 * AI-Origin inference: joins commit → usage spans via traceId.
 * - Has correlated usage spans → ai-generated, tool from span
 * - No correlated usage spans → human, tool=none
 *
 * Metrics published (namespace: PRISM/D1/Velocity):
 *   AICommits        — count of ai-generated commits (dimensionless + by Tool)
 *   HumanCommits     — count of human commits (dimensionless only)
 *   RevertedAICommits — ai-generated commits that were later reverted
 *   CommitsTotal     — all tracked commits regardless of origin
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

/** Parse a stream record into commit metadata. Only processes COMMIT# items. */
function parseCommitRecord(record: StreamRecord): {
  user: string;
  traceId: string;
  wasReverted: boolean;
  inMain: boolean;
  timestamp: string;
  /** Which state transitions this event represents. INSERT = 'new'. A MODIFY
   * can flip in_main and/or was_reverted (receiver writes only when one of
   * them changed). */
  isNew: boolean;
  mergedNow: boolean;   // in_main flipped false → true
  revertedNow: boolean; // was_reverted flipped false → true
} | null {
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') return null;

  const newImage = record.dynamodb?.NewImage;
  if (!newImage) return null;

  const recordType = newImage.record_type?.S;
  if (recordType !== 'OTEL_ATTR_COMMIT') return null;

  const inMain = newImage.in_main?.BOOL ?? false;
  const wasReverted = newImage.was_reverted?.BOOL ?? false;

  let isNew = record.eventName === 'INSERT';
  let mergedNow = false;
  let revertedNow = false;

  if (record.eventName === 'MODIFY') {
    const oldImage = record.dynamodb?.OldImage;
    const oldInMain = oldImage?.in_main?.BOOL ?? false;
    const oldReverted = oldImage?.was_reverted?.BOOL ?? false;
    mergedNow = inMain && !oldInMain;
    revertedNow = wasReverted && !oldReverted;
    if (!mergedNow && !revertedNow) return null; // no meaningful transition
  }

  return {
    user: newImage.user?.S ?? '',
    traceId: newImage.trace_id?.S ?? '',
    wasReverted,
    inMain,
    timestamp: newImage.timestamp?.S ?? new Date().toISOString(),
    isNew,
    mergedNow,
    revertedNow,
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

  /** Push a Count=1 datum, dimensionless plus an optional Tool-dimensioned twin. */
  const emit = (name: string, ts: Date, tool?: string): void => {
    datums.push({ MetricName: name, Value: 1, Unit: StandardUnit.Count, Timestamp: ts, Dimensions: [] });
    if (tool) {
      datums.push({ MetricName: name, Value: 1, Unit: StandardUnit.Count, Timestamp: ts, Dimensions: [{ Name: 'Tool', Value: tool }] });
    }
  };

  for (const record of event.Records ?? []) {
    const commit = parseCommitRecord(record);
    if (!commit) continue;

    const { tool, isAi } = await resolveAiTool(commit.user, commit.traceId);
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

    // MODIFY — state transition(s). The receiver writes only when in_main or
    // was_reverted actually changed, and a single MODIFY can carry both flips.
    if (commit.mergedNow) {
      if (isAi) {
        mergedAi++;
        emit('MergedAICommits', metricTimestamp, tool);
      } else {
        emit('MergedHumanCommits', metricTimestamp);
      }
    }
    if (commit.revertedNow && isAi) {
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
    `ai=${aiCommits} human=${humanCommits} merged=${mergedAi} reverted=${revertedAi} datums=${datums.length}`,
  );
}
