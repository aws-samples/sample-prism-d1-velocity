# PRISM D1 Sample App — Task Management API

A simple REST API for the PRISM D1 Velocity workshop. Participants use Claude Code to extend this API by implementing features from specs.

## Quick Start

```bash
npm install
npm run dev     # Start dev server on http://localhost:3000
npm test        # Run test suite
```

## Endpoints

| Method | Path         | Description      |
|--------|--------------|------------------|
| GET    | /health      | Health check     |
| GET    | /tasks       | List all tasks   |
| POST   | /tasks       | Create a task    |
| GET    | /tasks/:id   | Get task by ID   |
| PUT    | /tasks/:id   | Update a task    |
| DELETE | /tasks/:id   | Delete a task    |

## Workshop Exercises

The `specs/` directory contains feature specs in Kiro-compatible format:

- **specs/task-api.md** — Already implemented (reference example)
- **specs/task-search.md** — Exercise 2: Add search and filtering
- **specs/task-priority.md** — Exercise 3: Add priority levels

Use Claude Code to implement each spec:

```
> Read specs/task-search.md and implement all requirements. Write tests first.
```

## Project Structure

```
src/
  index.ts            — Express app entry point
  types.ts            — TypeScript interfaces
  routes/
    health.ts         — Health check route
    tasks.ts          — Task CRUD routes
tests/
  tasks.test.ts       — Jest test suite
specs/
  task-api.md         — Implemented spec (reference)
  task-search.md      — Unimplemented (workshop exercise)
  task-priority.md    — Unimplemented (workshop exercise)
```
