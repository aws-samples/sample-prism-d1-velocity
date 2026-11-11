import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEBOUNCE_MS, FOCUS_STALE_MS, Refresher, type Clock } from '../src/refresh';

/** A manual clock: advance() fires due timers in order. */
function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => { timers.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout: (h) => { timers.delete(h as number); },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  return { clock, advance, pending: () => timers.size };
}

const flush = () => new Promise((r) => setImmediate(r));

function harness() {
  const c = fakeClock();
  const runs: boolean[] = [];
  let release: (() => void) | null = null;
  const r = new Refresher((fresh) => { runs.push(fresh); return new Promise<void>((res) => { release = res; }); }, c.clock);
  const finish = async () => { release?.(); release = null; await flush(); };
  return { ...c, r, runs, finish };
}

test('requests within the debounce window collapse into one run', async () => {
  const h = harness();
  h.r.request(); h.advance(500); h.r.request(); h.advance(500); h.r.request();
  h.advance(DEBOUNCE_MS - 1);
  assert.equal(h.runs.length, 0);
  h.advance(1);
  assert.equal(h.runs.length, 1);
  await h.finish();
});

test('one run at a time: a request during a run queues exactly one more', async () => {
  const h = harness();
  h.r.request({ immediate: true });
  assert.equal(h.runs.length, 1);
  assert.equal(h.r.busy, true);
  h.r.request({ immediate: true });
  h.r.request({ immediate: true });
  h.r.request(); h.advance(DEBOUNCE_MS);
  assert.equal(h.runs.length, 1, 'no second run while the first is going');
  await h.finish();
  assert.equal(h.runs.length, 2, 'the queued requests become one run');
  await h.finish();
  assert.equal(h.runs.length, 2);
  assert.equal(h.r.busy, false);
});

test('fresh sticks until a run uses it', async () => {
  const h = harness();
  h.r.request({ fresh: true });
  h.r.request();
  h.advance(DEBOUNCE_MS);
  assert.deepEqual(h.runs, [true]);
  await h.finish();
  h.r.request({ immediate: true });
  assert.deepEqual(h.runs, [true, false]);
  await h.finish();
});

test('focus refreshes only data older than 60 s', async () => {
  const h = harness();
  h.r.request({ immediate: true });
  await h.finish();
  h.advance(FOCUS_STALE_MS - 1000);
  h.r.focus(); h.advance(DEBOUNCE_MS);
  assert.equal(h.runs.length, 1);
  h.advance(2000);
  h.r.focus(); h.advance(DEBOUNCE_MS);
  assert.equal(h.runs.length, 2);
  await h.finish();
});

test('a failing run does not wedge the lock; dispose cancels a pending run', async () => {
  const c = fakeClock();
  let n = 0;
  const r = new Refresher(async () => { n++; throw new Error('boom'); }, c.clock);
  r.request({ immediate: true });
  await flush();
  assert.equal(r.busy, false);
  r.request({ immediate: true });
  await flush();
  assert.equal(n, 2);
  r.request();
  r.dispose();
  c.advance(DEBOUNCE_MS * 2);
  assert.equal(n, 2);
  assert.equal(c.pending(), 0);
});
