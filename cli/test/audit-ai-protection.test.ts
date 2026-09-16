import { test } from 'node:test';
import assert from 'node:assert/strict';

import { auditAiProtection } from '../src/utils/audit-bedrock.js';
import { withFakeAws, detectors, noDetectors, type AwsStub } from './helpers.js';

const REGION = 'us-east-1';

/**
 * `guardduty get-detector` carrying an arbitrary feature list.
 *
 * The shape here is the one observed from the real AWS CLI against a live
 * GuardDuty detector, not inferred from the API docs: `Features` PascalCase, with
 * entries carrying exactly `Name`, `Status` and `UpdatedAt`. The `UpdatedAt` field is included even though
 * the check ignores it, so the fixture stays a faithful record of the real
 * response rather than a minimal one that could drift from it unnoticed.
 */
const getDetector = (features: unknown[]): AwsStub => ({
  match: ['guardduty', 'get-detector'],
  stdout: { Status: 'ENABLED', Features: features },
});

const OTHER_FEATURES = [
  { Name: 'CLOUD_TRAIL', Status: 'ENABLED', UpdatedAt: '2026-01-01T00:00:00.000Z' },
  { Name: 'LAMBDA_NETWORK_LOGS', Status: 'ENABLED', UpdatedAt: '2026-01-01T00:00:00.000Z' },
  // A real detector also reports AI_ANALYST (the investigation agent) as its own
  // feature. Present here so a future check for it cannot be written against a
  // fixture that pretends it does not exist.
  { Name: 'AI_ANALYST', Status: 'DISABLED', UpdatedAt: '2026-01-01T00:00:00.000Z' },
];

const run = (stubs: AwsStub[]) => withFakeAws(stubs, () => auditAiProtection(undefined, REGION));

test('every outcome is MEDIUM, matching the documented severity', () => {
  const outcomes = [
    run([detectors('d-1'), getDetector([...OTHER_FEATURES, { Name: 'AI_PROTECTION', Status: 'ENABLED' }])],),
    run([detectors('d-1'), getDetector(OTHER_FEATURES)]),
    run([noDetectors()]),
    run([{ match: ['guardduty', 'list-detectors'], error: 'AccessDeniedException' }]),
  ];
  for (const f of outcomes) {
    assert.equal(f.severity, 'MEDIUM');
    assert.equal(f.id, 'guardduty-ai-protection');
    assert.equal(f.category, 'detection');
  }
});

test('AI_PROTECTION ENABLED passes', () => {
  const f = run([
    detectors('d-1'),
    getDetector([...OTHER_FEATURES, { Name: 'AI_PROTECTION', Status: 'ENABLED' }]),
  ]);
  assert.equal(f.status, 'PASS');
  assert.match(f.detail, /enabled on d-1/);
  // The Low-severity routing caveat is the operationally load-bearing part.
  assert.match(f.detail, /severity Low/);
  assert.equal(f.remediation, undefined);
});

test('AI_PROTECTION DISABLED fails, and says present-but-off rather than unconfigured', () => {
  const f = run([
    detectors('d-1'),
    getDetector([...OTHER_FEATURES, { Name: 'AI_PROTECTION', Status: 'DISABLED' }]),
  ]);
  assert.equal(f.status, 'FAIL');
  assert.match(f.detail, /present but DISABLED/);
  assert.match(f.remediation!, /update-detector/);
});

test('AI_PROTECTION absent from Features fails as never-configured, a distinct state from DISABLED', () => {
  const f = run([detectors('d-1'), getDetector(OTHER_FEATURES)]);
  assert.equal(f.status, 'FAIL');
  assert.match(f.detail, /never been configured/);
  assert.doesNotMatch(f.detail, /DISABLED/);
});

test('no detector in the region fails, and points at the moot SCP guardrail', () => {
  // Exercises the exit-0-empty-body path through the real aws() wrapper: a naive
  // JSON.parse('') would throw here instead of reporting a finding.
  const f = run([noDetectors()]);
  assert.equal(f.status, 'FAIL');
  assert.match(f.detail, /not enabled in us-east-1 at all/);
  assert.match(f.detail, /scp-detection-tamper/);
});

test('camelCase feature keys still pass — a case mismatch must not read as a false FAIL', () => {
  const f = run([
    detectors('d-1'),
    getDetector([{ name: 'ai_protection', status: 'enabled' }]),
  ]);
  assert.equal(f.status, 'PASS');
});

test('list-detectors denied is INDETERMINATE, never FAIL', () => {
  const f = run([{ match: ['guardduty', 'list-detectors'], error: 'AccessDeniedException' }]);
  assert.equal(f.status, 'INDETERMINATE');
  assert.match(f.detail, /AccessDeniedException/);
  assert.match(f.remediation!, /guardduty:ListDetectors/);
});

test('an unreadable detector cannot clear the check when no readable one has the feature', () => {
  // Two detectors, the only readable one lacking AI_PROTECTION. The unreadable
  // one may be the one carrying it, so absence is not established.
  const f = withFakeAws([
    detectors('d-1', 'd-2'),
    { match: ['get-detector', 'd-1'], error: 'AccessDeniedException' },
    { match: ['get-detector', 'd-2'], stdout: { Features: OTHER_FEATURES } },
  ], () => auditAiProtection(undefined, REGION));
  assert.equal(f.status, 'INDETERMINATE');
  assert.match(f.detail, /Read 1\/2 detector/);
});

test('an unreadable detector does not block a PASS once another detector proves coverage', () => {
  const f = withFakeAws([
    detectors('d-1', 'd-2'),
    { match: ['get-detector', 'd-1'], error: 'AccessDeniedException' },
    { match: ['get-detector', 'd-2'], stdout: { Features: [{ Name: 'AI_PROTECTION', Status: 'ENABLED' }] } },
  ], () => auditAiProtection(undefined, REGION));
  assert.equal(f.status, 'PASS');
  assert.match(f.detail, /enabled on d-2/);
});
