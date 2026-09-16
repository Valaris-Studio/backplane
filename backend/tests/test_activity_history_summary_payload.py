# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Opt-in trimming of the activity HISTORY payload (`?summary=true`).

Every /history row ships three full JSONB blobs — `changes`, `before_state`,
`after_state` — while the activity feed renders only `summary` (plus actor,
entity_title and timestamps). The board-timeline REPLAY engine does need the
snapshots, but it reads a different endpoint (/timeline), which this trim
never touches. The WS reconciler reads the socket payload, not this response.

Opt-in for the same reason as everywhere else: MCP `list_activity` hands the
raw response to an agent, so the default must stay byte-identical.
"""

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace

BEFORE_STATE = {"title": "old title", "description": "x" * 2000}
AFTER_STATE = {"title": "new title", "description": "y" * 2000}
CHANGES = {"title": {"old": "old title", "new": "new title"}}


async def _seed_activity(
    db_session: AsyncSession,
    workspace: Workspace,
    board: Board,
    user: User,
) -> Activity:
    row = Activity(
        workspace_id=workspace.id,
        board_id=board.id,
        actor_id=user.id,
        entity_type=ActivityEntityType.card,
        entity_id=board.id,
        action=ActivityAction.updated,
        summary="renamed a card",
        changes=CHANGES,
        before_state=BEFORE_STATE,
        after_state=AFTER_STATE,
    )
    db_session.add(row)
    await db_session.flush()
    return row


async def test_workspace_history_summary_drops_snapshots(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_activity(db_session, test_workspace, test_board, test_user)

    response = await client.get("/api/workspaces/default/history?summary=true")

    assert response.status_code == 200
    row = response.json()[0]
    assert "changes" not in row
    assert "before_state" not in row
    assert "after_state" not in row


async def test_workspace_history_summary_keeps_rendered_fields(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Everything the feed actually renders must survive — including the
    i18n message_key/message_params pair the row prefers over `summary`."""
    await _seed_activity(db_session, test_workspace, test_board, test_user)

    response = await client.get("/api/workspaces/default/history?summary=true")

    row = response.json()[0]
    assert row["summary"] == "renamed a card"
    assert row["entity_type"] == "card"
    assert row["action"] == "updated"
    assert row["actor_email"] == "dev@valaris.dev"
    assert "message_key" in row
    assert "message_params" in row
    assert "entity_title" in row
    assert "created_at" in row
    assert "via_api_key" in row


async def test_workspace_history_default_stays_full(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """MCP list_activity sees this response."""
    await _seed_activity(db_session, test_workspace, test_board, test_user)

    response = await client.get("/api/workspaces/default/history")

    row = response.json()[0]
    assert row["changes"] == CHANGES
    assert row["before_state"] == BEFORE_STATE
    assert row["after_state"] == AFTER_STATE


async def test_board_history_summary_drops_snapshots(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_activity(db_session, test_workspace, test_board, test_user)

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/history?summary=true"
    )

    row = response.json()[0]
    assert "changes" not in row
    assert "after_state" not in row
    assert row["summary"] == "renamed a card"


async def test_board_history_default_stays_full(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_activity(db_session, test_workspace, test_board, test_user)

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/history"
    )

    assert response.json()[0]["after_state"] == AFTER_STATE


async def test_timeline_keeps_full_snapshots(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """The replay engine folds before/after snapshots — the timeline endpoint
    has no `summary` mode and must never lose them, whatever is passed."""
    await _seed_activity(db_session, test_workspace, test_board, test_user)

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/timeline?summary=true"
    )

    event = response.json()["events"][0]
    assert event["before_state"] == BEFORE_STATE
    assert event["after_state"] == AFTER_STATE
    assert event["changes"] == CHANGES


async def test_workspace_summary_embedded_activity_trims_on_opt_in(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """GET /workspaces/{slug}/summary embeds recent_activity. The dashboard
    (its only frontend consumer) renders id/entity_type/summary and nothing
    else, but MCP get_workspace_summary hands this response verbatim to an
    agent — so the trim stays opt-in here too rather than unconditional.
    """
    await _seed_activity(db_session, test_workspace, test_board, test_user)

    response = await client.get("/api/workspaces/default/summary?summary_activity=true")

    activity = response.json()["recent_activity"][0]
    assert activity["summary"] == "renamed a card"
    assert activity["entity_type"] == "card"
    assert "changes" not in activity
    assert "before_state" not in activity
    assert "after_state" not in activity


async def test_workspace_summary_default_activity_stays_full(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_activity(db_session, test_workspace, test_board, test_user)

    response = await client.get("/api/workspaces/default/summary")

    assert response.json()["recent_activity"][0]["after_state"] == AFTER_STATE
