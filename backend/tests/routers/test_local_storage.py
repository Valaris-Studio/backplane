# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Local-storage serving routes: tenancy, size caps, and path-shape allowlist.

The backend mints exactly TWO path shapes (resources `{ws_uuid}/{uuid}/{name}`
and media `media/{ws_uuid}/{uuid}/{name}`); nothing else legitimate exists
under LOCAL_STORAGE_DIR. Card da3dcf4c pins default-DENY for every other
shape on BOTH verbs: today `_enforce_tenancy` stays permissive when no path
segment resolves to a workspace, so any authed caller — agent keys included,
their allowlist never consulted — reads and writes arbitrary non-traversal
paths (`.env`, `etc/passwd`, ...). The deny sweep below is the red suite for
that fix; the allow pins hold the two minted shapes (and 404-for-missing on
valid shapes) green through it. `_safe_path` traversal blocks stay as
defense-in-depth — pinned, not replaced.
"""

import uuid

from pathlib import Path
from unittest.mock import patch

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.main import create_app
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


@pytest_asyncio.fixture
async def unauth_client(db_session: AsyncSession) -> AsyncClient:
    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture
async def foreign_workspace(db_session: AsyncSession) -> Workspace:
    owner = User(email="stranger@valaris.dev", name="Stranger")
    db_session.add(owner)
    await db_session.flush()
    workspace = Workspace(name="Foreign", slug="foreign", created_by=owner.id)
    db_session.add(workspace)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(workspace_id=workspace.id, user_id=owner.id, role=WorkspaceRole.owner)
    )
    await db_session.flush()
    return workspace


async def test_upload_then_download(
    client: AsyncClient, tmp_path: Path, test_workspace: Workspace, monkeypatch
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    file_path = f"{test_workspace.id}/{uuid.uuid4()}/test.txt"
    content = b"hello world"

    upload_resp = await client.put(
        f"/api/local-storage/upload/{file_path}",
        content=content,
    )
    assert upload_resp.status_code == 200

    assert (tmp_path / file_path).read_bytes() == content

    download_resp = await client.get(f"/api/local-storage/download/{file_path}")
    assert download_resp.status_code == 200
    assert download_resp.content == content


async def test_download_is_never_gzipped(
    client: AsyncClient, tmp_path: Path, test_workspace: Workspace, monkeypatch
):
    """File downloads must ship byte-identical, opted out of GZipMiddleware.

    Without the identity opt-out, GZip's streaming branch re-compresses the file
    and strips Content-Length — breaking range/resumable downloads and wasting
    CPU on already-compressed uploads."""
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    file_path = f"{test_workspace.id}/{uuid.uuid4()}/big.bin"
    content = b"x" * 4096  # over GZip's minimum_size so only the opt-out saves it

    upload_resp = await client.put(
        f"/api/local-storage/upload/{file_path}",
        content=content,
    )
    assert upload_resp.status_code == 200

    download_resp = await client.get(
        f"/api/local-storage/download/{file_path}",
        headers={"Accept-Encoding": "gzip"},
    )
    assert download_resp.status_code == 200
    assert download_resp.headers.get("content-encoding") != "gzip"
    assert download_resp.content == content
    assert download_resp.headers.get("content-length") == str(len(content))


async def test_download_not_found(
    client: AsyncClient, tmp_path: Path, test_workspace: Workspace, monkeypatch
):
    """A VALID shape whose object does not exist stays 404 — the existence
    signal survives the shape allowlist; only invalid shapes turn 403."""
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    resp = await client.get(
        f"/api/local-storage/download/{test_workspace.id}/{uuid.uuid4()}/file.txt"
    )
    assert resp.status_code == 404


async def test_upload_path_traversal_blocked(
    client: AsyncClient, tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    # Use %2e%2e to bypass httpx URL normalization — tests the server-side guard
    resp = await client.put(
        "/api/local-storage/upload/%2e%2e/%2e%2e/etc/passwd",
        content=b"hacked",
    )
    assert resp.status_code == 403


async def test_download_path_traversal_blocked(
    client: AsyncClient, tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    resp = await client.get(
        "/api/local-storage/download/%2e%2e/%2e%2e/etc/passwd"
    )
    assert resp.status_code == 403


async def test_upload_unauthenticated_rejected(
    unauth_client: AsyncClient, tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    with patch("app.core.auth.settings") as mock_auth_settings:
        mock_auth_settings.is_development = False
        mock_auth_settings.IAP_AUDIENCE = ""
        mock_auth_settings.TRUSTED_PROXY_AUTH = False
        resp = await unauth_client.put(
            "/api/local-storage/upload/some/file.txt",
            content=b"no auth",
        )
    assert resp.status_code == 403


async def test_download_unauthenticated_rejected(
    unauth_client: AsyncClient, tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    with patch("app.core.auth.settings") as mock_auth_settings:
        mock_auth_settings.is_development = False
        mock_auth_settings.IAP_AUDIENCE = ""
        mock_auth_settings.TRUSTED_PROXY_AUTH = False
        resp = await unauth_client.get("/api/local-storage/download/some/file.txt")
    assert resp.status_code == 403


async def test_upload_cross_workspace_rejected(
    client: AsyncClient,
    tmp_path: Path,
    foreign_workspace: Workspace,
    monkeypatch,
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    file_path = f"{foreign_workspace.id}/{uuid.uuid4()}/test.txt"
    resp = await client.put(
        f"/api/local-storage/upload/{file_path}",
        content=b"cross tenant",
    )
    assert resp.status_code == 403


async def test_download_cross_workspace_rejected(
    client: AsyncClient,
    tmp_path: Path,
    foreign_workspace: Workspace,
    monkeypatch,
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    object_id = uuid.uuid4()
    (tmp_path / str(foreign_workspace.id) / str(object_id)).mkdir(parents=True, exist_ok=True)
    (tmp_path / str(foreign_workspace.id) / str(object_id) / "test.txt").write_bytes(b"secret")

    resp = await client.get(
        f"/api/local-storage/download/{foreign_workspace.id}/{object_id}/test.txt"
    )
    assert resp.status_code == 403


async def test_upload_over_size_cap_rejected(
    client: AsyncClient, tmp_path: Path, test_workspace: Workspace, monkeypatch
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    from app.routers import local_storage

    file_path = f"{test_workspace.id}/{uuid.uuid4()}/big.bin"
    oversized = b"x" * (local_storage.MAX_UPLOAD_BYTES + 1)
    resp = await client.put(
        f"/api/local-storage/upload/{file_path}",
        content=oversized,
    )
    assert resp.status_code == 413
    assert not (tmp_path / file_path).exists()


async def test_upload_lying_content_length_rejected(
    client: AsyncClient, tmp_path: Path, test_workspace: Workspace, monkeypatch
):
    """A truthful Content-Length under the cap must not let the body exceed it."""
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    from app.routers import local_storage

    file_path = f"{test_workspace.id}/{uuid.uuid4()}/liar.bin"
    oversized = b"y" * (local_storage.MAX_UPLOAD_BYTES + 1)
    resp = await client.put(
        f"/api/local-storage/upload/{file_path}",
        content=oversized,
        headers={"Content-Length": "10"},
    )
    assert resp.status_code == 413
    assert not (tmp_path / file_path).exists()


async def test_upload_at_size_cap_succeeds(
    client: AsyncClient, tmp_path: Path, test_workspace: Workspace, monkeypatch
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    file_path = f"{test_workspace.id}/{uuid.uuid4()}/ok.bin"
    content = b"z" * 1024
    resp = await client.put(
        f"/api/local-storage/upload/{file_path}",
        content=content,
    )
    assert resp.status_code == 200
    assert (tmp_path / file_path).read_bytes() == content


async def test_upload_own_workspace_prefix_succeeds(
    client: AsyncClient,
    tmp_path: Path,
    test_workspace: Workspace,
    monkeypatch,
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    file_path = f"{test_workspace.id}/{uuid.uuid4()}/test.txt"
    resp = await client.put(
        f"/api/local-storage/upload/{file_path}",
        content=b"mine",
    )
    assert resp.status_code == 200
    assert (tmp_path / file_path).read_bytes() == b"mine"


# --- default-deny path-shape allowlist (card da3dcf4c) ---
#
# Every shape below the DENY line succeeds on current main — that is the hole.
# Red until the allowlist lands; the ALLOW pins and the two already-blocked
# cases (leading `//` via _safe_path, out-of-scope agent on a resolving
# workspace segment via enforce_agent_scope) must stay green through the fix.

import pytest

from app.core.auth import current_agent_id, get_current_user
from app.models.agents.agent import Agent, AgentType


@pytest_asyncio.fixture
async def scoped_agent_client(
    db_session: AsyncSession, test_user: User
) -> AsyncClient:
    """Caller is an agent key whose allowlist does NOT cover `default` —
    enforce_agent_scope must bind whenever a workspace is identifiable."""
    agent = Agent(
        name="scoped-storage-agent",
        agent_type=AgentType.coding,
        description="local-storage scope pin",
        created_by_id=test_user.id,
        is_active=True,
        allowed_workspaces=["elsewhere"],
    )
    db_session.add(agent)
    await db_session.flush()

    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        current_agent_id.set(agent.id)
        return test_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


# path templates; {ws} = caller's workspace, {obj}/{rand} = fresh UUID4s
UNKNOWN_SHAPES = [
    pytest.param("etc/passwd", id="two-seg-zero-uuid"),
    pytest.param(".env", id="one-seg-dotfile"),
    pytest.param("a/b/c", id="three-seg-no-uuid"),
    pytest.param("notauuid/{obj}/x.txt", id="three-seg-first-not-uuid"),
    pytest.param("{ws}/{obj}/sub/dir/x.txt", id="minted-prefix-wrong-arity"),
    pytest.param("{rand}/{obj}/x.txt", id="non-resolving-workspace-uuid"),
    pytest.param("other/{ws}/{obj}/x.txt", id="four-seg-first-not-media"),
    pytest.param("{ws}/{obj}/...", id="dots-only-filename"),
]


def _shape(template: str, workspace: Workspace) -> str:
    return template.format(
        ws=workspace.id, obj=uuid.uuid4(), rand=uuid.uuid4()
    )


@pytest.mark.parametrize("template", UNKNOWN_SHAPES)
async def test_upload_unknown_shape_rejected(
    client: AsyncClient, tmp_path: Path, test_workspace: Workspace,
    monkeypatch, template: str,
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))
    file_path = _shape(template, test_workspace)

    resp = await client.put(
        f"/api/local-storage/upload/{file_path}", content=b"smuggled"
    )
    assert resp.status_code == 403, (
        f"unknown shape {file_path!r} was WRITTEN to local storage: "
        f"{resp.status_code}: {resp.text}"
    )
    assert not (tmp_path / file_path).exists()


@pytest.mark.parametrize("template", UNKNOWN_SHAPES)
async def test_download_unknown_shape_rejected(
    client: AsyncClient, tmp_path: Path, test_workspace: Workspace,
    monkeypatch, template: str,
):
    """Pre-seeds real bytes at the path: today they are SERVED (200)."""
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))
    file_path = _shape(template, test_workspace)
    target = tmp_path / file_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"secret bytes")

    resp = await client.get(f"/api/local-storage/download/{file_path}")
    assert resp.status_code == 403, (
        f"unknown shape {file_path!r} was served from local storage: "
        f"{resp.status_code}: {resp.text[:200]}"
    )


async def test_upload_agent_key_zero_uuid_shape_rejected(
    scoped_agent_client: AsyncClient, tmp_path: Path, monkeypatch
):
    """The agent-scope bypass: with no resolvable workspace segment,
    enforce_agent_scope is never reached, so a scoped agent key writes
    anywhere. Default-deny must close this for agents like everyone else."""
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    resp = await scoped_agent_client.put(
        "/api/local-storage/upload/etc/passwd", content=b"agent smuggle"
    )
    assert resp.status_code == 403, (
        "out-of-scope agent key wrote a zero-uuid path: "
        f"{resp.status_code}: {resp.text}"
    )
    assert not (tmp_path / "etc" / "passwd").exists()


async def test_download_agent_key_zero_uuid_shape_rejected(
    scoped_agent_client: AsyncClient, tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))
    (tmp_path / "etc").mkdir()
    (tmp_path / "etc" / "passwd").write_bytes(b"root:x:0:0")

    resp = await scoped_agent_client.get("/api/local-storage/download/etc/passwd")
    assert resp.status_code == 403, (
        "out-of-scope agent key read a zero-uuid path: "
        f"{resp.status_code}: {resp.text[:200]}"
    )


# --- green pins: already blocked today, must stay blocked ---


async def test_upload_leading_empty_segment_rejected(
    client: AsyncClient, tmp_path: Path, test_workspace: Workspace, monkeypatch
):
    """`//{ws}/...` makes the joined path absolute; _safe_path's root
    confinement already rejects it. Pinned so the allowlist rewrite keeps
    empty segments out rather than re-normalizing them into a valid shape."""
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    resp = await client.put(
        f"/api/local-storage/upload//{test_workspace.id}/{uuid.uuid4()}/x.txt",
        content=b"absolute",
    )
    assert resp.status_code == 403, f"{resp.status_code}: {resp.text}"


async def test_download_leading_empty_segment_rejected(
    client: AsyncClient, tmp_path: Path, test_workspace: Workspace, monkeypatch
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    resp = await client.get(
        f"/api/local-storage/download//{test_workspace.id}/{uuid.uuid4()}/x.txt"
    )
    assert resp.status_code == 403, f"{resp.status_code}: {resp.text}"


async def test_upload_agent_key_out_of_scope_valid_shape_rejected(
    scoped_agent_client: AsyncClient, tmp_path: Path,
    test_workspace: Workspace, monkeypatch,
):
    """Green pin: when the workspace segment DOES resolve, enforce_agent_scope
    already refuses an agent whose allowlist excludes it — for both verbs."""
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))
    file_path = f"{test_workspace.id}/{uuid.uuid4()}/x.txt"

    put = await scoped_agent_client.put(
        f"/api/local-storage/upload/{file_path}", content=b"x"
    )
    assert put.status_code == 403, f"{put.status_code}: {put.text}"

    get = await scoped_agent_client.get(
        f"/api/local-storage/download/{file_path}"
    )
    assert get.status_code == 403, f"{get.status_code}: {get.text}"


# --- green pins: the two minted shapes round-trip for a member caller ---


async def test_upload_then_download_media_shape(
    client: AsyncClient, tmp_path: Path, test_workspace: Workspace, monkeypatch
):
    """The second minted shape (media.py) — including a filename whose dots
    are inert (`a..b.pdf` contains ".." only as a substring, never as a
    segment): the allowlist must not over-reject real filenames."""
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    file_path = f"media/{test_workspace.id}/{uuid.uuid4()}/a..b.pdf"
    content = b"%PDF-1.4 media bytes"

    upload_resp = await client.put(
        f"/api/local-storage/upload/{file_path}", content=content
    )
    assert upload_resp.status_code == 200, (
        f"{upload_resp.status_code}: {upload_resp.text}"
    )
    assert (tmp_path / file_path).read_bytes() == content

    download_resp = await client.get(f"/api/local-storage/download/{file_path}")
    assert download_resp.status_code == 200, (
        f"{download_resp.status_code}: {download_resp.text}"
    )
    assert download_resp.content == content


async def test_download_media_shape_not_found(
    client: AsyncClient, tmp_path: Path, test_workspace: Workspace, monkeypatch
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    resp = await client.get(
        f"/api/local-storage/download/media/{test_workspace.id}/{uuid.uuid4()}/gone.pdf"
    )
    assert resp.status_code == 404, f"{resp.status_code}: {resp.text}"
