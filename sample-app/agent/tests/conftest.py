"""Shared test fixtures for agent tests."""

import pytest


@pytest.fixture
def mock_task_api(monkeypatch):
    """Mock the task API HTTP calls with in-memory responses."""
    tasks = {}
    counter = {"id": 0}

    def mock_request(method, path, body=None):
        if method == "GET" and path == "/tasks":
            task_list = list(tasks.values())
            return {"data": task_list, "count": len(task_list)}

        if method == "POST" and path == "/tasks":
            counter["id"] += 1
            task_id = f"test-{counter['id']}"
            task = {
                "id": task_id,
                "title": body.get("title", ""),
                "description": body.get("description", ""),
                "status": body.get("status", "todo"),
                "tags": body.get("tags", []),
                "createdAt": "2026-04-14T00:00:00Z",
                "updatedAt": "2026-04-14T00:00:00Z",
            }
            tasks[task_id] = task
            return {"data": task}

        if method == "PUT" and path.startswith("/tasks/"):
            task_id = path.split("/")[-1]
            if task_id not in tasks:
                return {"error": f"Task not found: {task_id}"}
            task = tasks[task_id]
            if body:
                task.update({k: v for k, v in body.items() if v is not None})
                task["updatedAt"] = "2026-04-14T01:00:00Z"
            tasks[task_id] = task
            return {"data": task}

        if method == "DELETE" and path.startswith("/tasks/"):
            task_id = path.split("/")[-1]
            if task_id not in tasks:
                return {"error": f"Task not found: {task_id}"}
            del tasks[task_id]
            return {"data": {"deleted": task_id}}

        return {"error": "Unknown route"}

    import src.task_assistant.tools as tools_module
    monkeypatch.setattr(tools_module, "_request", mock_request)

    return tasks
