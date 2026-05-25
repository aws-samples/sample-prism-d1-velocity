/**
 * MCP Tool Registry — maps each tool to required scopes, risk level, and audit requirements.
 *
 * Scopes follow the pattern: <resource>:<action>
 * Risk levels determine logging verbosity and approval requirements.
 */

export interface ToolScope {
  toolName: string;
  requiredScopes: string[];
  riskLevel: 'low' | 'medium' | 'high';
  auditRequired: boolean;
  description: string;
}

/**
 * Registry of all MCP tools with their authorization requirements.
 * Add new tools here when extending the MCP server.
 */
export const TOOL_REGISTRY: Record<string, ToolScope> = {
  list_tasks: {
    toolName: 'list_tasks',
    requiredScopes: ['tasks:read'],
    riskLevel: 'low',
    auditRequired: false,
    description: 'List all tasks, optionally filtered by status',
  },
  search_tasks: {
    toolName: 'search_tasks',
    requiredScopes: ['tasks:read'],
    riskLevel: 'low',
    auditRequired: false,
    description: 'Search tasks by keyword',
  },
  create_task: {
    toolName: 'create_task',
    requiredScopes: ['tasks:write'],
    riskLevel: 'medium',
    auditRequired: true,
    description: 'Create a new task',
  },
  update_task: {
    toolName: 'update_task',
    requiredScopes: ['tasks:write'],
    riskLevel: 'medium',
    auditRequired: true,
    description: 'Update an existing task',
  },
  delete_task: {
    toolName: 'delete_task',
    requiredScopes: ['tasks:delete'],
    riskLevel: 'high',
    auditRequired: true,
    description: 'Permanently delete a task',
  },
};

/**
 * All possible scopes in the system. Used for validation.
 */
export const ALL_SCOPES = ['tasks:read', 'tasks:write', 'tasks:delete'] as const;
export type Scope = (typeof ALL_SCOPES)[number];

/**
 * Predefined scope profiles for common use cases.
 */
export const SCOPE_PROFILES: Record<string, Scope[]> = {
  'read-only': ['tasks:read'],
  'read-write': ['tasks:read', 'tasks:write'],
  admin: ['tasks:read', 'tasks:write', 'tasks:delete'],
};

export function getToolScope(toolName: string): ToolScope | undefined {
  return TOOL_REGISTRY[toolName];
}

export function isValidScope(scope: string): scope is Scope {
  return (ALL_SCOPES as readonly string[]).includes(scope);
}
