# Spec: Task Management API

**Status**: Implemented
**Author**: Workshop team
**Spec-Ref**: specs/task-api.md

## Summary

A RESTful CRUD API for managing tasks. Tasks are stored in-memory and support a title, description, status, and tags. This is the baseline API that workshop participants extend in later exercises.

## Requirements

1. The API MUST support creating a task with at least a title.
2. The API MUST auto-assign a UUID `id`, `createdAt`, and `updatedAt` timestamp to new tasks.
3. The API MUST default `status` to `"todo"` when not provided.
4. The API MUST default `tags` to an empty array when not provided.
5. The API MUST support listing all tasks.
6. The API MUST support retrieving a single task by ID.
7. The API MUST support partial updates to a task (title, description, status, tags).
8. The API MUST update the `updatedAt` timestamp on every mutation.
9. The API MUST support deleting a task by ID.
10. The API MUST return 404 for operations on non-existent task IDs.
11. The API MUST validate that `status` is one of: `todo`, `in-progress`, `done`.
12. The API MUST reject requests with an empty or missing title on create.

## Acceptance Criteria

### AC-1: Create a task
- **Given** a POST request to `/tasks` with `{ "title": "Write tests" }`
- **When** the request is processed
- **Then** the response status is 201 and the body contains the task with an `id`, `status: "todo"`, and timestamps

### AC-2: List tasks
- **Given** two tasks exist in the store
- **When** a GET request is made to `/tasks`
- **Then** the response contains `data` with 2 tasks and `count: 2`

### AC-3: Get task by ID
- **Given** a task with ID `abc-123` exists
- **When** a GET request is made to `/tasks/abc-123`
- **Then** the response contains the task data

### AC-4: Update a task
- **Given** a task exists with `status: "todo"`
- **When** a PUT request is made with `{ "status": "done" }`
- **Then** the task's status is updated and `updatedAt` changes

### AC-5: Delete a task
- **Given** a task with ID `abc-123` exists
- **When** a DELETE request is made to `/tasks/abc-123`
- **Then** the task is removed and subsequent GET returns 404

### AC-6: Validation errors
- **Given** a POST request with no title
- **When** the request is processed
- **Then** the response status is 400 with an error message

## Design Constraints

- In-memory storage only (Map keyed by task ID)
- No authentication
- Express.js with TypeScript
- UUID v4 for task IDs

## API Contract

### POST /tasks
**Request:**
```json
{
  "title": "Write tests",
  "description": "Add unit tests for task routes",
  "status": "todo",
  "tags": ["testing"]
}
```
**Response (201):**
```json
{
  "data": {
    "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "title": "Write tests",
    "description": "Add unit tests for task routes",
    "status": "todo",
    "tags": ["testing"],
    "createdAt": "2026-04-13T10:00:00.000Z",
    "updatedAt": "2026-04-13T10:00:00.000Z"
  }
}
```

### GET /tasks
**Response (200):**
```json
{
  "data": [ ... ],
  "count": 2
}
```

### GET /tasks/:id
**Response (200):**
```json
{
  "data": { "id": "...", "title": "...", ... }
}
```

### PUT /tasks/:id
**Request:** (partial update)
```json
{ "status": "done" }
```
**Response (200):**
```json
{
  "data": { "id": "...", "status": "done", "updatedAt": "..." }
}
```

### DELETE /tasks/:id
**Response (200):**
```json
{
  "data": { "deleted": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }
}
```
