import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { toolDefinitions, handleToolCall } from './tools';
import {
  staticResources,
  resourceTemplates,
  handleResourceRead,
} from './resources';
import { TOOL_REGISTRY, SCOPE_PROFILES, isValidScope, type Scope } from './auth/tool-registry';
import { MCPAuthorizer } from './auth/authorizer';
import { InMemorySessionStore } from './auth/session-store';
import { MCPAuditLogger, type MCPToolCallAudit } from './auth/audit-logger';

// ---------------------------------------------------------------------------
// Authorization setup
// ---------------------------------------------------------------------------
const sessionStore = new InMemorySessionStore(3600); // 1 hour TTL
const authorizer = new MCPAuthorizer(sessionStore);
const auditLogger = new MCPAuditLogger({
  teamId: process.env.PRISM_TEAM_ID ?? 'unknown',
  repo: process.env.PRISM_REPO ?? 'prism-d1-sample-app',
  eventBusName: process.env.PRISM_EVENT_BUS ?? 'prism-d1-metrics',
  awsRegion: process.env.AWS_REGION ?? 'us-west-2',
  enabled: process.env.PRISM_EMIT_METRICS !== 'false',
});

// Active sessions mapped by transport connection
const activeSessions = new Map<string, string>(); // connectionId -> sessionId

// ---------------------------------------------------------------------------
// Create MCP server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: 'prism-d1-task-api',
  version: '1.0.0',
});

// ---------------------------------------------------------------------------
// Session initialization — clients negotiate scopes on connect
// ---------------------------------------------------------------------------
server.server.setRequestHandler(
  { method: 'prism/session/create' } as any,
  async (request: any) => {
    const { client_id, requested_scopes, profile } = request.params ?? {};

    if (!client_id) {
      return { error: 'client_id is required' };
    }

    // Resolve scopes: use profile if provided, otherwise validate individual scopes
    let scopes: Scope[];
    if (profile && SCOPE_PROFILES[profile]) {
      scopes = SCOPE_PROFILES[profile];
    } else if (requested_scopes && Array.isArray(requested_scopes)) {
      scopes = requested_scopes.filter(isValidScope);
      if (scopes.length === 0) {
        return { error: 'No valid scopes requested' };
      }
    } else {
      // Default to read-only
      scopes = SCOPE_PROFILES['read-only'];
    }

    const session = sessionStore.create(client_id, scopes);
    return {
      session_id: session.sessionId,
      granted_scopes: session.grantedScopes,
      expires_at: session.expiresAt,
    };
  },
);

// ---------------------------------------------------------------------------
// Register tools
// ---------------------------------------------------------------------------
server.server.setRequestHandler(
  { method: 'tools/list' } as any,
  async () => ({
    tools: toolDefinitions,
  }),
);

server.server.setRequestHandler(
  { method: 'tools/call' } as any,
  async (request: any) => {
    const { name, arguments: args } = request.params;
    const startTime = Date.now();

    // Extract session ID from request metadata
    const sessionId = request.params?._meta?.sessionId
      ?? request.params?.session_id
      ?? process.env.MCP_SESSION_ID;

    // If no session, run in open mode (backwards compatible) but log it
    if (!sessionId) {
      const result = await handleToolCall(name, args ?? {});

      // Audit unauthed calls on tools that require audit
      const toolScope = TOOL_REGISTRY[name];
      if (toolScope?.auditRequired) {
        const audit: MCPToolCallAudit = {
          session_id: 'none',
          client_id: 'anonymous',
          tool_name: name,
          scopes_used: [],
          authorized: true, // open mode
          risk_level: toolScope.riskLevel,
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
          result_status: result.isError ? 'error' : 'success',
        };
        auditLogger.log(audit).catch(() => {});
      }

      return result;
    }

    // Authorize the call
    const authResult = authorizer.authorize(sessionId, name);

    if (!authResult.authorized) {
      const audit: MCPToolCallAudit = {
        session_id: sessionId,
        client_id: 'unknown',
        tool_name: name,
        scopes_used: authResult.grantedScopes,
        authorized: false,
        risk_level: authResult.riskLevel,
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        result_status: 'denied',
      };
      auditLogger.log(audit).catch(() => {});

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'Unauthorized',
              reason: authResult.reason,
              required_scopes: authResult.requiredScopes,
              granted_scopes: authResult.grantedScopes,
            }),
          },
        ],
        isError: true,
      };
    }

    // Execute the tool
    const result = await handleToolCall(name, args ?? {});

    // Audit the call
    if (authResult.auditRequired) {
      const audit: MCPToolCallAudit = {
        session_id: sessionId,
        client_id: 'unknown',
        tool_name: name,
        scopes_used: authResult.grantedScopes,
        authorized: true,
        risk_level: authResult.riskLevel,
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        result_status: result.isError ? 'error' : 'success',
      };
      auditLogger.log(audit).catch(() => {});
    }

    return result;
  },
);

// ---------------------------------------------------------------------------
// Register resources
// ---------------------------------------------------------------------------
server.server.setRequestHandler(
  { method: 'resources/list' } as any,
  async () => ({
    resources: staticResources,
  }),
);

server.server.setRequestHandler(
  { method: 'resources/templates/list' } as any,
  async () => ({
    resourceTemplates,
  }),
);

server.server.setRequestHandler(
  { method: 'resources/read' } as any,
  async (request: any) => {
    const { uri } = request.params;
    return handleResourceRead(uri);
  },
);

// ---------------------------------------------------------------------------
// Start server over stdio
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('PRISM D1 Task API MCP server running on stdio (with auth)');
}

main().catch((err) => {
  console.error('Fatal error starting MCP server:', err);
  process.exit(1);
});
