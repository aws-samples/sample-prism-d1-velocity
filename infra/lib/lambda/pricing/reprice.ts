/**
 * Decide the corrected cost for a span stored at $0.
 *
 * Pure: takes a DynamoDB item and a price table, returns the writes to make.
 * The refresh Lambda performs them; the check script tests this directly.
 */
import { PriceTable, lookupPrice, computeCost, hasTokens, TokenCounts } from './price-table';

type Attr = { S?: string; N?: string; BOOL?: boolean };
export type SpanItem = Record<string, Attr | undefined>;

export interface RepricePlan {
  pk: string;
  sk: string;
  /** sk of the OTEL#DAY aggregate the cost must be added to. */
  aggregateSk: string;
  model: string;
  costUsd: number;
  pricedKey: string;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Where the cache-token counts came from. */
  cacheSource: 'span' | 'archive' | 'absent';
}

/** The aggregate sk the receiver's bumpDailyAggregate writes for this span. */
export function aggregateSkFor(timestamp: string, tool: string, model: string): string {
  const m = (model || 'unknown').replace(/#/g, '');
  return `OTEL#DAY#${timestamp.slice(0, 10)}#${tool}#${m}`;
}

function n(a: Attr | undefined): number {
  const v = Number(a?.N ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Spans written before the receiver stored cache-token counts have no
 * `cache_read_tokens` attribute at all (newer spans store 0 explicitly). Their
 * real counts are only in the raw OTLP archive.
 */
export function lacksCacheCounts(item: SpanItem): boolean {
  return item.cache_read_tokens === undefined;
}

export function planReprice(
  item: SpanItem,
  table: PriceTable,
  /** Cache counts recovered from the OTLP archive, keyed by span id. */
  archived?: Map<string, { cacheReadTokens: number; cacheWriteTokens: number }>,
): RepricePlan | null {
  if (item.record_type?.S !== 'OTEL_SPAN') return null;
  if (Number(item.cost_usd?.N ?? 'NaN') !== 0) return null;
  const pk = item.pk?.S;
  const sk = item.sk?.S;
  const timestamp = item.timestamp?.S;
  if (!pk || !sk || !timestamp) return null;

  let cacheSource: RepricePlan['cacheSource'] = 'span';
  let cacheReadTokens = n(item.cache_read_tokens);
  let cacheWriteTokens = n(item.cache_write_tokens);
  if (lacksCacheCounts(item)) {
    // sk is SPAN#<timestamp>#<spanId>; the timestamp contains no '#'.
    const spanId = sk.slice(sk.lastIndexOf('#') + 1);
    const hit = archived?.get(spanId);
    cacheSource = hit ? 'archive' : 'absent';
    cacheReadTokens = hit?.cacheReadTokens ?? 0;
    cacheWriteTokens = hit?.cacheWriteTokens ?? 0;
  }

  const tokens: TokenCounts = {
    inputTokens: n(item.input_tokens),
    outputTokens: n(item.output_tokens),
    cacheReadTokens,
    cacheWriteTokens,
  };
  if (!hasTokens(tokens)) return null;

  const model = item.model?.S ?? '';
  const match = lookupPrice(table, model);
  if (!match) return null;
  const costUsd = computeCost(match.entry, tokens);
  if (costUsd <= 0) return null;

  return {
    pk,
    sk,
    aggregateSk: aggregateSkFor(timestamp, item.tool?.S ?? '', model),
    model,
    costUsd,
    pricedKey: match.key,
    cacheReadTokens,
    cacheWriteTokens,
    cacheSource,
  };
}

/** Plans keyed by the aggregate item they add to, in their original order. */
export function groupByAggregate(plans: RepricePlan[]): Map<string, RepricePlan[]> {
  const groups = new Map<string, RepricePlan[]>();
  for (const p of plans) {
    const k = `${p.pk}\u0000${p.aggregateSk}`;
    const g = groups.get(k);
    if (g) g.push(p);
    else groups.set(k, [p]);
  }
  return groups;
}
