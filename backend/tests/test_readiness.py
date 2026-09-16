# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pins GET /api/ready: a DB-backed readiness probe distinct from /api/health.

/api/health is pure liveness (no DB access) so Cloud Run/compose can always
reach it even mid-migration. /api/ready additionally proves the DB answers,
for orchestrators (docker compose `condition: service_healthy`) that must not
route traffic to a backend whose `alembic upgrade head` hasn't finished. A DB
failure must surface as 503 (retry-worthy), never 500 -- the endpoint itself
must catch what the dependency raises, and the get_db teardown must not turn
that catch back into an unhandled exception.
"""

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.exc import OperationalError

from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.user import User


class _BrokenSession:
    """Stands in for an AsyncSession whose every query fails.

    Mirrors the shape get_db's generator yields (a context-free object with
    execute/commit/rollback/close) without needing a real broken engine --
    any DB access at all raises, which is all /api/ready's dependency touches.
    """

    async def execute(self, *args, **kwargs):
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))

    async def commit(self):
        pass

    async def rollback(self):
        pass

    async def close(self):
        pass


@pytest.fixture
async def broken_db_client(db_session, test_user: User) -> AsyncClient:
    app = create_app()

    async def override_get_db():
        yield _BrokenSession()

    async def override_get_current_user():
        return test_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.mark.asyncio
async def test_ready_success(client: AsyncClient):
    response = await client.get("/api/ready")
    assert response.status_code == 200
    assert response.json()["status"] == "ready"


@pytest.mark.asyncio
async def test_ready_db_failure_returns_503(broken_db_client: AsyncClient):
    # Must not raise through the get_db teardown -- httpx re-raises any
    # exception the ASGI app lets escape, which would surface here as a
    # transport error rather than a clean response.
    response = await broken_db_client.get("/api/ready")
    assert response.status_code == 503
    assert response.json()["status"] != "ready"


@pytest.mark.asyncio
async def test_health_stays_db_free(broken_db_client: AsyncClient):
    # Same broken-DB override active: liveness must never grow a DB
    # dependency, so this stays 200 even when /api/ready 503s.
    response = await broken_db_client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
