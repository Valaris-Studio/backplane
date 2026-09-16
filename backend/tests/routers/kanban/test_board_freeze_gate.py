# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Frozen-board mutation gate — the 409 matrix + explicit "still allowed" pins.

RED phase: every gated mutation on a frozen board must return HTTP 409 with
{"detail": <mentions frozen>, "error_code": "board_frozen"} (a new exception
subclassing ConflictError). Reads and board-independent telemetry surfaces
stay open — those tests are green pins guarding the gate's blast radius.

Boards are frozen via direct model assignment (not the endpoint) so each
matrix test reds on the missing GATE (mutation succeeds where 409 expected),
not on the missing freeze endpoint.
"""

from datetime import datetime, timedelta, timezone

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent
from app.models.approvals.approval import (
    ApprovalCategory,
    ApprovalRequest,
    ApprovalStatus,
)
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.git.git_repo import GitRepo
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace


BOARD_URL = "/api/workspaces/default/boards"


async def _freeze_board(db_session: AsyncSession, board: Board) -> None:
    board.is_frozen = True
    board.frozen_at = datetime.now(timezone.utc)
    await db_session.flush()


def _assert_frozen_conflict(response):
    assert response.status_code == 409, (
        f"expected 409 board_frozen, got {response.status_code}: {response.text}"
    )
    body = response.json()
    assert body["error_code"] == "board_frozen"
    assert "frozen" in body["detail"].lower()


async def _make_card(
    db_session: AsyncSession, board: Board, column: Column, user: User, title: str
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        position=2048.0,
        created_by=user.id,
    )
    db_session.add(card)
    await db_session.flush()
    return card


# --- cards -------------------------------------------------------------------


async def test_create_card_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.post(
        f"{BOARD_URL}/{test_board.id}/cards",
        json={"title": "nope", "column_id": str(test_column.id)},
    )
    _assert_frozen_conflict(response)


async def test_bulk_create_cards_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.post(
        f"{BOARD_URL}/{test_board.id}/cards/bulk",
        json={"cards": [{"title": "nope", "column_id": str(test_column.id)}]},
    )
    _assert_frozen_conflict(response)


async def test_update_card_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.patch(
        f"{BOARD_URL}/{test_board.id}/cards/{test_card.id}",
        json={"title": "renamed"},
    )
    _assert_frozen_conflict(response)


async def test_move_card_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.patch(
        f"{BOARD_URL}/{test_board.id}/cards/{test_card.id}/move",
        json={"column_id": str(test_column.id), "position": 4096.0},
    )
    _assert_frozen_conflict(response)


async def test_delete_card_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.delete(f"{BOARD_URL}/{test_board.id}/cards/{test_card.id}")
    _assert_frozen_conflict(response)


async def test_add_participant_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.post(
        f"{BOARD_URL}/{test_board.id}/cards/{test_card.id}/participants",
        json={"user_id": str(test_user.id), "role": "helper"},
    )
    _assert_frozen_conflict(response)


async def test_remove_participant_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
    db_session: AsyncSession,
):
    added = await client.post(
        f"{BOARD_URL}/{test_board.id}/cards/{test_card.id}/participants",
        json={"user_id": str(test_user.id), "role": "helper"},
    )
    assert added.status_code in (200, 201), added.text

    await _freeze_board(db_session, test_board)
    response = await client.delete(
        f"{BOARD_URL}/{test_board.id}/cards/{test_card.id}/participants/{test_user.id}"
    )
    _assert_frozen_conflict(response)


async def test_claim_card_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_agent: Agent,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.post(
        f"{BOARD_URL}/{test_board.id}/cards/{test_card.id}/claim",
        json={"agent_id": str(test_agent.id)},
    )
    _assert_frozen_conflict(response)


# --- columns -----------------------------------------------------------------


async def test_create_column_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.post(
        f"{BOARD_URL}/{test_board.id}/columns", json={"name": "New Column"}
    )
    _assert_frozen_conflict(response)


async def test_update_column_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.patch(
        f"{BOARD_URL}/{test_board.id}/columns/{test_column.id}",
        json={"name": "Renamed"},
    )
    _assert_frozen_conflict(response)


async def test_delete_column_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.delete(
        f"{BOARD_URL}/{test_board.id}/columns/{test_column.id}"
    )
    _assert_frozen_conflict(response)


async def test_reorder_columns_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    db_session: AsyncSession,
):
    second = Column(
        board_id=test_board.id, name="Second", position=2048.0, color="#888"
    )
    db_session.add(second)
    await db_session.flush()

    await _freeze_board(db_session, test_board)
    response = await client.patch(
        f"{BOARD_URL}/{test_board.id}/columns/reorder",
        json={"column_ids": [str(second.id), str(test_column.id)]},
    )
    _assert_frozen_conflict(response)


# --- board -------------------------------------------------------------------


async def test_update_board_metadata_frozen_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.patch(
        f"{BOARD_URL}/{test_board.id}", json={"name": "Renamed"}
    )
    _assert_frozen_conflict(response)


async def test_delete_board_frozen_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.delete(f"{BOARD_URL}/{test_board.id}")
    _assert_frozen_conflict(response)


# --- card dependencies -------------------------------------------------------


async def test_add_dependency_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
    db_session: AsyncSession,
):
    other = await _make_card(db_session, test_board, test_column, test_user, "dep")
    await _freeze_board(db_session, test_board)
    response = await client.post(
        f"{BOARD_URL}/{test_board.id}/cards/{test_card.id}/dependencies",
        json={"depends_on_card_id": str(other.id)},
    )
    _assert_frozen_conflict(response)


async def test_remove_dependency_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
    db_session: AsyncSession,
):
    other = await _make_card(db_session, test_board, test_column, test_user, "dep")
    added = await client.post(
        f"{BOARD_URL}/{test_board.id}/cards/{test_card.id}/dependencies",
        json={"depends_on_card_id": str(other.id)},
    )
    assert added.status_code in (200, 201), added.text

    await _freeze_board(db_session, test_board)
    response = await client.delete(
        f"{BOARD_URL}/{test_board.id}/cards/{test_card.id}/dependencies/{other.id}"
    )
    _assert_frozen_conflict(response)


async def test_bulk_set_dependencies_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
    db_session: AsyncSession,
):
    other = await _make_card(db_session, test_board, test_column, test_user, "dep")
    await _freeze_board(db_session, test_board)
    response = await client.put(
        f"{BOARD_URL}/{test_board.id}/cards/{test_card.id}/dependencies",
        json={"depends_on_card_ids": [str(other.id)]},
    )
    _assert_frozen_conflict(response)


# --- board-scoped notes ------------------------------------------------------


async def test_create_board_note_frozen_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.post(
        f"{BOARD_URL}/{test_board.id}/notes",
        json={"title": "nope", "content": "frozen"},
    )
    _assert_frozen_conflict(response)


async def test_update_board_note_frozen_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_note: Note,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.put(
        f"{BOARD_URL}/{test_board.id}/notes/{test_note.id}",
        json={"title": "renamed"},
    )
    _assert_frozen_conflict(response)


async def test_delete_board_note_frozen_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_note: Note,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.delete(
        f"{BOARD_URL}/{test_board.id}/notes/{test_note.id}"
    )
    _assert_frozen_conflict(response)


# --- board-scoped resources --------------------------------------------------


async def test_create_board_resource_frozen_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.post(
        f"{BOARD_URL}/{test_board.id}/resources", json={"name": "nope.txt"}
    )
    _assert_frozen_conflict(response)


async def test_update_board_resource_frozen_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    created = await client.post(
        f"{BOARD_URL}/{test_board.id}/resources", json={"name": "keep.txt"}
    )
    assert created.status_code == 201, created.text
    resource_id = created.json()["id"]

    await _freeze_board(db_session, test_board)
    response = await client.put(
        f"{BOARD_URL}/{test_board.id}/resources/{resource_id}",
        json={"name": "renamed.txt"},
    )
    _assert_frozen_conflict(response)


async def test_delete_board_resource_frozen_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    created = await client.post(
        f"{BOARD_URL}/{test_board.id}/resources", json={"name": "keep.txt"}
    )
    assert created.status_code == 201, created.text
    resource_id = created.json()["id"]

    await _freeze_board(db_session, test_board)
    response = await client.delete(
        f"{BOARD_URL}/{test_board.id}/resources/{resource_id}"
    )
    _assert_frozen_conflict(response)


# --- definitions -------------------------------------------------------------


async def test_upsert_definition_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.put(
        f"{BOARD_URL}/{test_board.id}/definitions",
        json={"scope": "frozen scope"},
    )
    _assert_frozen_conflict(response)


# --- git repos ---------------------------------------------------------------


async def test_create_git_repo_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.post(
        f"{BOARD_URL}/{test_board.id}/git-repos",
        json={
            "name": "nope",
            "url": "https://github.com/acme/nope",
            "provider": "github",
        },
    )
    _assert_frozen_conflict(response)


async def test_update_git_repo_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo: GitRepo,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.put(
        f"{BOARD_URL}/{test_board.id}/git-repos/{test_git_repo.id}",
        json={"description": "changed"},
    )
    _assert_frozen_conflict(response)


async def test_delete_git_repo_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo: GitRepo,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.delete(
        f"{BOARD_URL}/{test_board.id}/git-repos/{test_git_repo.id}"
    )
    _assert_frozen_conflict(response)


# --- merge queue (gate keys on the GitRepo's board) --------------------------


async def test_enqueue_merge_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_git_repo: GitRepo,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.post(
        "/api/workspaces/default/merge-queue/enqueue",
        json={
            "card_id": str(test_card.id),
            "repo_id": str(test_git_repo.id),
            "pr_url": "https://github.com/valaris/test-repo/pull/1",
            "pr_branch": "feat/frozen",
        },
    )
    _assert_frozen_conflict(response)


# --- loop mode ---------------------------------------------------------------


def _loop_config_dict(enabled: bool = True) -> dict:
    """Complete canonical loop_config, seeded directly at the model layer so
    these tests red on the missing GATE, not on the missing PUT endpoint."""
    return {
        "enabled": enabled,
        "provider": "",
        "model": "mid",
        "system_prompt": "",
        "loop_prompt": "keep the board healthy",
        "tools": [],
        "max_iterations": 25,
        "iteration_delay_seconds": 30,
        "iteration_timeout_seconds": 3600,
        "budget_usd": 20.0,
        "max_consecutive_failures": 3,
        "disabled_reason": None,
        "version": 1,
        "updated_at": "2026-07-31T00:00:00",
    }


async def _configure_loop(
    db_session: AsyncSession, board: Board, enabled: bool = True
) -> None:
    board.loop_config = _loop_config_dict(enabled)
    await db_session.flush()


async def test_put_board_loop_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    await _configure_loop(db_session, test_board)
    await _freeze_board(db_session, test_board)
    response = await client.put(
        f"{BOARD_URL}/{test_board.id}/loop",
        json={"loop_prompt": "frozen boards reject loop edits"},
    )
    _assert_frozen_conflict(response)


async def test_patch_board_loop_state_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    await _configure_loop(db_session, test_board, enabled=True)
    await _freeze_board(db_session, test_board)
    response = await client.patch(
        f"{BOARD_URL}/{test_board.id}/loop/state",
        json={"enabled": False, "reason": "trying to flip a frozen board"},
    )
    _assert_frozen_conflict(response)


# --- board health ------------------------------------------------------------


async def test_escalate_stale_cards_frozen_board_conflict(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)
    response = await client.post(f"{BOARD_URL}/{test_board.id}/health/escalate")
    _assert_frozen_conflict(response)


# --- NOT gated: pins that must keep passing after the gate lands -------------


async def test_workspace_note_mutations_still_allowed_when_board_frozen(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    """Workspace-scoped notes (board_id NULL) are outside the freeze gate."""
    await _freeze_board(db_session, test_board)

    created = await client.post(
        "/api/workspaces/default/notes", json={"title": "ws note"}
    )
    assert created.status_code == 201, created.text
    note_id = created.json()["id"]

    updated = await client.put(
        f"/api/workspaces/default/notes/{note_id}", json={"title": "renamed"}
    )
    assert updated.status_code == 200, updated.text


async def test_workspace_resource_mutations_still_allowed_when_board_frozen(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)

    created = await client.post(
        "/api/workspaces/default/resources", json={"name": "ws.txt"}
    )
    assert created.status_code == 201, created.text
    resource_id = created.json()["id"]

    updated = await client.put(
        f"/api/workspaces/default/resources/{resource_id}",
        json={"name": "renamed.txt"},
    )
    assert updated.status_code == 200, updated.text


async def test_execution_logging_still_allowed_when_board_frozen(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Telemetry is exempt: agents must be able to log work against a board
    that froze mid-run."""
    await _freeze_board(db_session, test_board)

    started = await client.post(
        f"/api/agents/{test_agent.id}/executions",
        json={
            "workspace_slug": "default",
            "board_id": str(test_board.id),
            "action": "implement_card",
            "input_summary": "work on frozen board",
        },
    )
    assert started.status_code == 201, started.text
    execution_id = started.json()["id"]

    updated = await client.patch(
        f"/api/agents/{test_agent.id}/executions/{execution_id}",
        json={"output_summary": "done"},
    )
    assert updated.status_code == 200, updated.text


