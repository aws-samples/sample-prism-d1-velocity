/**
 * PRISM D1 — daily price-table refresh and $0-span reprice.
 *
 * Runs once a day on an EventBridge schedule:
 *
 *   1. Refresh. Fetch LiteLLM's price file, trim it to four rates per model,
 *      validate it against the table currently in S3, and write it to
 *      s3://<archive>/pricing/litellm-prices.json. A refused or failed fetch
 *      keeps the previous table in service and fails the invocation at the end,
 *      so the Lambda Errors metric shows it.
 *
 *   2. Reprice. Scan for usage spans stored with cost 0 but tokens > 0. These
 *      are spans no price table matched when they arrived; a model is often
 *      added to LiteLLM days after people start using it. Each one that now
 *      matches is corrected in one transaction with its OTEL#DAY aggregate, so
 *      the dashboards and the CloudWatch metrics (via the table stream) pick up
 *      the difference.
 *
 * Spans written before the receiver stored cache-token counts lack them. For
 * those, the cache counts are recovered from the raw OTLP archive; without
 * them, cached input would go unpriced or be billed at the full input rate.
 *
 * Invoke manually with {"skipRefresh": true} to reprice without fetching, or
 * {"dryRun": true} to report what would change without writing.
 */
import {
  DynamoDBClient,
  ScanCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
  type ScanCommandOutput,
} from '@aws-sdk/client-dynamodb';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
} from '@aws-sdk/client-s3';
import {
  LITELLM_PRICES_URL, slimLiteLLM, validateTable, toDocument, parseDocument, PriceDocument,
} from './pricing/price-table';
import { PRICES_KEY, BUNDLED_PRICES } from './pricing/price-source';
import { planReprice, lacksCacheCounts, RepricePlan, SpanItem } from './pricing/reprice';

const dynamo = new DynamoDBClient({});
const s3 = new S3Client({});

const TABLE = process.env.AI_USAGE_TABLE || 'prism-d1-ai-usage';
const BUCKET = process.env.ARCHIVE_BUCKET || '';
const FETCH_TIMEOUT_MS = 30_000;
const WRITE_CONCURRENCY = 10;
/** Upper bound on the raw download; LiteLLM's file is about 3 MB today. */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

interface RefreshEvent {
  skipRefresh?: boolean;
  dryRun?: boolean;
}

async function readCurrentTable(): Promise<PriceDocument | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: PRICES_KEY }));
    return parseDocument(JSON.parse(await res.Body!.transformToString()));
  } catch (e) {
    if (e instanceof NoSuchKey) return null;
    throw e;
  }
}

async function fetchLiteLLM(): Promise<unknown> {
  const res = await fetch(LITELLM_PRICES_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${LITELLM_PRICES_URL}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new Error(`response is ${len} bytes, over the ${MAX_DOWNLOAD_BYTES} limit`);
  const text = await res.text();
  if (text.length > MAX_DOWNLOAD_BYTES) throw new Error(`response over the ${MAX_DOWNLOAD_BYTES} byte limit`);
  return JSON.parse(text);
}

/** Step 1. Returns the table to reprice with and, if the refresh failed, why. */
async function refresh(dryRun: boolean): Promise<{ doc: PriceDocument; failure: string | null }> {
  const current = await readCurrentTable();
  const fallback = current ?? BUNDLED_PRICES;
  let next;
  try {
    next = slimLiteLLM(await fetchLiteLLM());
  } catch (e) {
    return { doc: fallback, failure: `fetch failed: ${(e as Error).message}` };
  }
  // Validate against the S3 table, or the bundled snapshot on first run, so
  // even the first write is checked against something.
  const v = validateTable(next, fallback.entries);
  if (!v.ok) {
    return { doc: fallback, failure: `refused new table: ${v.reasons.join('; ')}` };
  }
  const doc = toDocument(next, new Date().toISOString());
  const added = Object.keys(next).filter((k) => !fallback.entries[k]);
  console.log(JSON.stringify({
    msg: 'price table refreshed',
    entries: doc.entryCount,
    previousEntries: fallback.entryCount,
    previousFetchedAt: fallback.fetchedAt,
    added: added.length,
    addedSample: added.slice(0, 20),
    rateJumps: v.jumps.slice(0, 20),
    dryRun,
  }));
  if (!dryRun) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: PRICES_KEY,
      Body: JSON.stringify(doc),
      ContentType: 'application/json',
    }));
  }
  return { doc, failure: null };
}

