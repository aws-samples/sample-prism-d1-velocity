/**
 * MCP Session Store — manages client sessions with TTL expiry.
 *
 * Uses an in-memory Map for the sample app. The SessionStore interface
 * allows swapping to a DynamoDB-backed implementation for production.
 */

import { Scope } from './tool-registry';

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
 * In-memory session store with automatic TTL cleanup.
 */
export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, MCPSession>();
  private readonly defaultTtlSeconds: number;

  constructor(defaultTtlSeconds = 3600) {
    this.defaultTtlSeconds = defaultTtlSeconds;
  }

  create(clientId: string, scopes: Scope[], ttlSeconds?: number): MCPSession {
    const ttl = ttlSeconds ?? this.defaultTtlSeconds;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    const session: MCPSession = {
      sessionId: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
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
}
