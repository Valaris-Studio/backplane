# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Admin account management through the workspace-members surface (card 8).

The L8 rule: whoever is owner/admin of a workspace (the get_workspace_admin
authority that already manages its members) may create accounts with an
initial password and set temporary passwords for its members. A user who
manages no workspace manages nobody.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings as app_settings
from app.core.auth import get_current_user
from app.core.password import MIN_PASSWORD_LENGTH, hash_password
from app.database import get_db
from app.main import create_app
from app.models.activity import Activity, ActivityEntityType
from app.models.notifications.notification import Notification
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.services.auth.local_auth import MAX_FAILED_LOGIN_ATTEMPTS

INITIAL_PASSWORD = "a fine first password"
TEMP_PASSWORD = "temporary but long enough"


@pytest_asyncio.fixture
async def member_user(db_session: AsyncSession) -> User:
    user = User(email="member@valaris.dev", name="Member User")
    db_session.add(user)
    await db_session.flush()
    return user


@pytest_asyncio.fixture
async def workspace_with_member(
    db_session: AsyncSession, test_workspace: Workspace, member_user: User
) -> Workspace:
    membership = WorkspaceMember(
        workspace_id=test_workspace.id,
        user_id=member_user.id,
        role=WorkspaceRole.member,
    )
    db_session.add(membership)
    await db_session.flush()
    return test_workspace


@pytest_asyncio.fixture
async def member_client(db_session: AsyncSession, member_user: User) -> AsyncClient:
    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return member_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac


async def _login_status(client: AsyncClient, email: str, password: str) -> int:
    resp = await client.post(
        "/api/auth/login", json={"email": email, "password": password}
    )
    return resp.status_code


