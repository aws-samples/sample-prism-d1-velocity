/**
 * PRISM D1 — OTEL metrics publisher.
 *
 * Consumes the prism-d1-ai-usage DynamoDB stream (filtered at the event
 * source to sk begins_with "OTEL#DAY#") and publishes token/cost deltas to
 * CloudWatch under the same metric names the dashboards already read:
 * AIInputTokens, AIOutputTokens, AICostUSD.
 *
 * Only active when the OTEL collector is enabled — the metrics-processor
 * stops publishing trailer-sourced token metrics (OTEL_ENABLED=true) so
 * these series are exclusively OTEL-fed and never double-counted.
 *
 * Scale guards (by design):
 *  - Deltas are exact: OTEL#DAY# items are ADD counters, so delta = NEW − OLD.
 *  - Metrics are timestamped with the SPAN day, not arrival time. Backfilled
 *    days older than the CloudWatch ingest window (14 days) are dropped —
 *    the DynamoDB aggregates and S3 OTLP archive still hold full history.
 *  - Published dimensionless (matches dashboard widgets) AND with Tool and
 *    Model dimensions (small, bounded cardinality) for per-tool / per-model
 *    slicing.
 *  - Single PutMetricData call per batch, chunked at the API limit.
 */

import {
  CloudWatchClient,
  PutMetricDataCommand,
  MetricDatum,
  StandardUnit,
} from '@aws-sdk/client-cloudwatch';

const cloudwatch = new CloudWatchClient({});

const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE || 'PRISM/D1/Velocity';
/** CloudWatch rejects datapoints older than 14 days. */
const MAX_METRIC_AGE_DAYS = 14;
/** PutMetricData accepts up to 1000 datums per call. */
const PUT_METRIC_BATCH_SIZE = 1000;

// ---- Types (DynamoDB stream event, trimmed to what we read) ----

interface AttributeValue {
  S?: string;
  N?: string;
}

interface StreamImage {
  sk?: AttributeValue;
  day?: AttributeValue;
  tool?: AttributeValue;
  model?: AttributeValue;
  input_tokens?: AttributeValue;
  output_tokens?: AttributeValue;
  cost_usd?: AttributeValue;
}

interface StreamRecord {
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE';
  dynamodb?: {
    Keys?: { pk?: AttributeValue; sk?: AttributeValue };
    NewImage?: StreamImage;
    OldImage?: StreamImage;
  };
}

export interface StreamEvent {
  Records?: StreamRecord[];
}

// ---- Helpers ----

function num(v: AttributeValue | undefined): number {
  const n = Number(v?.N ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Resolve the metric timestamp from the aggregate's span day. Null = drop. */
export function resolveTimestamp(day: string, now: Date = new Date()): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  // Noon UTC keeps the datum inside the calendar day for all dashboard periods.
  const ts = new Date(`${day}T12:00:00Z`);
  if (isNaN(ts.getTime())) return null;
  const ageMs = now.getTime() - ts.getTime();
  // Too old for CloudWatch ingest (backfilled history) — drop, don't error.
  if (ageMs > MAX_METRIC_AGE_DAYS * 24 * 60 * 60 * 1000) return null;
  // Guard against clock skew: never publish a future timestamp.
  return ts.getTime() > now.getTime() ? now : ts;
}

interface Delta {
  day: string;
  tool: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Compute the counter delta for one OTEL#DAY# stream record. Null = skip. */
export function computeDelta(record: StreamRecord): Delta | null {
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') return null;

  const newImage = record.dynamodb?.NewImage;
  const sk = newImage?.sk?.S ?? record.dynamodb?.Keys?.sk?.S ?? '';
  // Defense in depth — the event source filter should already guarantee this.
  if (!sk.startsWith('OTEL#DAY#')) return null;

  const oldImage = record.dynamodb?.OldImage;
  const delta: Delta = {
    day: newImage?.day?.S ?? sk.split('#')[2] ?? '',
    tool: newImage?.tool?.S ?? sk.split('#')[3] ?? 'unknown',
    model: newImage?.model?.S ?? sk.split('#')[4] ?? 'unknown',
    inputTokens: num(newImage?.input_tokens) - num(oldImage?.input_tokens),
    outputTokens: num(newImage?.output_tokens) - num(oldImage?.output_tokens),
    costUsd: num(newImage?.cost_usd) - num(oldImage?.cost_usd),
  };

  // Nothing to publish (e.g. metadata-only update) or a counter went
  // backwards (should not happen with ADD — treat defensively as no-op).
  if (delta.inputTokens <= 0 && delta.outputTokens <= 0 && delta.costUsd <= 0) return null;
  return delta;
}

/**
 * Build datums for a delta across three dimension sets:
 * dimensionless (dashboards), Tool, and Model. CloudWatch cannot roll up
 * across dimensions, so each slice needs its own series. Tool and model
 * cardinality are both small and bounded.
 */
export function buildDatums(delta: Delta, timestamp: Date): MetricDatum[] {
  const metrics: Array<[string, number, StandardUnit]> = [
    ['AIInputTokens', delta.inputTokens, StandardUnit.Count],
    ['AIOutputTokens', delta.outputTokens, StandardUnit.Count],
    ['AICostUSD', delta.costUsd, StandardUnit.None],
  ];

  const dimensionSets = [
    [],
    [{ Name: 'Tool', Value: delta.tool }],
    [{ Name: 'Model', Value: delta.model }],
  ];

  const datums: MetricDatum[] = [];
  for (const [name, value, unit] of metrics) {
    if (value <= 0) continue;
    for (const dimensions of dimensionSets) {
      datums.push({ MetricName: name, Value: value, Unit: unit, Timestamp: timestamp, Dimensions: dimensions });
    }
  }
  return datums;
}

// ---- Handler ----

export async function handler(event: StreamEvent): Promise<void> {
  const now = new Date();
  const datums: MetricDatum[] = [];
  let processed = 0;
  let droppedOld = 0;

  for (const record of event.Records ?? []) {
    const delta = computeDelta(record);
    if (!delta) continue;

    const timestamp = resolveTimestamp(delta.day, now);
    if (!timestamp) {
      droppedOld++;
      continue;
    }

    datums.push(...buildDatums(delta, timestamp));
    processed++;
  }

  for (let i = 0; i < datums.length; i += PUT_METRIC_BATCH_SIZE) {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: METRIC_NAMESPACE,
      MetricData: datums.slice(i, i + PUT_METRIC_BATCH_SIZE),
    }));
  }

  console.log(
    `[otel-metrics-publisher] records=${event.Records?.length ?? 0} ` +
    `published=${processed} droppedTooOld=${droppedOld} datums=${datums.length}`,
  );
}
