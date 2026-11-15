/**
 * The action runner ends a run when its child EXITS, even if a process the child started still
 * holds stdout/stderr ('close' would never fire): otherwise the lock stays taken and every later
 * Run button answers 409 "another action is running". Real processes, no AWS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionRunner } from '../src/dashboard/actions.js';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'prism-runner-exit-')));
// The "CLI": starts a grandchild that inherits stdout/stderr and lives 30 s, prints its pid, exits 0.
const entry = join(dir, 'fake-cli.mjs');
writeFileSync(entry, `
import { spawn } from 'node:child_process';
const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
g.unref();
console.log('grandchild ' + g.pid);
process.exit(0);
`);

function runner() {
  return new ActionRunner({
    execPath: process.execPath, entry, cwd: dir, home: dir, repos: async () => [],
    systemdAvailable: () => false, platform: 'linux', exitGraceMs: 150,
  });
}
const until = async (f: () => boolean, ms = 10000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)); } };

test('runner: a grandchild holding the output pipe does not keep the run (or the lock) going', async () => {
  const r = runner();
  let grandchild = 0;
  try {
    assert.equal((await r.start({ action: 'codeburn-status' })).status, 202);
    await until(() => r.status().state === 'done');
    const s = r.status();
    grandchild = Number(/grandchild (\d+)/.exec(s.output || '')?.[1] || 0);
    assert.ok(grandchild > 0, 'the grandchild started: ' + s.output);
    assert.equal(s.exitCode, 0);
    assert.match(s.output!, /a process it started still holds its output; stopped reading/);
    assert.equal(r.running, false, 'the lock is released');
    // The next action starts: 202, not 409.
    const next = await r.start({ action: 'codeburn-status' });
    assert.equal(next.status, 202, JSON.stringify(next.json));
    await until(() => r.status().state === 'done');
  } finally {
    for (const m of (r.status().output || '').matchAll(/grandchild (\d+)/g)) { try { process.kill(-Number(m[1]), 'SIGKILL'); } catch { /* gone */ } }
    if (grandchild) { try { process.kill(-grandchild, 'SIGKILL'); } catch { /* gone */ } }
  }
});