/** Every span item stored at cost 0. Usage spans only; tokens are checked in planReprice. */
async function scanZeroCostSpans(): Promise<SpanItem[]> {
  const items: SpanItem[] = [];
  let key: ScanCommandOutput['LastEvaluatedKey'];
  do {
    const res = await dynamo.send(new ScanCommand({
      TableName: TABLE,
      // Every attribute name is a placeholder: several (timestamp, model) are
      // or may become DynamoDB reserved words, and a missed one fails the scan.
      FilterExpression: '#rt = :span AND #cost = :zero',
      ProjectionExpression: '#pk, #sk, #rt, #cost, #tool, #model, #ts, #in, #out, #cr, #cw',
      ExpressionAttributeNames: {
        '#pk': 'pk', '#sk': 'sk', '#rt': 'record_type', '#cost': 'cost_usd', '#tool': 'tool',
        '#model': 'model', '#ts': 'timestamp', '#in': 'input_tokens', '#out': 'output_tokens',
        '#cr': 'cache_read_tokens', '#cw': 'cache_write_tokens',
      },
      ExpressionAttributeValues: { ':span': { S: 'OTEL_SPAN' }, ':zero': { N: '0' } },
      ...(key ? { ExclusiveStartKey: key } : {}),
    }));
    items.push(...((res.Items ?? []) as SpanItem[]));
    key = res.LastEvaluatedKey;
  } while (key);
  return items;
}

/**
 * Recover cache-token counts for the given span ids from the raw OTLP archive.
 * Reads only partitions on or after the earliest span's date (a span is
 * archived when pushed, which is never before it happened), and stops once
 * every id is found.
 */
async function cacheCountsFromArchive(
  spanIds: Set<string>,
  earliestDay: string,
): Promise<Map<string, { cacheReadTokens: number; cacheWriteTokens: number }>> {
  const found = new Map<string, { cacheReadTokens: number; cacheWriteTokens: number }>();
  let token: string | undefined;
  let objects = 0;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: 'otlp/',
      StartAfter: `otlp/dt=${earliestDay}`,
      ContinuationToken: token,
    }));
    for (const obj of page.Contents ?? []) {
      if (!obj.Key) continue;
      objects++;
      const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
      let payload: { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }> }> };
      try {
        payload = JSON.parse(await res.Body!.transformToString());
      } catch {
        continue;
      }
      for (const rs of payload.resourceSpans ?? []) {
        for (const ss of rs.scopeSpans ?? []) {
          for (const sp of ss.spans ?? []) {
            const id = String(sp.spanId ?? '').toLowerCase();
            if (!spanIds.has(id) || found.has(id)) continue;
            const attrs = (sp.attributes ?? []) as Array<{ key: string; value: { intValue?: string | number } }>;
            const get = (k: string) => Math.max(0, Number(attrs.find((a) => a.key === k)?.value?.intValue ?? 0) || 0);
            found.set(id, {
              cacheReadTokens: get('ai.cache_read_tokens'),
              cacheWriteTokens: get('ai.cache_write_tokens'),
            });
          }
        }
      }
      if (found.size === spanIds.size) {
        console.log(`[archive] found all ${found.size} spans after ${objects} objects`);
        return found;
      }
    }
    token = page.NextContinuationToken;
  } while (token);
  console.log(`[archive] found ${found.size} of ${spanIds.size} spans in ${objects} objects`);
  return found;
}

type WriteOutcome = 'repriced' | 'alreadyPriced' | 'aggregateMissing';

/**
 * One transaction: set the span's cost (only if it is still 0) and add the
 * same amount to its daily aggregate. The condition makes a re-run, or two
 * overlapping runs, a no-op instead of a double count.
 */
async function applyPlan(p: RepricePlan, now: string): Promise<WriteOutcome> {
  try {
    await dynamo.send(new TransactWriteItemsCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { pk: { S: p.pk }, sk: { S: p.sk } },
            UpdateExpression:
              'SET #cost = :cost, #est = :t, #src = :src, #key = :key, #cr = :cr, #cw = :cw, #at = :now',
            ConditionExpression: '#cost = :zero',
            ExpressionAttributeNames: {
              '#cost': 'cost_usd', '#est': 'cost_estimated', '#src': 'cost_source', '#key': 'priced_key',
              '#cr': 'cache_read_tokens', '#cw': 'cache_write_tokens', '#at': 'repriced_at',
            },
            ExpressionAttributeValues: {
              ':cost': { N: String(p.costUsd) }, ':t': { BOOL: true }, ':src': { S: 'reprice' },
              ':key': { S: p.pricedKey }, ':cr': { N: String(p.cacheReadTokens) },
              ':cw': { N: String(p.cacheWriteTokens) }, ':now': { S: now }, ':zero': { N: '0' },
            },
          },
        },
        {
          Update: {
            TableName: TABLE,
            Key: { pk: { S: p.pk }, sk: { S: p.aggregateSk } },
            UpdateExpression: 'ADD #cost :cost SET #upd = :now',
            ConditionExpression: 'attribute_exists(#pk)',
            ExpressionAttributeNames: { '#cost': 'cost_usd', '#upd': 'updated_at', '#pk': 'pk' },
            ExpressionAttributeValues: { ':cost': { N: String(p.costUsd) }, ':now': { S: now } },
          },
        },
      ],
    }));
    return 'repriced';
  } catch (e) {
    if (e instanceof TransactionCanceledException) {
      const [span, agg] = e.CancellationReasons ?? [];
      if (span?.Code === 'ConditionalCheckFailed') return 'alreadyPriced';
      if (agg?.Code === 'ConditionalCheckFailed') return 'aggregateMissing';
    }
    throw e;
  }
}

