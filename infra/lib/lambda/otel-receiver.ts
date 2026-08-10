/**
 * PRISM D1 — OTLP receiver for codeburn sync.
 *
 * Serves two routes on the OTEL collector HTTP API:
 *   GET  /.well-known/codeburn-export.json  — discovery doc (no auth)
 *   POST /v1/traces                         — OTLP/HTTP JSON traces (JWT-authorized)
 *
 * Trace flow: validate (JWT done by API Gateway) → archive raw OTLP batch to S3
 * (external contract — standard OTLP JSON, Athena/replay-friendly) → per-span
 * conditional DynamoDB write (dedup gate) → daily aggregate ADD (only for
 * newly-seen spans, bucketed by SPAN date, not arrival date).
 *
 * Item shapes in the AI-usage table:
 *   pk=USER#<identity>  sk=SPAN#<timestamp>#<spanId>            raw span, TTL 90d
 *   pk=USER#<identity>  sk=OTEL#DAY#<yyyy-mm-dd>#<tool>#<model> daily aggregate
 */

import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const dynamoClient = new DynamoDBClient({});
const s3Client = new S3Client({});

const AI_USAGE_TABLE = process.env.AI_USAGE_TABLE || 'prism-d1-ai-usage';
const ARCHIVE_BUCKET = process.env.ARCHIVE_BUCKET || '';
const IDENTITY_CLAIM = process.env.IDENTITY_CLAIM || 'username';
const OIDC_ISSUER = process.env.OIDC_ISSUER || '';
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || '';
const MAX_BATCH_SIZE = Number(process.env.MAX_BATCH_SIZE || '1000');
const SPAN_TTL_DAYS = Number(process.env.SPAN_TTL_DAYS || '90');

/** codeburn provider names → PRISM tool names. */
const PROVIDER_TO_TOOL: Record<string, string> = {
  claude: 'claude-code',
  kiro: 'kiro',
  cursor: 'cursor',
  codex: 'codex',
  copilot: 'copilot',
};

// ---- Types (API Gateway HTTP API v2 proxy + OTLP JSON) ----

interface HttpApiEvent {
  rawPath: string;
  requestContext: {
    http: { method: string; path: string };
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
  body?: string;
  isBase64Encoded?: boolean;
}

interface HttpApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

type OtlpValue =
  | { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };

interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  name?: string;
  startTimeUnixNano?: string;
  attributes?: OtlpAttribute[];
}

interface OtlpPayload {
  resourceSpans?: Array<{
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
  }>;
}

interface ParsedSpan {
  spanId: string;
  timestamp: string; // ISO from span start time
  tool: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  project: string;
  costEstimated: boolean;
  deviceId: string;
}

// ---- Helpers ----

function jsonResponse(statusCode: number, body: unknown): HttpApiResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function attrMap(attrs: OtlpAttribute[] | undefined): Map<string, OtlpValue> {
  const m = new Map<string, OtlpValue>();
  for (const a of attrs ?? []) {
    if (a && typeof a.key === 'string' && a.value) m.set(a.key, a.value);
  }
  return m;
}

function str(v: OtlpValue | undefined): string {
  return typeof v?.stringValue === 'string' ? v.stringValue : '';
}

function num(v: OtlpValue | undefined): number {
  if (v?.intValue !== undefined) {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v?.doubleValue === 'number' && Number.isFinite(v.doubleValue)) return v.doubleValue;
  return 0;
}

function bool(v: OtlpValue | undefined): boolean {
  return v?.boolValue === true;
}

/** Convert OTLP unix-nano string to ISO timestamp; empty string if invalid. */
function nanoToIso(nano: string | undefined): string {
  if (!nano || !/^\d+$/.test(nano)) return '';
  try {
    const ms = Number(BigInt(nano) / 1_000_000n);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  } catch {
    return '';
  }
}

