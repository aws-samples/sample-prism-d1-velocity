import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportOtel, runExportOtel, type ExportOtelDeps } from '../src/commands/export/otel.js';
import { runStreaming } from '../src/utils/exec.js';

function home(configured: boolean): string {
  const h = mkdtempSync(join(tmpdir(), 'prism-otel-home-'));
  if (configured) {
    mkdirSync(join(h, '.config', 'codeburn'), { recursive: true });
    writeFileSync(join(h, '.config', 'codeburn', 'sync.json'), '{"baseUrl":"https://otel.example.com"}');
  }
  return h;
}

function fake(o: { installed?: boolean; configured?: boolean; exitCode?: number } = {}) {
  const calls: string[] = [];
  const err: string[] = [];
  const deps: ExportOtelDeps = {
    findCodeburn: () => (o.installed ?? true ? '/fake/codeburn' : null),
    home: home(o.configured ?? true),
    stream: (file, args) => { calls.push(`${file} ${args.join(' ')}`); return o.exitCode ?? 0; },
    log: () => {},
    error: (l) => err.push(l),
  };
  return { deps, calls, err };
}

test('export otel runs the scheduled push argv, default window 7d', async () => {
  const f = fake();
  assert.equal(await exportOtel({}, f.deps), 0);
  assert.deepEqual(f.calls, ['/fake/codeburn sync push --since 7d --attribution']);
});

test('export otel passes --since through and returns codeburn\'s exit code', async () => {
  const f = fake({ exitCode: 3 });
  assert.equal(await exportOtel({ since: '30d' }, f.deps), 3);
  assert.deepEqual(f.calls, ['/fake/codeburn sync push --since 30d --attribution']);
  assert.match(f.err.join('\n'), /exited with 3/);
});

test('export otel: clear errors when codeburn is missing or sync is not set up', async () => {
  const missing = fake({ installed: false });
  assert.equal(await exportOtel({}, missing.deps), 1);
  assert.deepEqual(missing.calls, []);
  assert.match(missing.err.join('\n'), /not installed[\s\S]*prism-cli enable codeburn/);

  const unconfigured = fake({ configured: false });
  assert.equal(await exportOtel({}, unconfigured.deps), 1);
  assert.deepEqual(unconfigured.calls, []);
  assert.match(unconfigured.err.join('\n'), /not set up[\s\S]*prism-cli enable codeburn --url/);
});

test('export otel exits with codeburn\'s code through runGuarded', async () => {
  const f = fake({ exitCode: 2 });
  let code = 0;
  await runExportOtel({}, { deps: () => f.deps, exit: (c) => { code = c; }, error: () => {} });
  assert.equal(code, 2);
});

test('runStreaming returns the child exit code, and 127 for a missing binary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-fake-cb-'));
  const bin = join(dir, 'codeburn');
  const argsFile = join(dir, 'args');
  writeFileSync(bin, `#!/bin/sh\necho "$@" > '${argsFile}'\nexit 4\n`);
  chmodSync(bin, 0o755);
  assert.equal(runStreaming(bin, ['sync', 'push', '--since', '7d', '--attribution']), 4);
  assert.equal(readFileSync(argsFile, 'utf8').trim(), 'sync push --since 7d --attribution');
  assert.equal(runStreaming(join(dir, 'nope'), []), 127);
});
