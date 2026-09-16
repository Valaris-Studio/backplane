# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from datetime import datetime, timedelta

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace


# ---------------------------------------------------------------------------
# Card 6c036f0b — the full loop iteration log.
#
# `Recent iterations` in BoardLoopDialog shows the newest slice and nothing
# else, so a 30-70 iteration run is unreadable: no way to page back to the
# start, isolate the failures, or find the iteration that touched a card.
#
# The locked design keeps GET /api/workspaces/{slug}/executions returning a
# BARE ARRAY (six existing tests and the frontend's `Execution[]` typing
# depend on that shape) and extends it with additive query params:
# `offset`, `outcome`, `q`, `since`, `until`. The unpaged count the UI needs
# for "showing N of M" rides an `X-Total-Count` RESPONSE HEADER, which no
# existing consumer can notice.
#
# `outcome` has no column: the runner encodes it as an `outcome=<value>`
# prefix inside output_summary (runner/internal/workloop/loopmode.go). The
# filter therefore matches that token, NOT a bare substring — searching for
# `worked` must not match an iteration whose prose merely says "worked".
# ---------------------------------------------------------------------------

BASE = datetime(2026, 6, 1, 0, 0, 0)


async def _seed_iterations(
    db_session: AsyncSession,
    workspace: Workspace,
    board: Board,
    user: User,
    count: int,
) -> Agent:
    """`count` loop_iteration rows, newest last, each an hour apart.

    Every fourth row is a `nothing_ready` outcome; the rest are `worked`, so
    outcome filtering has a predictable minority to isolate.
    """
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=user.id)
    db_session.add(agent)
    await db_session.flush()

    rows = []
    for i in range(count):
        outcome = "nothing_ready" if i % 4 == 3 else "worked"
        rows.append(
            AgentExecution(
                agent_id=agent.id,
                workspace_id=workspace.id,
                board_id=board.id,
                action="loop_iteration",
                status=ExecutionStatus.completed,
                input_summary=f"loop iteration {i}",
                output_summary=(
                    f"outcome={outcome} cost=$0.0100 duration=10s — shipped card {i}"
                ),
                started_at=BASE + timedelta(hours=i),
            )
        )
    db_session.add_all(rows)
    await db_session.flush()
    return agent


