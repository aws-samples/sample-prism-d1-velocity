import request from 'supertest';
import app from '../src/index';
import { taskStore } from '../src/routes/tasks';
import { Task } from '../src/types';

beforeEach(() => {
  taskStore.clear();
});

// ---------------------------------------------------------------------------
// Create task
// ---------------------------------------------------------------------------
describe('POST /tasks', () => {
  it('creates a task with required fields', async () => {
    const res = await request(app)
      .post('/tasks')
      .send({ title: 'Write tests' });

    expect(res.status).toBe(201);
    expect(res.body.data.title).toBe('Write tests');
    expect(res.body.data.status).toBe('todo');
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.createdAt).toBeDefined();
  });

  it('creates a task with all fields', async () => {
    const res = await request(app)
      .post('/tasks')
      .send({
        title: 'Deploy app',
        description: 'Push to production',
        status: 'in-progress',
        tags: ['ops', 'urgent'],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.description).toBe('Push to production');
    expect(res.body.data.status).toBe('in-progress');
    expect(res.body.data.tags).toEqual(['ops', 'urgent']);
  });

  it('rejects missing title', async () => {
    const res = await request(app).post('/tasks').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
  });

  it('rejects empty title', async () => {
    const res = await request(app).post('/tasks').send({ title: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects invalid status', async () => {
    const res = await request(app)
      .post('/tasks')
      .send({ title: 'Bad status', status: 'invalid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/i);
  });
});

// ---------------------------------------------------------------------------
// List tasks
// ---------------------------------------------------------------------------
describe('GET /tasks', () => {
  it('returns empty list initially', async () => {
    const res = await request(app).get('/tasks');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it('returns all tasks', async () => {
    await request(app).post('/tasks').send({ title: 'Task 1' });
    await request(app).post('/tasks').send({ title: 'Task 2' });

    const res = await request(app).get('/tasks');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Get single task
// ---------------------------------------------------------------------------
describe('GET /tasks/:id', () => {
  it('returns a task by ID', async () => {
    const created = await request(app)
      .post('/tasks')
      .send({ title: 'Find me' });
    const id = created.body.data.id;

    const res = await request(app).get(`/tasks/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Find me');
  });

  it('returns 404 for unknown ID', async () => {
    const res = await request(app).get('/tasks/nonexistent');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Update task
// ---------------------------------------------------------------------------
describe('PUT /tasks/:id', () => {
  let taskId: string;

  beforeEach(async () => {
    const created = await request(app)
      .post('/tasks')
      .send({ title: 'Original', description: 'First version', status: 'todo' });
    taskId = created.body.data.id;
  });

  it('updates title', async () => {
    const res = await request(app)
      .put(`/tasks/${taskId}`)
      .send({ title: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Updated');
    expect(res.body.data.description).toBe('First version');
  });

  it('updates status', async () => {
    const res = await request(app)
      .put(`/tasks/${taskId}`)
      .send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('done');
  });

  it('sets updatedAt on change', async () => {
    const before = taskStore.get(taskId)!.updatedAt;
    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    const res = await request(app)
      .put(`/tasks/${taskId}`)
      .send({ title: 'Changed' });

    expect(res.body.data.updatedAt).not.toBe(before);
  });

  it('returns 404 for unknown ID', async () => {
    const res = await request(app)
      .put('/tasks/nonexistent')
      .send({ title: 'Nope' });
    expect(res.status).toBe(404);
  });

  it('rejects invalid status', async () => {
    const res = await request(app)
      .put(`/tasks/${taskId}`)
      .send({ status: 'invalid' });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Delete task
// ---------------------------------------------------------------------------
describe('DELETE /tasks/:id', () => {
  it('deletes an existing task', async () => {
    const created = await request(app)
      .post('/tasks')
      .send({ title: 'Delete me' });
    const id = created.body.data.id;

    const res = await request(app).delete(`/tasks/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(id);

    // Verify it's gone
    const get = await request(app).get(`/tasks/${id}`);
    expect(get.status).toBe(404);
  });

  it('returns 404 for unknown ID', async () => {
    const res = await request(app).delete('/tasks/nonexistent');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 404 for unknown routes
// ---------------------------------------------------------------------------
describe('Unknown routes', () => {
  it('returns 404', async () => {
    const res = await request(app).get('/nonexistent');
    expect(res.status).toBe(404);
  });
});
