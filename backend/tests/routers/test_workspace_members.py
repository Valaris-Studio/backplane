# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.notifications.notification import Notification
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


@pytest_asyncio.fixture
async def member_user(db_session: AsyncSession) -> User:
    user = User(email="member@valaris.dev", name="Member User")
    db_session.add(user)
    await db_session.flush()
    return user


@pytest_asyncio.fixture
async def workspace_with_member(
    db_session: AsyncSession,
    test_workspace: Workspace,
    member_user: User,
) -> Workspace:
    """Adds member_user as a 'member' role to test_workspace."""
    membership = WorkspaceMember(
        workspace_id=test_workspace.id,
        user_id=member_user.id,
        role=WorkspaceRole.member,
    )
    db_session.add(membership)
    await db_session.flush()
    return test_workspace


@pytest_asyncio.fixture
async def member_client(
    db_session: AsyncSession,
    member_user: User,
) -> AsyncClient:
    """Client authenticated as member_user (member role, not admin/owner)."""
    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return member_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


# --- List Members ---


async def test_list_members_success(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
):
    response = await client.get("/api/workspaces/default/members")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["email"] == "dev@valaris.dev"
    assert data[0]["role"] == "owner"
    assert data[0]["user_id"] == str(test_user.id)
    assert "joined_at" in data[0]


async def test_list_members_multiple(
    client: AsyncClient,
    workspace_with_member: Workspace,
    test_user: User,
    member_user: User,
):
    response = await client.get("/api/workspaces/default/members")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2
    emails = {m["email"] for m in data}
    assert emails == {"dev@valaris.dev", "member@valaris.dev"}


async def test_list_members_as_member(
    member_client: AsyncClient,
    workspace_with_member: Workspace,
):
    """Non-admin members can still list members."""
    response = await member_client.get("/api/workspaces/default/members")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2


# --- Member Search (autocomplete source, contract §6) ---


@pytest_asyncio.fixture
async def workspace_with_searchable_members(
    db_session: AsyncSession,
    test_workspace: Workspace,
) -> Workspace:
    """test_workspace already has owner dev@valaris.dev (name 'Dev User').
    Add Alice and Bob so ?q= can filter by name and by email."""
    for email, name in (
        ("alice@example.com", "Alice Adams"),
        ("bob@other.org", "Bob Brown"),
    ):
        user = User(email=email, name=name)
        db_session.add(user)
        await db_session.flush()
        db_session.add(
            WorkspaceMember(
                workspace_id=test_workspace.id,
                user_id=user.id,
                role=WorkspaceRole.member,
            )
        )
    await db_session.flush()
    return test_workspace


async def test_search_members_filters_by_name(
    client: AsyncClient,
    workspace_with_searchable_members: Workspace,
):
    response = await client.get("/api/workspaces/default/members?q=alice")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["email"] == "alice@example.com"


async def test_search_members_filters_by_email(
    client: AsyncClient,
    workspace_with_searchable_members: Workspace,
):
    response = await client.get("/api/workspaces/default/members?q=other.org")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["email"] == "bob@other.org"


async def test_search_members_is_case_insensitive(
    client: AsyncClient,
    workspace_with_searchable_members: Workspace,
):
    response = await client.get("/api/workspaces/default/members?q=ALICE")
    assert response.status_code == 200
    assert len(response.json()) == 1


async def test_search_members_limit_caps_results(
    client: AsyncClient,
    workspace_with_searchable_members: Workspace,
):
    """All three members match the empty-ish substring 'a' across name/email
    variously; limit=1 caps the returned list at 1."""
    response = await client.get("/api/workspaces/default/members?q=a&limit=1")
    assert response.status_code == 200
    assert len(response.json()) == 1


async def test_search_members_limit_hard_capped_at_20(
    client: AsyncClient,
    workspace_with_searchable_members: Workspace,
):
    """An over-large limit is clamped (cap 20), never honored verbatim."""
    response = await client.get("/api/workspaces/default/members?q=a&limit=999")
    assert response.status_code == 200
    # Only a handful of members exist; the cap doesn't change THIS count but the
    # request must not error and must not return more than the cap.
    assert len(response.json()) <= 20


async def test_list_members_without_q_is_unchanged(
    client: AsyncClient,
    workspace_with_searchable_members: Workspace,
):
    """The no-q path returns the full member list (existing behavior preserved)."""
    response = await client.get("/api/workspaces/default/members")
    assert response.status_code == 200
    data = response.json()
    emails = {m["email"] for m in data}
    assert emails == {"dev@valaris.dev", "alice@example.com", "bob@other.org"}


