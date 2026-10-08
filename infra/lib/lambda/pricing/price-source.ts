/**
 * Where the receiver gets its price table at runtime.
 *
 * The refresh Lambda writes a validated, trimmed LiteLLM table to S3 once a
 * day. The receiver reads it at most once an hour per warm container. When the
 * object is missing (fresh deploy, refresh not yet run) or unreadable, it
 * prices with the snapshot bundled at build time, so ingestion never fails or
 * waits on pricing.
 */
import { S3Client, GetObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import { parseDocument, PriceDocument } from './price-table';
import bundled from './litellm-snapshot.json';
import { PRICES_KEY } from './prices-key';

export { PRICES_KEY };

const CACHE_MS = 60 * 60 * 1000;
/** After a failed read, retry no sooner than this, so S3 errors do not slow every batch. */
const RETRY_MS = 5 * 60 * 1000;

export const BUNDLED_PRICES: PriceDocument = parseDocument(bundled) ?? {
  version: 1, source: 'empty', fetchedAt: '', entryCount: 0, entries: {},
};

let cached: { doc: PriceDocument; origin: 's3' | 'bundled'; until: number } | null = null;

export async function loadPrices(
  s3: S3Client,
  bucket: string,
  now = Date.now(),
): Promise<{ doc: PriceDocument; origin: 's3' | 'bundled' }> {
  if (cached && now < cached.until) return cached;
  if (!bucket) {
    cached = { doc: BUNDLED_PRICES, origin: 'bundled', until: now + CACHE_MS };
    return cached;
  }
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: PRICES_KEY }));
    const doc = parseDocument(JSON.parse(await res.Body!.transformToString()));
    if (!doc) throw new Error('price document failed shape check');
    cached = { doc, origin: 's3', until: now + CACHE_MS };
  } catch (e) {
    if (!(e instanceof NoSuchKey)) {
      console.warn(`[pricing] using bundled snapshot (${BUNDLED_PRICES.fetchedAt}): ${(e as Error).message}`);
    }
    // Keep a previously loaded S3 table over the older bundled one.
    const doc = cached?.origin === 's3' ? cached.doc : BUNDLED_PRICES;
    cached = { doc, origin: cached?.origin === 's3' ? 's3' : 'bundled', until: now + RETRY_MS };
  }
  return cached;
}

/** Test hook: forget the cached table. */
export function resetPriceCache(): void {
  cached = null;
}
