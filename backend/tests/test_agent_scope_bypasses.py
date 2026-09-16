# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Routes that reach workspace-scoped data WITHOUT passing `WorkspaceDep`.

Commit a8f7c5e enforces `Agent.allowed_workspaces` inside
`WorkspaceDep.__call__`, which gates every route carrying `{slug}` in its path.
Three subsystems reach workspace-scoped data by another route and therefore
inherit none of that enforcement:

  1. `/api/local-storage/{upload,download}/{file_path:path}` — no slug in the
     path at all. `_enforce_tenancy` scans path segments for a workspace UUID
     and checks the *user's* membership. The agent's scope is never consulted,
     and the agent's creating user is a member of both workspaces.
  2. `POST /api/agents/{agent_id}/executions` — the workspace arrives in the
     BODY as `workspace_slug`. `ExecutionService._resolve_workspace` turns it
     into a workspace_id with no scope check.
  3. `GET /ws/workspaces/{slug}/events` — a WebSocket with its own auth
     (`_authenticate_ws`) and its own workspace resolution (`_resolve_workspace`,
     membership only). It never touches the HTTP dependency graph.

Each site gets a denial test AND a negative control on the agent's OWN
workspace, so a fix that simply denies everything cannot pass.

Auth goes over the REAL API-key path (see the module docstring of
`test_agent_workspace_scope.py`): a genuine ApiKey row whose sha256 hash matches
`ApiKeyService.verify_key`, linked to an Agent via `Agent.api_key_id`. The app
under test deliberately does NOT override `get_current_user`, so `app.core.auth`
binds the agent and sets the `current_agent_id` ContextVar as in production.
conftest's `agent_client` fakes that ContextVar via a `get_current_user`
override and would bypass the plumbing under test.
"""

import hashlib
import secrets
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType
from app.models.api_key import ApiKey
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


async def _make_workspace(
    db_session: AsyncSession, owner: User, *, name: str, slug: str
) -> Workspace:
    workspace = Workspace(name=name, slug=slug, created_by=owner.id)
    db_session.add(workspace)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=workspace.id, user_id=owner.id, role=WorkspaceRole.owner
        )
    )
    await db_session.flush()
    return workspace


async def _make_agent_with_key(
    db_session: AsyncSession,
    owner: User,
    *,
    allowed_workspaces: list[str] | None,
    name: str = "scoped-agent",
) -> tuple[Agent, str]:
    """Mint a real ApiKey + linked Agent; return (agent, raw `vlr_` token).

    The hash must be sha256(raw) to match ApiKeyService.verify_key, and the
    Agent must be is_active=True or auth silently skips the agent lookup.
    """
    raw = "vlr_" + secrets.token_urlsafe(32)
    api_key = ApiKey(
        user_id=owner.id,
        name=f"{name}-key",
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:8],
    )
    db_session.add(api_key)
    await db_session.flush()

    agent = Agent(
        name=name,
        agent_type=AgentType.coding,
        description="Agent under workspace-scope-bypass test",
        created_by_id=owner.id,
        is_active=True,
        api_key_id=api_key.id,
        allowed_workspaces=allowed_workspaces,
    )
    db_session.add(agent)
    await db_session.flush()
    return agent, raw


@pytest_asyncio.fixture
async def raw_key_client(db_session: AsyncSession) -> AsyncClient:
    """Client with NO auth override — exercises the real Bearer vlr_ code path."""
    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture
async def workspace_a(db_session: AsyncSession, test_user: User) -> Workspace:
    return await _make_workspace(
        db_session, test_user, name="Workspace A", slug="workspace-a"
    )


@pytest_asyncio.fixture
async def workspace_b(db_session: AsyncSession, test_user: User) -> Workspace:
    """A second workspace owned by the SAME user, so membership is never the
    reason a request is denied — only agent scoping can be."""
    return await _make_workspace(
        db_session, test_user, name="Workspace B", slug="workspace-b"
    )


@pytest.fixture
def storage_dir(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))
    return tmp_path


def _auth(raw_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {raw_key}"}


def _media_path(workspace: Workspace, filename: str) -> str:
    """Production media shape: `media/{workspace.id}/{uuid4}/{filename}`.

    The workspace id is deliberately NOT the leading segment — that is the
    shape `_enforce_tenancy` scans for, and the shape a scoped agent would use
    to reach another tenant's bucket.
    """
    return f"media/{workspace.id}/{uuid.uuid4()}/{filename}"


# --------------------------------------------------------------------------
# Site 1 — /api/local-storage (no slug in the path, so WorkspaceDep never runs)
# --------------------------------------------------------------------------


async def test_local_storage_upload_denies_foreign_workspace_path(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
    workspace_b: Workspace,
    storage_dir: Path,
):
    """An agent scoped to A must not write a file into B's storage prefix.

    `_enforce_tenancy` only asks whether the *user* is a member of the
    workspace named in the path. The agent's creating user owns B, so the
    check passes and the scope is bypassed entirely.
    """
    _agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    file_path = _media_path(workspace_b, "secret.txt")
    resp = await raw_key_client.put(
        f"/api/local-storage/upload/{file_path}",
        content=b"exfiltrated by a scoped agent",
        headers=_auth(raw_key),
    )

    assert resp.status_code == 403, (
        "agent scoped to workspace A uploaded into workspace B's storage prefix: "
        f"{resp.status_code} {resp.text}"
    )
    assert not (storage_dir / file_path).exists(), (
        "the denied upload still wrote bytes to disk"
    )


async def test_local_storage_denies_path_naming_both_workspaces(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
    workspace_b: Workspace,
    storage_dir: Path,
):
    """Every workspace a path names must pass, not merely the first one found.

    Scanning until the first segment resolves lets the caller choose which id
    is inspected: prefixing their own workspace satisfies the check while the
    file still lands under the victim's prefix.
    """
    _agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    file_path = f"{workspace_a.id}/{workspace_b.id}/{uuid.uuid4()}/loot.txt"
    resp = await raw_key_client.put(
        f"/api/local-storage/upload/{file_path}",
        content=b"smuggled past the first-match check",
        headers=_auth(raw_key),
    )

    assert resp.status_code == 403, (
        "a path naming the agent's own workspace first slipped a write into "
        f"workspace B's prefix: {resp.status_code} {resp.text}"
    )
    assert not (storage_dir / file_path).exists(), (
        "the denied upload still wrote bytes to disk"
    )


async def test_local_storage_download_denies_foreign_workspace_path(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
    workspace_b: Workspace,
    storage_dir: Path,
):
    """Reads are scoped too — a scope that still serves another workspace's
    files is not a scope."""
    _agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    # Plant the file directly on disk so the assertion below cannot be
    # satisfied by a 404: the only honest reasons for a non-200 are the scope
    # guard (403) or a bug.
    file_path = _media_path(workspace_b, "confidential.txt")
    dest = storage_dir / file_path
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(b"workspace B private bytes")

    resp = await raw_key_client.get(
        f"/api/local-storage/download/{file_path}",
        headers=_auth(raw_key),
    )

    assert resp.status_code == 403, (
        "agent scoped to workspace A downloaded a workspace B file: "
        f"{resp.status_code} {resp.text}"
    )
    assert b"workspace B private bytes" not in resp.content, (
        "the response leaked workspace B's file contents"
    )


async def test_local_storage_allows_own_workspace_path(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
    workspace_b: Workspace,
    storage_dir: Path,
):
    """NEGATIVE CONTROL: the agent's OWN workspace prefix must still work, for
    both verbs. Without this, a fix that denies every local-storage request
    from an agent would pass the two tests above."""
    _agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    file_path = _media_path(workspace_a, "own.txt")
    content = b"workspace A bytes"

    upload_resp = await raw_key_client.put(
        f"/api/local-storage/upload/{file_path}",
        content=content,
        headers=_auth(raw_key),
    )
    assert upload_resp.status_code == 200, (
        f"agent denied upload to its OWN workspace: {upload_resp.text}"
    )

    download_resp = await raw_key_client.get(
        f"/api/local-storage/download/{file_path}",
        headers=_auth(raw_key),
    )
    assert download_resp.status_code == 200, (
        f"agent denied download from its OWN workspace: {download_resp.text}"
    )
    assert download_resp.content == content


# --------------------------------------------------------------------------
# Site 2 — POST /api/agents/{agent_id}/executions (slug travels in the BODY)
# --------------------------------------------------------------------------


async def test_execution_create_denies_foreign_workspace_slug(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
    workspace_b: Workspace,
):
    """A scoped agent must not open an execution against another workspace.

    The slug never appears in the path, so `WorkspaceDep` never runs;
    `ExecutionService._resolve_workspace` resolves it straight to a
    workspace_id. The resulting execution row — and the EXECUTION_STARTED
    event fanned out on B's workspace channel — land in a workspace the agent
    is not scoped to.
    """
    agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    resp = await raw_key_client.post(
        f"/api/agents/{agent.id}/executions",
        json={
            "workspace_slug": workspace_b.slug,
            "action": "implement",
            "input_summary": "work in a workspace this agent is not scoped to",
        },
        headers=_auth(raw_key),
    )

    assert resp.status_code != 422, (
        "request body was rejected by validation, so this test never reached "
        f"the scope check it claims to measure: {resp.text}"
    )
    assert resp.status_code == 403, (
        "agent scoped to workspace A started an execution in workspace B: "
        f"{resp.status_code} {resp.text}"
    )


async def test_execution_create_allows_own_workspace_slug(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
    workspace_b: Workspace,
):
    """NEGATIVE CONTROL: the agent's own workspace slug must still start an
    execution. This is also the proof that the body above is well-formed —
    identical shape, only the slug differs."""
    agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    resp = await raw_key_client.post(
        f"/api/agents/{agent.id}/executions",
        json={
            "workspace_slug": workspace_a.slug,
            "action": "implement",
            "input_summary": "work in the agent's own workspace",
        },
        headers=_auth(raw_key),
    )

    assert resp.status_code == 201, (
        f"agent denied an execution in its OWN workspace: {resp.text}"
    )
    assert resp.json()["workspace_id"] == str(workspace_a.id)


# --------------------------------------------------------------------------
# Site 3 — GET /ws/workspaces/{slug}/events (WebSocket with its own auth)
# --------------------------------------------------------------------------
#
# The WS route resolves its own sessions via `async_session` rather than the
# injected `get_db`, so the `raw_key_client` override does not reach it and it
# would otherwise query the real (non-test) engine. Patching
# `app.routers.events.async_session` with a factory bound to the per-test
# in-memory engine points both `_authenticate_ws` and `_resolve_workspace` at
# the fixtures below.
#
# The app is driven through the raw ASGI websocket protocol instead of
# Starlette's TestClient: TestClient runs the app in a separate thread with its
# own event loop, which would deadlock against the StaticPool `:memory:`
# connection owned by this test's loop. Every existing WS test in
# tests/routers/test_events_ws.py sidesteps that by mocking `_authenticate_ws`
# and `_resolve_workspace` outright — which is exactly the code under test here,
# so mocking them is not an option.
#
# `test_ws_harness_observes_real_denials` is the guard that keeps this honest:
# it pins that the driver reports genuine rejections (4001/4002) rather than
# reporting "accepted" unconditionally.


async def _drive_ws_handshake(
    app, slug: str, token: str, *, via_header: bool = False
) -> tuple[str, int | None]:
    """Run one websocket handshake against the ASGI app.

    Returns ("accepted", None) if the server accepted the socket, or
    ("closed", code) if it rejected the handshake — 4001 for auth failure,
    4002 for workspace-not-found/not-a-member.

    `via_header=True` sends the token as `Authorization: Bearer <token>` and
    an EMPTY query string — pinning the WS-token-in-query-string fix (card
    85f993da): the runner Go client must be able to authenticate without ever
    putting the key in the URL (proxy/access logs).
    """
    path = f"/ws/workspaces/{slug}/events"
    headers = [(b"host", b"test")]
    query_string = f"token={token}".encode()
    if via_header:
        headers.append((b"authorization", f"Bearer {token}".encode()))
        query_string = b""

    scope = {
        "type": "websocket",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "scheme": "ws",
        "path": path,
        "raw_path": path.encode(),
        "query_string": query_string,
        "root_path": "",
        "headers": headers,
        "client": ("127.0.0.1", 12345),
        "server": ("test", 80),
        "subprotocols": [],
        "state": {},
    }

    pending = [{"type": "websocket.connect"}]
    outcome: dict[str, tuple[str, int | None]] = {}

    async def receive():
        if pending:
            return pending.pop(0)
        # Close immediately after the handshake — this test only cares whether
        # the socket was accepted, not about the message loop.
        return {"type": "websocket.disconnect", "code": 1000}

    async def send(message):
        if "result" in outcome:
            return
        if message["type"] == "websocket.accept":
            outcome["result"] = ("accepted", None)
        elif message["type"] == "websocket.close":
            outcome["result"] = ("closed", message.get("code"))

    try:
        await app(scope, receive, send)
    except Exception as exc:  # surfaced as a test failure, never swallowed
        outcome.setdefault("result", ("error", f"{type(exc).__name__}: {exc}"))
    return outcome.get("result", ("no-response", None))


@pytest_asyncio.fixture
async def ws_app(db_engine):
    """App whose WS route reads the per-test in-memory DB."""
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    app = create_app()
    with patch("app.routers.events.async_session", factory):
        yield app


@pytest_asyncio.fixture
async def committed_scope_fixtures(
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
    workspace_b: Workspace,
):
    """Commit the agent + workspaces so the WS route's OWN session can see them.

    `_authenticate_ws`/`_resolve_workspace` open separate sessions; uncommitted
    rows sitting in the fixture session's transaction would be invisible to them
    and every connection would fail for the wrong reason.
    """
    agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )
    await db_session.commit()
    return agent, raw_key


async def test_ws_events_denies_foreign_workspace(
    ws_app,
    committed_scope_fixtures,
    workspace_b: Workspace,
):
    """An agent scoped to A must not open the event stream for workspace B.

    `_resolve_workspace` checks only that the *user* is a member. The workspace
    event stream carries every card/board/execution event in the workspace, so
    an accepted socket here is a continuous cross-tenant read channel — not a
    single leaked request.
    """
    _agent, raw_key = committed_scope_fixtures

    status, code = await _drive_ws_handshake(ws_app, workspace_b.slug, raw_key)

    assert status == "closed", (
        "agent scoped to workspace A opened workspace B's event stream: "
        f"handshake result was {status!r} (code={code})"
    )


async def test_ws_events_allows_own_workspace(
    ws_app,
    committed_scope_fixtures,
    workspace_a: Workspace,
):
    """NEGATIVE CONTROL: the agent's own workspace stream must still connect."""
    _agent, raw_key = committed_scope_fixtures

    status, code = await _drive_ws_handshake(ws_app, workspace_a.slug, raw_key)

    assert status == "accepted", (
        "agent denied the event stream for its OWN workspace: "
        f"{status!r} (code={code})"
    )


