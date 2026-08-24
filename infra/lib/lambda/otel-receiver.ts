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

// clientId -> identity, for machine-to-machine tokens. A Cognito
// client-credentials access token carries no `username` and no `email`, and its
// `sub` is the app client id -- so without a mapping the coding agent would appear
// on every dashboard as a random opaque string.
//
// Deliberately deploy-time configuration rather than anything the caller sends. A
// payload that could name its own author would let any holder of any token post as
// anyone, which is a worse problem than an ugly label.
const MACHINE_IDENTITIES: Record<string, string> = (() => {
  try {
    return JSON.parse(process.env.MACHINE_IDENTITIES || '{}');
  } catch {
    console.warn('MACHINE_IDENTITIES is not valid JSON; machine tokens will fall back to sub');
    return {};
  }
})();
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
  /** True for spans the PRISM coding agent emitted: work no human prompted. */
  autonomous?: boolean;
  /** The issue the agent was handed. 0 when not an agent span. */
  issueNumber?: number;
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
  /** True for spans the PRISM coding agent emitted. */
  autonomous?: boolean;
  /** The issue handed to the agent; 0 for human spans. */
  issueNumber?: number;
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

  // A machine token first: checked before the claim chain because its `sub` would
  // otherwise satisfy that chain with the app client id.
  for (const claim of ['client_id', 'sub']) {
    const raw = claims[claim];
    if (typeof raw === 'string' && MACHINE_IDENTITIES[raw]) {
      return MACHINE_IDENTITIES[raw].trim().toLowerCase();
    }
  }

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
              autonomous: bool(attrs.get('prism.autonomous')),
              issueNumber: num(attrs.get('prism.issue_number')),
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
              autonomous: bool(attrs.get('prism.autonomous')),
              issueNumber: num(attrs.get('prism.issue_number')),
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
          // Emitted by the PRISM coding agent. `autonomous` separates work no human
          // prompted from human-assisted AI use, which the PRISM levels treat as
          // different things -- L5 is about autonomous deployments, not AI share.
          autonomous: bool(attrs.get('prism.autonomous')),
          issueNumber: num(attrs.get('prism.issue_number')),
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
        autonomous: { BOOL: s.autonomous === true },
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

/**
 * Record that this identity worked on one issue.
 *
 * One item per (user, repo, issue) rather than a counter, because "issues worked
 * on" is a count of DISTINCT issues and an agent emits a usage span per invocation
 * -- a re-run of the same issue would otherwise inflate the number. The dedup is
 * the condition expression, exactly as it is for spans.
 *
 * A separate item rather than a field on the span so counting is a Query on an sk
 * prefix instead of a scan-and-deduplicate over every span in the window.
 */
