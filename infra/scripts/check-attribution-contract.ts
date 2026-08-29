#!/usr/bin/env npx tsx
/**
 * Attribution wire-contract guard.
 *
 * codeburn is versioned and published independently of this receiver, so the
 * OTLP attribute contract between them can drift without either side failing
 * to build. It did:
 *
 *   codeburn <= 0.9.20  attribution spans carried `ai.session_id`
 *   codeburn 0.9.21-22  the attribute was dropped, nothing replaced it
 *   codeburn 0.9.23+    `ai.work_unit_id`
 *
 * The receiver required `ai.session_id` and rejected the span when it was
 * absent. That check ran BEFORE the session/commit split, so from 0.9.21
 * onward it discarded 100% of attribution facts -- both kinds -- for every
 * developer on a current codeburn. Nothing surfaced the cause: commits were
 * still created by the CI seeding path with the documented `ai_origin=human`
 * default, so the dashboard read "all commits human" rather than "attribution
 * is broken", and the receiver reported one generic string for all six of its
 * distinct validation branches.
 *
 * These cases pin the shapes actually observed in the wild. Case 2 is the one
 * that regressed; it must stay green as codeburn keeps moving.
 *
 * Run: npx tsx scripts/check-attribution-contract.ts
 */
import { parseOtlpSpans } from '../lib/lambda/otel-receiver.js';

// A valid 16-hex span id and 32-hex trace id, matching codeburn's
// deriveSpanId/deriveTraceId (sha256 hex, sliced).
const SPAN_ID = 'a1b2c3d4e5f60718';
const SPAN_ID_2 = '0f1e2d3c4b5a6978';
const TRACE_ID = 'd04625d0b0f640b97eafbe2ec9a32a33';
const NANOS = String(BigInt(Date.parse('2026-08-29T17:38:30.000Z')) * 1_000_000n);

type Attr = { key: string; value: Record<string, unknown> };

function s(key: string, value: string): Attr {
  return { key, value: { stringValue: value } };
}
function b(key: string, value: boolean): Attr {
  return { key, value: { boolValue: value } };
}

function payload(spans: Array<Record<string, unknown>>) {
  return {
    resourceSpans: [{
      resource: { attributes: [s('codeburn.device_id', '87c5988219a81930')] },
      scopeSpans: [{ spans }],
    }],
  };
}

function commitSpan(attrs: Attr[], spanId = SPAN_ID) {
  return {
    name: 'codeburn.commit',
    spanId,
    traceId: TRACE_ID,
    startTimeUnixNano: NANOS,
    endTimeUnixNano: NANOS,
    attributes: attrs,
  };
}

function sessionSpan(attrs: Attr[], spanId = SPAN_ID_2) {
  return {
    name: 'codeburn.session.attribution',
    spanId,
    traceId: TRACE_ID,
    startTimeUnixNano: NANOS,
    endTimeUnixNano: NANOS,
    attributes: attrs,
  };
}

const GIT_COMMIT: Attr[] = [
  s('git.repo', 'github.com/Enclavet/prism-d1-velocity'),
  s('git.sha', '29bc79a2578905b74b16dfe2ae7b45585c36f665'),
  b('git.in_main', true),
  b('git.was_reverted', false),
];

