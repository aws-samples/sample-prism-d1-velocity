#!/usr/bin/env npx tsx
/**
 * Metric coverage guard — fails the build on orphaned metrics.
 *
 * Two invariants, both violated repeatedly before this existed:
 *
 *   1. EVERY CloudWatch metric a dashboard or alarm reads must have an emitter.
 *      Violations render as permanently empty widgets and alarms stuck in
 *      INSUFFICIENT_DATA. Found in this repo: BedrockCostUSD and
 *      TokenEfficiency (demo-generator only), plus a "Pen Test Exploit
 *      Detected" alarm on a metric that never existed.
 *
 *   2. EVERY metric emitted must have a consumer. Violations are pure cost and
 *      false confidence. Found in this repo: 10 of them at once —
 *      AIAdoptionRate, SpecCoverage, ClaudeCodeCommits, KiroCommits,
 *      QDeveloperCommits, UntaggedCommits, DeploymentFrequency,
 *      LeadTimeForChanges, AIToMergeRatio, MTTR.
 *
 * Run: npx tsx scripts/check-metric-coverage.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAMBDA_DIR = join(HERE, '..', 'lib', 'lambda');
const STACK_DIR = join(HERE, '..', 'lib');

/**
 * Metrics published without a dashboard/alarm consumer BY DESIGN.
 *
 * This repo is a reference implementation, so a CloudWatch metric surface that
 * operators can build their own alarms and dashboards on is legitimate — the
 * shipped dashboards read the events table directly instead. What is NOT
 * legitimate is a metric with no producer, which is why that check is a hard
 * failure and this one is advisory unless --strict is passed.
 */
const INTENTIONAL_SURFACE = new Map<string, string>([
  ['ChangeFailureCount', 'CFR alarm numerator (inside a MathExpression)'],
  ['DeploymentFrequency', 'CFR alarm denominator (inside a MathExpression)'],
  ['LeadTimeForChanges', 'operator surface; shipped dashboards read dora.lead_time_seconds from events'],
  ['ChangeFailureRate', 'operator surface; shipped dashboards derive CFR from is_failure_fix'],
  ['MTTR', 'operator surface; shipped dashboards derive MTTR from failure-fix lead times'],
  ['EvalGatePassRateByRubric', 'operator surface; eval panel reads prism.d1.eval events'],
  ['EvalScore', 'operator surface; eval panel reads prism.d1.eval events'],
  ['GuardrailAnonymizeCount', 'operator surface; governance panel reads guardrail events'],
  ['MCPToolCallCount', 'operator surface; governance panel reads mcp_tool_call events'],
  ['MCPToolCallDurationMs', 'operator surface; governance panel reads mcp_tool_call events'],
  ['SecurityFindingByOrigin', 'operator surface; CISO panels read finding events (partial-dimension trap)'],
  ['SecurityFindingCVSS', 'operator surface; CISO exposure panel reads cvss_score from events'],
  ['SecurityScanCount', 'operator surface; NOTE emitted per FINDING, not per scan — do not build a scan-volume widget on it'],
  ['AIInputTokens', 'operator surface; cost panels use AICostUSD'],
  ['AIOutputTokens', 'operator surface; cost panels use AICostUSD'],
  ['PostMergeDefectRateAI', 'operator surface; dashboards use attribution RevertedAICommits/MergedAICommits'],
  ['PostMergeDefectRateHuman', 'operator surface; dashboards use attribution metrics'],
  // Agent runtime metrics: the agents panel reads these from prism.d1.agent
  // events (per-agent table with steps/tools/tokens/guardrails), so the
  // CloudWatch copies exist for operator alarming only.
  ['AgentStepCount', 'operator surface; agents panel reads agent events'],
  ['AgentDurationMs', 'operator surface; agents panel reads agent events'],
  ['AgentTokensUsed', 'operator surface; agents panel reads agent events'],
  ['AgentToolInvocationCount', 'operator surface; agents panel reads agent events'],
  ['AgentGuardrailTriggerCount', 'operator surface; agents panel reads agent events'],
]);

