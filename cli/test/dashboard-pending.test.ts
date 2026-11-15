/**
 * 1.16.0: a Security Agent fetch whose job is still running exits EXIT_PENDING (2), and the
 * dashboard's runner reports it as outcome "pending", not a failure. Also: the Action output
 * drawer masks account ids, assumed-role session names and the home directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIONS, ActionRunner, redact, repoId, type ActionId, type ScanRepo } from '../src/dashboard/actions.js';
import { EXIT_PENDING } from '../src/security/errors.js';
import { SETUP_SCRIPT } from '../src/dashboard/setup-page.js';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'prism-pending-home-')));
const REPO: ScanRepo = { id: repoId(join(home, 'src', 'demo')), name: 'demo', path: join(home, 'src', 'demo') };

/** A runner whose child prints `out` and exits `code`. */
function runner(code: number, out = '') {
  const spawn = () => {
    const c: any = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => true;
    setTimeout(() => { c.stdout.emit('data', out); c.emit('close', code); }, 1);
    return c;
  };
  return new ActionRunner({
    execPath: '/usr/bin/node', entry: '/opt/prism/dist/bin/prism-cli.js', cwd: home, home, repos: async () => [REPO],
    systemdAvailable: () => false, platform: 'linux', spawn: spawn as any,
    awsArgs: () => ['--profile', 'demo', '--region', 'us-west-2'], writeGate: () => null,
  });
}
async function run(id: ActionId, code: number, out = '') {
  const r = runner(code, out);
  const started = await r.start({ action: id, repo: REPO.id });
  assert.equal(started.status, 202, JSON.stringify(started.json));
  for (let i = 0; i < 200 && r.status().state !== 'done'; i++) await new Promise((x) => setTimeout(x, 5));
  return r.status();
}

test('exit codes: EXIT_PENDING is 2, and only the three fetch actions declare it', () => {
  assert.equal(EXIT_PENDING, 2);
  const pending = (Object.keys(ACTIONS) as ActionId[]).filter((id) => ACTIONS[id].pendingExit !== undefined);
  assert.deepEqual(pending, ['security-findings', 'security-threats', 'security-pentest-findings']);
  for (const id of pending) assert.equal(ACTIONS[id].pendingExit, EXIT_PENDING);
});

test('runner: exit 2 from a fetch is pending; exit 1, a non-fetch exit 2 and exit 0 are not', async () => {
  for (const id of ['security-findings', 'security-threats', 'security-pentest-findings'] as ActionId[]) {
    const s = await run(id, 2, 'The job is still IN_PROGRESS. Re-run with --wait to wait for it, or check back later.\n');
    assert.equal(s.outcome, 'pending', id);
    assert.equal(s.exitCode, 2, id);
    assert.equal((await run(id, 1, 'Error: x\n')).outcome, 'failed', id);
    assert.equal((await run(id, 0)).outcome, 'ok', id);
  }
  assert.equal((await run('security-status', 2)).outcome, 'failed', 'exit 2 means pending only where the action declares it');
});

test('drawer output: account ids as last 4, the ARN keeps the role name only, home as ~', async () => {
  const out = [
    'Account:     111122223333 (demo-dev)',
    'Caller:      arn:aws:sts::111122223333:assumed-role/PrismDemoReadOnly/someone@example.com',
    `Saved ${home}/src/demo/.prism/results/x.json`,
  ].join('\n');
  const s = await run('security-findings', 0, out);
  assert.ok(!s.output!.includes('111122223333'));
  assert.match(s.output!, /Account: {5}••••3333 \(demo-dev\)/);
  assert.match(s.output!, /Caller: {6}arn:aws:sts::••••3333:assumed-role\/PrismDemoReadOnly\/…$/m);
  assert.ok(!s.output!.includes('someone@example.com'), 'no session name');
  assert.ok(!s.output!.includes(home), 'no home path in the output');
  assert.match(s.output!, /Saved ~\/src\/demo\/\.prism\/results\/x\.json/);
  assert.equal(s.cwd, '~/src/demo');
  // A user ARN and an IAM role ARN keep their names (no session to drop).
  assert.equal(redact('arn:aws:iam::111122223333:role/Deploy'), 'arn:aws:iam::••••3333:role/Deploy');
});

test('page: a pending outcome gets the amber "still running" pill and a hint, not the red exit pill', () => {
  assert.match(SETUP_SCRIPT, /pending \? pill\('warn', 'still running \(exit ' \+ s\.exitCode \+ '\)'\)/);
  assert.match(SETUP_SCRIPT, /Check back later, or run the same command with --wait\./);
});
