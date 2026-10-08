/**
 * LiteLLM-derived price table: trimming, validation, model-id lookup, costing.
 *
 * Pure functions only -- no AWS calls -- so the receiver, the refresh Lambda,
 * the snapshot script and the check script all share one implementation.
 *
 * Why the receiver prices anything at all: codeburn prices each call on the
 * client and sends `ai.cost_usd`. When its bundled table has no entry for the
 * id a tool reports, it sends 0 without flagging the span estimated. Codex on
 * Bedrock reports `openai.gpt-6-astra`; neither codeburn 0.9.24 nor LiteLLM
 * lists that exact key (LiteLLM has `bedrock_mantle/openai.gpt-6-astra`,
 * `us.openai.gpt-6-astra` and `global.openai.gpt-6-astra`), so 1,597 spans and
 * 214M tokens reached the dashboards as $0. A fresher table alone would not
 * have fixed it; the lookup chain below is the other half.
 */

/** [input, output, cacheWrite, cacheRead] in USD per token. null = not listed. */
export type PriceEntry = [number | null, number | null, number | null, number | null];
export type PriceTable = Record<string, PriceEntry>;

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Above this a per-token rate is a unit error ($10,000 per million tokens). */
const MAX_RATE = 0.01;

function rate(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_RATE ? v : null;
}

/**
 * Reduce LiteLLM's model_prices_and_context_window.json (about 3 MB) to the
 * four rates the receiver uses (about 450 KB). Entries with neither an input
 * nor an output rate (image, audio, rerank models) are dropped.
 */
export function slimLiteLLM(raw: unknown): PriceTable {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('LiteLLM table is not a JSON object');
  }
  const out: PriceTable = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'sample_spec' || !v || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    const entry: PriceEntry = [
      rate(e.input_cost_per_token),
      rate(e.output_cost_per_token),
      rate(e.cache_creation_input_token_cost),
      rate(e.cache_read_input_token_cost),
    ];
    if (entry[0] === null && entry[1] === null) continue;
    out[key] = entry;
  }
  return out;
}

export interface ValidationResult {
  ok: boolean;
  reasons: string[];
  /** Keys whose input or output rate moved by more than RATE_JUMP. */
  jumps: string[];
}

/** A table smaller than this is a truncated or wrong file, not LiteLLM. */
export const MIN_ENTRIES = 1000;
/** A refresh may lose at most this share of the previous table's entries. */
const MAX_SHRINK = 0.1;
/** Factor that counts as a suspicious rate change. */
const RATE_JUMP = 10;
/** Share of shared keys allowed to jump before the whole refresh is refused. */
const MAX_JUMP_SHARE = 0.01;

/**
 * Decide whether a freshly fetched table may replace the current one.
 *
 * The table comes from a third-party repository and directly changes the cost
 * figures on every dashboard, so a bad upstream commit must not land silently.
 * A single corrected price is normal; many prices moving 10x at once, or a
 * table that suddenly lost entries, is a broken file. Refusing keeps the
 * previous table in service, which is always safe.
 */
export function validateTable(next: PriceTable, prev?: PriceTable | null): ValidationResult {
  const reasons: string[] = [];
  const jumps: string[] = [];
  const n = Object.keys(next).length;
  if (n < MIN_ENTRIES) reasons.push(`only ${n} priced entries (minimum ${MIN_ENTRIES})`);

  if (prev) {
    const p = Object.keys(prev).length;
    if (p > 0 && n < p * (1 - MAX_SHRINK)) {
      reasons.push(`entry count fell from ${p} to ${n} (more than ${MAX_SHRINK * 100}%)`);
    }
    let shared = 0;
    for (const [key, was] of Object.entries(prev)) {
      const now = next[key];
      if (!now) continue;
      shared++;
      for (const i of [0, 1] as const) {
        const a = was[i];
        const b = now[i];
        if (a && b && (b / a > RATE_JUMP || a / b > RATE_JUMP)) {
          jumps.push(key);
          break;
        }
      }
    }
    if (shared > 0 && jumps.length / shared > MAX_JUMP_SHARE) {
      reasons.push(`${jumps.length} of ${shared} shared entries changed price by more than ${RATE_JUMP}x`);
    }
  }
  return { ok: reasons.length === 0, reasons, jumps };
}

const REGION_PREFIX = /^(us|eu|apac|ap|jp|au|ca|us-gov|global)\./i;
/** Bedrock model ids carry the vendor as a dotted prefix: openai.gpt-6-astra. */
const BEDROCK_VENDOR = /^(openai|anthropic|amazon|meta|mistral|cohere|deepseek|qwen|writer|ai21|moonshot|google|minimax)\./i;

