# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.user import User
from app.models.workspace import Workspace


UPLOAD_URL = "/api/workspaces/default/media/upload-url"
PAYLOAD = {"filename": "screenshot.png", "content_type": "image/png"}


@pytest.mark.anyio
async def test_media_upload_url_local_storage(
    client: AsyncClient,
    test_workspace: Workspace,
):
    resp = await client.post(UPLOAD_URL, json=PAYLOAD)
    assert resp.status_code == 200
    data = resp.json()

    assert data["upload_url"].startswith("/api/local-storage/upload/media/")
    assert data["public_url"].startswith("/api/local-storage/download/media/")

    # Path contains workspace id and filename
    assert str(test_workspace.id) in data["upload_url"]
    assert "screenshot.png" in data["upload_url"]
    assert str(test_workspace.id) in data["public_url"]
    assert "screenshot.png" in data["public_url"]

    # upload and public share the same gcs_path suffix
    upload_path = data["upload_url"].removeprefix("/api/local-storage/upload/")
    public_path = data["public_url"].removeprefix("/api/local-storage/download/")
    assert upload_path == public_path


@pytest_asyncio.fixture
async def non_member_client(db_session: AsyncSession) -> AsyncClient:
    non_member = User(email="outsider@example.com", name="Outsider")
    db_session.add(non_member)
    await db_session.flush()

    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return non_member

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.mark.anyio
async def test_media_upload_url_requires_workspace_membership(
    non_member_client: AsyncClient,
    test_workspace: Workspace,
):
    resp = await non_member_client.post(UPLOAD_URL, json=PAYLOAD)
    assert resp.status_code == 403
