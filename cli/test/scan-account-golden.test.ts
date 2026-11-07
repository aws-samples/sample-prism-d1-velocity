/**
 * `bedrock-protection scan-account` must print exactly what it printed before
 * its checks were moved into a shared function for `aws check`. The golden file
 * was captured from the code on main before that refactor.
 *
 * Regenerate (only when a change to the report is intended):
 *   PRISM_WRITE_GOLDEN=1 npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import scanAccount from '../src/commands/bedrock-protection/scan-account.js';
import { withFakeAws, type AwsStub } from './helpers.js';
import { SCAN_ACCOUNT_STUBS } from './aws-fixtures.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scan-account', 'golden.txt');


/** Runs the command's action with console.log captured and a clean HOME and AWS env. */
export async function captureScanAccount(opts: Record<string, unknown>, stubs: AwsStub[] = SCAN_ACCOUNT_STUBS): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'prism-golden-home-'));
  const saved = { ...process.env };
  const log = console.log;
  const err = console.error;
  const lines: string[] = [];
  process.env.HOME = home;
  for (const k of ['AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ACCESS_KEY_ID']) delete process.env[k];
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  console.error = () => {};
  try {
    await withFakeAws(stubs, () => scanAccount.action(opts as any));
  } finally {
    console.log = log;
    console.error = err;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(home, { recursive: true, force: true });
  }
  return lines.join('\n') + '\n';
}

test('scan-account: text report is byte-for-byte what main printed', async () => {
  const out = await captureScanAccount({ region: 'us-east-1', maxKeyAge: '90', unusedDays: '90', failOn: 'none' });
  if (process.env.PRISM_WRITE_GOLDEN) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, out);
  }
  assert.equal(out, readFileSync(GOLDEN, 'utf8'));
});

test('ACCOUNT_AUDIT_IDS lists every check id the IAM and Bedrock audit modules can emit', async () => {
  const { ACCOUNT_AUDIT_IDS } = await import('../src/utils/audit-account.js');
  const src = ['audit-iam.ts', 'audit-bedrock.ts']
    .map((f) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'utils', f), 'utf8')).join('\n');
  // Literal `id: '...'`, `const id = '...'` and the `['id', 'title'...]` tables used for INDETERMINATE fan-out.
  const found = new Set<string>();
  for (const m of src.matchAll(/\bid(?::|\s*=)\s*'([a-z0-9-]+)'/g)) found.add(m[1]);
  for (const m of src.matchAll(/\[\s*'([a-z0-9-]+)',\s*'[A-Z]/g)) found.add(m[1]);
  assert.deepEqual([...found].sort(), [...ACCOUNT_AUDIT_IDS].sort());
});

test('scan-account never skips the credential report generation it always did; aws check can opt out', async () => {
  const stubs: AwsStub[] = [
    { match: ['iam', 'get-credential-report'], error: 'ReportNotPresent' },
    { match: ['iam', 'generate-credential-report'], error: 'AccessDenied' },
  ];
  const { auditUsers } = await import('../src/utils/audit-iam.js');
  const gen = withFakeAws(stubs, () => auditUsers(undefined, 90, 90));
  const noGen = withFakeAws(stubs, () => auditUsers(undefined, 90, 90, false));
  assert.match(gen[0].detail, /AccessDenied/);
  assert.match(noGen[0].detail, /ReportNotPresent/);
});
