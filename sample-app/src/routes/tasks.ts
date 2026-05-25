import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  Task,
  CreateTaskRequest,
  UpdateTaskRequest,
  TaskStatus,
} from '../types';

const router = Router();

/** In-memory task store — keyed by task ID */
export const taskStore = new Map<string, Task>();

const VALID_STATUSES: TaskStatus[] = ['todo', 'in-progress', 'done'];

function isValidStatus(status: unknown): status is TaskStatus {
  return typeof status === 'string' && VALID_STATUSES.includes(status as TaskStatus);
}

// ---------------------------------------------------------------------------
// GET /tasks — list all tasks
// ---------------------------------------------------------------------------
router.get('/tasks', (_req: Request, res: Response) => {
  const tasks = Array.from(taskStore.values());
  res.json({ data: tasks, count: tasks.length });
});

// ---------------------------------------------------------------------------
// POST /tasks — create a new task
// ---------------------------------------------------------------------------
router.post('/tasks', (req: Request, res: Response) => {
  const body = req.body as CreateTaskRequest;

  if (!body.title || typeof body.title !== 'string' || body.title.trim() === '') {
    res.status(400).json({ error: 'title is required and must be a non-empty string' });
    return;
  }

  if (body.status !== undefined && !isValidStatus(body.status)) {
    res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    return;
  }

  if (body.tags !== undefined && !Array.isArray(body.tags)) {
    res.status(400).json({ error: 'tags must be an array of strings' });
    return;
  }

  const now = new Date().toISOString();
  const task: Task = {
    id: uuidv4(),
    title: body.title.trim(),
    description: body.description?.trim() ?? '',
    status: body.status ?? 'todo',
    tags: body.tags ?? [],
    createdAt: now,
    updatedAt: now,
  };

  taskStore.set(task.id, task);
  res.status(201).json({ data: task });
});

// ---------------------------------------------------------------------------
// GET /tasks/:id — get a single task
// ---------------------------------------------------------------------------
router.get('/tasks/:id', (req: Request, res: Response) => {
  const task = taskStore.get(req.params.id);

  if (!task) {
    res.status(404).json({ error: `Task not found: ${req.params.id}` });
    return;
  }

  res.json({ data: task });
});

// ---------------------------------------------------------------------------
// PUT /tasks/:id — update an existing task
// ---------------------------------------------------------------------------
router.put('/tasks/:id', (req: Request, res: Response) => {
  const task = taskStore.get(req.params.id);

  if (!task) {
    res.status(404).json({ error: `Task not found: ${req.params.id}` });
    return;
  }

  const body = req.body as UpdateTaskRequest;

  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim() === '')) {
    res.status(400).json({ error: 'title must be a non-empty string' });
    return;
  }

  if (body.status !== undefined && !isValidStatus(body.status)) {
    res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    return;
  }

  if (body.tags !== undefined && !Array.isArray(body.tags)) {
    res.status(400).json({ error: 'tags must be an array of strings' });
    return;
  }

  const updated: Task = {
    ...task,
    title: body.title?.trim() ?? task.title,
    description: body.description?.trim() ?? task.description,
    status: body.status ?? task.status,
    tags: body.tags ?? task.tags,
    updatedAt: new Date().toISOString(),
  };

  taskStore.set(updated.id, updated);
  res.json({ data: updated });
});

// ---------------------------------------------------------------------------
// DELETE /tasks/:id — delete a task
// ---------------------------------------------------------------------------
router.delete('/tasks/:id', (req: Request, res: Response) => {
  const existed = taskStore.delete(req.params.id);

  if (!existed) {
    res.status(404).json({ error: `Task not found: ${req.params.id}` });
    return;
  }

  res.status(200).json({ data: { deleted: req.params.id } });
});

export default router;
