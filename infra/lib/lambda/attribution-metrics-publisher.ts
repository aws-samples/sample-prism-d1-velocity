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

/** Parse a stream record into commit metadata. Only processes INSERT events for COMMIT# items. */
function parseCommitRecord(record: StreamRecord): {
  user: string;
  traceId: string;
  wasReverted: boolean;
  timestamp: string;
} | null {
  // Only process new commits (INSERT) and state updates (MODIFY where wasReverted changes)
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') return null;

  const newImage = record.dynamodb?.NewImage;
  if (!newImage) return null;

  const recordType = newImage.record_type?.S;
  if (recordType !== 'OTEL_ATTR_COMMIT') return null;

  // For MODIFY, only publish if wasReverted changed from false → true
  if (record.eventName === 'MODIFY') {
    const oldImage = record.dynamodb?.OldImage;
    const oldReverted = oldImage?.was_reverted?.BOOL ?? false;
    const newReverted = newImage.was_reverted?.BOOL ?? false;
    if (!newReverted || oldReverted === newReverted) return null; // no revert transition
  }

  return {
    user: newImage.user?.S ?? '',
    traceId: newImage.trace_id?.S ?? '',
    wasReverted: newImage.was_reverted?.BOOL ?? false,
    timestamp: newImage.timestamp?.S ?? new Date().toISOString(),
  };
}

// ---- Handler ----

export async function handler(event: StreamEvent): Promise<void> {
  const now = new Date();
  const datums: MetricDatum[] = [];
  let aiCommits = 0;
  let humanCommits = 0;
  let revertedAi = 0;

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

    // For MODIFY events, we only get here if wasReverted changed to true
    if (record.eventName === 'MODIFY') {
      if (isAi) {
        revertedAi++;
        datums.push({
          MetricName: 'RevertedAICommits',
          Value: 1,
          Unit: StandardUnit.Count,
          Timestamp: metricTimestamp,
          Dimensions: [],
        });
        datums.push({
          MetricName: 'RevertedAICommits',
          Value: 1,
          Unit: StandardUnit.Count,
          Timestamp: metricTimestamp,
          Dimensions: [{ Name: 'Tool', Value: tool }],
        });
      }
      continue;
    }

    // INSERT — new commit
    // CommitsTotal (always)
    datums.push({
      MetricName: 'CommitsTotal',
      Value: 1,
      Unit: StandardUnit.Count,
      Timestamp: metricTimestamp,
      Dimensions: [],
    });

    if (isAi) {
      aiCommits++;
      // AICommits dimensionless
      datums.push({
        MetricName: 'AICommits',
        Value: 1,
        Unit: StandardUnit.Count,
        Timestamp: metricTimestamp,
        Dimensions: [],
      });
      // AICommits by Tool
      datums.push({
        MetricName: 'AICommits',
        Value: 1,
        Unit: StandardUnit.Count,
        Timestamp: metricTimestamp,
        Dimensions: [{ Name: 'Tool', Value: tool }],
      });

      // If already reverted at INSERT time (rare but possible via upsert race)
      if (commit.wasReverted) {
        revertedAi++;
        datums.push({
          MetricName: 'RevertedAICommits',
          Value: 1,
          Unit: StandardUnit.Count,
          Timestamp: metricTimestamp,
          Dimensions: [],
        });
      }
    } else {
      humanCommits++;
      datums.push({
        MetricName: 'HumanCommits',
        Value: 1,
        Unit: StandardUnit.Count,
        Timestamp: metricTimestamp,
        Dimensions: [],
      });
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
    `ai=${aiCommits} human=${humanCommits} reverted=${revertedAi} datums=${datums.length}`,
  );
}
