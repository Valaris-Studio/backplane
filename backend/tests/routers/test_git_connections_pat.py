# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""PAT-backed git connection endpoints.

The probe is injected (app.dependency_overrides on get_forge_probe) so no test
touches the network. What these tests pin: a token is never stored before the
forge confirms it identifies someone, tokens never appear in a response, and
the guidance returned by /verify names the exact missing permission.
"""

from __future__ import annotations

import os

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.database import get_db
from app.integrations.git.vault import FernetTokenVault
from app.main import create_app
from app.models.git.git_connection import GitConnection
from app.models.git.git_repo import GitProvider
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.repositories.git.git_connection import GitConnectionRepository
from app.services.git.forge_probe import (
    ForgeProbe,
    ProbeIdentity,
    ProbeUnauthorized,
    ProbeUnreachable,
    get_forge_probe,
)


def _vault() -> FernetTokenVault:
    return FernetTokenVault(os.environ["INTEGRATIONS_TOKEN_KEY"].encode())


class FakeProbe(ForgeProbe):
    """Records what it was asked and returns a scripted outcome."""

    def __init__(self, outcome=None):
        self.outcome = outcome or ProbeIdentity(
            account_login="acme-bot",
            account_type="organization",
            scopes=["repo", "workflow"],
        )
        self.calls: list[tuple[str, str, str | None]] = []

    async def probe(
        self, *, provider: GitProvider, token: str, base_url: str | None
    ) -> ProbeIdentity:
        self.calls.append((provider.value, token, base_url))
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


@pytest_asyncio.fixture
async def probe() -> FakeProbe:
    return FakeProbe()


@pytest_asyncio.fixture
async def pat_client(
    db_session: AsyncSession, test_user: User, probe: FakeProbe
) -> AsyncClient:
    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return test_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    app.dependency_overrides[get_forge_probe] = lambda: probe

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def _member_client(
    db_session: AsyncSession, workspace: Workspace, probe: FakeProbe
) -> tuple[AsyncClient, User]:
    member = User(email="member@valaris.dev", name="Member")
    db_session.add(member)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=workspace.id, user_id=member.id, role=WorkspaceRole.member
        )
    )
    await db_session.flush()

    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return member

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    app.dependency_overrides[get_forge_probe] = lambda: probe
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test"), member


# --- POST / (create via PAT) ---


async def test_create_pat_connection_probes_then_stores(
    pat_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    probe: FakeProbe,
    monkeypatch: pytest.MonkeyPatch,
):
    # Spy on the repo write: last_verified_at MUST be naive UTC (house style,
    # app.utils.utcnow) — asyncpg rejects tz-aware values against these
    # timezone-less columns. Asserting on the stored row is useless here:
    # SQLite strips tzinfo on the refresh() round-trip and hides the bug.
    written: dict = {}
    original_create = GitConnectionRepository.create

    async def spy_create(self, **kwargs):
        written.update(kwargs)
        return await original_create(self, **kwargs)

    monkeypatch.setattr(GitConnectionRepository, "create", spy_create)

    response = await pat_client.post(
        "/api/workspaces/default/git-connections",
        json={"provider": "github", "token": "ghp_realtoken"},
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["account_login"] == "acme-bot"
    assert body["account_type"] == "organization"
    assert body["provider"] == "github"
    assert body["auth_kind"] == "pat"
    assert body["scopes"] == ["repo", "workflow"]
    assert body["last_verified_at"] is not None
    assert body["last_error"] is None
    # The probe saw the real token; the response must not.
    assert probe.calls == [("github", "ghp_realtoken", None)]
    assert "ghp_realtoken" not in response.text
    assert "token" not in body

    stored = (
        await db_session.execute(
            select(GitConnection).where(
                GitConnection.workspace_id == test_workspace.id
            )
        )
    ).scalar_one()
    assert _vault().decrypt(stored.encrypted_access_token) == "ghp_realtoken"
    assert stored.auth_kind == "pat"
    assert written["last_verified_at"] is not None
    assert written["last_verified_at"].tzinfo is None


async def test_create_pat_connection_passes_base_url_to_probe(
    pat_client: AsyncClient, test_workspace: Workspace, probe: FakeProbe
):
    response = await pat_client.post(
        "/api/workspaces/default/git-connections",
        json={
            "provider": "gitea",
            "token": "gta_token",
            "base_url": "https://git.acme.dev",
        },
    )

    assert response.status_code == 201, response.text
    assert probe.calls == [("gitea", "gta_token", "https://git.acme.dev")]
    assert response.json()["base_url"] == "https://git.acme.dev"


async def test_create_pat_connection_rejects_bad_token_without_storing(
    pat_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    probe: FakeProbe,
):
    probe.outcome = ProbeUnauthorized("token was rejected by github")

    response = await pat_client.post(
        "/api/workspaces/default/git-connections",
        json={"provider": "github", "token": "ghp_bad"},
    )

    assert response.status_code == 422
    assert "rejected" in response.text.lower()
    assert "ghp_bad" not in response.text
    rows = (await db_session.execute(select(GitConnection))).scalars().all()
    assert rows == []


async def test_create_pat_connection_rejects_unreachable_host(
    pat_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    probe: FakeProbe,
):
    probe.outcome = ProbeUnreachable("could not reach https://git.nope.dev")

    response = await pat_client.post(
        "/api/workspaces/default/git-connections",
        json={
            "provider": "gitea",
            "token": "gta_token",
            "base_url": "https://git.nope.dev",
        },
    )

    assert response.status_code == 422
    assert "reach" in response.text.lower()
    rows = (await db_session.execute(select(GitConnection))).scalars().all()
    assert rows == []


async def test_create_pat_connection_requires_gitea_base_url(
    pat_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    probe: FakeProbe,
):
    """A gitea connection without base_url can never be host-matched."""
    response = await pat_client.post(
        "/api/workspaces/default/git-connections",
        json={"provider": "gitea", "token": "gta_token"},
    )

    assert response.status_code == 422
    assert "base_url" in response.text
    assert probe.calls == []


async def test_create_pat_connection_is_idempotent_on_same_account(
    pat_client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    first = await pat_client.post(
        "/api/workspaces/default/git-connections",
        json={"provider": "github", "token": "ghp_one"},
    )
    second = await pat_client.post(
        "/api/workspaces/default/git-connections",
        json={"provider": "github", "token": "ghp_two"},
    )

    assert first.status_code == 201
    assert second.status_code in (200, 201)
    assert first.json()["id"] == second.json()["id"]
    rows = (await db_session.execute(select(GitConnection))).scalars().all()
    assert len(rows) == 1
    # The re-POST refreshes the stored token rather than keeping the stale one.
    assert _vault().decrypt(rows[0].encrypted_access_token) == "ghp_two"


async def test_create_pat_connection_without_token_key_is_actionable_503(
    pat_client: AsyncClient,
    test_workspace: Workspace,
):
    """An unset INTEGRATIONS_TOKEN_KEY must not surface as a raw 500.

    The person seeing this error is a workspace admin who CANNOT fix it — only
    the platform operator can. 503 + copy that names the env var and who to
    ask turns a dead end into a support path (the deploy itself stays healthy:
    everything except token storage works without the key).
    """
    from app import config as _config

    s = _config.settings
    saved = s.INTEGRATIONS_TOKEN_KEY
    s.INTEGRATIONS_TOKEN_KEY = ""
    try:
        response = await pat_client.post(
            "/api/workspaces/default/git-connections",
            json={"provider": "github", "token": "ghp_realtoken"},
        )
    finally:
        s.INTEGRATIONS_TOKEN_KEY = saved

    assert response.status_code == 503, response.text
    body = response.json()
    assert body["error_code"] == "integrations_config_error"
    assert "INTEGRATIONS_TOKEN_KEY" in body["detail"]
    # Actionable for the admin reading it: point at the operator, not the code.
    assert "operat" in body["detail"].lower() or "runs" in body["detail"].lower()


async def test_create_pat_connection_requires_admin(
    db_session: AsyncSession, test_workspace: Workspace, probe: FakeProbe
):
    client, _ = await _member_client(db_session, test_workspace, probe)
    async with client as ac:
        response = await ac.post(
            "/api/workspaces/default/git-connections",
            json={"provider": "github", "token": "ghp_token"},
        )

    assert response.status_code == 403
    assert probe.calls == []


async def test_create_pat_connection_records_activity_without_token(
    pat_client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    from app.models.activity import Activity

    await pat_client.post(
        "/api/workspaces/default/git-connections",
        json={"provider": "github", "token": "ghp_supersecret"},
    )

    activities = (await db_session.execute(select(Activity))).scalars().all()
    assert len(activities) == 1
    blob = f"{activities[0].summary} {activities[0].changes}"
    assert "ghp_supersecret" not in blob
    assert "acme-bot" in blob


# --- POST /{id}/verify ---


@pytest_asyncio.fixture
async def existing_connection(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
) -> GitConnection:
    conn = GitConnection(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="acme-bot",
        account_type="organization",
        encrypted_access_token=_vault().encrypt("ghp_stored"),
        scopes=["repo"],
        auth_kind="pat",
        last_error="previous failure",
        connected_by=test_user.id,
    )
    db_session.add(conn)
    await db_session.flush()
    return conn


async def test_verify_connection_clears_prior_error_and_stamps_time(
    pat_client: AsyncClient,
    db_session: AsyncSession,
    existing_connection: GitConnection,
    probe: FakeProbe,
    monkeypatch: pytest.MonkeyPatch,
):
    # Same naive-UTC spy as the create path — SQLite's refresh() round-trip
    # strips tzinfo, so only the value handed to the repo tells the truth.
    written: dict = {}
    original_update = GitConnectionRepository.update

    async def spy_update(self, instance, **kwargs):
        written.update(kwargs)
        return await original_update(self, instance, **kwargs)

    monkeypatch.setattr(GitConnectionRepository, "update", spy_update)

    response = await pat_client.post(
        f"/api/workspaces/default/git-connections/{existing_connection.id}/verify"
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["connection"]["last_error"] is None
    assert body["connection"]["last_verified_at"] is not None
    assert probe.calls == [("github", "ghp_stored", None)]
    assert "ghp_stored" not in response.text
    assert written["last_verified_at"] is not None
    assert written["last_verified_at"].tzinfo is None


async def test_verify_connection_returns_scope_checks_with_guidance(
    pat_client: AsyncClient, existing_connection: GitConnection, probe: FakeProbe
):
    probe.outcome = ProbeIdentity(
        account_login="acme-bot", account_type="organization", scopes=["repo"]
    )

    response = await pat_client.post(
        f"/api/workspaces/default/git-connections/{existing_connection.id}/verify"
    )

    assert response.status_code == 200
    checks = response.json()["checks"]
    assert checks, "verify must report per-duty checks"
    by_name = {c["name"]: c for c in checks}
    assert by_name["identity"]["ok"] is True
    # Every check carries guidance an operator can act on.
    for check in checks:
        assert isinstance(check["ok"], bool)
        assert check["guidance"]


async def test_verify_connection_records_probe_failure(
    pat_client: AsyncClient,
    db_session: AsyncSession,
    existing_connection: GitConnection,
    probe: FakeProbe,
):
    probe.outcome = ProbeUnauthorized("token was rejected by github")

    response = await pat_client.post(
        f"/api/workspaces/default/git-connections/{existing_connection.id}/verify"
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["connection"]["last_error"]
    assert "rejected" in body["connection"]["last_error"].lower()
    identity = next(c for c in body["checks"] if c["name"] == "identity")
    assert identity["ok"] is False

    await db_session.refresh(existing_connection)
    assert existing_connection.last_error


async def test_verify_connection_requires_admin(
    db_session: AsyncSession,
    test_workspace: Workspace,
    existing_connection: GitConnection,
    probe: FakeProbe,
):
    client, _ = await _member_client(db_session, test_workspace, probe)
    async with client as ac:
        response = await ac.post(
            f"/api/workspaces/default/git-connections/{existing_connection.id}/verify"
        )

    assert response.status_code == 403


async def test_verify_connection_from_other_workspace_is_404(
    pat_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
):
    other = Workspace(name="Other", slug="other-ws", created_by=test_user.id)
    db_session.add(other)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=other.id, user_id=test_user.id, role=WorkspaceRole.owner
        )
    )
    foreign = GitConnection(
        workspace_id=other.id,
        provider=GitProvider.github,
        account_login="foreign",
        account_type="user",
        encrypted_access_token=_vault().encrypt("ghp_foreign"),
        scopes=[],
        connected_by=test_user.id,
    )
    db_session.add(foreign)
    await db_session.flush()

    response = await pat_client.post(
        f"/api/workspaces/default/git-connections/{foreign.id}/verify"
    )

    assert response.status_code == 404


# --- GET / (list now carries health) ---


async def test_list_connections_includes_health_metadata(
    pat_client: AsyncClient, existing_connection: GitConnection
):
    response = await pat_client.get("/api/workspaces/default/git-connections")

    assert response.status_code == 200
    row = response.json()[0]
    assert row["auth_kind"] == "pat"
    assert row["last_error"] == "previous failure"
    assert "last_verified_at" in row
    assert row["account_login"] == "acme-bot"
    assert "token" not in row
    assert "encrypted_access_token" not in row


async def test_list_connections_allows_plain_member(
    db_session: AsyncSession,
    test_workspace: Workspace,
    existing_connection: GitConnection,
    probe: FakeProbe,
):
    """Members bind repos to connections, so they must be able to see them."""
    client, _ = await _member_client(db_session, test_workspace, probe)
    async with client as ac:
        response = await ac.get("/api/workspaces/default/git-connections")

    assert response.status_code == 200
    assert len(response.json()) == 1


# --- DELETE ---


async def test_delete_connection_is_idempotent(
    pat_client: AsyncClient, existing_connection: GitConnection
):
    first = await pat_client.delete(
        f"/api/workspaces/default/git-connections/{existing_connection.id}"
    )
    second = await pat_client.delete(
        f"/api/workspaces/default/git-connections/{existing_connection.id}"
    )

    assert first.status_code == 204
    assert second.status_code == 204
