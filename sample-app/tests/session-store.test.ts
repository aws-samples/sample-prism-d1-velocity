/**
 * Session store tests.
 *
 * The randomness assertions exist because session IDs are bearer credentials --
 * authorize() maps an ID straight to grantedScopes with no signature and no
 * client binding. A regression to Math.random() here is an authorization-bypass
 * primitive, not a cosmetic issue, and it previously shipped unnoticed because
 * this file had no tests at all.
 */

import { InMemorySessionStore } from '../src/mcp/auth/session-store';
import type { Scope } from '../src/mcp/auth/tool-registry';

const SCOPES = ['tasks:read'] as unknown as Scope[];

describe('InMemorySessionStore session IDs', () => {
  it('does not embed a timestamp', () => {
    // The old scheme was sess_<Date.now()>_<random>. A run of digits after the
    // prefix means the creation time leaked back into the token.
    const { sessionId } = new InMemorySessionStore().create('c1', SCOPES);
    expect(sessionId).not.toMatch(/^sess_\d{10,}_/);
  });

  it('carries at least 256 bits of entropy', () => {
    const { sessionId } = new InMemorySessionStore().create('c1', SCOPES);
    const body = sessionId.replace(/^sess_/, '');
    // 32 bytes base64url encodes to 43 chars with no padding.
    expect(body).toHaveLength(43);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('emits a constant-length id across many draws', () => {
    // .slice(2, 10) on a base36 float silently produced short ids for draws
    // whose expansion was shorter -- observed once per ~200k.
    const store = new InMemorySessionStore();
    const lengths = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      lengths.add(store.create('c1', SCOPES, 3600).sessionId.length);
    }
    expect([...lengths]).toEqual([48]); // 'sess_' (5) + 43
  });

  it('never repeats an id', () => {
    const store = new InMemorySessionStore();
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      seen.add(store.create('c1', SCOPES, 3600).sessionId);
    }
    expect(seen.size).toBe(5000);
  });

  it('produces ids that are not predictable from a prior run of outputs', () => {
    // A recovered-PRNG attack replays observed output to predict the next id.
    // We cannot prove unpredictability in a unit test, but we can assert the
    // property that made the old scheme trivially attackable: two independently
    // constructed stores must not produce correlated sequences.
    const a = Array.from({ length: 50 }, () => new InMemorySessionStore().create('c', SCOPES).sessionId);
    const b = Array.from({ length: 50 }, () => new InMemorySessionStore().create('c', SCOPES).sessionId);
    expect(a.filter((id) => b.includes(id))).toHaveLength(0);
  });
});

describe('InMemorySessionStore lifecycle', () => {
  it('returns a live session', () => {
    const store = new InMemorySessionStore();
    const created = store.create('client-a', SCOPES, 3600);
    expect(store.get(created.sessionId)).toEqual(created);
  });

  it('treats an expired session as absent', () => {
    const store = new InMemorySessionStore();
    const created = store.create('client-a', SCOPES, -1);
    expect(store.get(created.sessionId)).toBeUndefined();
  });

  it('revokes a session', () => {
    const store = new InMemorySessionStore();
    const created = store.create('client-a', SCOPES, 3600);
    expect(store.revoke(created.sessionId)).toBe(true);
    expect(store.get(created.sessionId)).toBeUndefined();
    expect(store.revoke(created.sessionId)).toBe(false);
  });

  it('does not retain expired sessions unboundedly', () => {
    // Read-time expiry alone leaks these forever; create() must sweep. The
    // sweep is amortized every 256 creates, so the assertion is that growth is
    // bounded by the interval rather than by the number of creates.
    const store = new InMemorySessionStore();
    for (let i = 0; i < 2000; i++) store.create('stale', SCOPES, -1);
    // @ts-expect-error -- reaching into private state to assert reclamation.
    const size = store.sessions.size as number;
    expect(size).toBeLessThanOrEqual(256);
    expect(size).toBeLessThan(2000);
  });

  it('does not sweep live sessions', () => {
    const store = new InMemorySessionStore();
    const keep = store.create('a', SCOPES, 3600);
    for (let i = 0; i < 300; i++) store.create('b', SCOPES, 3600);
    // A sweep has run by now; nothing live may have been dropped.
    expect(store.get(keep.sessionId)).toBeDefined();
    // @ts-expect-error -- private state.
    expect(store.sessions.size).toBe(301);
  });

  it('honours an unknown id', () => {
    expect(new InMemorySessionStore().get('sess_nope')).toBeUndefined();
  });
});
