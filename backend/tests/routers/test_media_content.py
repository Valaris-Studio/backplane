# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Durable, authenticated media URLs (WP2 §1).

`GET /api/workspaces/{slug}/media/{object_id}/{filename}` is what notes store
instead of a signed URL that dies after an hour. Authorization is the normal
workspace dependency; in GCS mode the answer is a 302 to a fresh short-lived
signed URL, locally the bytes are streamed with the hardened headers.
"""

import uuid
from pathlib import Path
from urllib.parse import urlsplit

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.auth import current_agent_id, get_current_user
from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.services.media.signed_url_cache import signed_url_cache
from tests.routers.media_fakes import FAKE_BUCKET, install_fake_gcs


@pytest.fixture(autouse=True)
def _fresh_signed_url_cache():
    signed_url_cache.clear()
    yield
    signed_url_cache.clear()


def _client_for(db_session: AsyncSession, user: User, agent: Agent | None = None):
    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        if agent is not None:
            current_agent_id.set(agent.id)
        return user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest_asyncio.fixture
async def outsider_client(db_session: AsyncSession):
    outsider = User(email="outsider@example.com", name="Outsider")
    db_session.add(outsider)
    await db_session.flush()
    async with _client_for(db_session, outsider) as ac:
        yield ac


async def _agent_client(db_session, test_user, allowed: list[str]):
    agent = Agent(
        name=f"media-agent-{uuid.uuid4().hex[:6]}",
        agent_type=AgentType.coding,
        description="media scope pin",
        created_by_id=test_user.id,
        is_active=True,
        allowed_workspaces=allowed,
    )
    db_session.add(agent)
    await db_session.flush()
    return _client_for(db_session, test_user, agent)


@pytest_asyncio.fixture
async def scoped_out_agent_client(db_session: AsyncSession, test_user: User):
    async with await _agent_client(db_session, test_user, ["elsewhere"]) as ac:
        yield ac


@pytest_asyncio.fixture
async def scoped_in_agent_client(db_session: AsyncSession, test_user: User):
    async with await _agent_client(db_session, test_user, ["default"]) as ac:
        yield ac


def media_url(object_id, filename: str, slug: str = "default") -> str:
    return f"/api/workspaces/{slug}/media/{object_id}/{filename}"


@pytest.fixture
def stored_image(monkeypatch, test_workspace: Workspace):
    fake = install_fake_gcs(monkeypatch)
    object_id = uuid.uuid4()
    key = f"media/{test_workspace.id}/{object_id}/shot one.png"
    fake.add(key)
    return fake, object_id, key


# --- GCS mode: 302 to a fresh signed URL -----------------------------------


async def test_media_member_gets_redirect_to_own_workspace_key(
    client: AsyncClient, test_workspace: Workspace, stored_image
):
    fake, object_id, key = stored_image

    resp = await client.get(media_url(object_id, "shot%20one.png"))

    assert resp.status_code == 302
    location = urlsplit(resp.headers["location"])
    assert location.scheme == "https"
    assert location.hostname == "storage.googleapis.com"
    assert location.path.startswith(f"/{FAKE_BUCKET}/media/{test_workspace.id}/")
    assert resp.headers["cache-control"] == "private, max-age=300"
    signed_key, ttl, disposition = fake.sign_calls[0]
    assert signed_key == key
    assert ttl.total_seconds() == 15 * 60
    assert disposition is None  # raster image renders inline


async def test_media_non_image_is_signed_as_attachment(
    client: AsyncClient, test_workspace: Workspace, monkeypatch
):
    fake = install_fake_gcs(monkeypatch)
    object_id = uuid.uuid4()
    fake.add(f"media/{test_workspace.id}/{object_id}/report.pdf", "application/pdf")

    resp = await client.get(media_url(object_id, "report.pdf"))

    assert resp.status_code == 302
    assert fake.sign_calls[0][2] == "attachment; filename*=UTF-8''report.pdf"


async def test_media_reuses_signed_url_from_cache(client: AsyncClient, stored_image):
    fake, object_id, _ = stored_image

    first = await client.get(media_url(object_id, "shot%20one.png"))
    second = await client.get(media_url(object_id, "shot%20one.png"))

    assert first.headers["location"] == second.headers["location"]
    assert len(fake.sign_calls) == 1
    assert len(fake.stat_calls) == 1


async def test_media_non_member_forbidden(outsider_client: AsyncClient, stored_image):
    _, object_id, _ = stored_image

    resp = await outsider_client.get(media_url(object_id, "shot%20one.png"))

    assert resp.status_code == 403


async def test_media_unknown_workspace_not_found(client: AsyncClient, stored_image):
    _, object_id, _ = stored_image

    resp = await client.get(media_url(object_id, "shot%20one.png", slug="nope"))

    assert resp.status_code == 404


async def test_media_revoked_member_forbidden_on_next_request(
    db_session: AsyncSession, second_user: User, test_workspace: Workspace, stored_image
):
    _, object_id, _ = stored_image
    db_session.add(
        WorkspaceMember(workspace_id=test_workspace.id, user_id=second_user.id, role=WorkspaceRole.member)
    )
    await db_session.flush()

    async with _client_for(db_session, second_user) as member:
        assert (await member.get(media_url(object_id, "shot%20one.png"))).status_code == 302
        await db_session.execute(
            delete(WorkspaceMember).where(WorkspaceMember.user_id == second_user.id)
        )
        await db_session.flush()
        assert (await member.get(media_url(object_id, "shot%20one.png"))).status_code == 403


async def test_media_agent_key_respects_allowlist(
    scoped_out_agent_client: AsyncClient, scoped_in_agent_client: AsyncClient, stored_image
):
    _, object_id, _ = stored_image

    denied = await scoped_out_agent_client.get(media_url(object_id, "shot%20one.png"))
    allowed = await scoped_in_agent_client.get(media_url(object_id, "shot%20one.png"))

    assert denied.status_code == 403
    assert allowed.status_code == 302


async def test_media_auth_runs_before_signed_url_cache(
    client: AsyncClient,
    outsider_client: AsyncClient,
    scoped_out_agent_client: AsyncClient,
    stored_image,
    monkeypatch,
):
    fake, object_id, _ = stored_image
    url = media_url(object_id, "shot%20one.png")
    assert (await client.get(url)).status_code == 302  # member A warms the cache

    cache_reads: list[str] = []
    real_get = signed_url_cache.get

    def spying_get(key):
        cache_reads.append(key)
        return real_get(key)

    monkeypatch.setattr(signed_url_cache, "get", spying_get)

    assert (await outsider_client.get(url)).status_code == 403
    assert (await scoped_out_agent_client.get(url)).status_code == 403
    assert cache_reads == []
    assert len(fake.sign_calls) == 1


# --- uniform 404 -----------------------------------------------------------


@pytest.mark.parametrize(
    "path_tail",
    [
        "not-a-uuid/x.png",
        "{obj}/%2E%2E",
        "{obj}/...",
        "{obj}/a%2Fb.png",
        "{obj}/%20x.png",
        "{missing}/x.png",
    ],
)
async def test_media_bad_or_missing_object_is_one_uniform_404(
    client: AsyncClient, stored_image, path_tail: str
):
    _, object_id, _ = stored_image
    reference = await client.get(media_url(uuid.uuid4(), "nothing.png"))

    resp = await client.get(
        "/api/workspaces/default/media/"
        + path_tail.format(obj=object_id, missing=uuid.uuid4())
    )

    assert resp.status_code == 404
    assert resp.json() == reference.json()
    assert reference.status_code == 404


async def test_media_cannot_name_another_workspaces_object(
    client: AsyncClient, monkeypatch, test_workspace: Workspace
):
    fake = install_fake_gcs(monkeypatch)
    object_id = uuid.uuid4()
    fake.add(f"media/{uuid.uuid4()}/{object_id}/x.png")

    resp = await client.get(media_url(object_id, "x.png"))

    assert resp.status_code == 404
    assert fake.stat_calls == [f"media/{test_workspace.id}/{object_id}/x.png"]


# --- GCS unavailable -------------------------------------------------------


async def test_media_signing_unavailable_without_local_copy_is_503(
    client: AsyncClient, stored_image, tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))
    fake, object_id, _ = stored_image
    fake.signing_broken = True

    resp = await client.get(media_url(object_id, "shot%20one.png"))

    assert resp.status_code == 503
    assert resp.json()["error_code"] == "storage_backend_unavailable"


async def test_media_bucket_unreachable_streams_existing_local_copy(
    client: AsyncClient, stored_image, tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))
    fake, object_id, key = stored_image
    fake.bucket_unreachable = True
    (tmp_path / key).parent.mkdir(parents=True)
    (tmp_path / key).write_bytes(b"png-bytes")

    resp = await client.get(media_url(object_id, "shot%20one.png"))

    assert resp.status_code == 200
    assert resp.content == b"png-bytes"


# --- local mode: stream with hardened headers ------------------------------


@pytest.fixture
def local_mode(monkeypatch, tmp_path: Path) -> Path:
    monkeypatch.setattr(settings, "GCS_BUCKET", "")
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))
    return tmp_path


def _put_local(root: Path, key: str, content: bytes) -> None:
    (root / key).parent.mkdir(parents=True, exist_ok=True)
    (root / key).write_bytes(content)


async def test_media_local_mode_streams_image_inline_with_hardening(
    client: AsyncClient, test_workspace: Workspace, local_mode: Path
):
    object_id = uuid.uuid4()
    _put_local(local_mode, f"media/{test_workspace.id}/{object_id}/a.png", b"img")

    resp = await client.get(media_url(object_id, "a.png"))

    assert resp.status_code == 200
    assert resp.content == b"img"
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in resp.headers["content-security-policy"]
    assert resp.headers["content-disposition"].startswith("inline;")


@pytest.mark.parametrize("filename", ["page.html", "logo.svg"])
async def test_media_local_mode_active_content_downloads(
    client: AsyncClient, test_workspace: Workspace, local_mode: Path, filename: str
):
    object_id = uuid.uuid4()
    _put_local(local_mode, f"media/{test_workspace.id}/{object_id}/{filename}", b"<script>")

    resp = await client.get(media_url(object_id, filename))

    assert resp.status_code == 200
    assert resp.headers["content-disposition"].startswith("attachment;")


async def test_media_local_mode_missing_is_uniform_404(client: AsyncClient, local_mode: Path):
    resp = await client.get(media_url(uuid.uuid4(), "gone.png"))

    assert resp.status_code == 404


# --- upload-url ------------------------------------------------------------


async def test_media_upload_url_returns_relative_stable_path_locally(
    client: AsyncClient, test_workspace: Workspace, local_mode: Path
):
    resp = await client.post(
        "/api/workspaces/default/media/upload-url",
        json={"filename": "my shot#1.png", "content_type": "image/png"},
    )

    assert resp.status_code == 200
    data = resp.json()
    object_id = data["upload_url"].split("/")[-2]
    assert data["upload_url"] == (
        f"/api/local-storage/upload/media/{test_workspace.id}/{object_id}/my shot#1.png"
    )
    assert data["public_url"] == f"/api/workspaces/default/media/{object_id}/my%20shot%231.png"


async def test_media_upload_url_returns_relative_stable_path_in_gcs_mode(
    client: AsyncClient, test_workspace: Workspace, monkeypatch
):
    install_fake_gcs(monkeypatch)

    resp = await client.post(
        "/api/workspaces/default/media/upload-url",
        json={"filename": "a.png", "content_type": "image/png"},
    )

    data = resp.json()
    assert data["upload_url"].startswith("https://storage.googleapis.com/")
    assert data["public_url"].startswith("/api/workspaces/default/media/")
    assert "X-Goog" not in data["public_url"]


async def test_media_upload_url_fails_loud_when_gcs_cannot_sign(
    client: AsyncClient, test_workspace: Workspace, monkeypatch
):
    fake = install_fake_gcs(monkeypatch)
    fake.signing_broken = True

    resp = await client.post(
        "/api/workspaces/default/media/upload-url",
        json={"filename": "a.png", "content_type": "image/png"},
    )

    assert resp.status_code == 503
    assert resp.json()["error_code"] == "storage_backend_unavailable"


@pytest.mark.parametrize("filename", ["", "   ", "..", "a/b.png"])
async def test_media_upload_url_rejects_invalid_filename(
    client: AsyncClient, test_workspace: Workspace, filename: str
):
    resp = await client.post(
        "/api/workspaces/default/media/upload-url",
        json={"filename": filename, "content_type": "image/png"},
    )

    assert resp.status_code == 422


async def test_media_routes_appear_in_openapi(client: AsyncClient):
    paths = (await client.get("/api/openapi.json")).json()["paths"]

    assert "/api/workspaces/{slug}/media/{object_id}/{filename}" in paths
    assert "/api/workspaces/{slug}/resources/{resource_id}/content" in paths
