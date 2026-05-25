"""Task API tools — @tool decorated functions for the Strands agent.

These tools wrap HTTP calls to the task API. When running with MCP,
the agent discovers tools via the MCP protocol instead of using these
directly. These serve as the fallback / direct-HTTP mode.
"""

import json
from typing import Any

import requests
from strands import tool

# Base URL for the task API — overridden by config in production
_API_BASE = "http://localhost:3000"


def set_api_base(url: str) -> None:
    """Set the task API base URL."""
    global _API_BASE
    _API_BASE = url.rstrip("/")


def _request(method: str, path: str, body: dict | None = None) -> dict:
    """Make an HTTP request to the task API."""
    url = f"{_API_BASE}{path}"
    resp = requests.request(method, url, json=body, timeout=10)
    data = resp.json()
    if resp.status_code >= 400:
        return {"error": data.get("error", f"HTTP {resp.status_code}")}
    return data


@tool
def list_tasks(status: str = "") -> str:
    """List all tasks, optionally filtered by status.

    Args:
        status: Filter by task status. One of: todo, in-progress, done. Leave empty for all.
    """
    path = "/tasks"
    result = _request("GET", path)
    tasks = result.get("data", [])
    if status:
        tasks = [t for t in tasks if t.get("status") == status]
    return json.dumps({"data": tasks, "count": len(tasks)}, indent=2)


@tool
def create_task(
    title: str,
    description: str = "",
    status: str = "todo",
    tags: str = "",
) -> str:
    """Create a new task.

    Args:
        title: The task title (required).
        description: A longer description of the task.
        status: Initial status — one of: todo, in-progress, done. Defaults to todo.
        tags: Comma-separated tags, e.g. "bug,critical,backend".
    """
    body: dict[str, Any] = {"title": title}
    if description:
        body["description"] = description
    if status:
        body["status"] = status
    if tags:
        body["tags"] = [t.strip() for t in tags.split(",") if t.strip()]
    return json.dumps(_request("POST", "/tasks", body), indent=2)


@tool
def update_task(
    id: str,
    title: str = "",
    description: str = "",
    status: str = "",
    tags: str = "",
) -> str:
    """Update an existing task by ID.

    Args:
        id: The task ID to update (required).
        title: New title (leave empty to keep current).
        description: New description (leave empty to keep current).
        status: New status — one of: todo, in-progress, done (leave empty to keep current).
        tags: New comma-separated tags (leave empty to keep current).
    """
    body: dict[str, Any] = {}
    if title:
        body["title"] = title
    if description:
        body["description"] = description
    if status:
        body["status"] = status
    if tags:
        body["tags"] = [t.strip() for t in tags.split(",") if t.strip()]
    if not body:
        return json.dumps({"error": "No fields to update"})
    return json.dumps(_request("PUT", f"/tasks/{id}", body), indent=2)


@tool
def delete_task(id: str) -> str:
    """Delete a task by ID.

    Args:
        id: The task ID to delete (required).
    """
    return json.dumps(_request("DELETE", f"/tasks/{id}"), indent=2)