/** Resolve caller identity from JWT claims (validated by the API Gateway authorizer). */
function resolveIdentity(event: HttpApiEvent): string | null {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  if (!claims) return null;
  for (const claim of [IDENTITY_CLAIM, 'username', 'email', 'sub']) {
    const v = claims[claim];
    if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase();
  }
  return null;
}

/** Extract and sanity-check spans from an OTLP payload. Returns spans + rejected count. */
export function parseOtlpSpans(payload: OtlpPayload): { spans: ParsedSpan[]; rejected: number } {
  const spans: ParsedSpan[] = [];
  let rejected = 0;

  for (const rs of payload.resourceSpans ?? []) {
    const resourceAttrs = attrMap(rs.resource?.attributes);
    const deviceId = str(resourceAttrs.get('codeburn.device_id')).slice(0, 64);

    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs = attrMap(span.attributes);
        const spanId = typeof span.spanId === 'string' ? span.spanId : '';
        const timestamp = nanoToIso(span.startTimeUnixNano);
        const provider = str(attrs.get('ai.provider'));

        // Minimum viable span: identity key parts must be present and sane.
        if (!/^[0-9a-f]{16}$/i.test(spanId) || !timestamp || !provider) {
          rejected++;
          continue;
        }

        const inputTokens = num(attrs.get('ai.input_tokens'));
        const outputTokens = num(attrs.get('ai.output_tokens'));
        const costUsd = num(attrs.get('ai.cost_usd'));
        // Clamp: reject absurd values (mirrors the CI trailer clamps).
        if (
          inputTokens < 0 || outputTokens < 0 || costUsd < 0 ||
          inputTokens > 100_000_000 || outputTokens > 100_000_000 || costUsd > 10_000
        ) {
          rejected++;
          continue;
        }

        spans.push({
          spanId: spanId.toLowerCase(),
          timestamp,
          tool: PROVIDER_TO_TOOL[provider] ?? provider.slice(0, 32),
          model: str(attrs.get('ai.model')).slice(0, 128),
          inputTokens,
          outputTokens,
          costUsd,
          project: str(attrs.get('ai.project')).slice(0, 256),
          costEstimated: bool(attrs.get('ai.cost_estimated')),
          deviceId,
        });
      }
    }
  }

  return { spans, rejected };
}

// ---- Route: discovery doc ----

function handleDiscovery(): HttpApiResponse {
  return jsonResponse(200, {
    version: 1,
    issuer: OIDC_ISSUER,
    client_id: OIDC_CLIENT_ID,
    scopes: ['openid', 'email', 'profile'],
    traces_path: '/v1/traces',
    max_batch_size: MAX_BATCH_SIZE,
  });
}

// ---- Route: traces ----

async function archiveToS3(rawBody: string): Promise<void> {
  if (!ARCHIVE_BUCKET) return;
  const now = new Date();
  const dt = now.toISOString().slice(0, 10);
  const key = `otlp/dt=${dt}/${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
  await s3Client.send(new PutObjectCommand({
    Bucket: ARCHIVE_BUCKET,
    Key: key,
    Body: rawBody,
    ContentType: 'application/json',
  }));
}

/** Conditional raw-span write. Returns true if the span is NEW (write succeeded). */
async function writeSpanIfNew(user: string, s: ParsedSpan): Promise<boolean> {
  const ttl = Math.floor(Date.now() / 1000) + SPAN_TTL_DAYS * 24 * 60 * 60;
  try {
    await dynamoClient.send(new PutItemCommand({
      TableName: AI_USAGE_TABLE,
      Item: {
        pk: { S: `USER#${user}` },
        sk: { S: `SPAN#${s.timestamp}#${s.spanId}` },
        record_type: { S: 'OTEL_SPAN' },
        tool: { S: s.tool },
        model: { S: s.model },
        input_tokens: { N: String(s.inputTokens) },
        output_tokens: { N: String(s.outputTokens) },
        cost_usd: { N: String(s.costUsd) },
        project: { S: s.project },
        device_id: { S: s.deviceId },
        cost_estimated: { BOOL: s.costEstimated },
        timestamp: { S: s.timestamp },
        ttl: { N: String(ttl) },
      },
      // Dedup gate: deterministic span IDs make retried batches no-ops.
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
    return true;
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) return false;
    throw e;
  }
}

