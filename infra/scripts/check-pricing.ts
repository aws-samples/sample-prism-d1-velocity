#!/usr/bin/env npx tsx
/**
 * Price-table guard: model-id lookup, refresh validation, and reprice planning.
 *
 * Uses a small fixed table, not the bundled snapshot, so a snapshot refresh
 * cannot change what these cases assert. The rates mirror LiteLLM's real
 * entries for the gpt-6 family.
 *
 * Run: npx tsx scripts/check-pricing.ts
 */
import {
  PriceTable, slimLiteLLM, validateTable, lookupPrice, computeCost, MIN_ENTRIES,
} from '../lib/lambda/pricing/price-table.js';
import { planReprice, aggregateSkFor, groupByAggregate, RepricePlan, SpanItem } from '../lib/lambda/pricing/reprice.js';
import { BUNDLED_PRICES } from '../lib/lambda/pricing/price-source.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
}

const M = 1e-6;
const TABLE: PriceTable = {
  'gpt-6-astra': [10 * M, 50 * M, null, 1 * M],
  'us.openai.gpt-6-astra': [11 * M, 55 * M, null, 1.1 * M],
  'global.openai.gpt-6-astra': [10 * M, 50 * M, null, 1 * M],
  'bedrock_mantle/openai.gpt-6-astra': [11 * M, 55 * M, null, 1.1 * M],
  'openai.gpt-6-sol': [2 * M, 10 * M, null, 0.2 * M],
  'anthropic.claude-haiku-4-5-20251001-v1:0': [1 * M, 5 * M, 1.25 * M, 0.1 * M],
  'claude-opus-4-8': [5 * M, 25 * M, 6.25 * M, 0.5 * M],
};

console.log('\nPrice-table guard\n');

// --- Lookup chain ---
{
  const cases: Array<[string, string | null, boolean]> = [
    // [reported id, expected key, expected approximate]
    ['openai.gpt-6-sol', 'openai.gpt-6-sol', false],
    // The id Codex on Bedrock reports, which LiteLLM does not list. Must land
    // on the global rate, LiteLLM's convention for unprefixed Bedrock keys.
    ['openai.gpt-6-astra', 'global.openai.gpt-6-astra', true],
    ['us.openai.gpt-6-astra', 'us.openai.gpt-6-astra', false],
    ['eu.openai.gpt-6-astra', 'global.openai.gpt-6-astra', true],
    ['OpenAI.GPT-6-Astra', 'global.openai.gpt-6-astra', true],
    ['gpt-6-astra', 'gpt-6-astra', false],
    ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'anthropic.claude-haiku-4-5-20251001-v1:0', true],
    ['claude-opus-4-8-20260101', 'claude-opus-4-8', false],
    ['some-new-model-9', null, false],
    ['', null, false],
  ];
  for (const [model, key, approx] of cases) {
    const m = lookupPrice(TABLE, model);
    check(
      `lookup ${JSON.stringify(model)} -> ${key ?? 'no match'}`,
      key === null ? m === null : m?.key === key && m.approximate === approx,
      `got key=${m?.key} approximate=${m?.approximate}`,
    );
  }
}

// --- Costing ---
{
  const e = TABLE['global.openai.gpt-6-astra'];
  const c = computeCost(e, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 });
  check('cost = input + output + cache read at their own rates', c === 17, `got ${c}`);
  const w = computeCost(e, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 });
  check('missing cache-write rate falls back to 1.25x input', w === 12.5, `got ${w}`);
}

// --- Trimming the upstream file ---
{
  const slim = slimLiteLLM({
    sample_spec: { input_cost_per_token: 0 },
    'gpt-x': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, cache_read_input_token_cost: 1e-7, max_tokens: 9 },
    'dall-e-3': { output_cost_per_image: 0.04 },
    'broken': { input_cost_per_token: 'free', output_cost_per_token: 5 },
  });
  check(
    'slim keeps priced models, drops sample_spec, image-only and nonsense rates',
    JSON.stringify(slim) === JSON.stringify({ 'gpt-x': [1e-6, 2e-6, null, 1e-7] }),
    `got ${JSON.stringify(slim)}`,
  );
  let threw = false;
  try { slimLiteLLM([1, 2]); } catch { threw = true; }
  check('slim refuses a non-object document', threw);
}

