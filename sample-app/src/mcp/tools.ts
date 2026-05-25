import { v4 as uuidv4 } from 'uuid';
import { taskStore } from '../routes/tasks';
import { Task, TaskStatus } from '../types';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------
const VALID_STATUSES: TaskStatus[] = ['todo', 'in-progress', 'done'];

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema for MCP tool registration)
// ---------------------------------------------------------------------------
export const toolDefinitions = [
  {
    name: 'list_tasks',
    description:
      'List all tasks. Optionally filter by status (todo, in-progress, done).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['todo', 'in-progress', 'done'],
          description: 'Filter tasks by status',
        },
      },
    },
  },
  {
    name: 'create_task',
    description:
      'Create a new task. Title is required. Description, status, and tags are optional.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Task title (required)' },
        description: { type: 'string', description: 'Task description' },
        status: {
          type: 'string',
          enum: ['todo', 'in-progress', 'done'],
          description: 'Task status (defaults to todo)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for the task',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description:
      'Update an existing task by ID. Any combination of title, description, status, and tags can be provided.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Task ID (required)' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        status: {
          type: 'string',
          enum: ['todo', 'in-progress', 'done'],
          description: 'New status',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'New tags',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_task',
    description: 'Delete a task by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Task ID to delete (required)' },
      },
      required: ['id'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handler dispatch
// ---------------------------------------------------------------------------
export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  switch (name) {
    case 'list_tasks':
      return listTasks(args);
    case 'create_task':
      return createTask(args);
    case 'update_task':
      return updateTask(args);
    case 'delete_task':
      return deleteTask(args);
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function listTasks(args: Record<string, unknown>) {
  let tasks = Array.from(taskStore.values());

  if (args.status) {
    const status = args.status as string;
    if (!VALID_STATUSES.includes(status as TaskStatus)) {
      return errorResult(`Invalid status filter. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }
    tasks = tasks.filter((t) => t.status === status);
  }

  return jsonResult({ data: tasks, count: tasks.length });
}

function createTask(args: Record<string, unknown>) {
  const title = args.title as string | undefined;

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return errorResult('title is required and must be a non-empty string');
  }

  if (args.status !== undefined && !VALID_STATUSES.includes(args.status as TaskStatus)) {
    return errorResult(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  if (args.tags !== undefined && !Array.isArray(args.tags)) {
    return errorResult('tags must be an array of strings');
  }

  const now = new Date().toISOString();
  const task: Task = {
    id: uuidv4(),
    title: title.trim(),
    description: typeof args.description === 'string' ? args.description.trim() : '',
    status: (args.status as TaskStatus) ?? 'todo',
    tags: (args.tags as string[]) ?? [],
    createdAt: now,
    updatedAt: now,
  };

  taskStore.set(task.id, task);
  return jsonResult({ data: task });
}

function updateTask(args: Record<string, unknown>) {
  const id = args.id as string;
  if (!id) {
    return errorResult('id is required');
  }

  const task = taskStore.get(id);
  if (!task) {
    return errorResult(`Task not found: ${id}`);
  }

  if (args.title !== undefined && (typeof args.title !== 'string' || (args.title as string).trim() === '')) {
    return errorResult('title must be a non-empty string');
  }

  if (args.status !== undefined && !VALID_STATUSES.includes(args.status as TaskStatus)) {
    return errorResult(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  if (args.tags !== undefined && !Array.isArray(args.tags)) {
    return errorResult('tags must be an array of strings');
  }

  const updated: Task = {
    ...task,
    title: args.title !== undefined ? (args.title as string).trim() : task.title,
    description: args.description !== undefined ? (args.description as string).trim() : task.description,
    status: args.status !== undefined ? (args.status as TaskStatus) : task.status,
    tags: args.tags !== undefined ? (args.tags as string[]) : task.tags,
    updatedAt: new Date().toISOString(),
  };

  taskStore.set(updated.id, updated);
  return jsonResult({ data: updated });
}

function deleteTask(args: Record<string, unknown>) {
  const id = args.id as string;
  if (!id) {
    return errorResult('id is required');
  }

  const existed = taskStore.delete(id);
  if (!existed) {
    return errorResult(`Task not found: ${id}`);
  }

  return jsonResult({ data: { deleted: id } });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