/** ADD-increment the daily aggregate for a newly-seen span (bucketed by SPAN date). */
async function bumpDailyAggregate(user: string, s: ParsedSpan): Promise<void> {
  const day = s.timestamp.slice(0, 10);
  // '#' is the key delimiter — strip it from the model to keep the sk parseable.
  const model = (s.model || 'unknown').replace(/#/g, '');
  await dynamoClient.send(new UpdateItemCommand({
    TableName: AI_USAGE_TABLE,
    Key: {
      pk: { S: `USER#${user}` },
      sk: { S: `OTEL#DAY#${day}#${s.tool}#${model}` },
    },
    UpdateExpression:
      'ADD input_tokens :in, output_tokens :out, cost_usd :cost, call_count :one ' +
      'SET record_type = :rt, tool = :tool, model = :model, #day = :day, updated_at = :now',
    ExpressionAttributeNames: { '#day': 'day' },
    ExpressionAttributeValues: {
      ':in': { N: String(s.inputTokens) },
      ':out': { N: String(s.outputTokens) },
      ':cost': { N: String(s.costUsd) },
      ':one': { N: '1' },
      ':rt': { S: 'OTEL_DAY' },
      ':tool': { S: s.tool },
      ':model': { S: model },
      ':day': { S: day },
      ':now': { S: new Date().toISOString() },
    },
  }));
}

/** Process spans with bounded concurrency. Returns count of newly-written spans. */
async function processSpans(user: string, spans: ParsedSpan[]): Promise<number> {
  const CONCURRENCY = 20;
  let written = 0;
  for (let i = 0; i < spans.length; i += CONCURRENCY) {
    const chunk = spans.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async (s) => {
      const isNew = await writeSpanIfNew(user, s);
      if (isNew) await bumpDailyAggregate(user, s);
      return isNew;
    }));
    written += results.filter(Boolean).length;
  }
  return written;
}

async function handleTraces(event: HttpApiEvent): Promise<HttpApiResponse> {
  const user = resolveIdentity(event);
  if (!user) {
    return jsonResponse(401, { message: 'No resolvable identity claim in token' });
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
    : (event.body ?? '');

  let payload: OtlpPayload;
  try {
    payload = JSON.parse(rawBody) as OtlpPayload;
  } catch {
    return jsonResponse(400, { message: 'Body is not valid JSON' });
  }

  const { spans, rejected } = parseOtlpSpans(payload);

  if (spans.length > MAX_BATCH_SIZE) {
    return jsonResponse(400, { message: `Batch exceeds max_batch_size (${MAX_BATCH_SIZE})` });
  }

  // Archive the raw batch first — the S3 OTLP archive is the external contract.
  // Archive failures are fatal (client retries the batch; dedup gate makes it safe).
  await archiveToS3(rawBody);

  const written = await processSpans(user, spans);
  console.log(
    `[otel-receiver] user=${user} received=${spans.length + rejected} accepted=${spans.length} ` +
    `new=${written} duplicates=${spans.length - written} rejected=${rejected}`,
  );

  // OTLP/HTTP success response; report malformed spans via partialSuccess.
  if (rejected > 0) {
    return jsonResponse(200, {
      partialSuccess: { rejectedSpans: rejected, errorMessage: 'Spans missing required ai.* attributes or failed validation' },
    });
  }
  return jsonResponse(200, {});
}

// ---- Handler ----

export async function handler(event: HttpApiEvent): Promise<HttpApiResponse> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  if (method === 'GET' && path === '/.well-known/codeburn-export.json') {
    return handleDiscovery();
  }
  if (method === 'POST' && path === '/v1/traces') {
    return handleTraces(event);
  }
  return jsonResponse(404, { message: 'Not found' });
}
