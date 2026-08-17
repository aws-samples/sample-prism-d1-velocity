/**
 * MCP Session Store — manages client sessions with TTL expiry.
 *
 * Uses an in-memory Map for the sample app. The SessionStore interface
 * allows swapping to a DynamoDB-backed implementation for production.
 *
 * Session IDs are bearer credentials. authorize() resolves an ID straight to
 * its grantedScopes with no signature and no binding to client identity, so
 * whoever holds the string holds the scopes. They must therefore be generated
 * with a CSPRNG -- see SESSION_ID_BYTES below.
 */

import { randomBytes } from 'node:crypto';
import { Scope } from './tool-registry';

/**
 * Entropy per session ID.
 *
 * 32 bytes (256 bits) rendered base64url, giving a 43-character opaque token.
 *
 * This replaced `sess_${Date.now()}_${Math.random().toString(36).slice(2,10)}`,
 * which was unsafe in three separate ways:
 *
 *  1. Math.random() is not a CSPRNG. V8 implements it with xorshift128+, whose
 *     internal state is recoverable from a short run of consecutive outputs.
 *     That state is shared process-wide, so an attacker who creates a few
 *     sessions of their own -- an ordinary client operation -- samples the same
 *     stream that produces every other client's ID and can then predict them.
 *     The weakness is not the 41-bit nominal ceiling; it is that the generator
 *     is invertible from observed output, so brute force is never needed.
 *  2. The Date.now() prefix is not secret and is not entropy. It narrows the
 *     search space to whatever window the attacker can guess and leaks when the
 *     session was minted. createdAt already records that for legitimate
 *     consumers, so the prefix only ever helped an attacker.
 *  3. .slice(2, 10) assumed a fixed 8 characters. Draws whose base36 expansion
 *     is shorter silently yield a shorter ID -- measured once in 200,000 -- so
 *     the length was not even a reliable floor.
 *
 * ARCC secure-token guidance requires a cryptographically secure PRNG for any
 * unpredictable value in a token, and names this exact failure: "Non-random or
 * unencrypted tokens involved in making authorization decisions for an
 * application can be predicted and replayed resulting in authorization bypass."
 */
const SESSION_ID_BYTES = 32;

function generateSessionId(): string {
  return `sess_${randomBytes(SESSION_ID_BYTES).toString('base64url')}`;
}

export interface MCPSession {
  sessionId: string;
  clientId: string;
  grantedScopes: Scope[];
  createdAt: string;
  expiresAt: string;
}

export interface SessionStore {
  create(clientId: string, scopes: Scope[], ttlSeconds?: number): MCPSession;
  get(sessionId: string): MCPSession | undefined;
  revoke(sessionId: string): boolean;
}

/**
 * In-memory session store.
 *
 * Expiry is enforced on read, and create() amortizes a sweep of entries already
 * past expiresAt. The sweep matters because read-time expiry alone never
 * reclaims a session that is created and then never fetched again, so the Map
 * would grow without bound for the lifetime of the process.
 *
 * The sweep runs once every SWEEP_INTERVAL creates rather than on each one.
 * Sweeping every create makes create() O(map size) and the store O(n^2) to
 * fill, which is measurable: 20k creates took minutes before this was
 * amortized. There is deliberately no timer -- an unref'd interval would still
 * be a lifecycle concern for embedders.
 */
export class InMemorySessionStore implements SessionStore {
  /** Creates between opportunistic sweeps of expired entries. */
  private static readonly SWEEP_INTERVAL = 256;

  private sessions = new Map<string, MCPSession>();
  private createsSinceSweep = 0;
  private readonly defaultTtlSeconds: number;

  constructor(defaultTtlSeconds = 3600) {
    this.defaultTtlSeconds = defaultTtlSeconds;
  }

  create(clientId: string, scopes: Scope[], ttlSeconds?: number): MCPSession {
    const ttl = ttlSeconds ?? this.defaultTtlSeconds;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    if (++this.createsSinceSweep >= InMemorySessionStore.SWEEP_INTERVAL) {
      this.pruneExpired(now);
      this.createsSinceSweep = 0;
    }

    const session: MCPSession = {
      sessionId: generateSessionId(),
      clientId,
      grantedScopes: scopes,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): MCPSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    // Check expiry
    if (new Date(session.expiresAt) < new Date()) {
      this.sessions.delete(sessionId);
      return undefined;
    }

    return session;
  }

  revoke(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Drops every session already past its expiry as of `now`. */
  private pruneExpired(now: Date): void {
    for (const [id, session] of this.sessions) {
      if (new Date(session.expiresAt) < now) {
        this.sessions.delete(id);
      }
    }
  }
}
