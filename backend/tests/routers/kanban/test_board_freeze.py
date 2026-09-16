# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Board freeze — model fields, freeze/unfreeze endpoints, role matrix, events.

RED phase for the board-freeze feature:
  - Board gains is_frozen / frozen_at / frozen_by_id, exposed on BoardRead.
  - POST /boards/{id}/freeze   — workspace admin or owner, idempotent.
  - POST /boards/{id}/unfreeze — workspace owner ONLY, idempotent.
  - BoardUpdate must never be able to touch is_frozen.
  - Freezing records a board/updated activity whose changes.fields includes
    "is_frozen" (and fans out over the event bus).

The gated-mutation 409 matrix lives in test_board_freeze_gate.py; scheduler
behavior in tests/services/test_scheduler_board_freeze.py.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


BASE_URL = "/api/workspaces/default/boards"


# --- role-scoped clients (mirrors tests/routers/test_workspace_members.py) ---


def _client_app(db_session: AsyncSession, user: User):
    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    return app


async def _add_role_user(
    db_session: AsyncSession, workspace: Workspace, email: str, role: WorkspaceRole
) -> User:
    user = User(email=email, name=email.split("@")[0])
    db_session.add(user)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=role)
    )
    await db_session.flush()
    return user


@pytest_asyncio.fixture
async def admin_client(db_session: AsyncSession, test_workspace: Workspace) -> AsyncClient:
    user = await _add_role_user(
        db_session, test_workspace, "freeze-admin@valaris.dev", WorkspaceRole.admin
    )
    transport = ASGITransport(app=_client_app(db_session, user))
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture
async def member_client(db_session: AsyncSession, test_workspace: Workspace) -> AsyncClient:
    user = await _add_role_user(
        db_session, test_workspace, "freeze-member@valaris.dev", WorkspaceRole.member
    )
    transport = ASGITransport(app=_client_app(db_session, user))
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture
async def viewer_client(db_session: AsyncSession, test_workspace: Workspace) -> AsyncClient:
    user = await _add_role_user(
        db_session, test_workspace, "freeze-viewer@valaris.dev", WorkspaceRole.viewer
    )
    transport = ASGITransport(app=_client_app(db_session, user))
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def _freeze_board_orm(db_session: AsyncSession, board: Board) -> None:
    """Freeze directly at the model layer (used where the endpoint itself is
    not the behavior under test)."""
    board.is_frozen = True
    board.frozen_at = datetime.now(timezone.utc)
    await db_session.flush()


# --- schema exposure ---------------------------------------------------------


