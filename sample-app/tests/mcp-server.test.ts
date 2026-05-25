import { taskStore } from '../src/routes/tasks';
import { handleToolCall } from '../src/mcp/tools';
import { handleResourceRead } from '../src/mcp/resources';

/** Helper to parse tool result text */
function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  taskStore.clear();
});

// ---------------------------------------------------------------------------
// create_task
// ---------------------------------------------------------------------------
describe('create_task', () => {
  it('creates a task with required fields', async () => {
    const result = await handleToolCall('create_task', { title: 'Write tests' });
    const body = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(body.data.title).toBe('Write tests');
    expect(body.data.status).toBe('todo');
    expect(body.data.id).toBeDefined();
    expect(body.data.createdAt).toBeDefined();
  });

  it('creates a task with all fields', async () => {
    const result = await handleToolCall('create_task', {
      title: 'Deploy app',
      description: 'Push to production',
      status: 'in-progress',
      tags: ['ops', 'urgent'],
    });
    const body = parseResult(result);

    expect(body.data.description).toBe('Push to production');
    expect(body.data.status).toBe('in-progress');
    expect(body.data.tags).toEqual(['ops', 'urgent']);
  });

  it('rejects missing title', async () => {
    const result = await handleToolCall('create_task', {});
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toMatch(/title/i);
  });

  it('rejects empty title', async () => {
    const result = await handleToolCall('create_task', { title: '   ' });
    expect(result.isError).toBe(true);
  });

  it('rejects invalid status', async () => {
    const result = await handleToolCall('create_task', {
      title: 'Bad status',
      status: 'invalid',
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toMatch(/status/i);
  });
});

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------
describe('list_tasks', () => {
  it('returns empty list initially', async () => {
    const result = await handleToolCall('list_tasks', {});
    const body = parseResult(result);
    expect(body.data).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('returns all tasks', async () => {
    await handleToolCall('create_task', { title: 'Task 1' });
    await handleToolCall('create_task', { title: 'Task 2' });

    const result = await handleToolCall('list_tasks', {});
    const body = parseResult(result);
    expect(body.count).toBe(2);
  });

  it('filters by status', async () => {
    await handleToolCall('create_task', { title: 'Todo task', status: 'todo' });
    await handleToolCall('create_task', { title: 'Done task', status: 'done' });

    const result = await handleToolCall('list_tasks', { status: 'done' });
    const body = parseResult(result);
    expect(body.count).toBe(1);
    expect(body.data[0].title).toBe('Done task');
  });

  it('rejects invalid status filter', async () => {
    const result = await handleToolCall('list_tasks', { status: 'invalid' });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// update_task
// ---------------------------------------------------------------------------
describe('update_task', () => {
  let taskId: string;

  beforeEach(async () => {
    const result = await handleToolCall('create_task', {
      title: 'Original',
      description: 'First version',
      status: 'todo',
    });
    taskId = parseResult(result).data.id;
  });

  it('updates title', async () => {
    const result = await handleToolCall('update_task', { id: taskId, title: 'Updated' });
    const body = parseResult(result);
    expect(body.data.title).toBe('Updated');
    expect(body.data.description).toBe('First version');
  });

  it('updates status', async () => {
    const result = await handleToolCall('update_task', { id: taskId, status: 'done' });
    const body = parseResult(result);
    expect(body.data.status).toBe('done');
  });

  it('updates tags', async () => {
    const result = await handleToolCall('update_task', { id: taskId, tags: ['new-tag'] });
    const body = parseResult(result);
    expect(body.data.tags).toEqual(['new-tag']);
  });

  it('returns error for unknown ID', async () => {
    const result = await handleToolCall('update_task', { id: 'nonexistent', title: 'Nope' });
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toMatch(/not found/i);
  });

  it('rejects invalid status', async () => {
    const result = await handleToolCall('update_task', { id: taskId, status: 'invalid' });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// delete_task
// ---------------------------------------------------------------------------
describe('delete_task', () => {
  it('deletes an existing task', async () => {
    const created = await handleToolCall('create_task', { title: 'Delete me' });
    const id = parseResult(created).data.id;

    const result = await handleToolCall('delete_task', { id });
    const body = parseResult(result);
    expect(body.data.deleted).toBe(id);

    // Verify it is gone
    const list = await handleToolCall('list_tasks', {});
    expect(parseResult(list).count).toBe(0);
  });

  it('returns error for unknown ID', async () => {
    const result = await handleToolCall('delete_task', { id: 'nonexistent' });
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Unknown tool
// ---------------------------------------------------------------------------
describe('unknown tool', () => {
  it('returns error for unrecognized tool name', async () => {
    const result = await handleToolCall('does_not_exist', {});
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toMatch(/unknown tool/i);
  });
});

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------
describe('resources', () => {
  it('reads task://list with no tasks', async () => {
    const result = await handleResourceRead('task://list');
    const body = JSON.parse(result.contents[0].text);
    expect(body.data).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('reads task://list with tasks', async () => {
    await handleToolCall('create_task', { title: 'Resource task' });
    const result = await handleResourceRead('task://list');
    const body = JSON.parse(result.contents[0].text);
    expect(body.count).toBe(1);
  });

  it('reads task://{id} for existing task', async () => {
    const created = await handleToolCall('create_task', { title: 'Find me' });
    const id = parseResult(created).data.id;

    const result = await handleResourceRead(`task://${id}`);
    const body = JSON.parse(result.contents[0].text);
    expect(body.data.title).toBe('Find me');
    expect(result.contents[0].mimeType).toBe('application/json');
  });

  it('throws for unknown task ID', async () => {
    await expect(handleResourceRead('task://nonexistent')).rejects.toThrow(/not found/i);
  });

  it('throws for unknown resource URI scheme', async () => {
    await expect(handleResourceRead('unknown://foo')).rejects.toThrow(/unknown resource/i);
  });
});