export interface PriceMatch {
  entry: PriceEntry;
  /** The table key that matched, stored on repriced spans for audit. */
  key: string;
  /**
   * True when the match came from a different id than the one reported
   * (another region, endpoint or the plain model name), so the rate may not
   * be the one actually billed.
   */
  approximate: boolean;
}

/**
 * Ordered candidate keys for a reported model id, most specific first.
 *
 * 1. The id as reported, then lowercased, then without a date suffix.
 * 2. For a bare Bedrock id (`openai.x`, no region): the `global.`
 *    cross-region key, then the OpenAI-compatible ("mantle") endpoint key.
 * 3. For a region-prefixed id (`eu.openai.x`): the same id under `global.`
 *    and mantle, and without the prefix.
 * 4. The plain model name (`gpt-6-astra`), the direct-API rate. Last because
 *    Bedrock rates differ from direct rates.
 */
export function candidateKeys(model: string): Array<{ key: string; approximate: boolean }> {
  const out: Array<{ key: string; approximate: boolean }> = [];
  const seen = new Set<string>();
  const push = (key: string, approximate: boolean) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ key, approximate });
  };

  const reported = model.trim().replace(/@.*$/, '');
  const lower = reported.toLowerCase();
  const undated = lower.replace(/-\d{8}$/, '');
  push(reported, false);
  push(lower, false);
  push(undated, false);

  const region = undated.match(REGION_PREFIX);
  const unregioned = undated.replace(REGION_PREFIX, '');
  if (BEDROCK_VENDOR.test(unregioned)) {
    if (!region) {
      // LiteLLM prices its own unprefixed Bedrock keys (openai.gpt-6-sol) at
      // the global cross-region rate; regional and mantle keys are 1.1x.
      // Follow that convention for an unprefixed id it happens not to list.
      push(`global.${unregioned}`, true);
      push(`bedrock_mantle/${unregioned}`, true);
    } else {
      push(`global.${unregioned}`, true);
      push(`bedrock_mantle/${unregioned}`, true);
      push(unregioned, true);
    }
    // Bedrock Anthropic keys carry a version suffix the tool may omit.
    if (!/-v\d+(:\d+)?$/.test(unregioned)) {
      if (region) push(`${undated}-v1:0`, true);
      push(`${unregioned}-v1:0`, true);
    }
    push(unregioned.replace(BEDROCK_VENDOR, ''), true);
  } else if (region) {
    push(unregioned, true);
  }
  return out;
}

export function lookupPrice(table: PriceTable, model: string): PriceMatch | null {
  if (!model) return null;
  for (const c of candidateKeys(model)) {
    const entry = table[c.key];
    if (entry) return { entry, key: c.key, approximate: c.approximate };
  }
  return null;
}

/**
 * Cost of one call, the way codeburn's calculateCost computes it: input
 * excludes cache reads, and each token class is billed at its own rate. A
 * missing cache-write rate falls back to 1.25x input and a missing cache-read
 * rate to 0.1x input, the ratios LiteLLM lists for most Bedrock models.
 */
export function computeCost(entry: PriceEntry, t: TokenCounts): number {
  const [input, output, cacheWrite, cacheRead] = entry;
  const inRate = input ?? 0;
  const cost =
    t.inputTokens * inRate +
    t.outputTokens * (output ?? 0) +
    t.cacheWriteTokens * (cacheWrite ?? inRate * 1.25) +
    t.cacheReadTokens * (cacheRead ?? inRate * 0.1);
  // 1e-6 USD resolution keeps the stored N value short; per-call costs are
  // fractions of a cent and daily aggregates sum thousands of them.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function hasTokens(t: TokenCounts): boolean {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens > 0;
}

/** Upstream file. Pinned here rather than configurable: it is a trust anchor. */
export const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** Shape of both the bundled snapshot and the S3 copy the refresh writes. */
export interface PriceDocument {
  version: 1;
  source: string;
  fetchedAt: string;
  entryCount: number;
  entries: PriceTable;
}

export function toDocument(entries: PriceTable, fetchedAt: string): PriceDocument {
  return { version: 1, source: LITELLM_PRICES_URL, fetchedAt, entryCount: Object.keys(entries).length, entries };
}

export function parseDocument(raw: unknown): PriceDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<PriceDocument>;
  if (d.version !== 1 || !d.entries || typeof d.entries !== 'object') return null;
  return d as PriceDocument;
}