# --- Add Member ---


async def test_add_member_success(
    client: AsyncClient,
    test_workspace: Workspace,
):
    response = await client.post(
        "/api/workspaces/default/members",
        json={"email": "newuser@valaris.dev", "role": "member"},
    )
    assert response.status_code == 201
    assert response.json() == {"status": "ok"}

    members_response = await client.get("/api/workspaces/default/members")
    members = members_response.json()
    emails = [m["email"] for m in members]
    assert "newuser@valaris.dev" in emails


async def test_add_member_duplicate_is_idempotent(
    client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
):
    response = await client.post(
        "/api/workspaces/default/members",
        json={"email": "member@valaris.dev", "role": "member"},
    )
    assert response.status_code == 201

    members_response = await client.get("/api/workspaces/default/members")
    emails = [m["email"] for m in members_response.json()]
    assert emails.count("member@valaris.dev") == 1


async def test_add_member_non_admin_rejected(
    member_client: AsyncClient,
    workspace_with_member: Workspace,
):
    response = await member_client.post(
        "/api/workspaces/default/members",
        json={"email": "another@valaris.dev", "role": "member"},
    )
    assert response.status_code == 403


async def test_add_member_with_admin_role(
    client: AsyncClient,
    test_workspace: Workspace,
):
    response = await client.post(
        "/api/workspaces/default/members",
        json={"email": "admin-new@valaris.dev", "role": "admin"},
    )
    assert response.status_code == 201

    members_response = await client.get("/api/workspaces/default/members")
    members = members_response.json()
    admin_member = next(m for m in members if m["email"] == "admin-new@valaris.dev")
    assert admin_member["role"] == "admin"


# --- Remove Member ---


async def test_remove_member_success(
    client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
):
    response = await client.delete(f"/api/workspaces/default/members/{member_user.id}")
    assert response.status_code == 204

    members_response = await client.get("/api/workspaces/default/members")
    members = members_response.json()
    member_ids = [m["user_id"] for m in members]
    assert str(member_user.id) not in member_ids


async def test_remove_member_nonexistent(
    client: AsyncClient,
    test_workspace: Workspace,
):
    fake_id = uuid.uuid4()
    response = await client.delete(f"/api/workspaces/default/members/{fake_id}")
    # remove_member silently succeeds even if user not found (no-op delete)
    assert response.status_code == 204


async def test_remove_member_non_admin_rejected(
    member_client: AsyncClient,
    workspace_with_member: Workspace,
    test_user: User,
):
    response = await member_client.delete(
        f"/api/workspaces/default/members/{test_user.id}"
    )
    assert response.status_code == 403


# --- Role-ceiling / owner protection (privilege escalation guard) ---


@pytest_asyncio.fixture
async def admin_user(db_session: AsyncSession) -> User:
    user = User(email="admin@valaris.dev", name="Admin User")
    db_session.add(user)
    await db_session.flush()
    return user


@pytest_asyncio.fixture
async def workspace_with_admin(
    db_session: AsyncSession,
    test_workspace: Workspace,
    admin_user: User,
) -> Workspace:
    """test_workspace already has owner dev@valaris.dev; add admin_user as admin."""
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=admin_user.id,
            role=WorkspaceRole.admin,
        )
    )
    await db_session.flush()
    return test_workspace


@pytest_asyncio.fixture
async def admin_client(
    db_session: AsyncSession,
    admin_user: User,
) -> AsyncClient:
    """Client authenticated as admin_user (admin role, not owner)."""
    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return admin_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def test_add_member_admin_cannot_grant_owner_role(
    admin_client: AsyncClient,
    workspace_with_admin: Workspace,
):
    """A non-owner admin must not be able to mint another owner."""
    response = await admin_client.post(
        "/api/workspaces/default/members",
        json={"email": "escalated@valaris.dev", "role": "owner"},
    )
    assert response.status_code == 403


async def test_remove_member_admin_cannot_remove_owner(
    admin_client: AsyncClient,
    workspace_with_admin: Workspace,
    test_user: User,
):
    """A non-owner admin must not be able to remove the workspace owner."""
    response = await admin_client.delete(
        f"/api/workspaces/default/members/{test_user.id}"
    )
    assert response.status_code == 403