/** Metrics a consumer may read that have no in-repo emitter, with reason. */
const ALLOWED_UNEMITTED = new Map<string, string>([
  ['AICommits', 'attribution-metrics-publisher (dimension-derived name)'],
  ['HumanCommits', 'attribution-metrics-publisher'],
  ['MergedAICommits', 'attribution-metrics-publisher'],
  ['MergedHumanCommits', 'attribution-metrics-publisher'],
  ['RevertedAICommits', 'attribution-metrics-publisher'],
  ['CommitsTotal', 'attribution-metrics-publisher'],
]);

function readAll(dir: string, filter: (f: string) => boolean): string {
  return readdirSync(dir)
    .filter(filter)
    .map(f => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

const lambdaSrc = readAll(LAMBDA_DIR, f => f.endsWith('.ts'));
const stackSrc = readAll(STACK_DIR, f => f.endsWith('.ts'));

// --- Emitters: MetricName: 'X' / MetricName: "X" in Lambda sources
const emitted = new Set<string>();
for (const m of lambdaSrc.matchAll(/MetricName:\s*['"]([A-Za-z0-9_]+)['"]/g)) emitted.add(m[1]);
// Tuple form used by the aiDoraMap / agent metric maps:
//   ['MetricName', detail.x, Unit]           property access
//   ['MetricName', agent.status === ..., Unit]
//   ['MetricName', pctFromRatio(detail.x), Unit]   helper call
// The trailing requirement keeps this from matching arbitrary string arrays. An
// earlier version required `detail.` specifically and produced a false positive
// on AgentSuccessRate, which uses `agent.status`. A later version allowed only
// `.` or `[` after the identifier, so wrapping a value in a scaling helper made
// the emission invisible and the metric was reported as consumed-but-not-
// emitted — the guard could not express "emitted with a transform" at all.
// `(` is therefore accepted alongside property access.
for (const m of lambdaSrc.matchAll(/\[\s*['"]([A-Z][A-Za-z0-9_]+)['"]\s*,\s*[a-zA-Z_][A-Za-z0-9_]*[.[(]/g)) emitted.add(m[1]);

// --- Consumers: metricName in dashboards/alarms, plus SEARCH expressions
const consumed = new Set<string>();
for (const m of stackSrc.matchAll(/metricName:\s*['"]([A-Za-z0-9_]+)['"]/g)) consumed.add(m[1]);
for (const m of stackSrc.matchAll(/MetricName="([A-Za-z0-9_]+)"/g)) consumed.add(m[1]);

const strict = process.argv.includes('--strict');
const errors: string[] = [];
const advisories: string[] = [];

// INVARIANT 1 (hard): a consumed metric with no producer is always a bug — the
// widget renders empty or the alarm sits in INSUFFICIENT_DATA forever.
for (const name of consumed) {
  if (!emitted.has(name) && !ALLOWED_UNEMITTED.has(name)) {
    errors.push(
      `CONSUMED BUT NOT EMITTED: '${name}' is read by a dashboard or alarm but no Lambda publishes it.`,
    );
  }
}

// INVARIANT 2 (advisory unless --strict): an emitted metric with no in-repo
// consumer may be a deliberate operator surface. Undocumented ones are debt.
for (const name of emitted) {
  if (!consumed.has(name) && !INTENTIONAL_SURFACE.has(name)) {
    advisories.push(
      `EMITTED BUT NOT CONSUMED: '${name}' is published but nothing in this repo reads it. ` +
      `Delete it, or document it in INTENTIONAL_SURFACE.`,
    );
  }
}

console.log(`Metric coverage: ${emitted.size} emitted, ${consumed.size} consumed`);
console.log(`Documented: ${INTENTIONAL_SURFACE.size} operator-surface, ${ALLOWED_UNEMITTED.size} external-emitter`);

if (advisories.length > 0) {
  console.warn(`\n${advisories.length} undocumented metric(s):\n`);
  for (const a of advisories) console.warn(`  ! ${a}`);
}

if (errors.length > 0) {
  console.error(`\n${errors.length} coverage FAILURE(S):\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error('');
  process.exit(1);
}

if (strict && advisories.length > 0) {
  console.error('\n--strict: undocumented metrics treated as failures\n');
  process.exit(1);
}

console.log('✓ every consumed metric has an emitter');