async def test_approval_decide_still_allowed_when_board_frozen(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_agent: Agent,
    db_session: AsyncSession,
):
    # Seed the row directly: the create endpoint auto-approves low-risk
    # categories, and a decided approval can't be decided again.
    approval = ApprovalRequest(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        category=ApprovalCategory.deletion,
        action_description="delete a stale branch",
        status=ApprovalStatus.pending,
        # Explicit: the column's server_default arithmetic doesn't round-trip
        # on the SQLite test engine.
        expires_at=datetime.utcnow() + timedelta(hours=24),
    )
    db_session.add(approval)
    await db_session.flush()

    await _freeze_board(db_session, test_board)
    decided = await client.post(
        f"/api/workspaces/default/approvals/{approval.id}/decide",
        json={"decision": "rejected", "reason": "board frozen mid-flight"},
    )
    assert decided.status_code == 200, decided.text


async def test_channel_mutations_still_allowed_when_board_frozen(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)

    created = await client.post(
        "/api/workspaces/default/channels",
        json={
            "name": "ops",
            "channel_type": "email",
            "contact_value": "ops@valaris.dev",
        },
    )
    assert created.status_code == 201, created.text
    channel_id = created.json()["id"]

    updated = await client.put(
        f"/api/workspaces/default/channels/{channel_id}",
        json={"description": "still mutable"},
    )
    assert updated.status_code == 200, updated.text

    deleted = await client.delete(f"/api/workspaces/default/channels/{channel_id}")
    assert deleted.status_code == 204, deleted.text


async def test_get_board_loop_still_readable_on_frozen_board(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    """The freeze gate blocks loop mutations only — the runner (and the
    frontend panel) must still be able to READ a frozen board's loop config."""
    await _configure_loop(db_session, test_board, enabled=True)
    await _freeze_board(db_session, test_board)

    response = await client.get(f"{BOARD_URL}/{test_board.id}/loop")
    assert response.status_code == 200, response.text
    assert response.json()["enabled"] is True


async def test_reads_still_allowed_on_frozen_board(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_note: Note,
    db_session: AsyncSession,
):
    await _freeze_board(db_session, test_board)

    detail = await client.get(f"{BOARD_URL}/{test_board.id}")
    assert detail.status_code == 200

    card = await client.get(f"{BOARD_URL}/{test_board.id}/cards/{test_card.id}")
    assert card.status_code == 200

    notes = await client.get(f"{BOARD_URL}/{test_board.id}/notes")
    assert notes.status_code == 200

    deps = await client.get(f"{BOARD_URL}/{test_board.id}/dependencies")
    assert deps.status_code == 200