/** Step 2. */
async function reprice(doc: PriceDocument, dryRun: boolean) {
  const items = await scanZeroCostSpans();

  // Price once without archive data to learn which legacy spans are worth
  // the archive read: only spans whose model now has a price.
  const legacy = items.filter((i) => lacksCacheCounts(i) && planReprice(i, doc.entries));
  let archived = new Map<string, { cacheReadTokens: number; cacheWriteTokens: number }>();
  if (legacy.length > 0 && BUCKET) {
    const ids = new Set(legacy.map((i) => i.sk!.S!.slice(i.sk!.S!.lastIndexOf('#') + 1)));
    const earliest = legacy.map((i) => i.timestamp!.S!.slice(0, 10)).sort()[0];
    archived = await cacheCountsFromArchive(ids, earliest);
  }

  const plans = items.map((i) => planReprice(i, doc.entries, archived)).filter((p): p is RepricePlan => p !== null);
  const unmatched = new Map<string, number>();
  for (const i of items) {
    if (!planReprice(i, doc.entries, archived)) {
      const tokens = Number(i.input_tokens?.N ?? 0) + Number(i.output_tokens?.N ?? 0);
      if (tokens > 0) {
        const m = i.model?.S || 'unknown';
        unmatched.set(m, (unmatched.get(m) ?? 0) + 1);
      }
    }
  }

  const counts: Record<WriteOutcome, number> = { repriced: 0, alreadyPriced: 0, aggregateMissing: 0 };
  let addedUsd = 0;
  const byModel: Record<string, { spans: number; usd: number; key: string }> = {};
  const cacheSources: Record<string, number> = {};
  const now = new Date().toISOString();

  for (let i = 0; i < plans.length; i += WRITE_CONCURRENCY) {
    const chunk = plans.slice(i, i + WRITE_CONCURRENCY);
    const outcomes = dryRun
      ? chunk.map(() => 'repriced' as const)
      : await Promise.all(chunk.map((p) => applyPlan(p, now)));
    outcomes.forEach((o, j) => {
      counts[o]++;
      if (o !== 'repriced') return;
      const p = chunk[j];
      addedUsd += p.costUsd;
      const m = (byModel[p.model || 'unknown'] ??= { spans: 0, usd: 0, key: p.pricedKey });
      m.spans++;
      m.usd += p.costUsd;
      cacheSources[p.cacheSource] = (cacheSources[p.cacheSource] ?? 0) + 1;
    });
  }
  for (const m of Object.values(byModel)) m.usd = Math.round(m.usd * 100) / 100;

  return {
    zeroCostSpans: items.length,
    ...counts,
    addedUsd: Math.round(addedUsd * 100) / 100,
    byModel,
    cacheSources,
    stillUnpriced: Object.fromEntries([...unmatched.entries()].slice(0, 30)),
  };
}

export async function handler(event: RefreshEvent = {}): Promise<Record<string, unknown>> {
  const dryRun = event.dryRun === true;
  const { doc, failure } = event.skipRefresh
    ? { doc: (await readCurrentTable()) ?? BUNDLED_PRICES, failure: null }
    : await refresh(dryRun);
  if (failure) console.error(`[pricing] ${failure}; repricing with table from ${doc.fetchedAt || 'bundle'}`);

  const result = await reprice(doc, dryRun);
  const summary = { msg: 'reprice complete', dryRun, tableFetchedAt: doc.fetchedAt, ...result };
  console.log(JSON.stringify(summary));

  // Fail after repricing, not before: a stale table still prices what it can,
  // and the error makes the stale table visible on the Lambda Errors metric.
  if (failure) throw new Error(`price refresh failed: ${failure}`);
  return summary;
}
