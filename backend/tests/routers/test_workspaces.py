# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from datetime import datetime, timedelta, timezone

from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution
from app.models.approvals.approval import ApprovalCategory, ApprovalRequest
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.services.activity import ActivityService


async def test_list_workspaces_empty(client: AsyncClient):
    response = await client.get("/api/workspaces")
    assert response.status_code == 200
    assert response.json() == []


async def test_list_workspaces_returns_member_workspaces(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get("/api/workspaces")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["slug"] == "default"
    assert data[0]["name"] == "Default"


async def test_list_workspaces_includes_board_and_card_counts(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board,
    test_column,
    test_card,
):
    """The list payload carries batched board_count/card_count (single query, no N+1)
    so the welcome screen can show per-workspace stats without a call per workspace."""
    response = await client.get("/api/workspaces")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["board_count"] == 1
    assert data[0]["card_count"] == 1


async def test_list_workspaces_counts_zero_when_empty(
    client: AsyncClient, test_workspace: Workspace
):
    """A workspace with no boards/cards reports 0, not null — the count columns
    must coalesce the LEFT JOIN miss to zero."""
    response = await client.get("/api/workspaces")
    assert response.status_code == 200
    data = response.json()
    assert data[0]["board_count"] == 0
    assert data[0]["card_count"] == 0


async def test_list_workspaces_last_activity_reflects_board_card_work(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    test_board,
):
    """The Activity sort signal must reflect work INSIDE the workspace (board/card
    edits), not just workspace-row mutation. last_activity_at is derived from the
    newest activity row, so a card edit bubbles the workspace up the list."""
    activity = ActivityService(db_session)
    await activity.record(
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.card,
        entity_id=test_board.id,
        action=ActivityAction.created,
        board_id=test_board.id,
        summary="created a card",
    )
    await db_session.flush()

    response = await client.get("/api/workspaces")
    assert response.status_code == 200
    data = response.json()
    assert data[0]["last_activity_at"] is not None


async def test_list_workspaces_last_activity_null_without_activity(
    client: AsyncClient, test_workspace: Workspace
):
    """No activity rows → last_activity_at is null (the frontend falls back to
    updated_at). It must not error or fabricate a timestamp."""
    response = await client.get("/api/workspaces")
    assert response.status_code == 200
    data = response.json()
    assert data[0]["last_activity_at"] is None


async def test_create_workspace_success(client: AsyncClient, test_user: User):
    response = await client.post(
        "/api/workspaces", json={"name": "New Workspace", "slug": "new-ws"}
    )
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "New Workspace"
    assert data["slug"] == "new-ws"
    assert data["created_by"] == str(test_user.id)


async def test_create_workspace_duplicate_slug_is_idempotent(
    client: AsyncClient, test_workspace: Workspace
):
    """Retrying create_workspace with an existing slug returns the existing row.

    The caller here is the workspace's CREATOR (and owner) — the original
    reason for the idempotency: LLM agents retry on failure, and a retried
    create must not error. Card 3dfd1412 narrows the idempotency to members;
    this creator/owner case must stay green through it."""
    response = await client.post(
        "/api/workspaces", json={"name": "Another", "slug": "default"}
    )
    assert response.status_code == 201
    data = response.json()
    assert data["slug"] == "default"
    assert data["id"] == str(test_workspace.id)


async def test_get_workspace_detail(client: AsyncClient, test_workspace: Workspace):
    response = await client.get("/api/workspaces/default")
    assert response.status_code == 200
    data = response.json()
    assert data["slug"] == "default"
    assert data["name"] == "Default"
    assert data["id"] == str(test_workspace.id)


async def test_get_workspace_not_found(client: AsyncClient, test_user: User):
    response = await client.get("/api/workspaces/nonexistent")
    assert response.status_code == 404


async def test_update_workspace_as_owner(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.put(
        "/api/workspaces/default", json={"name": "Updated Name"}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Updated Name"
    assert data["slug"] == "default"


async def test_delete_workspace_as_owner(
    client: AsyncClient,
    test_workspace: Workspace,
    db_session: AsyncSession,
):
    response = await client.delete("/api/workspaces/default")
    assert response.status_code == 204


async def test_delete_workspace_with_content(
    client: AsyncClient,
    test_workspace: Workspace,
    test_agent: Agent,
    db_session: AsyncSession,
):
    created = await client.post(
        "/api/workspaces/default/boards", json={"name": "Content Board"}
    )
    assert created.status_code == 201
    board_id = created.json()["id"]
    columns = (
        await client.get(f"/api/workspaces/default/boards/{board_id}")
    ).json()["columns"]
    response = await client.post(
        f"/api/workspaces/default/boards/{board_id}/cards",
        json={"title": "A Card", "column_id": columns[0]["id"]},
    )
    assert response.status_code == 201

    db_session.add(
        AgentExecution(
            agent_id=test_agent.id,
            workspace_id=test_workspace.id,
            action="test_action",
        )
    )
    db_session.add(
        ApprovalRequest(
            agent_id=test_agent.id,
            workspace_id=test_workspace.id,
            category=ApprovalCategory.deletion,
            action_description="delete something",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=24),
        )
    )
    await db_session.flush()

    async def count_for_workspace(model):
        return await db_session.scalar(
            select(func.count())
            .select_from(model)
            .where(model.workspace_id == test_workspace.id)
        )

    assert await count_for_workspace(Activity) >= 1

    response = await client.delete("/api/workspaces/default")
    assert response.status_code == 204

    assert await count_for_workspace(Activity) == 0
    assert await count_for_workspace(AgentExecution) == 0
    assert await count_for_workspace(ApprovalRequest) == 0


async def test_list_members(client: AsyncClient, test_workspace: Workspace, test_user: User):
    response = await client.get("/api/workspaces/default/members")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["email"] == "dev@valaris.dev"
    assert data[0]["role"] == "owner"
    assert data[0]["user_id"] == str(test_user.id)


async def test_add_member(
    client: AsyncClient,
    test_workspace: Workspace,
    db_session: AsyncSession,
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
    test_workspace: Workspace,
    second_user: User,
    db_session: AsyncSession,
):
    """Re-adding an existing member returns 201 with the existing membership."""
    member = WorkspaceMember(
        workspace_id=test_workspace.id,
        user_id=second_user.id,
        role=WorkspaceRole.member,
    )
    db_session.add(member)
    await db_session.flush()

    response = await client.post(
        "/api/workspaces/default/members",
        json={"email": "other@valaris.dev", "role": "member"},
    )
    assert response.status_code == 201
    assert response.json() == {"status": "ok"}


async def test_remove_member(
    client: AsyncClient,
    test_workspace: Workspace,
    second_user: User,
    db_session: AsyncSession,
):
    # Add second_user as member
    member = WorkspaceMember(
        workspace_id=test_workspace.id,
        user_id=second_user.id,
        role=WorkspaceRole.member,
    )
    db_session.add(member)
    await db_session.flush()

    response = await client.delete(
        f"/api/workspaces/default/members/{second_user.id}"
    )
    assert response.status_code == 204

    # Verify member is gone
    members_response = await client.get("/api/workspaces/default/members")
    members = members_response.json()
    member_ids = [m["user_id"] for m in members]
    assert str(second_user.id) not in member_ids


# --- ownership invariant: a colliding create never changes the owner set ---
#
# The slug-collision branch of create_workspace returns the EXISTING workspace
# early, skipping the owner-minting line — correct, because the workspace
# already has its owner. These pins hold the invariant (card cd87225e): no
# colliding create may enroll the caller or disturb the existing owner row.
# Pinned at the DB level, and with a MEMBER as the colliding caller, so card
# 3dfd1412 (members-only idempotency + 409 for strangers) only has to touch
# response-shape assertions, not these.


import pytest_asyncio
from httpx import ASGITransport

from app.database import get_db
from app.main import create_app


@pytest_asyncio.fixture
async def header_auth_client(db_session: AsyncSession) -> AsyncClient:
    """No get_current_user override: dev-tier X-User-Email picks the caller,
    so one test can act as different users."""
    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def _owner_rows(db: AsyncSession, workspace: Workspace):
    return (
        (
            await db.execute(
                select(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == workspace.id,
                    WorkspaceMember.role == WorkspaceRole.owner,
                )
            )
        )
        .scalars()
        .all()
    )


async def test_create_workspace_slug_collision_by_member_keeps_owner_set(
    header_auth_client: AsyncClient, test_workspace: Workspace,
    test_user: User, second_user: User, db_session: AsyncSession,
):
    """A plain member retrying create on an existing slug gets the existing
    workspace back, is NOT promoted, and the owner set is untouched."""
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.member,
        )
    )
    await db_session.flush()

    response = await header_auth_client.post(
        "/api/workspaces",
        json={"name": "Retry", "slug": "default"},
        headers={"X-User-Email": second_user.email},
    )
    assert response.status_code == 201, response.text
    assert response.json()["id"] == str(test_workspace.id)

    rows = (
        (
            await db_session.execute(
                select(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == test_workspace.id,
                    WorkspaceMember.user_id == second_user.id,
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].role == WorkspaceRole.member, (
        "colliding create changed the caller's role"
    )

    owners = await _owner_rows(db_session, test_workspace)
    assert [o.user_id for o in owners] == [test_user.id], (
        "colliding create disturbed the owner set"
    )


async def test_create_workspace_slug_collision_by_stranger_keeps_owner_set(
    header_auth_client: AsyncClient, test_workspace: Workspace,
    test_user: User, second_user: User, db_session: AsyncSession,
):
    """A non-member colliding on the slug must not be enrolled at any role.
    Deliberately asserts NOTHING about the response (card 3dfd1412 will turn
    this from 201-returns-existing into 409): the pin is the DB invariant."""
    await header_auth_client.post(
        "/api/workspaces",
        json={"name": "Squat", "slug": "default"},
        headers={"X-User-Email": second_user.email},
    )

    stranger_rows = (
        (
            await db_session.execute(
                select(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == test_workspace.id,
                    WorkspaceMember.user_id == second_user.id,
                )
            )
        )
        .scalars()
        .all()
    )
    assert stranger_rows == [], "colliding create enrolled a stranger"

    owners = await _owner_rows(db_session, test_workspace)
    assert [o.user_id for o in owners] == [test_user.id], (
        "colliding create disturbed the owner set"
    )


# --- slug collision: idempotent for members, 409 for strangers (3dfd1412) ---
#
# Today ANY caller colliding on a slug receives the full existing-workspace
# payload — a cross-tenant metadata oracle (id, name, created_at of someone
# else's workspace, keyed by slug guessing). The owner-decided contract:
# any membership row keeps the idempotent existing-workspace response;
# non-members get a metadata-free 409. The cd87225e pins above stay as the
# owner-set invariant; the tests below own the response shape.


async def test_create_workspace_slug_collision_by_stranger_conflicts(
    header_auth_client: AsyncClient, test_workspace: Workspace,
    second_user: User,
):
    """RED: a non-member colliding on the slug must get 409 with the house
    conflict envelope and learn NOTHING about the existing workspace."""
    response = await header_auth_client.post(
        "/api/workspaces",
        json={"name": "Squat", "slug": "default"},
        headers={"X-User-Email": second_user.email},
    )
    assert response.status_code == 409, (
        "stranger slug collision leaked the existing workspace: "
        f"{response.status_code}: {response.text}"
    )
    body = response.json()
    assert body["error_code"] == "conflict"
    for leaked_key in ("id", "name", "created_at", "created_by"):
        assert leaked_key not in body, f"conflict body leaks '{leaked_key}'"
    # These raw-text scans are the LOAD-BEARING leak assertions: metadata
    # smuggled into the detail string passes the body-key checks above.
    assert str(test_workspace.id) not in response.text
    assert "Default" not in response.text, (
        "conflict body leaks the existing workspace's name"
    )


async def test_create_workspace_slug_collision_by_new_user_conflicts(
    header_auth_client: AsyncClient, test_workspace: Workspace,
):
    """RED: a just-auto-provisioned account (never seen before, so it cannot
    hold any membership) colliding on the slug is the pure oracle probe."""
    response = await header_auth_client.post(
        "/api/workspaces",
        json={"name": "Probe", "slug": "default"},
        headers={"X-User-Email": "brand.new.prober@valaris.dev"},
    )
    assert response.status_code == 409, (
        "brand-new user harvested workspace metadata by slug collision: "
        f"{response.status_code}: {response.text}"
    )
    assert str(test_workspace.id) not in response.text


async def test_create_workspace_slug_collision_by_member_returns_existing(
    header_auth_client: AsyncClient, test_workspace: Workspace,
    test_user: User, second_user: User, db_session: AsyncSession,
):
    """GREEN: a plain member keeps the idempotent response — the full existing
    workspace, unmodified (not renamed to the retried payload's name). This is
    the response-shape half the cd87225e owner-set pin deliberately left to
    this card."""
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.member,
        )
    )
    await db_session.flush()

    response = await header_auth_client.post(
        "/api/workspaces",
        json={"name": "Renamed Attempt", "slug": "default"},
        headers={"X-User-Email": second_user.email},
    )
    assert response.status_code in (200, 201), response.text
    data = response.json()
    assert data["id"] == str(test_workspace.id)
    assert data["slug"] == "default"
    assert data["name"] == "Default", "collision must not rename the workspace"
    assert data["created_by"] == str(test_user.id)