let failures = 0;
function check(name: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}\n      ${detail}`);
    failures++;
  }
}

console.log('\nAttribution wire-contract guard\n');

// --- Case 1: codeburn <= 0.9.20 — ai.session_id present ---
{
  const r = parseOtlpSpans(payload([
    commitSpan([s('ai.session_id', 'sess-abc'), s('ai.project', 'sample-app'), ...GIT_COMMIT]),
  ]) as never);
  check(
    'codeburn <=0.9.20 (ai.session_id) accepted',
    r.attributionSpans.length === 1 && r.rejected === 0,
    `got attributionSpans=${r.attributionSpans.length} rejected=${r.rejected}`,
  );
  check(
    'codeburn <=0.9.20 sessionId read from ai.session_id',
    r.attributionSpans[0]?.sessionId === 'sess-abc',
    `got sessionId=${r.attributionSpans[0]?.sessionId}`,
  );
}

// --- Case 2: codeburn 0.9.21+ — NO session attribute at all (the regression) ---
{
  const r = parseOtlpSpans(payload([
    sessionSpan([s('git.repo', 'github.com/Enclavet/prism-d1-velocity')]),
    commitSpan(GIT_COMMIT),
  ]) as never);
  check(
    'codeburn 0.9.21+ (no session attribute) accepted — both kinds',
    r.attributionSpans.length === 2 && r.rejected === 0,
    `got attributionSpans=${r.attributionSpans.length} rejected=${r.rejected} ` +
    `reasons=${JSON.stringify(r.rejectedReasons)}`,
  );
  check(
    'codeburn 0.9.21+ falls back to traceId for session identity',
    // Length is asserted here too: `.every()` on an empty array is vacuously
    // true, so without it this passes in exactly the broken state it exists
    // to catch.
    r.attributionSpans.length === 2 && r.attributionSpans.every(a => a.sessionId === TRACE_ID),
    `got sessionIds=${JSON.stringify(r.attributionSpans.map(a => a.sessionId))}`,
  );
}

// --- Case 3: codeburn 0.9.23+ — ai.work_unit_id ---
{
  const r = parseOtlpSpans(payload([
    commitSpan([s('ai.work_unit_id', 'wu-xyz'), ...GIT_COMMIT]),
  ]) as never);
  check(
    'codeburn 0.9.23+ (ai.work_unit_id) accepted',
    r.attributionSpans.length === 1 && r.rejected === 0,
    `got attributionSpans=${r.attributionSpans.length} rejected=${r.rejected}`,
  );
  check(
    'codeburn 0.9.23+ sessionId read from ai.work_unit_id',
    r.attributionSpans[0]?.sessionId === 'wu-xyz',
    `got sessionId=${r.attributionSpans[0]?.sessionId}`,
  );
}

// --- Case 4: genuinely unjoinable spans are still rejected, with a named reason ---
{
  // A commit with no repo cannot be joined to a REPO# item. codeburn already
  // suppresses these (commits[] is empty when repo is null), but a third-party
  // OTLP producer could send one, and silently accepting it would create an
  // unreachable DDB item.
  const r = parseOtlpSpans(payload([
    commitSpan([s('git.sha', 'deadbeef'), b('git.in_main', true)]),
  ]) as never);
  check(
    'commit without git.repo still rejected',
    r.attributionSpans.length === 0 && r.rejected === 1,
    `got attributionSpans=${r.attributionSpans.length} rejected=${r.rejected}`,
  );
  check(
    'rejection reason is attributed to noRepo',
    r.rejectedReasons.noRepo === 1,
    `got reasons=${JSON.stringify(r.rejectedReasons)}`,
  );
}

// --- Case 5: reasons are distinguishable, not collapsed into one counter ---
{
  const r = parseOtlpSpans(payload([
    // malformed span id
    { ...commitSpan(GIT_COMMIT), spanId: 'nothex' },
    // commit missing sha
    commitSpan([s('git.repo', 'github.com/o/r')]),
    // usage span with no provider
    { name: 'codeburn.call', spanId: SPAN_ID, traceId: TRACE_ID, startTimeUnixNano: NANOS, attributes: [] },
  ]) as never);
  check(
    'three different failures produce three distinct reasons',
    r.rejectedReasons.malformedSpan === 1 &&
    r.rejectedReasons.noSha === 1 &&
    r.rejectedReasons.noProvider === 1,
    `got reasons=${JSON.stringify(r.rejectedReasons)}`,
  );
  check(
    'reason counts sum to the total',
    Object.values(r.rejectedReasons).reduce((a, n) => a + n, 0) === r.rejected,
    `sum=${Object.values(r.rejectedReasons).reduce((a, n) => a + n, 0)} rejected=${r.rejected}`,
  );
}

// --- Case 6: usage spans keep working (they were never broken; guard the fix) ---
{
  const r = parseOtlpSpans(payload([{
    name: 'codeburn.call',
    spanId: SPAN_ID,
    traceId: TRACE_ID,
    startTimeUnixNano: NANOS,
    attributes: [
      s('ai.provider', 'claude-code'),
      s('ai.model', 'claude-sonnet-4-5-20250929'),
      { key: 'ai.input_tokens', value: { intValue: '10' } },
      { key: 'ai.output_tokens', value: { intValue: '253' } },
      { key: 'ai.cost_usd', value: { doubleValue: 0.0934 } },
    ],
  }]) as never);
  check(
    'usage span still accepted',
    r.spans.length === 1 && r.rejected === 0,
    `got spans=${r.spans.length} rejected=${r.rejected}`,
  );
}

console.log();
if (failures > 0) {
  console.error(`✗ ${failures} attribution-contract check(s) failed\n`);
  process.exit(1);
}
console.log('✓ attribution wire contract holds for codeburn <=0.9.20, 0.9.21-22 and 0.9.23+\n');
