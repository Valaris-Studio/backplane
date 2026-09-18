# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute

from app import database
from app.core.auth import get_current_user
from app.main import app
from app.routers.workspaces import router
from app.services.workspace import WorkspaceService


@pytest.mark.parametrize("commit_fails", [False, True])
async def test_workspace_response_waits_for_transaction_completion(monkeypatch, commit_fails):
    events = []

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def commit(self):
            events.append("commit")
            if commit_fails:
                raise RuntimeError("commit failed")

        async def rollback(self):
            events.append("rollback")

    monkeypatch.setattr(database, "async_session", Session)
    user_id = uuid.uuid4()
    workspace = dict(id=uuid.uuid4(), name="Example", slug="example", created_by=user_id,
                     created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z")
    monkeypatch.setattr(WorkspaceService, "create_workspace", AsyncMock(return_value=workspace))
    application = FastAPI()
    application.include_router(router)
    application.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=user_id)

    async def receive():
        return {"type": "http.request", "body": json.dumps({"name": "Example", "slug": "example"}).encode()}

    async def send(message):
        if message["type"] == "http.response.start":
            events.append(message["status"])

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
             "method": "POST", "scheme": "http", "path": "/api/workspaces", "query_string": b"",
             "headers": [(b"content-type", b"application/json")], "server": ("test", 80)}
    if commit_fails:
        with pytest.raises(RuntimeError, match="commit failed"):
            await application(scope, receive, send)
        assert events == ["commit", "rollback", 500]
    else:
        await application(scope, receive, send)
        assert events == ["commit", 201]


def test_all_http_database_dependencies_finish_before_sending_responses():
    def check(dependency):
        if dependency.call is database.get_db:
            assert dependency.scope == "function", dependency.name
        for child in dependency.dependencies:
            check(child)

    for route in app.routes:
        if isinstance(route, APIRoute):
            check(route.dependant)
