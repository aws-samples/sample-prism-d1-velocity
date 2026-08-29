#!/usr/bin/env npx tsx
/**
 * Commit state-transition guard for the attribution metrics publisher.
 *
 * PRISM writes each COMMIT# item from two directions, and the second one only
 * changes `ai_origin`:
 *
 *   1. CI merges a PR. metrics-processor seeds every SHA with ai_origin=human,
 *      in_main=true — it cannot know origin.
 *   2. codeburn attribution arrives (up to 12h later). The receiver upgrades
 *      the AI ones human → ai-generated. Its Write 1 sets in_main and
 *      was_reverted with if_not_exists, so NEITHER changes.
 *
 * parseCommitRecord used to bail on any MODIFY where in_main and was_reverted
 * were unchanged, so step 2 was dropped: the upgrade reached DynamoDB but never
 * CloudWatch. AICommits was never emitted and MergedAICommits stayed at zero,
 * which blanks the "AI Defect Trend (reverted / merged)" widget on the Team
 * Velocity dashboard — its MathExpression is guarded on `mergedAi2 > 0`.
 *
 * Observed in workshop account 595520249681: 5 commits, HumanCommits=5,
 * MergedHumanCommits=5, AICommits absent from the namespace entirely.
 *
 * Case 2 is the regression. Case 4 pins the guard that still has to hold —
 * an unrelated MODIFY must stay ignored, or every touch double-counts.
 *
 * Run: npx tsx scripts/check-commit-transitions.ts
 */
import { parseCommitRecord } from '../lib/lambda/attribution-metrics-publisher.js';

const TS = '2026-08-29T17:54:56Z';

type Img = Record<string, unknown>;

function img(o: {
  origin?: string; tool?: string; inMain?: boolean; reverted?: boolean;
}): Img {
  const i: Img = {
    record_type: { S: 'OTEL_ATTR_COMMIT' },
    user: { S: 'andklee@amazon.com' },
    trace_id: { S: 'd04625d0b0f640b97eafbe2ec9a32a33' },
    timestamp: { S: TS },
    in_main: { BOOL: o.inMain ?? false },
    was_reverted: { BOOL: o.reverted ?? false },
  };
  if (o.origin !== undefined) i.ai_origin = { S: o.origin };
  if (o.tool !== undefined) i.ai_tool = { S: o.tool };
  return i;
}

function insert(newImage: Img) {
  return { eventName: 'INSERT', dynamodb: { NewImage: newImage } };
}
function modify(oldImage: Img, newImage: Img) {
  return { eventName: 'MODIFY', dynamodb: { OldImage: oldImage, NewImage: newImage } };
}

let failures = 0;
function check(name: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}\n      ${detail}`);
    failures++;
  }
}

console.log('\nCommit state-transition guard\n');

// --- Case 1: CI seeds a merged commit as human ---
{
  const r = parseCommitRecord(insert(img({ origin: 'human', tool: 'none', inMain: true })) as never);
  check(
    'CI-seeded INSERT is parsed as new, human, merged',
    r !== null && r.isNew && r.storedOrigin === 'human' && r.inMain === true && !r.originUpgraded,
    `got ${JSON.stringify(r)}`,
  );
}

// --- Case 2: the regression — attribution upgrades origin, nothing else moves ---
{
  const before = img({ origin: 'human', tool: 'none', inMain: true });
  const after = img({ origin: 'ai-generated', tool: 'claude-code', inMain: true });
  const r = parseCommitRecord(modify(before, after) as never);
  check(
    'origin upgrade human→ai-generated is NOT dropped',
    r !== null,
    'parseCommitRecord returned null — the upgrade never reaches CloudWatch',
  );
  check(
    'origin upgrade sets originUpgraded, not mergedNow/revertedNow',
    r !== null && r.originUpgraded === true && r.mergedNow === false && r.revertedNow === false,
    `got ${JSON.stringify(r)}`,
  );
  check(
    'upgraded record carries the stored tool for the Tool dimension',
    r !== null && r.storedOrigin === 'ai-generated' && r.storedTool === 'claude-code',
    `got storedOrigin=${r?.storedOrigin} storedTool=${r?.storedTool}`,
  );
  check(
    'upgraded record reports in_main so MergedAICommits can be moved onto the AI series',
    r !== null && r.inMain === true,
    `got inMain=${r?.inMain}`,
  );
}

// --- Case 3: merge flip still detected (pre-existing behaviour) ---
{
  const r = parseCommitRecord(modify(
    img({ origin: 'ai-generated', tool: 'kiro', inMain: false }),
    img({ origin: 'ai-generated', tool: 'kiro', inMain: true }),
  ) as never);
  check(
    'in_main false→true still reports mergedNow',
    r !== null && r.mergedNow === true && r.originUpgraded === false,
    `got ${JSON.stringify(r)}`,
  );
}

// --- Case 4: an unrelated MODIFY must STILL be ignored ---
{
  const same = img({ origin: 'human', tool: 'none', inMain: true });
  const r = parseCommitRecord(modify(same, img({ origin: 'human', tool: 'none', inMain: true })) as never);
  check(
    'MODIFY with no meaningful transition is still dropped',
    r === null,
    'a no-op MODIFY produced a record — every touch would double-count',
  );
}

// --- Case 5: ai-generated must not "downgrade" to human ---
{
  const r = parseCommitRecord(modify(
    img({ origin: 'ai-generated', tool: 'kiro', inMain: true }),
    img({ origin: 'human', tool: 'none', inMain: true }),
  ) as never);
  // The receiver's ConditionExpression forbids this direction, so it should
  // never occur; asserting it here means a future relaxation cannot silently
  // start retracting AI counts.
  check(
    'ai-generated → human is not treated as an upgrade',
    r === null || r.originUpgraded === false,
    `got ${JSON.stringify(r)}`,
  );
}

// --- Case 6: revert flip on an already-AI commit ---
{
  const r = parseCommitRecord(modify(
    img({ origin: 'ai-generated', tool: 'kiro', inMain: true, reverted: false }),
    img({ origin: 'ai-generated', tool: 'kiro', inMain: true, reverted: true }),
  ) as never);
  check(
    'was_reverted false→true still reports revertedNow',
    r !== null && r.revertedNow === true && r.originUpgraded === false,
    `got ${JSON.stringify(r)}`,
  );
}

// --- Case 7: legacy item with no ai_origin falls through to the span join ---
{
  const r = parseCommitRecord(insert(img({ inMain: false })) as never);
  check(
    'legacy INSERT without ai_origin yields empty storedOrigin (span-join fallback)',
    r !== null && r.storedOrigin === '',
    `got storedOrigin=${JSON.stringify(r?.storedOrigin)}`,
  );
}

// --- Case 8: non-commit records are ignored ---
{
  const r = parseCommitRecord(insert({ record_type: { S: 'OTEL_SPAN' } }) as never);
  check('non-COMMIT record_type ignored', r === null, `got ${JSON.stringify(r)}`);
}

console.log();
if (failures > 0) {
  console.error(`✗ ${failures} commit-transition check(s) failed\n`);
  process.exit(1);
}
console.log('✓ commit state transitions handled: insert, origin upgrade, merge, revert\n');