async def _get_user(db: AsyncSession, email: str) -> User:
    # populate_existing refreshes just this instance — expire_all() would
    # leave e.g. test_user expired, and the next request's sync attribute
    # access on it would MissingGreenlet.
    return (
        await db.execute(
            select(User)
            .where(User.email == email)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


# ── add member with initial password ──


@pytest.mark.asyncio
async def test_add_member_with_initial_password_new_user_can_login(
    client: AsyncClient, test_workspace: Workspace, db_session: AsyncSession
):
    resp = await client.post(
        "/api/workspaces/default/members",
        json={
            "email": "new.hire@example.com",
            "role": "member",
            "initial_password": INITIAL_PASSWORD,
        },
    )
    assert resp.status_code == 201

    assert await _login_status(client, "new.hire@example.com", INITIAL_PASSWORD) == 200
    activity = await db_session.scalar(
        select(Activity).where(
            Activity.message_key == "activity.member.added_with_initial_password"
        )
    )
    assert activity is not None
    assert activity.message_params == {
        "member_email": "new.hire@example.com",
        "role": "member",
    }
    assert INITIAL_PASSWORD not in str(activity.message_params)


@pytest.mark.asyncio
async def test_add_member_initial_password_never_overwrites(
    client: AsyncClient, test_workspace: Workspace, db_session: AsyncSession
):
    existing = User(
        email="veteran@example.com",
        name="Vet",
        password_hash=hash_password("the original password"),
    )
    db_session.add(existing)
    await db_session.flush()

    resp = await client.post(
        "/api/workspaces/default/members",
        json={
            "email": "veteran@example.com",
            "role": "member",
            "initial_password": INITIAL_PASSWORD,
        },
    )
    assert resp.status_code == 201

    assert (
        await _login_status(client, "veteran@example.com", "the original password")
        == 200
    )
    assert await _login_status(client, "veteran@example.com", INITIAL_PASSWORD) == 401


@pytest.mark.asyncio
async def test_add_member_with_password_is_idempotent(
    client: AsyncClient, test_workspace: Workspace, db_session: AsyncSession
):
    payload = {
        "email": "new.hire@example.com",
        "role": "member",
        "initial_password": INITIAL_PASSWORD,
    }
    assert (
        await client.post("/api/workspaces/default/members", json=payload)
    ).status_code == 201
    first_hash = (await _get_user(db_session, "new.hire@example.com")).password_hash

    retry = await client.post(
        "/api/workspaces/default/members",
        json={**payload, "initial_password": "a different password!"},
    )
    assert retry.status_code == 201
    assert (
        await _get_user(db_session, "new.hire@example.com")
    ).password_hash == first_hash


@pytest.mark.asyncio
async def test_initial_password_respects_email_domain_allowlist(
    client: AsyncClient, test_workspace: Workspace, monkeypatch
):
    """Membership alone was never domain-gated (an explicit invite is a
    deliberate act), but granting a LOGIN-CAPABLE credential must honor the
    same allowlist as first-run setup — otherwise the invite path quietly
    mints out-of-domain logins on allowlisted instances."""
    monkeypatch.setattr(app_settings, "AUTH_ALLOWED_EMAIL_DOMAINS", "valaris.dev")

    resp = await client.post(
        "/api/workspaces/default/members",
        json={
            "email": "outsider@elsewhere.com",
            "role": "member",
            "initial_password": INITIAL_PASSWORD,
        },
    )
    assert resp.status_code == 403
    assert resp.json()["error_code"] == "email_domain_not_allowed"

    # Without a password the invite still works, exactly as before.
    resp = await client.post(
        "/api/workspaces/default/members",
        json={"email": "outsider@elsewhere.com", "role": "member"},
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_member_cannot_add_member_with_password(
    member_client: AsyncClient, workspace_with_member: Workspace
):
    resp = await member_client.post(
        "/api/workspaces/default/members",
        json={
            "email": "sneaky@example.com",
            "role": "member",
            "initial_password": INITIAL_PASSWORD,
        },
    )
    assert resp.status_code == 403


# ── set temporary password ──


@pytest.mark.asyncio
async def test_owner_sets_temporary_password_unlocks_locked_member(
    client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
    db_session: AsyncSession,
):
    """The L6 lockout escape hatch, end to end: locked member, admin resets,
    member logs in immediately with the temporary password."""
    member_user.password_hash = hash_password("forgotten password")
    member_user.failed_login_attempts = MAX_FAILED_LOGIN_ATTEMPTS
    member_user.locked_until = datetime.now(UTC) + timedelta(minutes=10)
    await db_session.flush()

    resp = await client.post(
        f"/api/workspaces/default/members/{member_user.id}/temporary-password",
        json={"password": TEMP_PASSWORD},
    )
    assert resp.status_code == 200
    assert resp.json()["temporary_password"] == TEMP_PASSWORD

    assert await _login_status(client, member_user.email, TEMP_PASSWORD) == 200

    user = await _get_user(db_session, member_user.email)
    assert user.failed_login_attempts == 0
    assert user.locked_until is None


@pytest.mark.asyncio
async def test_temporary_password_generated_when_not_provided(
    client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
):
    resp = await client.post(
        f"/api/workspaces/default/members/{member_user.id}/temporary-password",
        json={},
    )
    assert resp.status_code == 200
    generated = resp.json()["temporary_password"]
    assert len(generated) >= MIN_PASSWORD_LENGTH

    assert await _login_status(client, member_user.email, generated) == 200


@pytest.mark.asyncio
async def test_member_cannot_set_temporary_password(
    member_client: AsyncClient,
    workspace_with_member: Workspace,
    test_user: User,
):
    resp = await member_client.post(
        f"/api/workspaces/default/members/{test_user.id}/temporary-password",
        json={"password": TEMP_PASSWORD},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_temporary_password_target_not_a_member_404(
    client: AsyncClient, test_workspace: Workspace, db_session: AsyncSession
):
    outsider = User(email="outsider@example.com", name="Out")
    db_session.add(outsider)
    await db_session.flush()

    resp = await client.post(
        f"/api/workspaces/default/members/{outsider.id}/temporary-password",
        json={"password": TEMP_PASSWORD},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_temporary_password_local_auth_disabled_404(
    client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
    monkeypatch,
):
    monkeypatch.setattr(app_settings, "LOCAL_AUTH_ENABLED", False)
    resp = await client.post(
        f"/api/workspaces/default/members/{member_user.id}/temporary-password",
        json={"password": TEMP_PASSWORD},
    )
    assert resp.status_code == 404


# ── audit trail ──


@pytest.mark.asyncio
async def test_admin_password_actions_are_recorded_as_activity(
    client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
    db_session: AsyncSession,
):
    await client.post(
        "/api/workspaces/default/members",
        json={
            "email": "new.hire@example.com",
            "role": "member",
            "initial_password": INITIAL_PASSWORD,
        },
    )
    await client.post(
        f"/api/workspaces/default/members/{member_user.id}/temporary-password",
        json={"password": TEMP_PASSWORD},
    )

    summaries = (
        (
            await db_session.execute(
                select(Activity.summary).where(
                    Activity.entity_type == ActivityEntityType.member
                )
            )
        )
        .scalars()
        .all()
    )
    assert any("initial password" in s for s in summaries)
    assert any("temporary password" in s for s in summaries)
    # Passwords themselves never reach the audit trail.
    assert all(INITIAL_PASSWORD not in s and TEMP_PASSWORD not in s for s in summaries)


@pytest.mark.asyncio
async def test_set_temporary_password_notifies_affected_user(
    client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
    db_session: AsyncSession,
):
    """Setting a temporary password is a credential change the member must
    learn about — the member/updated activity pair is mapped to the
    workspace_member category so generation notifies the affected user."""
    resp = await client.post(
        f"/api/workspaces/default/members/{member_user.id}/temporary-password",
        json={"password": TEMP_PASSWORD},
    )
    assert resp.status_code == 200

    rows = (
        (
            await db_session.execute(
                select(Notification).where(
                    Notification.recipient_user_id == member_user.id,
                    Notification.category == "workspace_member",
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].workspace_id == workspace_with_member.id
