/**
 * MCP Authorizer — scope-based authorization for MCP tool calls.
 *
 * Validates that a session has the required scopes to invoke a tool.
 */

import { TOOL_REGISTRY, type ToolScope } from './tool-registry';
import type { MCPSession, SessionStore } from './session-store';

export interface AuthResult {
  authorized: boolean;
  toolName: string;
  requiredScopes: string[];
  grantedScopes: string[];
  missingScopes: string[];
  riskLevel: string;
  auditRequired: boolean;
  reason?: string;
}

export class MCPAuthorizer {
  constructor(private sessionStore: SessionStore) {}

  /**
   * Authorize a tool call against a session's granted scopes.
   */
  authorize(sessionId: string, toolName: string): AuthResult {
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      return {
        authorized: false,
        toolName,
        requiredScopes: [],
        grantedScopes: [],
        missingScopes: [],
        riskLevel: 'unknown',
        auditRequired: true,
        reason: 'Invalid or expired session',
      };
    }

    return this.authorizeWithSession(session, toolName);
  }

  /**
   * Authorize a tool call with an already-resolved session.
   */
  authorizeWithSession(session: MCPSession, toolName: string): AuthResult {
    const toolScope = TOOL_REGISTRY[toolName];
    if (!toolScope) {
      return {
        authorized: false,
        toolName,
        requiredScopes: [],
        grantedScopes: session.grantedScopes,
        missingScopes: [],
        riskLevel: 'high',
        auditRequired: true,
        reason: `Unknown tool: ${toolName}. Tool not registered in TOOL_REGISTRY.`,
      };
    }

    const missingScopes = toolScope.requiredScopes.filter(
      (scope) => !session.grantedScopes.includes(scope as any),
    );

    const authorized = missingScopes.length === 0;

    return {
      authorized,
      toolName,
      requiredScopes: toolScope.requiredScopes,
      grantedScopes: session.grantedScopes,
      missingScopes,
      riskLevel: toolScope.riskLevel,
      auditRequired: toolScope.auditRequired,
      reason: authorized ? undefined : `Missing scopes: ${missingScopes.join(', ')}`,
    };
  }
}
