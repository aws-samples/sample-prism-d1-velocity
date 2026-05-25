import { taskStore } from '../routes/tasks';

// ---------------------------------------------------------------------------
// Resource definitions for MCP registration
// ---------------------------------------------------------------------------

/** Static resource: list all tasks */
export const staticResources = [
  {
    uri: 'task://list',
    name: 'All Tasks',
    description: 'Returns every task currently in the task store',
    mimeType: 'application/json',
  },
];

/** Resource template: single task by ID */
export const resourceTemplates = [
  {
    uriTemplate: 'task://{id}',
    name: 'Task by ID',
    description: 'Returns a single task by its unique ID',
    mimeType: 'application/json',
  },
];

// ---------------------------------------------------------------------------
// Resource read handler
// ---------------------------------------------------------------------------
export async function handleResourceRead(
  uri: string,
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  // Static: task://list
  if (uri === 'task://list') {
    const tasks = Array.from(taskStore.values());
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ data: tasks, count: tasks.length }, null, 2),
        },
      ],
    };
  }

  // Template: task://{id}
  const match = uri.match(/^task:\/\/(.+)$/);
  if (match) {
    const id = match[1];
    const task = taskStore.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ data: task }, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}