async def test_list_workspace_executions_offset_pages_newest_first(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Page 2 is the next slice down the newest-first ordering, with no row
    repeated from page 1 and none skipped between them."""
    await _seed_iterations(db_session, test_workspace, test_board, test_user, 60)

    first = await client.get(
        "/api/workspaces/default/executions?action=loop_iteration&limit=20&offset=0"
    )
    second = await client.get(
        "/api/workspaces/default/executions?action=loop_iteration&limit=20&offset=20"
    )
    assert first.status_code == 200
    assert second.status_code == 200

    page_one = first.json()
    page_two = second.json()
    assert len(page_one) == 20
    assert len(page_two) == 20

    # Newest first: iteration 59 leads page 1, iteration 39 leads page 2.
    assert page_one[0]["input_summary"] == "loop iteration 59"
    assert page_two[0]["input_summary"] == "loop iteration 39"

    ids_one = {e["id"] for e in page_one}
    ids_two = {e["id"] for e in page_two}
    assert not (ids_one & ids_two), "pages must not repeat a row"


async def test_list_workspace_executions_reports_unpaged_total_header(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """X-Total-Count is the count BEFORE limit/offset, so the UI can render
    "showing 20 of 60" without walking every page to find the depth."""
    await _seed_iterations(db_session, test_workspace, test_board, test_user, 60)

    response = await client.get(
        "/api/workspaces/default/executions?action=loop_iteration&limit=20&offset=0"
    )
    assert response.status_code == 200
    assert len(response.json()) == 20
    assert response.headers["X-Total-Count"] == "60"


async def test_list_workspace_executions_total_header_reflects_filters(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """The total counts the FILTERED set, not the whole workspace — otherwise
    "showing 5 of 60" would lie the moment a filter chip is active."""
    await _seed_iterations(db_session, test_workspace, test_board, test_user, 60)

    response = await client.get(
        "/api/workspaces/default/executions"
        "?action=loop_iteration&outcome=nothing_ready&limit=5"
    )
    assert response.status_code == 200
    # 15 of the 60 seeded rows are nothing_ready (every fourth).
    assert response.headers["X-Total-Count"] == "15"
    assert len(response.json()) == 5


async def test_list_workspace_executions_filter_by_outcome(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_iterations(db_session, test_workspace, test_board, test_user, 60)

    response = await client.get(
        "/api/workspaces/default/executions"
        "?action=loop_iteration&outcome=nothing_ready&limit=200"
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 15
    assert all("outcome=nothing_ready" in e["output_summary"] for e in data)


async def test_list_workspace_executions_outcome_matches_token_not_prose(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """An iteration whose SUMMARY PROSE contains the word must not be returned
    by the outcome filter — only the structured `outcome=<value>` token counts.
    Otherwise "worked" matches half the summaries ever written."""
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()
    db_session.add_all(
        [
            AgentExecution(
                agent_id=agent.id,
                workspace_id=test_workspace.id,
                board_id=test_board.id,
                action="loop_iteration",
                status=ExecutionStatus.completed,
                input_summary="loop iteration 1",
                output_summary="outcome=worked cost=$0.01 duration=5s — did a thing",
                started_at=BASE,
            ),
            AgentExecution(
                agent_id=agent.id,
                workspace_id=test_workspace.id,
                board_id=test_board.id,
                action="loop_iteration",
                status=ExecutionStatus.completed,
                input_summary="loop iteration 2",
                output_summary=(
                    "outcome=blocked_on_human cost=$0.01 duration=5s — "
                    "nothing worked, needs a human"
                ),
                started_at=BASE + timedelta(hours=1),
            ),
        ]
    )
    await db_session.flush()

    response = await client.get(
        "/api/workspaces/default/executions?action=loop_iteration&outcome=worked"
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1, (
        "outcome=worked must match only the structured token, not the "
        f"blocked_on_human row whose prose says 'worked' — got {len(data)}"
    )
    assert data[0]["input_summary"] == "loop iteration 1"


async def test_list_workspace_executions_search_matches_summary_text(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """`q` finds the iteration that touched a given card — the operator's
    actual question ("which iteration did card 42?")."""
    await _seed_iterations(db_session, test_workspace, test_board, test_user, 60)

    response = await client.get(
        "/api/workspaces/default/executions"
        "?action=loop_iteration&q=shipped%20card%2042&limit=200"
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["input_summary"] == "loop iteration 42"


async def test_list_workspace_executions_search_is_case_insensitive(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_iterations(db_session, test_workspace, test_board, test_user, 8)

    response = await client.get(
        "/api/workspaces/default/executions?action=loop_iteration&q=SHIPPED%20CARD%205"
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["input_summary"] == "loop iteration 5"


async def test_list_workspace_executions_search_also_matches_input_summary(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """The iteration NUMBER lives in input_summary ("loop iteration 7"), so a
    search that only read output_summary could not find an iteration by
    number — the most obvious thing an operator types."""
    await _seed_iterations(db_session, test_workspace, test_board, test_user, 8)

    response = await client.get(
        "/api/workspaces/default/executions"
        "?action=loop_iteration&q=loop%20iteration%207"
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["input_summary"] == "loop iteration 7"


async def test_list_workspace_executions_date_range_filters(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """since/until bound started_at inclusively — the run window an operator
    picks off a calendar."""
    await _seed_iterations(db_session, test_workspace, test_board, test_user, 24)

    # Iterations 5..9 inclusive (BASE + 5h .. BASE + 9h).
    since = (BASE + timedelta(hours=5)).isoformat()
    until = (BASE + timedelta(hours=9)).isoformat()
    response = await client.get(
        f"/api/workspaces/default/executions"
        f"?action=loop_iteration&since={since}&until={until}&limit=200"
    )
    assert response.status_code == 200
    data = response.json()
    summaries = sorted(e["input_summary"] for e in data)
    assert summaries == [
        "loop iteration 5",
        "loop iteration 6",
        "loop iteration 7",
        "loop iteration 8",
        "loop iteration 9",
    ], f"since/until must bound inclusively, got {summaries}"


async def test_list_workspace_executions_filters_compose_with_board_scope(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """A second board's loop rows must not leak into the filtered log — the
    whole point is a per-board run history."""
    agent = await _seed_iterations(
        db_session, test_workspace, test_board, test_user, 12
    )
    other_board = Board(
        workspace_id=test_workspace.id,
        name="Board B",
        slug="board-b",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()
    db_session.add(
        AgentExecution(
            agent_id=agent.id,
            workspace_id=test_workspace.id,
            board_id=other_board.id,
            action="loop_iteration",
            status=ExecutionStatus.completed,
            input_summary="loop iteration 0",
            output_summary="outcome=worked cost=$0.01 duration=5s — shipped card 0",
            started_at=BASE,
        )
    )
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/executions"
        f"?board_id={test_board.id}&action=loop_iteration&outcome=worked&limit=200"
    )
    assert response.status_code == 200
    data = response.json()
    assert all(e["board_id"] == str(test_board.id) for e in data)
    # 12 seeded rows, every fourth is nothing_ready (indexes 3, 7, 11) => 9 worked.
    assert len(data) == 9
    assert response.headers["X-Total-Count"] == "9"


async def test_list_workspace_executions_no_paging_params_unchanged(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Backward compat: the new params are additive. Omitting them returns the
    same bare array as before, and the response is still a JSON list (not an
    envelope) — six existing tests and the frontend's `Execution[]` typing
    depend on that."""
    await _seed_iterations(db_session, test_workspace, test_board, test_user, 5)

    response = await client.get("/api/workspaces/default/executions")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) == 5
