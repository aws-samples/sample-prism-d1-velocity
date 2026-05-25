"""Tests for the task assistant tools (mocked HTTP, no AWS needed)."""

import json

from src.task_assistant.tools import (
    list_tasks,
    create_task,
    update_task,
    delete_task,
    search_tasks,
)

# Strands @tool wraps functions as DecoratedFunctionTool — use _tool_func for direct calls
_list = list_tasks._tool_func
_create = create_task._tool_func
_update = update_task._tool_func
_delete = delete_task._tool_func
_search = search_tasks._tool_func


def test_create_task(mock_task_api):
    result = json.loads(_create(title="Fix login bug", tags="critical,backend"))
    assert "data" in result
    assert result["data"]["title"] == "Fix login bug"
    assert result["data"]["tags"] == ["critical", "backend"]
    assert result["data"]["status"] == "todo"


def test_list_tasks(mock_task_api):
    _create(title="Task 1")
    _create(title="Task 2")
    result = json.loads(_list())
    assert result["count"] == 2


def test_list_tasks_with_status_filter(mock_task_api):
    _create(title="Todo task", status="todo")
    _create(title="Done task", status="done")
    result = json.loads(_list(status="done"))
    assert result["count"] == 1
    assert result["data"][0]["title"] == "Done task"


def test_update_task(mock_task_api):
    created = json.loads(_create(title="Original"))
    task_id = created["data"]["id"]
    result = json.loads(_update(id=task_id, title="Updated", status="in-progress"))
    assert result["data"]["title"] == "Updated"
    assert result["data"]["status"] == "in-progress"


def test_update_task_not_found(mock_task_api):
    result = json.loads(_update(id="nonexistent", title="Nope"))
    assert "error" in result


def test_delete_task(mock_task_api):
    created = json.loads(_create(title="To delete"))
    task_id = created["data"]["id"]
    result = json.loads(_delete(id=task_id))
    assert result["data"]["deleted"] == task_id

    remaining = json.loads(_list())
    assert remaining["count"] == 0


def test_delete_task_not_found(mock_task_api):
    result = json.loads(_delete(id="nonexistent"))
    assert "error" in result


def test_search_tasks(mock_task_api):
    _create(title="Fix authentication bug", tags="auth,critical")
    _create(title="Write documentation")
    _create(title="Auth module tests", tags="auth,testing")

    result = json.loads(_search(query="auth"))
    assert result["count"] == 2
    titles = [t["title"] for t in result["data"]]
    assert "Fix authentication bug" in titles
    assert "Auth module tests" in titles


def test_search_tasks_no_results(mock_task_api):
    _create(title="Something else")
    result = json.loads(_search(query="nonexistent"))
    assert result["count"] == 0


def test_create_task_defaults(mock_task_api):
    result = json.loads(_create(title="Minimal task"))
    assert result["data"]["status"] == "todo"
    assert result["data"]["description"] == ""
    assert result["data"]["tags"] == []