async function recordIssue(user: string, repo: string, issueNumber: number,
                           timestamp: string, autonomous: boolean): Promise<boolean> {
  if (!issueNumber || !repo) return false;
  try {
    await dynamoClient.send(new PutItemCommand({
      TableName: AI_USAGE_TABLE,
      Item: {
        pk: { S: `USER#${user}` },
        sk: { S: `ISSUE#${repo}#${issueNumber}` },
        record_type: { S: 'OTEL_ISSUE' },
        repo: { S: repo },
        issue_number: { N: String(issueNumber) },
        autonomous: { BOOL: autonomous },
        first_seen: { S: timestamp },
        ttl: { N: String(Math.floor(Date.now() / 1000) + COMMIT_TTL_DAYS * 86400) },
      },
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
      autonomous: { BOOL: s.autonomous === true },
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
 * AI-Origin is resolved HERE, at write time, and persisted on the item.
 *
 * It used to be inferred at query time by joining against usage spans. That was
 * a latent data-corruption bug: commit facts live COMMIT_TTL_DAYS (365) but
 * usage spans live SPAN_TTL_DAYS (90), so on day 91 the join found nothing and
 * every aging AI commit silently reclassified as `human` — making AI adoption
 * appear to decline over time, depressing the observed PRISM level's L2 gate,
 * and skewing the CISO per-100-commits comparison on both sides.
 *
 * "Derive at read time" is only sound when the inputs outlive the output. They
 * don't here, so the derivation is frozen at ingest while the spans are fresh.
 * Usage spans for this batch are written before attribution spans (see
 * handleTraces), so the trace map passed in already includes them.
 */
async function writeCommitAttribution(
  user: string,
  s: ParsedAttributionSpan,
  traceMap: Map<string, { tool: string; model: string }>,
): Promise<boolean> {
  if (!s.repo || !s.sha) return false;
  const ttl = Math.floor(Date.now() / 1000) + COMMIT_TTL_DAYS * 24 * 60 * 60;

  // Resolve origin now, against spans that are guaranteed to still exist.
  const usage = s.traceId ? traceMap.get(s.traceId) : undefined;
  const aiOrigin = usage ? 'ai-generated' : 'human';
  const aiTool = usage ? usage.tool : 'none';
  const aiModel = usage ? usage.model : '';

  try {
    // Write 1: Upsert metadata + origin. Does NOT touch in_main or was_reverted
    // to prevent codeburn (which doesn't know about merges) from downgrading
    // CI-seeded in_main=true back to false.
    await dynamoClient.send(new UpdateItemCommand({
      TableName: AI_USAGE_TABLE,
      Key: {
        pk: { S: `REPO#${s.repo}` },
        sk: { S: `COMMIT#${s.sha}` },
      },
      UpdateExpression:
        'SET record_type = :rt, session_id = :sid, trace_id = :tid, ' +
        '#proj = :proj, #usr = :usr, device_id = :did, ' +
        '#ts = :ts, updated_at = :now, #ttl = :ttl, ' +
        'ai_origin = :ao, ai_tool = :at, ai_model = :am, origin_source = :os, ' +
        'gsi_user = :gu, gsi_user_sk = :gusk, autonomous = :auto, ' +
        // Set in_main and was_reverted ONLY on new items. Existing values are
        // preserved — upgrades (false→true) happen in Write 2 below.
        'in_main = if_not_exists(in_main, :im), ' +
        'was_reverted = if_not_exists(was_reverted, :wr)',
      ConditionExpression:
        'attribute_not_exists(pk) ' +
        'OR attribute_not_exists(ai_origin) ' +
        'OR (ai_origin = :human AND :ao = :ai)',
      ExpressionAttributeNames: {
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
        ':ao': { S: aiOrigin },
        ':auto': { BOOL: s.autonomous === true },
        ':at': { S: aiTool },
        ':am': { S: aiModel },
        ':os': { S: 'write-time-join' },
        ':human': { S: 'human' },
        ':ai': { S: 'ai-generated' },
        ':gu': { S: `USER#${user}` },
        ':gusk': { S: `COMMIT#${s.timestamp}` },
      },
    }));
  } catch (e) {
    if (!(e instanceof ConditionalCheckFailedException)) throw e;
    // Item exists and origin is already ai-generated (or same) — no-op for Write 1.
  }

  // Write 2: Upgrade boolean state fields (false→true only). These are
  // separate so they never downgrade: codeburn may push in_main=false before
  // the commit merges, while CI already seeded in_main=true.
  if (s.inMain) {
    try {
      await dynamoClient.send(new UpdateItemCommand({
        TableName: AI_USAGE_TABLE,
        Key: {
          pk: { S: `REPO#${s.repo}` },
          sk: { S: `COMMIT#${s.sha}` },
        },
        UpdateExpression: 'SET in_main = :true, updated_at = :now',
        ConditionExpression: 'attribute_exists(pk) AND in_main = :false',
        ExpressionAttributeValues: {
          ':true': { BOOL: true },
          ':false': { BOOL: false },
          ':now': { S: new Date().toISOString() },
        },
      }));
    } catch (e) {
      if (!(e instanceof ConditionalCheckFailedException)) throw e;
      // Already true — expected.
    }
  }
  if (s.wasReverted) {
    try {
      await dynamoClient.send(new UpdateItemCommand({
        TableName: AI_USAGE_TABLE,
        Key: {
          pk: { S: `REPO#${s.repo}` },
          sk: { S: `COMMIT#${s.sha}` },
        },
        UpdateExpression: 'SET was_reverted = :true, updated_at = :now',
        ConditionExpression: 'attribute_exists(pk) AND was_reverted = :false',
        ExpressionAttributeValues: {
          ':true': { BOOL: true },
          ':false': { BOOL: false },
          ':now': { S: new Date().toISOString() },
        },
      }));
    } catch (e) {
      if (!(e instanceof ConditionalCheckFailedException)) throw e;
      // Already true — expected.
    }
  }

  return true;
}

/** Process attribution spans. Returns count of writes. */
async function processAttributionSpans(user: string, spans: ParsedAttributionSpan[]): Promise<number> {
  const CONCURRENCY = 20;
  let written = 0;

  // Build the user's traceId → usage map ONCE for the whole batch. Commit
  // origin is resolved at write time against this map (see
  // writeCommitAttribution), so it must be built AFTER processSpans has
  // persisted this batch's usage spans. Building it per commit would rescan
  // every span for every commit in the push.
  const needsTraceMap = spans.some(s => s.kind !== 'session');
  const traceMap = needsTraceMap
    ? await buildUserTraceMap(user)
    : new Map<string, { tool: string; model: string }>();

  for (let i = 0; i < spans.length; i += CONCURRENCY) {
    const chunk = spans.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async (s) => {
      if (s.kind === 'session') {
        // Fire alongside, not instead: the issue record answers "how many
        // issues" and the session record answers "what happened in one
        // sitting". Failing to dedup an issue must not fail the session write.
        await recordIssue(user, s.repo ?? '', s.issueNumber ?? 0, s.timestamp,
                          s.autonomous === true);
        return writeSessionAttribution(user, s);
      }
      return writeCommitAttribution(user, s, traceMap);
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
  /**
   * 'stored' = verdict frozen at ingest (authoritative).
   * 'joined' = re-derived from usage spans for a legacy item; unreliable once
   * the spans have aged past SPAN_TTL_DAYS.
   */
  originSource?: 'stored' | 'joined';
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

  // Prefer the origin frozen at ingest. Only fall back to a live span join for
  // legacy items written before write-time resolution existed.
  const stored = item.ai_origin?.S;
  const { aiOrigin, aiTool, aiModel, originSource } = (stored === 'ai-generated' || stored === 'human')
    ? resolveStoredOrigin(item, null)
    : resolveStoredOrigin(item, await buildUserTraceMap(user));

  return {
    sha,
    repo,
    sessionId,
    traceId,
    user,
    project: item.project?.S ?? '',
    inMain: (item.in_main?.BOOL ?? false) || item.origin_source?.S === 'ci-seeded',
    wasReverted: item.was_reverted?.BOOL ?? false,
    timestamp: item.timestamp?.S ?? '',
    aiOrigin,
    aiTool,
    aiModel,
    originSource,
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
    let originSource: 'stored' | 'joined' = 'stored';

    const storedOrigin = item.ai_origin?.S;
    if (storedOrigin === 'ai-generated' || storedOrigin === 'human') {
      // Frozen at ingest — authoritative regardless of span age.
      ({ aiOrigin, aiTool, aiModel, originSource } = resolveStoredOrigin(item, null));
    } else if (traceId && user) {
      // Legacy item: re-derive. Reliable only inside SPAN_TTL_DAYS.
      let traceMap = traceMaps.get(user);
      if (!traceMap) {
        traceMap = await buildUserTraceMap(user);
        traceMaps.set(user, traceMap);
      }
      ({ aiOrigin, aiTool, aiModel, originSource } = resolveStoredOrigin(item, traceMap));
    }

    commits.push({
      sha,
      repo,
      sessionId: item.session_id?.S ?? '',
      traceId,
      user,
      project: item.project?.S ?? '',
      inMain: (item.in_main?.BOOL ?? false) || item.origin_source?.S === 'ci-seeded',
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

/**
 * Resolve a commit item's AI origin, preferring the verdict frozen at ingest.
 *
 * New items carry ai_origin/ai_tool/ai_model written by writeCommitAttribution
 * while the usage spans were still alive. Items written before that change have
 * no stored verdict, so they fall back to the live traceId join — which stays
 * correct for commits under SPAN_TTL_DAYS old and degrades to `human` beyond
 * that. `originSource` makes the distinction visible to callers rather than
 * silently mixing frozen and re-derived values.
 */
function resolveStoredOrigin(
  item: Record<string, import('@aws-sdk/client-dynamodb').AttributeValue>,
  traceMap: Map<string, { tool: string; model: string }> | null,
): { aiOrigin: 'ai-generated' | 'human'; aiTool: string; aiModel: string; originSource: 'stored' | 'joined' } {
  const stored = item.ai_origin?.S;
  if (stored === 'ai-generated' || stored === 'human') {
    return {
      aiOrigin: stored,
      aiTool: item.ai_tool?.S ?? (stored === 'human' ? 'none' : ''),
      aiModel: item.ai_model?.S ?? '',
      originSource: 'stored',
    };
  }
  const traceId = item.trace_id?.S ?? '';
  const usage = traceId && traceMap ? traceMap.get(traceId) : undefined;
  return usage
    ? { aiOrigin: 'ai-generated', aiTool: usage.tool, aiModel: usage.model, originSource: 'joined' }
    : { aiOrigin: 'human', aiTool: 'none', aiModel: '', originSource: 'joined' };
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
  /** Distinct issues this identity worked on -- an agent metric with no human analogue. */
  issues: number;
  /**
   * True when every usage span for this identity was marked prism.autonomous.
   * Autonomous work is not human-assisted AI use, and PRISM's levels treat them as
   * different things: L5 is about autonomous deployments, not AI share. Kept
   * separable so it can be reported on its own rather than quietly inflating
   * everybody's numbers.
   */
  autonomous: boolean;
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
    issues: 0,
    autonomous: false,
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

  // --- Issues worked on ---
  // Counted from ISSUE# items rather than derived from spans: an agent emits one
  // usage span per invocation, so a re-run of the same issue would inflate a
  // span-derived count. The sk is ISSUE#<repo>#<number> and the write is
  // conditional, so these are distinct by construction and counting them is enough.
  //
  // Not date-filtered on purpose. `first_seen` records when an issue was first
  // touched, and an issue worked across a window boundary should still count once;
  // filtering by it would drop long-running work from the later window.
  {
    let lastKey: import('@aws-sdk/client-dynamodb').ScanCommandOutput['LastEvaluatedKey'];
    do {
      const result = await dynamoClient.send(new ScanCommand({
        TableName: AI_USAGE_TABLE,
        FilterExpression: 'record_type = :rt',
        ExpressionAttributeValues: { ':rt': { S: 'OTEL_ISSUE' } },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      for (const item of result.Items ?? []) {
        const email = item.pk?.S?.replace('USER#', '') ?? '';
        if (!email) continue;
        if (userParam !== 'all' && email !== userParam) continue;
        const u = getUser(email);
        u.issues += 1;
        if (item.autonomous?.BOOL === true) u.autonomous = true;
      }
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
  }

  // --- Commits ---
  type RawCommit = { user: string; traceId: string; inMain: boolean; wasReverted: boolean; storedOrigin?: string };
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
          inMain: (item.in_main?.BOOL ?? false) || item.origin_source?.S === 'ci-seeded',
          wasReverted: item.was_reverted?.BOOL ?? false,
          storedOrigin: item.ai_origin?.S,
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
          inMain: (item.in_main?.BOOL ?? false) || item.origin_source?.S === 'ci-seeded',
          wasReverted: item.was_reverted?.BOOL ?? false,
          storedOrigin: item.ai_origin?.S,
        });
      }
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
  }

  // Classify commits via one trace map per user (AI-origin = correlated
  // usage spans exist for the commit's traceId).
  const traceMaps = new Map<string, Map<string, { tool: string; model: string }>>();
  for (const c of rawCommits) {
    // CI-seeded items may lack a user field — still count them in fleet totals.
    const userKey = c.user || '__unattributed__';
    const u = getUser(userKey);
    u.commits.total++;
    // Prefer the verdict frozen at ingest. Legacy items (no ai_origin) fall
    // back to a live span join, which is only reliable inside SPAN_TTL_DAYS.
    let isAi: boolean;
    if (c.storedOrigin === 'ai-generated' || c.storedOrigin === 'human') {
      isAi = c.storedOrigin === 'ai-generated';
    } else {
      let traceMap = c.user ? traceMaps.get(c.user) : undefined;
      if (c.user && !traceMap) {
        traceMap = await buildUserTraceMap(c.user);
        traceMaps.set(c.user, traceMap);
      }
      isAi = c.traceId !== '' && !!traceMap?.has(c.traceId);
    }
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

  // Agents are separated from `totals`, and this is a deliberate change of meaning.
  //
  // `totals` sums every key in the map, so once the coding agent started reporting,
  // its spend and its commits would have flowed into the fleet AI-share and
  // cost-per-shipped-commit figures that the Developer Productivity and Executive
  // dashboards render -- at roughly $1.75 an issue, not a rounding error beside
  // human usage. Two things would have gone wrong at once: the human numbers would
  // read as worse (or better) than they are, and the autonomous signal would be
  // spent rather than captured, since PRISM's L5 gate is about autonomous
  // deployments and not about AI share.
  //
  // So `totals` is now humans, `agentTotals` is agents, and `agents` lists them.
  // Safe to change today because no agent data exists yet; a dashboard reading
  // `totals` keeps meaning what its author intended.
  const everyone = [...users.values()].filter(u => u.user !== '__unattributed__');
  const humans = everyone.filter(u => !u.autonomous);
  const agents = everyone.filter(u => u.autonomous);

  const humanTotals = emptyUserProductivity('__totals__');
  const agentTotals = emptyUserProductivity('__agents__');
  for (const [group, into] of [[humans, humanTotals], [agents, agentTotals]] as const) {
    for (const u of group) {
      into.usage.inputTokens += u.usage.inputTokens;
      into.usage.outputTokens += u.usage.outputTokens;
      into.usage.costUsd += u.usage.costUsd;
      into.usage.calls += u.usage.calls;
      into.commits.total += u.commits.total;
      into.commits.ai += u.commits.ai;
      into.commits.human += u.commits.human;
      into.commits.mergedAi += u.commits.mergedAi;
      into.commits.revertedAi += u.commits.revertedAi;
      into.issues += u.issues;
    }
    computeRatios(into);
    into.usage.costUsd = Math.round(into.usage.costUsd * 100) / 100;
  }
  agentTotals.autonomous = true;

  return jsonResponse(200, {
    range: { from, to },
    scope: userParam === 'all' ? 'org' : 'user',
    generatedAt: new Date().toISOString(),
    users: humans.sort((a, b) => b.usage.costUsd - a.usage.costUsd),
    totals: humanTotals,
    agents: agents.sort((a, b) => b.usage.costUsd - a.usage.costUsd),
    agentTotals,
    // The pre-split figure, so a caller that genuinely wants everything does not
    // have to add two objects and get the ratios wrong doing it.
    fleetTotals: totals,
  });
}

// ---- Route: per-repo attribution query ----

type RepoProductivity = {
  repo: string;
  commits: { total: number; ai: number; human: number; mergedAi: number; revertedAi: number };
  contributors: number;
  ratios: { aiSharePct: number | null; mergeRatePct: number | null; defectRatePct: number | null };
  lastActivity: string | null;
};

/**
 * GET /v1/repos?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Aggregates commit outcomes by repository. The per-developer view
 * (/v1/productivity) answers "who", this answers "where" — which repos are
 * AI-heavy, which have low merge rates or high revert rates. Repo comes from
 * the commit item pk (REPO#<repo>); AI-origin classification uses the same
 * traceId-join rule as /v1/productivity (a commit is AI-generated only if
 * correlated usage spans exist for its trace).
 *
 * Spend is deliberately NOT included: usage rollups are keyed by user/day,
 * not by repo, so per-repo cost cannot be derived without double-counting
 * sessions that touch multiple repos.
 */
async function handleReposQuery(event: HttpApiEvent): Promise<HttpApiResponse> {
  const caller = resolveIdentity(event);
  if (!caller) return jsonResponse(401, { message: 'No resolvable identity claim in token' });

  const url = new URL(event.rawPath + '?' + (event.rawQueryString ?? ''), 'http://localhost');
  const now = new Date();
  const from = url.searchParams.get('from') ?? new Date(now.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
  const to = url.searchParams.get('to') ?? now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return jsonResponse(400, { message: 'from/to must be YYYY-MM-DD' });
  }

  type RawCommit = { repo: string; user: string; traceId: string; inMain: boolean; wasReverted: boolean; ts: string; storedOrigin?: string };
  const rawCommits: RawCommit[] = [];
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
        // pk is REPO#<repo>; strip the prefix for display.
        repo: (item.pk?.S ?? '').replace(/^REPO#/, ''),
        user: item.user?.S ?? '',
        traceId: item.trace_id?.S ?? '',
        inMain: (item.in_main?.BOOL ?? false) || item.origin_source?.S === 'ci-seeded',
        wasReverted: item.was_reverted?.BOOL ?? false,
        ts: item.timestamp?.S ?? '',
        storedOrigin: item.ai_origin?.S,
      });
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  // One trace map per user (cached across repos — a user's spans are the same
  // regardless of which repo the commit landed in).
  const traceMaps = new Map<string, Map<string, { tool: string; model: string }>>();
  const repos = new Map<string, RepoProductivity>();
  const contributors = new Map<string, Set<string>>();

  for (const c of rawCommits) {
    if (!c.repo) continue;
    let r = repos.get(c.repo);
    if (!r) {
      r = {
        repo: c.repo,
        commits: { total: 0, ai: 0, human: 0, mergedAi: 0, revertedAi: 0 },
        contributors: 0,
        ratios: { aiSharePct: null, mergeRatePct: null, defectRatePct: null },
        lastActivity: null,
      };
      repos.set(c.repo, r);
      contributors.set(c.repo, new Set());
    }
    r.commits.total++;
    if (c.user) contributors.get(c.repo)!.add(c.user);
    if (!r.lastActivity || c.ts > r.lastActivity) r.lastActivity = c.ts;

    let isAi: boolean;
    if (c.storedOrigin === 'ai-generated' || c.storedOrigin === 'human') {
      isAi = c.storedOrigin === 'ai-generated';
    } else {
      let traceMap = c.user ? traceMaps.get(c.user) : undefined;
      if (c.user && !traceMap) {
        traceMap = await buildUserTraceMap(c.user);
        traceMaps.set(c.user, traceMap);
      }
      isAi = c.traceId !== '' && !!traceMap?.has(c.traceId);
    }
    if (isAi) {
      r.commits.ai++;
      if (c.inMain) r.commits.mergedAi++;
      if (c.wasReverted) r.commits.revertedAi++;
    } else {
      r.commits.human++;
    }
  }

  const pct = (num: number, den: number): number | null =>
    den > 0 ? Math.round((100 * num / den) * 10) / 10 : null;
  for (const r of repos.values()) {
    r.contributors = contributors.get(r.repo)?.size ?? 0;
    r.ratios = {
      aiSharePct: pct(r.commits.ai, r.commits.total),
      mergeRatePct: pct(r.commits.mergedAi, r.commits.ai),
      defectRatePct: pct(r.commits.revertedAi, r.commits.mergedAi),
    };
  }

  return jsonResponse(200, {
    range: { from, to },
    generatedAt: new Date().toISOString(),
    repos: [...repos.values()].sort((a, b) => b.commits.total - a.commits.total),
  });
}

/**
 * GET /v1/commits-daily?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns per-day commit counts bucketed by ai_origin. Designed for dashboard
 * bar charts that replace the CloudWatch-native "Commits / Day (AI vs Human)"
 * graph — reading DDB at render time avoids the increment-only CloudWatch
 * limitation that makes origin upgrades (human->ai) double-count.
 */
async function handleCommitsDailyQuery(event: HttpApiEvent): Promise<HttpApiResponse> {
  const caller = resolveIdentity(event);
  if (!caller) return jsonResponse(401, { message: 'No resolvable identity claim in token' });

  const url = new URL(event.rawPath + '?' + (event.rawQueryString ?? ''), 'http://localhost');
  const now = new Date();
  const from = url.searchParams.get('from') ?? new Date(now.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
  const to = url.searchParams.get('to') ?? now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return jsonResponse(400, { message: 'from/to must be YYYY-MM-DD' });
  }

  // Scan COMMIT# items in the date range.
  const days = new Map<string, { ai: number; human: number; mergedAi: number; mergedHuman: number }>();
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
      ProjectionExpression: '#ts, ai_origin, in_main',
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    for (const item of result.Items ?? []) {
      const ts = item.timestamp?.S ?? '';
      const day = ts.slice(0, 10);
      if (!day) continue;
      const origin = item.ai_origin?.S ?? 'human';
      const inMain = item.in_main?.BOOL ?? false;
      let bucket = days.get(day);
      if (!bucket) { bucket = { ai: 0, human: 0, mergedAi: 0, mergedHuman: 0 }; days.set(day, bucket); }
      if (origin === 'ai-generated') {
        bucket.ai++;
        if (inMain) bucket.mergedAi++;
      } else {
        bucket.human++;
        if (inMain) bucket.mergedHuman++;
      }
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  // Sort ascending by date and return as an array.
  const sorted = [...days.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, counts]) => ({ date, ...counts }));

  return jsonResponse(200, {
    range: { from, to },
    generatedAt: new Date().toISOString(),
    days: sorted,
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
  if (method === 'GET' && path === '/v1/repos') {
    return handleReposQuery(event);
  }
  if (method === 'GET' && path === '/v1/commits-daily') {
    return handleCommitsDailyQuery(event);
  }
  return jsonResponse(404, { message: 'Not found' });
}
