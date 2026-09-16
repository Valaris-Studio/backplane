# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Card 3f850adb — loop-mode iterations must report structured cost/tokens/
duration (+ resolved model/provider) on their AgentExecution rows, not just a
formatted summary string.

These are backend REGRESSION PINS: ExecutionCreate/ExecutionUpdate already
carry model/provider and tokens_used/cost_usd/duration_seconds (Wave 2 /
CRIT-2, card 6a3695c1's cost columns), so the full card-less loop_iteration
lifecycle below is expected to already pass at HEAD. The runner-side gap
(loopmode.go never sending these values) lives in the Go test suite
(runner/internal/workloop/loopmode_test.go) — this file exists so a future
regression in the backend's own persistence of these fields is caught
independently of the runner fix.
"""

from unittest.mock import patch

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.workspace import Workspace
from app.models.kanban.board import Board
from app.repositories.config_template import BoardLoopTemplateBindingRepository


AGENTS_URL = "/api/agents"

VALID_AGENT = {
    "name": "loop-mode-runner",
    "agent_type": "coding",
    "description": "loop mode test agent",
    "allowed_workspaces": ["default"],
}


async def _create_agent(client: AsyncClient) -> dict:
    resp = await client.post(AGENTS_URL, json=VALID_AGENT)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _bind_board(
    db_session: AsyncSession,
    board: Board,
    *,
    source: str = "system",
    slug: str = "coding-loop",
    version: int = 2,
) -> None:
    """Give the board a loop-template binding the way PUT /loop does."""
    template_ref: dict = {"source": source, "slug": slug}
    if source != "system":
        template_ref["id"] = str(board.id)
        template_ref["workspace_id"] = str(board.workspace_id)
    await BoardLoopTemplateBindingRepository(db_session).upsert(
        board_id=board.id,
        template_ref=template_ref,
        version=version,
        slot_values={},
        rendered_by_id=None,
        rendered_hash=None,
    )
    await db_session.commit()


async def _start_loop_iteration(
    client: AsyncClient, agent_id: str, board: Board, **extra
) -> dict:
    resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "board_id": str(board.id),
            "action": "loop_iteration",
            "input_summary": "loop iteration 1",
            **extra,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


# --- template stamping (card 8e4f95ba) ----------------------------------
#
# The profile page's track record is DERIVED from executions, so each
# loop_iteration row must carry which template rendered it. There is no
# metadata column on agent_executions, so the stamp reuses `prompt_slug`
# (operator Direction: no migration) under a `loop-template:` prefix.


async def test_loop_iteration_start_stamps_bound_template_into_prompt_slug(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    agent = await _create_agent(client)
    await _bind_board(db_session, test_board)

    data = await _start_loop_iteration(client, agent["id"], test_board)

    assert data["prompt_slug"] == "loop-template:system/coding-loop@2"


async def test_loop_iteration_start_stamps_workspace_template_source(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    """A workspace template stamps its own source, so the two namespaces never
    collide in the stats key."""
    agent = await _create_agent(client)
    await _bind_board(
        db_session, test_board, source="workspace", slug="my-loop", version=5
    )

    data = await _start_loop_iteration(client, agent["id"], test_board)

    assert data["prompt_slug"] == "loop-template:workspace/my-loop@5"


async def test_loop_iteration_on_a_malformed_binding_is_not_stamped(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    """`template_ref` is free-form JSON, so a partial ref must yield NO stamp.

    A key with an empty segment ("loop-template:/coding-loop@2") would look
    like a distinct template and silently split one history in two, which is
    worse than declining to attribute the row at all.
    """
    agent = await _create_agent(client)
    await BoardLoopTemplateBindingRepository(db_session).upsert(
        board_id=test_board.id,
        template_ref={"slug": "coding-loop"},  # no `source`
        version=2,
        slot_values={},
        rendered_by_id=None,
        rendered_hash=None,
    )
    await db_session.commit()

    data = await _start_loop_iteration(client, agent["id"], test_board)

    assert data["prompt_slug"] is None


async def test_loop_iteration_start_overrides_a_runner_supplied_prompt_slug(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    """Card 44231c47 REVERSED this: the stamp used to fill a gap, so a runner
    naming its own prompt won and could redirect any template's track record.
    For a loop iteration the server-derived stamp now wins outright.

    Full precedence table lives in test_execution_tenancy_and_attribution.py.
    """
    agent = await _create_agent(client)
    await _bind_board(db_session, test_board)

    data = await _start_loop_iteration(
        client, agent["id"], test_board, prompt_slug="runner-chosen-prompt"
    )

    assert data["prompt_slug"] == "loop-template:system/coding-loop@2"


async def test_loop_iteration_start_on_unbound_board_leaves_prompt_slug_null(
    client: AsyncClient,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    agent = await _create_agent(client)

    data = await _start_loop_iteration(client, agent["id"], test_board)

    assert data["prompt_slug"] is None


async def test_non_loop_execution_on_bound_board_is_not_stamped(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    """Only loop iterations carry the stamp; a pipeline stage on the same board
    must not be attributed to the loop template.

    The board here IS bound, so the lookup would return a real key — the
    action guard is the only thing keeping this row unstamped.
    """
    agent = await _create_agent(client)
    await _bind_board(db_session, test_board)

    with patch.object(
        BoardLoopTemplateBindingRepository,
        "get_by_board",
        autospec=True,
        side_effect=AssertionError("no binding lookup for a non-loop action"),
    ):
        resp = await client.post(
            f"{AGENTS_URL}/{agent['id']}/executions",
            json={
                "workspace_slug": "default",
                "board_id": str(test_board.id),
                "action": "implement",
                "input_summary": "card work",
            },
        )

    assert resp.status_code == 201, resp.text
    assert resp.json()["prompt_slug"] is None


async def test_board_less_loop_iteration_is_not_stamped(
    client: AsyncClient,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    """board_id is nullable — the stamp lookup must tolerate its absence.

    Asserted on the QUERY, not just the result: `WHERE board_id = NULL` matches
    nothing, so a missing guard would still yield an unstamped row while
    issuing a pointless lookup on every board-less execution. Only the call
    count distinguishes the two.
    """
    agent = await _create_agent(client)

    with patch.object(
        BoardLoopTemplateBindingRepository,
        "get_by_board",
        autospec=True,
        side_effect=AssertionError("no binding lookup for a board-less execution"),
    ):
        resp = await client.post(
            f"{AGENTS_URL}/{agent['id']}/executions",
            json={
                "workspace_slug": "default",
                "action": "loop_iteration",
                "input_summary": "loop iteration 1",
            },
        )

    assert resp.status_code == 201, resp.text
    assert resp.json()["prompt_slug"] is None


async def test_loop_iteration_execution_full_metrics_lifecycle(
    client: AsyncClient, test_user: User, test_workspace: Workspace, test_board: Board
):
    """Full card-less loop_iteration lifecycle: start with model+provider set
    and no card_id, complete with tokens_used/cost_usd/duration_seconds, then
    read it back and confirm every field persisted — the shape loop mode's
    completeExecution must produce once it stops throwing these numbers away.
    """
    agent = await _create_agent(client)
    agent_id = agent["id"]

    start_resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "board_id": str(test_board.id),
            "action": "loop_iteration",
            "input_summary": "loop iteration 1",
            "model": "claude-sonnet-4",
            "provider": "claude-cli",
        },
    )
    assert start_resp.status_code == 201, start_resp.text
    data = start_resp.json()
    assert data["model"] == "claude-sonnet-4"
    assert data["provider"] == "claude-cli"
    assert data["cards_affected"] in (None, [])
    exec_id = data["id"]

    update_resp = await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{exec_id}",
        json={
            "status": "completed",
            "output_summary": "cost=$0.0122 duration=50ms",
            "tokens_used": 1801,
            "cost_usd": 0.0122,
            "duration_seconds": 0.05,
        },
    )
    assert update_resp.status_code == 200, update_resp.text
    updated = update_resp.json()
    assert updated["status"] == "completed"
    assert updated["output_summary"] == "cost=$0.0122 duration=50ms"
    assert updated["tokens_used"] == 1801
    assert updated["cost_usd"] == 0.0122
    assert updated["duration_seconds"] == 0.05
    assert updated["model"] == "claude-sonnet-4"
    assert updated["provider"] == "claude-cli"

    list_resp = await client.get(f"{AGENTS_URL}/{agent_id}/executions")
    assert list_resp.status_code == 200
    row = next(e for e in list_resp.json() if e["id"] == exec_id)
    assert row["tokens_used"] == 1801
    assert row["cost_usd"] == 0.0122
    assert row["duration_seconds"] == 0.05
    assert row["model"] == "claude-sonnet-4"
    assert row["provider"] == "claude-cli"
    assert row["status"] == "completed"


async def test_loop_iteration_partial_update_leaves_metrics_null_not_zero(
    client: AsyncClient, test_user: User, test_workspace: Workspace, test_board: Board
):
    """Today's runner behavior — a PATCH carrying only status+output_summary,
    with no metrics keys at all — must leave tokens_used/cost_usd/
    duration_seconds NULL, not silently zero them. ExecutionUpdate's
    exclude_unset semantics already guarantee this; this pins it so a future
    change to update_execution can't regress an omitted field into a zeroed
    one now that the runner is expected to start sending real values on
    OTHER executions."""
    agent = await _create_agent(client)
    agent_id = agent["id"]

    start_resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "board_id": str(test_board.id),
            "action": "loop_iteration",
            "input_summary": "loop iteration 1",
        },
    )
    assert start_resp.status_code == 201, start_resp.text
    exec_id = start_resp.json()["id"]
    assert start_resp.json()["tokens_used"] is None
    assert start_resp.json()["cost_usd"] is None
    assert start_resp.json()["duration_seconds"] is None

    update_resp = await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{exec_id}",
        json={
            "status": "failed",
            "output_summary": "template render error: ...",
        },
    )
    assert update_resp.status_code == 200, update_resp.text
    updated = update_resp.json()
    assert updated["status"] == "failed"
    assert updated["tokens_used"] is None
    assert updated["cost_usd"] is None
    assert updated["duration_seconds"] is None

    list_resp = await client.get(f"{AGENTS_URL}/{agent_id}/executions")
    row = next(e for e in list_resp.json() if e["id"] == exec_id)
    assert row["tokens_used"] is None
    assert row["cost_usd"] is None
    assert row["duration_seconds"] is None