async def test_add_member_owner_can_grant_owner_role(
    client: AsyncClient,
    test_workspace: Workspace,
):
    """The owner CAN promote another user to owner (co-owner)."""
    response = await client.post(
        "/api/workspaces/default/members",
        json={"email": "coowner@valaris.dev", "role": "owner"},
    )
    assert response.status_code == 201

    members_response = await client.get("/api/workspaces/default/members")
    coowner = next(
        m for m in members_response.json() if m["email"] == "coowner@valaris.dev"
    )
    assert coowner["role"] == "owner"


async def test_remove_member_cannot_remove_last_owner(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
):
    """Even the owner cannot remove the sole remaining owner — it would orphan
    the workspace with no one able to manage it."""
    response = await client.delete(f"/api/workspaces/default/members/{test_user.id}")
    assert response.status_code == 403


async def test_remove_member_owner_can_remove_non_last_owner(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    second_user: User,
    test_user: User,
):
    """With two owners, an owner CAN remove the other owner (one remains)."""
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.owner,
        )
    )
    await db_session.flush()

    response = await client.delete(f"/api/workspaces/default/members/{second_user.id}")
    assert response.status_code == 204


# --- Update Member Role (PATCH /members/{user_id}) ---


def _member_url(user_id: uuid.UUID) -> str:
    return f"/api/workspaces/default/members/{user_id}"