// --- Refresh validation ---
{
  const big: PriceTable = {};
  for (let i = 0; i < MIN_ENTRIES + 500; i++) big[`m${i}`] = [1e-6, 2e-6, null, null];

  check('a sane table is accepted', validateTable(big, big).ok);
  check('a tiny table is refused', !validateTable(TABLE, null).ok);

  const shrunk = Object.fromEntries(Object.entries(big).slice(0, MIN_ENTRIES));
  const s = validateTable(shrunk, big);
  check('losing more than 10% of entries is refused', !s.ok, s.reasons.join('; '));

  const oneFix = { ...big, m0: [1e-4, 2e-4, null, null] as PriceTable[string] };
  const f = validateTable(oneFix, big);
  check('a single 100x price correction is accepted but reported', f.ok && f.jumps.length === 1);

  const unitBug: PriceTable = {};
  for (const [k, e] of Object.entries(big)) unitBug[k] = [e[0]! * 1000, e[1]! * 1000, null, null];
  check('every price moving 1000x at once is refused', !validateTable(unitBug, big).ok);

  check(
    'the bundled snapshot passes its own validation',
    validateTable(BUNDLED_PRICES.entries, null).ok && BUNDLED_PRICES.entryCount > MIN_ENTRIES,
    `entries=${BUNDLED_PRICES.entryCount}`,
  );
}

// --- Reprice planning ---
function span(overrides: SpanItem): SpanItem {
  return {
    pk: { S: 'USER#dev@example.com' },
    sk: { S: 'SPAN#2026-09-12T10:00:00.000Z#a1b2c3d4e5f60718' },
    record_type: { S: 'OTEL_SPAN' },
    tool: { S: 'codex' },
    model: { S: 'openai.gpt-6-astra' },
    timestamp: { S: '2026-09-12T10:00:00.000Z' },
    input_tokens: { N: '1000000' },
    output_tokens: { N: '100000' },
    cost_usd: { N: '0' },
    cache_read_tokens: { N: '0' },
    cache_write_tokens: { N: '0' },
    ...overrides,
  };
}
{
  const p = planReprice(span({}), TABLE);
  check(
    'a $0 astra span is planned at the global rate against the right aggregate',
    p?.costUsd === 15 && p.pricedKey === 'global.openai.gpt-6-astra' &&
    p.aggregateSk === 'OTEL#DAY#2026-09-12#codex#openai.gpt-6-astra' && p.cacheSource === 'span',
    `got ${JSON.stringify(p)}`,
  );
  check(
    'aggregate sk matches the receiver (strips # from the model, defaults unknown)',
    aggregateSkFor('2026-09-12T00:00:00Z', 'codex', 'a#b') === 'OTEL#DAY#2026-09-12#codex#ab' &&
    aggregateSkFor('2026-09-12T00:00:00Z', 'codex', '') === 'OTEL#DAY#2026-09-12#codex#unknown',
  );

  check('a span with a cost is never replanned', planReprice(span({ cost_usd: { N: '0.5' } }), TABLE) === null);
  check('a $0 span with no tokens is left alone',
    planReprice(span({ input_tokens: { N: '0' }, output_tokens: { N: '0' } }), TABLE) === null);
  check('a $0 span whose model is still unknown is left alone',
    planReprice(span({ model: { S: 'some-new-model-9' } }), TABLE) === null);
  check('a non-span item is ignored', planReprice(span({ record_type: { S: 'OTEL_DAY' } }), TABLE) === null);

  // Spans stored before cache counts were kept: recover them from the archive.
  const legacy = span({ cache_read_tokens: undefined, cache_write_tokens: undefined });
  const archived = new Map([['a1b2c3d4e5f60718', { cacheReadTokens: 2_000_000, cacheWriteTokens: 0 }]]);
  const a = planReprice(legacy, TABLE, archived);
  check(
    'a legacy span is priced with cache counts from the archive',
    a?.costUsd === 17 && a.cacheSource === 'archive' && a.cacheReadTokens === 2_000_000,
    `got ${JSON.stringify(a)}`,
  );
  const b = planReprice(legacy, TABLE, new Map());
  check(
    'a legacy span missing from the archive is priced without cache and says so',
    b?.costUsd === 15 && b.cacheSource === 'absent',
    `got ${JSON.stringify(b)}`,
  );
}

{
  // Spans of one user-day share an OTEL#DAY item; writing them concurrently
  // made DynamoDB cancel transactions with TransactionConflict.
  const plan = (pk: string, aggregateSk: string, sk: string) =>
    ({ pk, aggregateSk, sk } as unknown as RepricePlan);
  const groups = [...groupByAggregate([
    plan('USER#a', 'OTEL#DAY#2026-09-11', 's1'),
    plan('USER#a', 'OTEL#DAY#2026-09-12', 's2'),
    plan('USER#a', 'OTEL#DAY#2026-09-11', 's3'),
    plan('USER#b', 'OTEL#DAY#2026-09-11', 's4'),
  ]).values()].map((g) => g.map((p) => p.sk).join(','));
  check(
    'spans sharing an aggregate land in one group, in order',
    JSON.stringify(groups) === JSON.stringify(['s1,s3', 's2', 's4']),
    `got ${JSON.stringify(groups)}`,
  );
}

console.log();
if (failures > 0) {
  console.error(`✗ ${failures} pricing check(s) failed\n`);
  process.exit(1);
}
console.log('✓ pricing lookup, validation and reprice planning hold\n');
