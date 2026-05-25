export type TaskStatus = 'todo' | 'in-progress' | 'done';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskRequest {
  title: string;
  description?: string;
  status?: TaskStatus;
  tags?: string[];
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  status?: TaskStatus;
  tags?: string[];
}

export interface TaskListResponse {
  data: Task[];
  count: number;
}

export interface TaskResponse {
  data: Task;
}

export interface ErrorResponse {
  error: string;
}