async def test_get_board_exposes_frozen_fields_defaults(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.get(f"{BASE_URL}/{test_board.id}")
    assert response.status_code == 200
    data = response.json()
    assert data["is_frozen"] is False
    assert data["frozen_at"] is None
    assert data["frozen_by_id"] is None


async def test_list_boards_exposes_is_frozen(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.get(BASE_URL)
    assert response.status_code == 200
    assert response.json()[0]["is_frozen"] is False


# --- freeze endpoint ---------------------------------------------------------


async def test_freeze_board_owner_success(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_user: User
):
    response = await client.post(f"{BASE_URL}/{test_board.id}/freeze")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["id"] == str(test_board.id)
    assert data["is_frozen"] is True
    assert data["frozen_at"] is not None
    assert data["frozen_by_id"] == str(test_user.id)


async def test_freeze_board_writes_naive_utc_frozen_at(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """frozen_at is a naive TIMESTAMP WITHOUT TIME ZONE column: asyncpg 500s
    on tz-aware datetimes in prod Postgres, but SQLite silently strips the
    offset — so pin the value the service WRITES, not what the DB reads back.
    """
    from app.repositories.base import BaseRepository

    captured: dict = {}
    original = BaseRepository.update

    async def spy(self, instance, **kwargs):
        if "frozen_at" in kwargs:
            captured.update(kwargs)
        return await original(self, instance, **kwargs)

    with patch.object(BaseRepository, "update", spy):
        response = await client.post(f"{BASE_URL}/{test_board.id}/freeze")
    assert response.status_code == 200, response.text
    assert captured["frozen_at"] is not None
    assert captured["frozen_at"].tzinfo is None


async def test_freeze_board_idempotent(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    first = await client.post(f"{BASE_URL}/{test_board.id}/freeze")
    assert first.status_code == 200, first.text
    second = await client.post(f"{BASE_URL}/{test_board.id}/freeze")
    assert second.status_code == 200, second.text
    assert second.json()["is_frozen"] is True


async def test_freeze_board_admin_success(
    admin_client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await admin_client.post(f"{BASE_URL}/{test_board.id}/freeze")
    assert response.status_code == 200, response.text
    assert response.json()["is_frozen"] is True


async def test_freeze_board_member_forbidden(
    member_client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await member_client.post(f"{BASE_URL}/{test_board.id}/freeze")
    assert response.status_code == 403


async def test_freeze_board_viewer_forbidden(
    viewer_client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await viewer_client.post(f"{BASE_URL}/{test_board.id}/freeze")
    assert response.status_code == 403


# --- unfreeze endpoint -------------------------------------------------------


async def test_unfreeze_board_owner_success(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    frozen = await client.post(f"{BASE_URL}/{test_board.id}/freeze")
    assert frozen.status_code == 200, frozen.text

    response = await client.post(f"{BASE_URL}/{test_board.id}/unfreeze")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["is_frozen"] is False
    assert data["frozen_at"] is None
    assert data["frozen_by_id"] is None


async def test_unfreeze_board_idempotent_when_not_frozen(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.post(f"{BASE_URL}/{test_board.id}/unfreeze")
    assert response.status_code == 200, response.text
    assert response.json()["is_frozen"] is False


async def test_unfreeze_board_admin_forbidden(
    client: AsyncClient,
    admin_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    frozen = await client.post(f"{BASE_URL}/{test_board.id}/freeze")
    assert frozen.status_code == 200, frozen.text

    response = await admin_client.post(f"{BASE_URL}/{test_board.id}/unfreeze")
    assert response.status_code == 403

    still_frozen = await client.get(f"{BASE_URL}/{test_board.id}")
    assert still_frozen.json()["is_frozen"] is True


async def test_unfreeze_board_member_forbidden(
    client: AsyncClient,
    member_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    frozen = await client.post(f"{BASE_URL}/{test_board.id}/freeze")
    assert frozen.status_code == 200, frozen.text

    response = await member_client.post(f"{BASE_URL}/{test_board.id}/unfreeze")
    assert response.status_code == 403


async def test_unfreeze_board_viewer_forbidden(
    client: AsyncClient,
    viewer_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    frozen = await client.post(f"{BASE_URL}/{test_board.id}/freeze")
    assert frozen.status_code == 200, frozen.text

    response = await viewer_client.post(f"{BASE_URL}/{test_board.id}/unfreeze")
    assert response.status_code == 403


# --- PATCH must never touch is_frozen ---------------------------------------


async def test_update_board_ignores_is_frozen_field(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """is_frozen is not part of BoardUpdate — pydantic drops it silently."""
    response = await client.patch(
        f"{BASE_URL}/{test_board.id}",
        json={"name": "Renamed", "is_frozen": True},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Renamed"
    assert data["is_frozen"] is False

    detail = await client.get(f"{BASE_URL}/{test_board.id}")
    assert detail.json()["is_frozen"] is False


async def test_update_board_member_cannot_thaw_via_patch(
    member_client: AsyncClient,
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    """A member PATCHing {"is_frozen": false} on a frozen board: the field is
    dropped AND the PATCH itself is rejected by the frozen gate."""
    await _freeze_board_orm(db_session, test_board)

    response = await member_client.patch(
        f"{BASE_URL}/{test_board.id}", json={"is_frozen": False}
    )
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "board_frozen"

    detail = await client.get(f"{BASE_URL}/{test_board.id}")
    assert detail.status_code == 200
    assert detail.json()["is_frozen"] is True


# --- reads stay open for every role -----------------------------------------


async def test_get_frozen_board_all_roles_can_read(
    client: AsyncClient,
    admin_client: AsyncClient,
    member_client: AsyncClient,
    viewer_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    await _freeze_board_orm(db_session, test_board)

    for role_client in (client, admin_client, member_client, viewer_client):
        response = await role_client.get(f"{BASE_URL}/{test_board.id}")
        assert response.status_code == 200
        assert response.json()["is_frozen"] is True


# --- activity + event emission ----------------------------------------------


async def test_freeze_board_records_activity_with_is_frozen_change(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    with patch("app.services.activity.event_bus") as mock_bus:
        mock_bus.publish = AsyncMock()

        response = await client.post(f"{BASE_URL}/{test_board.id}/freeze")
        assert response.status_code == 200, response.text

        published = {
            call.kwargs["event_type"] for call in mock_bus.publish.await_args_list
        }
        assert "activity.board.updated" in published

    activity = await db_session.scalar(
        select(Activity)
        .where(
            Activity.entity_type == ActivityEntityType.board,
            Activity.entity_id == test_board.id,
            Activity.action == ActivityAction.updated,
        )
        .order_by(Activity.created_at.desc())
    )
    assert activity is not None
    assert "is_frozen" in (activity.changes or {}).get("fields", [])
