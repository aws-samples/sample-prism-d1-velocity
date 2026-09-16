import { test } from 'node:test';
import assert from 'node:assert/strict';

import { auditOrgAiProtection } from '../src/utils/audit-org.js';
import { withFakeAws, detectors, noDetectors, type AwsStub } from './helpers.js';

const REGION = 'us-east-1';

/**
 * `guardduty describe-organization-configuration` with the given AI_PROTECTION
 * auto-enable value.
 *
 * Shape observed from the real AWS CLI against a live delegated-administrator
 * account, not inferred from the API docs: PascalCase `Features` whose entries
 * carry exactly `Name` and
 * `AutoEnable` (no `UpdatedAt`, unlike the detector-level response), alongside
 * top-level `AutoEnable`, `AutoEnableOrganizationMembers`, `DataSources` and
 * `MemberAccountLimitReached`. Nine features came back on a single page with no
 * NextToken, which is why the paginated case below is a constructed fixture
 * rather than a real observation.
 */
const orgConfig = (autoEnable: string | null, extra: Record<string, unknown> = {}): AwsStub => ({
  match: ['guardduty', 'describe-organization-configuration'],
  stdout: {
    AutoEnable: false,
    AutoEnableOrganizationMembers: 'ALL',
    MemberAccountLimitReached: false,
    Features: [
      { Name: 'S3_DATA_EVENTS', AutoEnable: 'NONE' },
      ...(autoEnable ? [{ Name: 'AI_PROTECTION', AutoEnable: autoEnable }] : []),
      { Name: 'AI_ANALYST', AutoEnable: 'NONE' },
    ],
    ...extra,
  },
});

const delegatedAdmin = (id: string, name: string): AwsStub => ({
  match: ['organizations', 'list-delegated-administrators'],
  stdout: { DelegatedAdministrators: [{ Id: id, Name: name }] },
});

const run = (stubs: AwsStub[]) => withFakeAws(stubs, () => auditOrgAiProtection(undefined, REGION));

test('every outcome is MEDIUM and carries the org-detection category', () => {
  const outcomes = [
    run([detectors('d-1'), orgConfig('ALL')]),
    run([detectors('d-1'), orgConfig('NONE')]),
    run([detectors('d-1'), { match: ['describe-organization-configuration'], error: 'BadRequestException' },
      { match: ['list-delegated-administrators'], error: 'AccessDeniedException' }]),
  ];
  for (const f of outcomes) {
    assert.equal(f.severity, 'MEDIUM');
    assert.equal(f.id, 'guardduty-ai-protection-org');
    assert.equal(f.category, 'org-detection');
  }
});

test('autoEnable ALL passes — existing members and new joiners both covered', () => {
  const f = run([detectors('d-1'), orgConfig('ALL')]);
  assert.equal(f.status, 'PASS');
  assert.match(f.detail, /auto-enable is ALL/);
  assert.equal(f.remediation, undefined);
});

test('autoEnable NEW fails: it covers joiners but establishes nothing about existing members', () => {
  const f = run([detectors('d-1'), orgConfig('NEW')]);
  assert.equal(f.status, 'FAIL');
  assert.match(f.detail, /existing member accounts are NOT covered/);
  // Must not overclaim: NEW does not prove existing members lack it.
  assert.match(f.detail, /cannot see per-member state/);
  assert.match(f.remediation!, /get-member-detectors/);
});

test('autoEnable NONE fails as nothing-is-automatic', () => {
  const f = run([detectors('d-1'), orgConfig('NONE')]);
  assert.equal(f.status, 'FAIL');
  assert.match(f.detail, /nothing is automatic/);
  assert.match(f.remediation!, /AutoEnable":"ALL/);
});

test('AI_PROTECTION missing from the feature list fails as never-configured-org-wide', () => {
  const f = run([detectors('d-1'), orgConfig(null)]);
  assert.equal(f.status, 'FAIL');
  assert.match(f.detail, /never been configured at the organization level/);
});

test('a paginated feature list that omitted AI_PROTECTION is INDETERMINATE, not FAIL', () => {
  const f = run([detectors('d-1'), orgConfig(null, { NextToken: 'more' })]);
  assert.equal(f.status, 'INDETERMINATE');
  assert.match(f.detail, /returned paginated/);
});

test('service-level autoEnableOrganizationMembers=NONE is flagged even when the feature says ALL', () => {
  // Member accounts with no detector have nothing for AI_PROTECTION to attach to,
  // so a feature-level ALL is not sufficient on its own.
  const f = run([
    detectors('d-1'),
    orgConfig('ALL', { AutoEnableOrganizationMembers: 'NONE' }),
  ]);
  assert.equal(f.status, 'PASS');
  assert.match(f.detail, /autoEnableOrganizationMembers=NONE/);
  assert.notEqual(f.remediation, undefined);
});

test('camelCase org feature keys are read the same as PascalCase', () => {
  const f = run([
    detectors('d-1'),
    {
      match: ['describe-organization-configuration'],
      stdout: { autoEnableOrganizationMembers: 'ALL', features: [{ name: 'ai_protection', autoEnable: 'all' }] },
    },
  ]);
  assert.equal(f.status, 'PASS');
});

test('not being the delegated administrator is INDETERMINATE and names who to ask', () => {
  // BadRequestException is the real error code here, verified live against a
  // region with no delegated administrator: "The request failed because a
  // delegated administrator account has not been enabled." The CLI also prints a secondary
  // "Type: InvalidInputException" detail line, which utils/aws.ts does NOT parse
  // -- its regex captures the code in parentheses. Classifying on the detail line
  // instead would send this down the generic-permissions branch.
  const f = run([
    detectors('d-1'),
    { match: ['describe-organization-configuration'], error: 'BadRequestException' },
    delegatedAdmin('111122223333', 'security-tooling'),
  ]);
  assert.equal(f.status, 'INDETERMINATE');
  assert.match(f.detail, /not the delegated GuardDuty administrator/);
  assert.match(f.detail, /111122223333 \(security-tooling\)/);
});

test('no detector means this account cannot be the admin — INDETERMINATE, not FAIL', () => {
  const f = run([
    noDetectors(),
    delegatedAdmin('111122223333', 'security-tooling'),
  ]);
  assert.equal(f.status, 'INDETERMINATE');
  assert.match(f.detail, /is not the delegated GuardDuty administrator/);
  assert.match(f.detail, /111122223333/);
});

test('no detector and no registered admin says org-wide GuardDuty was never set up', () => {
  const f = run([
    noDetectors(),
    { match: ['organizations', 'list-delegated-administrators'], stdout: { DelegatedAdministrators: [] } },
  ]);
  assert.equal(f.status, 'INDETERMINATE');
  assert.match(f.detail, /has not been set up at all/);
});

test('a permissions failure on the org read is distinguished from not being the admin', () => {
  const f = run([
    detectors('d-1'),
    { match: ['describe-organization-configuration'], error: 'AccessDeniedException' },
  ]);
  assert.equal(f.status, 'INDETERMINATE');
  assert.match(f.detail, /AccessDeniedException/);
  assert.match(f.remediation!, /DescribeOrganizationConfiguration/);
});
