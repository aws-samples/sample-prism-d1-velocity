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
  QueryCommand,
  ScanCommand,
  GetItemCommand,
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
  rawQueryString?: string;
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
  | { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean; arrayValue?: { values?: OtlpValue[] } };

interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  name?: string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
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
  traceId: string;
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

// ---- Attribution span types ----

interface ParsedAttributionSpan {
  kind: 'session' | 'commit';
  spanId: string;
  traceId: string;
  timestamp: string;
  endTimestamp: string;
  sessionId: string;
  project: string;
  repo: string | null;
  deviceId: string;
  // session-specific
  commitCount?: number;
  prLinks?: string[];
  // commit-specific
  sha?: string;
  inMain?: boolean;
  wasReverted?: boolean;
}

const ATTRIBUTION_SPAN_NAMES: Record<string, 'session' | 'commit'> = {
  'codeburn.session.attribution': 'session',
  'codeburn.commit': 'commit',
};

const COMMIT_TTL_DAYS = 365; // commit facts are more durable than usage spans

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

/** Extract and sanity-check spans from an OTLP payload. Returns usage spans, attribution spans, and rejected count. */
export function parseOtlpSpans(payload: OtlpPayload): {
  spans: ParsedSpan[];
  attributionSpans: ParsedAttributionSpan[];
  rejected: number;
} {
  const spans: ParsedSpan[] = [];
  const attributionSpans: ParsedAttributionSpan[] = [];
  let rejected = 0;

  for (const rs of payload.resourceSpans ?? []) {
    const resourceAttrs = attrMap(rs.resource?.attributes);
    const deviceId = str(resourceAttrs.get('codeburn.device_id')).slice(0, 64);

    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const spanName = typeof span.name === 'string' ? span.name : '';
        const attrs = attrMap(span.attributes);
        const spanId = typeof span.spanId === 'string' ? span.spanId : '';
        const traceId = typeof span.traceId === 'string' ? span.traceId : '';
        const timestamp = nanoToIso(span.startTimeUnixNano);

        if (!/^[0-9a-f]{16}$/i.test(spanId) || !timestamp) {
          rejected++;
          continue;
        }

        // --- Attribution spans ---
        const attrKind = ATTRIBUTION_SPAN_NAMES[spanName];
        if (attrKind) {
          const sessionId = str(attrs.get('ai.session_id'));
          if (!sessionId) { rejected++; continue; }

          const endTimestamp = nanoToIso(span.endTimeUnixNano) || timestamp;
          const repo = str(attrs.get('git.repo')) || null;

          if (attrKind === 'commit') {
            const sha = str(attrs.get('git.sha'));
            if (!sha || !repo) { rejected++; continue; } // commits without repo can't be joined
            attributionSpans.push({
              kind: 'commit',
              spanId: spanId.toLowerCase(),
              traceId: traceId.toLowerCase(),
              timestamp,
              endTimestamp,
              sessionId,
              project: str(attrs.get('ai.project')).slice(0, 256),
              repo,
              deviceId,
              sha: sha.slice(0, 40),
              inMain: bool(attrs.get('git.in_main')),
              wasReverted: bool(attrs.get('git.was_reverted')),
            });
          } else {
            // session attribution
            const prLinksValue = attrs.get('git.pr_links');
            const prLinks: string[] = [];
            if (prLinksValue && 'arrayValue' in prLinksValue) {
              const av = (prLinksValue as { arrayValue?: { values?: OtlpValue[] } }).arrayValue;
              for (const v of av?.values ?? []) {
                const link = typeof (v as { stringValue?: string }).stringValue === 'string'
                  ? (v as { stringValue: string }).stringValue : '';
                if (link) prLinks.push(link.slice(0, 256));
              }
            }
            attributionSpans.push({
              kind: 'session',
              spanId: spanId.toLowerCase(),
              traceId: traceId.toLowerCase(),
              timestamp,
              endTimestamp,
              sessionId,
              project: str(attrs.get('ai.project')).slice(0, 256),
              repo,
              deviceId,
              commitCount: num(attrs.get('git.commit_count')),
              prLinks: prLinks.slice(0, 20),
            });
          }
          continue;
        }

        // --- Usage spans (existing logic) ---
        const provider = str(attrs.get('ai.provider'));
        if (!provider) {
          rejected++;
          continue;
        }

        const inputTokens = num(attrs.get('ai.input_tokens'));
        const outputTokens = num(attrs.get('ai.output_tokens'));
        const costUsd = num(attrs.get('ai.cost_usd'));
        if (
          inputTokens < 0 || outputTokens < 0 || costUsd < 0 ||
          inputTokens > 100_000_000 || outputTokens > 100_000_000 || costUsd > 10_000
        ) {
          rejected++;
          continue;
        }

        spans.push({
          spanId: spanId.toLowerCase(),
          traceId: traceId.toLowerCase(),
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

  return { spans, attributionSpans, rejected };
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
        trace_id: { S: s.traceId },
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

// ---- Attribution DDB writes ----

/**
 * Write a session attribution record. Conditional put (dedup by spanId which
 * encodes state). If state changes, codeburn sends a new spanId → new item.
 * Old items expire via TTL.
 */
async function writeSessionAttribution(user: string, s: ParsedAttributionSpan): Promise<boolean> {
  const ttl = Math.floor(Date.now() / 1000) + SPAN_TTL_DAYS * 24 * 60 * 60;
  try {
    const item: Record<string, { S?: string; N?: string; BOOL?: boolean; SS?: string[] }> = {
      pk: { S: `USER#${user}` },
      sk: { S: `ATTR#SESSION#${s.sessionId}#${s.spanId}` },
      record_type: { S: 'OTEL_ATTR_SESSION' },
      session_id: { S: s.sessionId },
      trace_id: { S: s.traceId },
      project: { S: s.project },
      device_id: { S: s.deviceId },
      timestamp: { S: s.timestamp },
      end_time: { S: s.endTimestamp },
      commit_count: { N: String(s.commitCount ?? 0) },
      ttl: { N: String(ttl) },
    };
    if (s.repo) item.repo = { S: s.repo };
    if (s.prLinks && s.prLinks.length > 0) item.pr_links = { SS: s.prLinks };

    await dynamoClient.send(new PutItemCommand({
      TableName: AI_USAGE_TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
    return true;
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) return false;
    throw e;
  }
}

/**
 * Write/update a commit attribution record. Conditional UPSERT — only writes
 * if the item doesn't exist OR the mutable state (inMain/wasReverted) changed.
 * This prevents redundant DDB stream MODIFY events that would double-count
 * CloudWatch metrics in the attribution-metrics-publisher.
 *
 * AI-Origin inference: done at query time by joining with usage spans via traceId.
 * If no usage spans share this traceId → origin=human, tool=none.
 * If usage spans exist → origin=ai-generated, tool=provider from usage span.
 */
async function writeCommitAttribution(user: string, s: ParsedAttributionSpan): Promise<boolean> {
  if (!s.repo || !s.sha) return false;
  const ttl = Math.floor(Date.now() / 1000) + COMMIT_TTL_DAYS * 24 * 60 * 60;

  try {
    await dynamoClient.send(new UpdateItemCommand({
      TableName: AI_USAGE_TABLE,
      Key: {
        pk: { S: `REPO#${s.repo}` },
        sk: { S: `COMMIT#${s.sha}` },
      },
      UpdateExpression:
        'SET record_type = :rt, session_id = :sid, trace_id = :tid, ' +
        '#proj = :proj, #usr = :usr, device_id = :did, ' +
        'in_main = :im, was_reverted = :wr, ' +
        '#ts = :ts, updated_at = :now, #ttl = :ttl, ' +
        // Sparse by-user GSI keys: per-developer commit queries (GET
        // /v1/productivity) without scanning the table.
        'gsi_user = :gu, gsi_user_sk = :gusk',
      // Only write if: item doesn't exist, OR inMain/wasReverted actually changed.
      // Suppresses no-op MODIFY stream events that would double-count metrics.
      ConditionExpression:
        'attribute_not_exists(pk) OR in_main <> :im OR was_reverted <> :wr',
      ExpressionAttributeNames: {
        // 'project', 'ttl', 'user', and 'timestamp' are all DynamoDB
        // reserved keywords — bare use in an expression throws
        // ValidationException at runtime.
        '#proj': 'project',
        '#ttl': 'ttl',
        '#usr': 'user',
        '#ts': 'timestamp',
      },
      ExpressionAttributeValues: {
        ':rt': { S: 'OTEL_ATTR_COMMIT' },
        ':sid': { S: s.sessionId },
        ':tid': { S: s.traceId },
        ':proj': { S: s.project },
        ':usr': { S: user },
        ':did': { S: s.deviceId },
        ':im': { BOOL: s.inMain ?? false },
        ':wr': { BOOL: s.wasReverted ?? false },
        ':ts': { S: s.timestamp },
        ':now': { S: new Date().toISOString() },
        ':ttl': { N: String(ttl) },
        ':gu': { S: `USER#${user}` },
        ':gusk': { S: `COMMIT#${s.timestamp}` },
      },
    }));
    return true;
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) return false; // no-op, state unchanged
    throw e;
  }
}

/** Process attribution spans. Returns count of writes. */
async function processAttributionSpans(user: string, spans: ParsedAttributionSpan[]): Promise<number> {
  const CONCURRENCY = 20;
  let written = 0;
  for (let i = 0; i < spans.length; i += CONCURRENCY) {
    const chunk = spans.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async (s) => {
      if (s.kind === 'session') return writeSessionAttribution(user, s);
      return writeCommitAttribution(user, s);
    }));
    written += results.filter(Boolean).length;
  }
  return written;
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

  const { spans, attributionSpans, rejected } = parseOtlpSpans(payload);
  const totalAccepted = spans.length + attributionSpans.length;

  if (totalAccepted > MAX_BATCH_SIZE) {
    return jsonResponse(400, { message: `Batch exceeds max_batch_size (${MAX_BATCH_SIZE})` });
  }

  // Archive the raw batch first — the S3 OTLP archive is the external contract.
  await archiveToS3(rawBody);

  // Process usage spans (existing flow)
  const usageWritten = await processSpans(user, spans);

  // Process attribution spans (new flow)
  const attrWritten = await processAttributionSpans(user, attributionSpans);

  console.log(
    `[otel-receiver] user=${user} ` +
    `usage: received=${spans.length} new=${usageWritten} dupes=${spans.length - usageWritten} | ` +
    `attribution: received=${attributionSpans.length} written=${attrWritten} | ` +
    `rejected=${rejected}`,
  );

  if (rejected > 0) {
    return jsonResponse(200, {
      partialSuccess: { rejectedSpans: rejected, errorMessage: 'Spans missing required attributes or failed validation' },
    });
  }
  return jsonResponse(200, {});
}

// ---- Attribution query helpers ----

export interface CommitAttribution {
  sha: string;
  repo: string;
  sessionId: string;
  traceId: string;
  user: string;
  project: string;
  inMain: boolean;
  wasReverted: boolean;
  timestamp: string;
  /** Inferred from presence of correlated usage spans. */
  aiOrigin: 'ai-generated' | 'human';
  /** Tool name from correlated usage spans, or 'none' if human. */
  aiTool: string;
  /** Model from correlated usage spans, or empty if human. */
  aiModel: string;
}

/**
 * Query a commit's attribution with AI-origin inference via traceId join.
 *
 * 1. Get REPO#<repo>/COMMIT#<sha> → session_id, trace_id, user
 * 2. Query USER#<user>/SPAN#* filtered by trace_id match
 * 3. If usage spans found → ai-generated + tool from first usage span
 * 4. If no usage spans → human, tool=none
 */
export async function queryCommitAttribution(repo: string, sha: string): Promise<CommitAttribution | null> {
  // Step 1: Get the commit record
  const commitResult = await dynamoClient.send(new GetItemCommand({
    TableName: AI_USAGE_TABLE,
    Key: {
      pk: { S: `REPO#${repo}` },
      sk: { S: `COMMIT#${sha}` },
    },
  }));

  const item = commitResult.Item;
  if (!item) return null;

  const traceId = item.trace_id?.S ?? '';
  const user = item.user?.S ?? '';
  const sessionId = item.session_id?.S ?? '';

  if (!traceId || !user) return null;

  // Step 2: Find correlated usage spans for this session's traceId.
  const usage = await lookupTraceUsage(user, traceId);

  // Step 3: Infer AI origin
  let aiOrigin: 'ai-generated' | 'human' = 'human';
  let aiTool = 'none';
  let aiModel = '';

  if (usage) {
    aiOrigin = 'ai-generated';
    aiTool = usage.tool;
    aiModel = usage.model;
  }

  return {
    sha,
    repo,
    sessionId,
    traceId,
    user,
    project: item.project?.S ?? '',
    inMain: item.in_main?.BOOL ?? false,
    wasReverted: item.was_reverted?.BOOL ?? false,
    timestamp: item.timestamp?.S ?? '',
    aiOrigin,
    aiTool,
    aiModel,
  };
}

/**
 * Query all commits for a repo, with AI-origin inference for each.
 * Returns commits sorted by timestamp descending.
 */
export async function queryRepoCommits(repo: string, limit = 50): Promise<CommitAttribution[]> {
  const result = await dynamoClient.send(new QueryCommand({
    TableName: AI_USAGE_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': { S: `REPO#${repo}` },
      ':prefix': { S: 'COMMIT#' },
    },
    ScanIndexForward: false, // newest first
    Limit: limit,
  }));

  const commits: CommitAttribution[] = [];
  // One trace map per distinct user in the result set — replaces the
  // previous per-commit span query (which used Limit:1 + FilterExpression;
  // DynamoDB applies Limit BEFORE the filter, so it examined one span and
  // misclassified nearly every commit as human).
  const traceMaps = new Map<string, Map<string, { tool: string; model: string }>>();
  for (const item of result.Items ?? []) {
    const sha = item.sk?.S?.replace('COMMIT#', '') ?? '';
    const traceId = item.trace_id?.S ?? '';
    const user = item.user?.S ?? '';

    let aiOrigin: 'ai-generated' | 'human' = 'human';
    let aiTool = 'none';
    let aiModel = '';

    if (traceId && user) {
      let traceMap = traceMaps.get(user);
      if (!traceMap) {
        traceMap = await buildUserTraceMap(user);
        traceMaps.set(user, traceMap);
      }
      const usage = traceMap.get(traceId);
      if (usage) {
        aiOrigin = 'ai-generated';
        aiTool = usage.tool;
        aiModel = usage.model;
      }
    }

    commits.push({
      sha,
      repo,
      sessionId: item.session_id?.S ?? '',
      traceId,
      user,
      project: item.project?.S ?? '',
      inMain: item.in_main?.BOOL ?? false,
      wasReverted: item.was_reverted?.BOOL ?? false,
      timestamp: item.timestamp?.S ?? '',
      aiOrigin,
      aiTool,
      aiModel,
    });
  }

  return commits;
}

// ---- Route: attribution query ----

async function handleAttributionQuery(event: HttpApiEvent): Promise<HttpApiResponse> {
  const user = resolveIdentity(event);
  if (!user) return jsonResponse(401, { message: 'No resolvable identity claim in token' });

  // Parse query params from rawPath: /v1/attribution?repo=X&sha=Y or /v1/attribution?repo=X
  const url = new URL(event.rawPath + '?' + (event.rawQueryString ?? ''), 'http://localhost');
  const repo = url.searchParams.get('repo');
  const sha = url.searchParams.get('sha');

  if (!repo) {
    return jsonResponse(400, { message: 'Missing required query parameter: repo' });
  }

  if (sha) {
    // Single commit lookup
    const commit = await queryCommitAttribution(repo, sha);
    if (!commit) return jsonResponse(404, { message: 'Commit not found' });
    return jsonResponse(200, commit);
  }

  // Repo commit list
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
  const commits = await queryRepoCommits(repo, limit);
  return jsonResponse(200, { repo, commits, count: commits.length });
}

// ---- Trace join helpers ----

/**
 * Build a user's traceId → {tool, model} map from their usage spans.
 * One paginated query (projected to three attributes) replaces per-commit
 * span lookups. NOTE: DynamoDB applies Limit BEFORE FilterExpression, so
 * the old Limit:1 + filter pattern examined a single span and almost never
 * found the match — every commit resolved as human.
 */
async function buildUserTraceMap(user: string): Promise<Map<string, { tool: string; model: string }>> {
  const map = new Map<string, { tool: string; model: string }>();
  let lastKey: import('@aws-sdk/client-dynamodb').QueryCommandOutput['LastEvaluatedKey'];
  for (let page = 0; page < 100; page++) {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: AI_USAGE_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ProjectionExpression: 'trace_id, tool, model',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${user}` },
        ':prefix': { S: 'SPAN#' },
      },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    for (const item of result.Items ?? []) {
      const tid = item.trace_id?.S;
      if (tid && !map.has(tid)) {
        map.set(tid, { tool: item.tool?.S ?? 'unknown', model: item.model?.S ?? '' });
      }
    }
    lastKey = result.LastEvaluatedKey;
    if (!lastKey) break;
  }
  return map;
}

/** Single traceId lookup via the trace map (small users) — kept simple. */
async function lookupTraceUsage(user: string, traceId: string): Promise<{ tool: string; model: string } | null> {
  const map = await buildUserTraceMap(user);
  return map.get(traceId) ?? null;
}

// ---- Route: productivity query ----

type UserProductivity = {
  user: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    calls: number;
    byTool: Record<string, { costUsd: number; calls: number }>;
    byModel: Record<string, { costUsd: number; calls: number }>;
  };
  commits: {
    total: number;
    ai: number;
    human: number;
    mergedAi: number;
    revertedAi: number;
  };
  ratios: {
    aiSharePct: number | null;
    mergeRatePct: number | null;
    defectRatePct: number | null;
    costPerAiCommit: number | null;
    costPerShippedCommit: number | null;
  };
};

function computeRatios(u: UserProductivity): void {
  const c = u.commits;
  const pct = (num: number, den: number): number | null =>
    den > 0 ? Math.round((100 * num / den) * 10) / 10 : null;
  u.ratios = {
    aiSharePct: pct(c.ai, c.total),
    mergeRatePct: pct(c.mergedAi, c.ai),
    defectRatePct: pct(c.revertedAi, c.mergedAi),
    costPerAiCommit: c.ai > 0 ? Math.round((u.usage.costUsd / c.ai) * 100) / 100 : null,
    costPerShippedCommit: c.mergedAi > 0 ? Math.round((u.usage.costUsd / c.mergedAi) * 100) / 100 : null,
  };
}

function emptyUserProductivity(user: string): UserProductivity {
  return {
    user,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0, byTool: {}, byModel: {} },
    commits: { total: 0, ai: 0, human: 0, mergedAi: 0, revertedAi: 0 },
    ratios: { aiSharePct: null, mergeRatePct: null, defectRatePct: null, costPerAiCommit: null, costPerShippedCommit: null },
  };
}

/**
 * GET /v1/productivity?user=<email|all>&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Aggregates usage (from OTEL#DAY rollups) and commit outcomes (attribution
 * items, AI-origin via traceId join) per developer, with fleet totals.
 * Defaults: user=all, last 30 days. Full history at real commit timestamps —
 * unlike the CloudWatch metrics, this path has no 2-week ingestion clamp.
 */
async function handleProductivityQuery(event: HttpApiEvent): Promise<HttpApiResponse> {
  const caller = resolveIdentity(event);
  if (!caller) return jsonResponse(401, { message: 'No resolvable identity claim in token' });

  const url = new URL(event.rawPath + '?' + (event.rawQueryString ?? ''), 'http://localhost');
  const userParam = url.searchParams.get('user') ?? 'all';
  const now = new Date();
  const from = url.searchParams.get('from') ?? new Date(now.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
  const to = url.searchParams.get('to') ?? now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return jsonResponse(400, { message: 'from/to must be YYYY-MM-DD' });
  }

  const users = new Map<string, UserProductivity>();
  const getUser = (email: string): UserProductivity => {
    let u = users.get(email);
    if (!u) { u = emptyUserProductivity(email); users.set(email, u); }
    return u;
  };

  // --- Usage from OTEL#DAY rollups ---
  if (userParam !== 'all') {
    // Single user: direct key-range query.
    let lastKey: import('@aws-sdk/client-dynamodb').QueryCommandOutput['LastEvaluatedKey'];
    do {
      const result = await dynamoClient.send(new QueryCommand({
        TableName: AI_USAGE_TABLE,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :lo AND :hi',
        ExpressionAttributeValues: {
          ':pk': { S: `USER#${userParam}` },
          ':lo': { S: `OTEL#DAY#${from}` },
          ':hi': { S: `OTEL#DAY#${to}\uffff` },
        },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      for (const item of result.Items ?? []) accumulateUsage(getUser(userParam), item);
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
  } else {
    // Fleet: paginated scan over the daily rollups. Item count is
    // users × days × tools × models — small at team scale; revisit with a
    // registry item or GSI if the fleet grows past a few hundred users.
    let lastKey: import('@aws-sdk/client-dynamodb').ScanCommandOutput['LastEvaluatedKey'];
    do {
      const result = await dynamoClient.send(new ScanCommand({
        TableName: AI_USAGE_TABLE,
        FilterExpression: 'record_type = :rt AND #day BETWEEN :lo AND :hi',
        ExpressionAttributeNames: { '#day': 'day' },
        ExpressionAttributeValues: {
          ':rt': { S: 'OTEL_DAY' },
          ':lo': { S: from },
          ':hi': { S: to },
        },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      for (const item of result.Items ?? []) {
        const email = item.pk?.S?.replace('USER#', '') ?? '';
        if (email) accumulateUsage(getUser(email), item);
      }
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
  }

  // --- Commits ---
  type RawCommit = { user: string; traceId: string; inMain: boolean; wasReverted: boolean };
  const rawCommits: RawCommit[] = [];
  const commitFrom = `COMMIT#${from}`;
  const commitTo = `COMMIT#${to}\uffff`;
  if (userParam !== 'all') {
    let lastKey: import('@aws-sdk/client-dynamodb').QueryCommandOutput['LastEvaluatedKey'];
    do {
      const result = await dynamoClient.send(new QueryCommand({
        TableName: AI_USAGE_TABLE,
        IndexName: 'by-user',
        KeyConditionExpression: 'gsi_user = :pk AND gsi_user_sk BETWEEN :lo AND :hi',
        ExpressionAttributeValues: {
          ':pk': { S: `USER#${userParam}` },
          ':lo': { S: commitFrom },
          ':hi': { S: commitTo },
        },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      for (const item of result.Items ?? []) {
        rawCommits.push({
          user: userParam,
          traceId: item.trace_id?.S ?? '',
          inMain: item.in_main?.BOOL ?? false,
          wasReverted: item.was_reverted?.BOOL ?? false,
        });
      }
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
  } else {
    let lastKey: import('@aws-sdk/client-dynamodb').ScanCommandOutput['LastEvaluatedKey'];
    do {
      const result = await dynamoClient.send(new ScanCommand({
        TableName: AI_USAGE_TABLE,
        FilterExpression: 'record_type = :rt AND #ts BETWEEN :lo AND :hi',
        ExpressionAttributeNames: { '#ts': 'timestamp' },
        ExpressionAttributeValues: {
          ':rt': { S: 'OTEL_ATTR_COMMIT' },
          ':lo': { S: from },
          ':hi': { S: `${to}\uffff` },
        },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      for (const item of result.Items ?? []) {
        rawCommits.push({
          user: item.user?.S ?? '',
          traceId: item.trace_id?.S ?? '',
          inMain: item.in_main?.BOOL ?? false,
          wasReverted: item.was_reverted?.BOOL ?? false,
        });
      }
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
  }

  // Classify commits via one trace map per user (AI-origin = correlated
  // usage spans exist for the commit's traceId).
  const traceMaps = new Map<string, Map<string, { tool: string; model: string }>>();
  for (const c of rawCommits) {
    if (!c.user) continue;
    const u = getUser(c.user);
    u.commits.total++;
    let traceMap = traceMaps.get(c.user);
    if (!traceMap) {
      traceMap = await buildUserTraceMap(c.user);
      traceMaps.set(c.user, traceMap);
    }
    const isAi = c.traceId !== '' && traceMap.has(c.traceId);
    if (isAi) {
      u.commits.ai++;
      if (c.inMain) u.commits.mergedAi++;
      if (c.wasReverted) u.commits.revertedAi++;
    } else {
      u.commits.human++;
    }
  }

  // --- Ratios + fleet totals ---
  const totals = emptyUserProductivity('all');
  for (const u of users.values()) {
    computeRatios(u);
    totals.usage.inputTokens += u.usage.inputTokens;
    totals.usage.outputTokens += u.usage.outputTokens;
    totals.usage.costUsd += u.usage.costUsd;
    totals.usage.calls += u.usage.calls;
    for (const [tool, t] of Object.entries(u.usage.byTool)) {
      const agg = totals.usage.byTool[tool] ?? { costUsd: 0, calls: 0 };
      agg.costUsd += t.costUsd;
      agg.calls += t.calls;
      totals.usage.byTool[tool] = agg;
    }
    for (const [model, m] of Object.entries(u.usage.byModel)) {
      const agg = totals.usage.byModel[model] ?? { costUsd: 0, calls: 0 };
      agg.costUsd += m.costUsd;
      agg.calls += m.calls;
      totals.usage.byModel[model] = agg;
    }
    totals.commits.total += u.commits.total;
    totals.commits.ai += u.commits.ai;
    totals.commits.human += u.commits.human;
    totals.commits.mergedAi += u.commits.mergedAi;
    totals.commits.revertedAi += u.commits.revertedAi;
  }
  computeRatios(totals);
  totals.usage.costUsd = Math.round(totals.usage.costUsd * 100) / 100;

  return jsonResponse(200, {
    range: { from, to },
    scope: userParam === 'all' ? 'org' : 'user',
    generatedAt: new Date().toISOString(),
    users: [...users.values()].sort((a, b) => b.usage.costUsd - a.usage.costUsd),
    totals,
  });
}

function accumulateUsage(u: UserProductivity, item: Record<string, { S?: string; N?: string }>): void {
  const tool = item.tool?.S ?? 'unknown';
  const cost = Number(item.cost_usd?.N ?? 0);
  const calls = Number(item.call_count?.N ?? 0);
  u.usage.inputTokens += Number(item.input_tokens?.N ?? 0);
  u.usage.outputTokens += Number(item.output_tokens?.N ?? 0);
  u.usage.costUsd = Math.round((u.usage.costUsd + cost) * 10000) / 10000;
  u.usage.calls += calls;
  const t = u.usage.byTool[tool] ?? { costUsd: 0, calls: 0 };
  t.costUsd = Math.round((t.costUsd + cost) * 10000) / 10000;
  t.calls += calls;
  u.usage.byTool[tool] = t;
  const model = item.model?.S ?? 'unknown';
  const m = u.usage.byModel[model] ?? { costUsd: 0, calls: 0 };
  m.costUsd = Math.round((m.costUsd + cost) * 10000) / 10000;
  m.calls += calls;
  u.usage.byModel[model] = m;
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
  if (method === 'GET' && path === '/v1/attribution') {
    return handleAttributionQuery(event);
  }
  if (method === 'GET' && path === '/v1/productivity') {
    return handleProductivityQuery(event);
  }
  return jsonResponse(404, { message: 'Not found' });
}