async def test_ws_harness_observes_real_denials(
    ws_app,
    committed_scope_fixtures,
    db_session: AsyncSession,
    workspace_a: Workspace,
):
    """META-CONTROL: prove the driver can SEE a rejection.

    Without this, `test_ws_events_denies_foreign_workspace` could be measuring
    a driver that never reports a close frame — it would fail today and pass
    after any change, proving nothing. A bad token must be rejected at auth
    (4001) and an unknown slug at workspace resolution (4002).
    """
    _agent, raw_key = committed_scope_fixtures

    bogus_status, bogus_code = await _drive_ws_handshake(
        ws_app, workspace_a.slug, "vlr_not_a_real_key"
    )
    assert (bogus_status, bogus_code) == ("closed", 4001), (
        f"harness did not observe an auth rejection: {bogus_status!r} {bogus_code}"
    )


# --------------------------------------------------------------------------
# WS token in the query string (card 85f993da): `?token=vlr_...` lands in
# proxy/access logs. The Go runner client must be able to authenticate over
# the `Authorization: Bearer vlr_...` header instead, with no token= param on
# the URL at all. The query param stays accepted (deprecation window) — these
# tests pin the NEW header path without touching the existing query-param
# tests above.
# --------------------------------------------------------------------------


async def test_ws_events_accepts_bearer_header_with_no_query_token(
    ws_app,
    committed_scope_fixtures,
    workspace_a: Workspace,
):
    """The header-auth path must work standalone — an empty query string and
    a valid Authorization header is enough to open the agent's own stream."""
    _agent, raw_key = committed_scope_fixtures

    status, code = await _drive_ws_handshake(
        ws_app, workspace_a.slug, raw_key, via_header=True
    )

    assert status == "accepted", (
        f"Authorization-header auth (no query token) was rejected: "
        f"{status!r} (code={code})"
    )


async def test_ws_events_header_auth_still_enforces_agent_scope(
    ws_app,
    committed_scope_fixtures,
    workspace_b: Workspace,
):
    """The header path must not be a shortcut around scope enforcement — an
    agent scoped to workspace A authenticating via header must still be
    denied workspace B's stream, exactly like the query-param path."""
    _agent, raw_key = committed_scope_fixtures

    status, code = await _drive_ws_handshake(
        ws_app, workspace_b.slug, raw_key, via_header=True
    )

    assert status == "closed", (
        "header-authenticated agent scoped to workspace A opened workspace B's "
        f"event stream: handshake result was {status!r} (code={code})"
    )

    missing_status, missing_code = await _drive_ws_handshake(
        ws_app, "no-such-workspace", raw_key
    )
    assert (missing_status, missing_code) == ("closed", 4002), (
        "harness did not observe a workspace-resolution rejection: "
        f"{missing_status!r} {missing_code}"
    )
