import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** One canned `aws` invocation. See test/fixtures/aws for the semantics. */
export interface AwsStub {
  /** Every token must appear in argv for the rule to match. */
  match: string[];
  /** JSON-encoded to stdout. */
  stdout?: unknown;
  /** Written to stdout verbatim — use '' for the exit-0-with-empty-body case. */
  raw?: string;
  /** An AWS error code, rendered in the real CLI's stderr shape. */
  error?: string;
  /** With `error`: the message after the code (default "stubbed"). */
  message?: string;
}

/**
 * Run `fn` with the fake `aws` first on PATH.
 *
 * PATH and the responses pointer are process-global, so this must not run
 * concurrently with anything else that shells out to aws. Every test using it is
 * therefore registered with `{ concurrency: false }` (the default for
 * node:test), and the restore happens in `finally` so one failing assertion
 * cannot leak a fake binary into the rest of the run.
 */
export function withFakeAws<T>(stubs: AwsStub[], fn: () => T, calls?: string[][]): T {
  const dir = mkdtempSync(join(tmpdir(), 'prism-fake-aws-'));
  const responses = join(dir, 'responses.json');
  const log = join(dir, 'calls.jsonl');
  writeFileSync(responses, JSON.stringify(stubs));

  const savedPath = process.env.PATH;
  const savedResponses = process.env.FAKE_AWS_RESPONSES;
  process.env.PATH = `${FIXTURES}:${savedPath ?? ''}`;
  process.env.FAKE_AWS_RESPONSES = responses;
  if (calls) process.env.FAKE_AWS_LOG = log;

  const restore = () => {
    process.env.PATH = savedPath;
    if (savedResponses === undefined) delete process.env.FAKE_AWS_RESPONSES;
    else process.env.FAKE_AWS_RESPONSES = savedResponses;
    if (calls) {
      delete process.env.FAKE_AWS_LOG;
      if (existsSync(log)) for (const l of readFileSync(log, 'utf8').split('\n').filter(Boolean)) calls.push(JSON.parse(l));
    }
    rmSync(dir, { recursive: true, force: true });
  };
  // An async fn keeps the fake on PATH until its promise settles.
  let pending = false;
  try {
    const r = fn();
    if (r instanceof Promise) { pending = true; return r.finally(restore) as T; }
    return r;
  } finally {
    if (!pending) restore();
  }
}

/** `guardduty list-detectors` returning the given detector ids. */
export const detectors = (...ids: string[]): AwsStub => ({
  match: ['guardduty', 'list-detectors'],
  stdout: { DetectorIds: ids },
});

/** `guardduty list-detectors` returning an exit-0 empty body, as it does when GuardDuty is off. */
export const noDetectors = (): AwsStub => ({
  match: ['guardduty', 'list-detectors'],
  raw: '',
});