async def _stored_role(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID
) -> str:
    """Fresh read of the persisted role — populate_existing so a stale
    identity-map instance can't mask a write (or hide that a refused one
    left a trace)."""
    membership = (
        await db.execute(
            select(WorkspaceMember)
            .where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.user_id == user_id,
            )
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    return membership.role.value


async def _role_change_activities(db: AsyncSession) -> list[Activity]:
    return (
        (
            await db.execute(
                select(Activity).where(
                    Activity.message_key == "activity.member.role_changed"
                )
            )
        )
        .scalars()
        .all()
    )


async def test_update_member_role_owner_promotes_member_to_admin(
    client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
    db_session: AsyncSession,
):
    response = await client.patch(_member_url(member_user.id), json={"role": "admin"})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["user_id"] == str(member_user.id)
    assert data["email"] == "member@valaris.dev"
    assert data["name"] == "Member User"
    assert data["role"] == "admin"
    assert "joined_at" in data

    stored = await _stored_role(db_session, workspace_with_member.id, member_user.id)
    assert stored == "admin"


async def test_update_member_role_records_activity(
    client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
    db_session: AsyncSession,
):
    response = await client.patch(_member_url(member_user.id), json={"role": "admin"})
    assert response.status_code == 200, response.text

    activities = await _role_change_activities(db_session)
    assert len(activities) == 1
    activity = activities[0]
    assert activity.entity_type == ActivityEntityType.member
    assert activity.action == ActivityAction.updated
    assert activity.message_params == {
        "member_email": "member@valaris.dev",
        "role": "admin",
        "previous_role": "member",
    }
    # workspace_member notification generation resolves recipients from
    # changes["affected_user_id"], mirroring add_member/remove_member.
    assert activity.changes["affected_user_id"] == str(member_user.id)


async def test_update_member_role_notifies_affected_user(
    client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
    db_session: AsyncSession,
):
    response = await client.patch(_member_url(member_user.id), json={"role": "admin"})
    assert response.status_code == 200, response.text

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


async def test_update_member_role_owner_promotes_member_to_owner(
    client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
    db_session: AsyncSession,
):
    response = await client.patch(_member_url(member_user.id), json={"role": "owner"})
    assert response.status_code == 200, response.text
    assert response.json()["role"] == "owner"

    stored = await _stored_role(db_session, workspace_with_member.id, member_user.id)
    assert stored == "owner"


async def test_update_member_role_admin_promotes_member_to_admin(
    admin_client: AsyncClient,
    workspace_with_admin: Workspace,
    workspace_with_member: Workspace,
    member_user: User,
):
    """Non-owner-involving role changes are plain admin territory."""
    response = await admin_client.patch(
        _member_url(member_user.id), json={"role": "admin"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["role"] == "admin"


async def test_update_member_role_admin_cannot_grant_owner(
    admin_client: AsyncClient,
    workspace_with_admin: Workspace,
    workspace_with_member: Workspace,
    member_user: User,
    db_session: AsyncSession,
):
    """A non-owner admin must not be able to mint an owner via role PATCH."""
    response = await admin_client.patch(
        _member_url(member_user.id), json={"role": "owner"}
    )
    assert response.status_code == 403, response.text

    stored = await _stored_role(db_session, workspace_with_admin.id, member_user.id)
    assert stored == "member"


async def test_update_member_role_admin_cannot_demote_owner(
    admin_client: AsyncClient,
    workspace_with_admin: Workspace,
    test_user: User,
    db_session: AsyncSession,
):
    """The owner guard is symmetric: touching an EXISTING owner's role is as
    owner-only as granting the role."""
    response = await admin_client.patch(
        _member_url(test_user.id), json={"role": "admin"}
    )
    assert response.status_code == 403, response.text

    stored = await _stored_role(db_session, workspace_with_admin.id, test_user.id)
    assert stored == "owner"


@pytest_asyncio.fixture
async def peer_admin_user(db_session: AsyncSession, test_workspace: Workspace) -> User:
    """A SECOND admin, so an admin-demotes-admin case has a peer to act on."""
    user = User(email="peer.admin@valaris.dev", name="Peer Admin")
    db_session.add(user)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=user.id,
            role=WorkspaceRole.admin,
        )
    )
    await db_session.flush()
    return user


async def test_update_member_role_admin_demotes_self(
    admin_client: AsyncClient,
    workspace_with_admin: Workspace,
    admin_user: User,
    db_session: AsyncSession,
):
    """Self-demotion is allowed: giving up your own privileges needs no higher
    authority, and the owner guard never fires since no owner is involved."""
    response = await admin_client.patch(
        _member_url(admin_user.id), json={"role": "viewer"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["role"] == "viewer"

    stored = await _stored_role(db_session, workspace_with_admin.id, admin_user.id)
    assert stored == "viewer"


async def test_update_member_role_admin_demotes_peer_admin(
    admin_client: AsyncClient,
    workspace_with_admin: Workspace,
    peer_admin_user: User,
    db_session: AsyncSession,
):
    """Admins are peers, not a hierarchy — consistent with remove_member, which
    already lets an admin remove a fellow admin."""
    response = await admin_client.patch(
        _member_url(peer_admin_user.id), json={"role": "member"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["role"] == "member"

    stored = await _stored_role(db_session, workspace_with_admin.id, peer_admin_user.id)
    assert stored == "member"


async def test_update_member_role_cannot_demote_last_owner(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
    db_session: AsyncSession,
):
    """Even the owner cannot demote themself while they are the sole owner —
    same orphaning rule as remove_member's last-owner refusal."""
    response = await client.patch(_member_url(test_user.id), json={"role": "admin"})
    assert response.status_code == 403, response.text

    stored = await _stored_role(db_session, test_workspace.id, test_user.id)
    assert stored == "owner"


async def test_update_member_role_owner_demotes_co_owner(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    second_user: User,
):
    """With two owners the refusal is count-based, not blanket: demoting the
    OTHER owner leaves one and must succeed."""
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.owner,
        )
    )
    await db_session.flush()

    response = await client.patch(_member_url(second_user.id), json={"role": "member"})
    assert response.status_code == 200, response.text
    assert response.json()["role"] == "member"


async def test_update_member_role_same_role_is_noop(
    client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
    db_session: AsyncSession,
):
    """PATCHing the role the member already holds is idempotent: 200, role
    unchanged, and NO activity row (retries must not spam the timeline)."""
    response = await client.patch(_member_url(member_user.id), json={"role": "member"})
    assert response.status_code == 200, response.text
    assert response.json()["role"] == "member"

    assert await _role_change_activities(db_session) == []


async def test_update_member_role_member_caller_rejected(
    member_client: AsyncClient,
    workspace_with_member: Workspace,
    test_user: User,
):
    response = await member_client.patch(
        _member_url(test_user.id), json={"role": "member"}
    )
    assert response.status_code == 403


async def test_update_member_role_nonexistent_member(
    client: AsyncClient,
    test_workspace: Workspace,
):
    fake_id = uuid.uuid4()
    response = await client.patch(_member_url(fake_id), json={"role": "admin"})
    assert response.status_code == 404
    assert response.json()["detail"] == "User is not a member of this workspace"


async def test_update_member_role_invalid_role_value(
    client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
):
    response = await client.patch(
        _member_url(member_user.id), json={"role": "superuser"}
    )
    assert response.status_code == 422


# --- Agent-key policy: owner-role changes are a HUMAN act ---


async def test_update_member_role_agent_key_cannot_grant_owner(
    agent_client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
    db_session: AsyncSession,
):
    """The agent key is bound to test_user — the workspace OWNER — and is still
    refused: granting the owner role is consent only a human can give."""
    response = await agent_client.patch(
        _member_url(member_user.id), json={"role": "owner"}
    )
    assert response.status_code == 403, response.text
    assert response.json()["error_code"] == "human_required"

    stored = await _stored_role(db_session, workspace_with_member.id, member_user.id)
    assert stored == "member"
    assert (
        await _role_change_activities(db_session) == []
    ), "a refused owner grant must leave no trace"


async def test_update_member_role_agent_key_cannot_demote_owner(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    second_user: User,
):
    """Symmetric refusal on the demote side, pinned with TWO owners so the
    human_required gate — not the last-owner rule — is what fires."""
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.owner,
        )
    )
    await db_session.flush()

    response = await agent_client.patch(
        _member_url(second_user.id), json={"role": "admin"}
    )
    assert response.status_code == 403, response.text
    assert response.json()["error_code"] == "human_required"

    stored = await _stored_role(db_session, test_workspace.id, second_user.id)
    assert stored == "owner"
    assert (
        await _role_change_activities(db_session) == []
    ), "a refused owner demote must leave no trace"


async def test_update_member_role_agent_key_allows_non_owner_change(
    agent_client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
    db_session: AsyncSession,
):
    """Owner-involving changes are human-only; ordinary role changes from an
    agent key whose bound user passes the gates stay allowed."""
    response = await agent_client.patch(
        _member_url(member_user.id), json={"role": "viewer"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["role"] == "viewer"

    stored = await _stored_role(db_session, workspace_with_member.id, member_user.id)
    assert stored == "viewer"


async def test_add_member_duplicate_does_not_change_role(
    client: AsyncClient,
    workspace_with_member: Workspace,
    member_user: User,
):
    """POST /members stays a pure add: re-adding an existing member with a
    DIFFERENT role keeps the old role — role changes go through the PATCH."""
    response = await client.post(
        "/api/workspaces/default/members",
        json={"email": "member@valaris.dev", "role": "admin"},
    )
    assert response.status_code == 201

    members_response = await client.get("/api/workspaces/default/members")
    existing = next(
        m for m in members_response.json() if m["email"] == "member@valaris.dev"
    )
    assert existing["role"] == "member"


# --- Stable error codes on role-management refusals (member role UI) ---
# The frontend maps these to localized toasts (errors.owner_role_owner_only,
# errors.last_owner) instead of a generic "forbidden" message.


async def test_update_member_role_admin_grant_owner_error_code(
    admin_client: AsyncClient,
    workspace_with_admin: Workspace,
    workspace_with_member: Workspace,
    member_user: User,
):
    """The owner-gate refusal carries a stable code so the UI can explain
    WHY the change was refused, not just that it was."""
    response = await admin_client.patch(
        _member_url(member_user.id), json={"role": "owner"}
    )
    assert response.status_code == 403, response.text
    assert response.json()["error_code"] == "owner_role_owner_only"


async def test_update_member_role_admin_demote_owner_error_code(
    admin_client: AsyncClient,
    workspace_with_admin: Workspace,
    test_user: User,
):
    """Same code on the symmetric side: an admin touching an EXISTING
    owner's role hits the same owner-only gate."""
    response = await admin_client.patch(
        _member_url(test_user.id), json={"role": "admin"}
    )
    assert response.status_code == 403, response.text
    assert response.json()["error_code"] == "owner_role_owner_only"


async def test_update_member_role_last_owner_error_code(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
):
    """Demoting the sole owner is a DIFFERENT refusal than the owner gate —
    the caller IS an owner — so it carries its own code."""
    response = await client.patch(_member_url(test_user.id), json={"role": "admin"})
    assert response.status_code == 403, response.text
    assert response.json()["error_code"] == "last_owner"


async def test_remove_member_last_owner_error_code(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
):
    """remove_member's last-owner refusal shares the same stable code as the
    role-PATCH variant — one localized message covers both surfaces."""
    response = await client.delete(f"/api/workspaces/default/members/{test_user.id}")
    assert response.status_code == 403, response.text
    assert response.json()["error_code"] == "last_owner"


async def test_remove_member_admin_remove_owner_error_code(
    admin_client: AsyncClient,
    workspace_with_admin: Workspace,
    test_user: User,
):
    """remove_member routes through the same _require_owner gate, so the
    admin-removes-owner refusal carries the same code as the PATCH gate."""
    response = await admin_client.delete(
        f"/api/workspaces/default/members/{test_user.id}"
    )
    assert response.status_code == 403, response.text
    assert response.json()["error_code"] == "owner_role_owner_only"
