# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Integration tests for the board_reconciler lane (A1b no-op-loop cure).

THE A1b LOOP (5x-observed in prod, the recurring north-star failure CLASS):
an implementer claims a card whose entire scope was already delivered by a
sibling PR. Under the cero-dead-code rule the LLM correctly REFUSES to fabricate
duplicate work, produces an empty diff, cannot open a PR, sheds its hero, and
unassigns. With the card back in `active` and hero-less, the implementer's
`unassigned_or_rework` discover RE-DISCOVERS it on the very next poll — and
re-hands it forever. A human must close it as a duplicate.

THE CURE — a routed signal + a consuming role (mirrors the ui_validator pattern,
where `needs-ui-validation` arms a dead lane):
  1. The producer (implementer/planner prompt) applies the `needs-reconcile`
     label and unassigns instead of looping.
  2. The implementer's `exclude_label` now skips `needs-reconcile`, so the loop
     is broken — it can no longer re-discover the card.
  3. `board_reconciler` (a new role, lowest priority) discovers the card via
     `include_label: needs-reconcile` and DISPOSES of it (supersede / consolidate
     / repair-deps / park / no_action), so the scheduler stops re-offering it.

These tests assert the SCHEDULER half (deterministic, zero LLM tokens): the loop
is broken and the lane is armed. The LLM disposition itself is exercised by the
full-walk harness, not here.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace

from .test_assignments import (
    URL_TPL,
    _add_team_role,
    _make_card,
    _make_repo,
    _make_typed_columns,
    _seed_default_pipeline,
)

RECONCILE_LABEL = "needs-reconcile"


@pytest.mark.asyncio
async def test_implementer_does_not_rehand_needs_reconcile_card(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The A1b loop is broken: an implementer must NOT re-discover a card the
    producer parked with `needs-reconcile`.

    This is the exact card state the cero-dead-code refusal leaves behind:
    in `active`, hero-less (the implementer shed itself), labeled
    `needs-reconcile`. Before the cure the implementer's
    `unassigned_or_rework` discover re-handed it every poll. After: the
    implementer's `exclude_label` skips it → 204 (no other work).
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="A1b duplicate scope"
    )
    card.labels = [RECONCILE_LABEL]
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    # The loop is dead: the implementer gets nothing, not the same card again.
    assert resp.status_code == 204, (
        "implementer re-discovered a needs-reconcile card — the A1b loop is "
        "still open (exclude_label not applied)"
    )


@pytest.mark.asyncio
async def test_board_reconciler_claims_needs_reconcile_card(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The lane is armed: board_reconciler discovers the parked card via
    `include_label: needs-reconcile` and is handed it to dispose of.

    Without this the `needs-reconcile` signal is a dead route (the exact trap
    ui_validator hit before its producer was wired) — the card would be
    excluded by everyone and strand instead of looping.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "board_reconciler"
    )
    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="A1b duplicate scope"
    )
    card.labels = [RECONCILE_LABEL]
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, (
        "board_reconciler did not discover the needs-reconcile card — the "
        "disposal lane is not armed (role/include_label missing)"
    )
    body = resp.json()
    assert body["card"]["id"] == str(card.id)
    assert body["role"] == "board_reconciler"


@pytest.mark.asyncio
async def test_board_reconciler_ignores_unlabeled_active_card(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """board_reconciler is scoped to the signal: a normal active card (real
    build work, no `needs-reconcile`) is NOT poached from the implementer.

    Guards against the role over-reaching and disposing of live work.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "board_reconciler"
    )
    await _make_card(
        db_session, test_board, cols["active"], test_user, title="real build work"
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 204, (
        "board_reconciler claimed an unlabeled card — it must only act on the "
        "needs-reconcile signal"
    )


@pytest.mark.asyncio
async def test_board_reconciler_does_not_reclaim_own_finished_card(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Idempotency / loop-safety: once board_reconciler has acted on a card
    (recorded as its pipeline_role), it must not re-discover it — otherwise the
    cure becomes a new loop. `skip_if_pipeline_role: board_reconciler` enforces
    this even while the `needs-reconcile` label is still being cleared.
    """
    from app.models.kanban.card import CardParticipant

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "board_reconciler"
    )
    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="already reconciled"
    )
    card.labels = [RECONCILE_LABEL]
    await db_session.flush()
    # Mark that board_reconciler already touched it.
    db_session.add(
        CardParticipant(
            card_id=card.id,
            user_id=test_user.id,
            agent_id=test_agent.id,
            role="helper",
            pipeline_role="board_reconciler",
        )
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 204, (
        "board_reconciler re-discovered its own finished card — skip_if_"
        "pipeline_role not applied, the cure became a loop"
    )


@pytest.mark.asyncio
async def test_board_reconciler_reservation_drops_when_signal_cleared(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Split-brain guard: a live reservation must NOT re-hand the card once the
    `needs-reconcile` signal is gone (the disposition cleared it).

    The reservation predates the label change. If `_reservation_still_eligible`
    did not re-check `include_label` against the card's CURRENT labels, the
    reservation would resurrect a card the role already disposed of — the exact
    re-hand bug from `scheduler_reservation_eligibility_label_loop`. This proves
    the include_label predicate is mirrored in BOTH the fresh scan and the
    reservation re-check.
    """
    from app.models.kanban.card import Card

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "board_reconciler"
    )
    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="disposed"
    )
    card.labels = [RECONCILE_LABEL]
    await db_session.flush()

    # First poll: the role reserves the card.
    first = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert first.status_code == 200
    assert first.json()["card"]["id"] == str(card.id)

    # Simulate the disposition clearing the signal (no_action/repair/park all
    # remove_label needs-reconcile as their terminal) WITHOUT expiring the
    # reservation — the live reservation now points at a card the fresh scan
    # would no longer match.
    reload = await db_session.get(Card, card.id)
    reload.labels = []
    await db_session.flush()

    # Second poll: the stale reservation must be dropped, not re-handed.
    second = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert second.status_code == 204, (
        "stale reservation re-handed a card whose needs-reconcile signal was "
        "cleared — include_label not mirrored in _reservation_still_eligible"
    )


@pytest.mark.asyncio
async def test_board_reconciler_assignment_carries_reconcile_output_schema(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The runner's built-in decisionOutputSchema enums decision to
    approve/request_changes — which would make board_reconciler's four
    dispositions impossible to emit (and hard-fail under Codex). So its
    produces_decision stage MUST ship a per-stage `llm.output_schema` over the
    wire carrying supersede/no_action/repair/park. Without this the lane decides
    but cannot route — the cure silently breaks in a real (full-walk) run.
    """
    import json

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "board_reconciler"
    )
    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="dispose me"
    )
    card.labels = [RECONCILE_LABEL]
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    schema_str = resp.json()["llm"].get("output_schema")
    assert schema_str, "board_reconciler assignment must carry llm.output_schema"
    schema = json.loads(schema_str)
    assert set(schema["properties"]["decision"]["enum"]) == {
        "supersede",
        "no_action",
        "repair",
        "park",
    }
    # OpenAI-compat (Codex strict --output-schema): required covers every prop.
    assert schema["required"] == list(schema["properties"].keys())
    assert schema["additionalProperties"] is False


@pytest.mark.asyncio
async def test_implementer_assignment_has_no_output_schema_override(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Only roles whose decision enum differs from the default set an
    output_schema. The implementer (a writes_code stage) must NOT — it gets an
    empty string so the runner applies no override. Guards against the schema
    leaking onto every stage.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    await _make_card(db_session, test_board, cols["active"], test_user, title="work")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["llm"].get("output_schema", "") == "", (
        "implementer must not carry an output_schema override"
    )


@pytest.mark.asyncio
async def test_board_reconciler_reservation_drops_when_card_moved_to_untyped(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Split-brain guard (untyped-column invariant): board_reconciler is the ONLY
    default role with no column_type filter (it scans board-wide by label). The
    untyped-column gate (`Column.column_type IS NOT NULL`, 1ff4e9a invariant) is
    applied unconditionally in _candidate_cards but historically only inside the
    `if required or excluded` block of _reservation_still_eligible — so a card
    dragged into an untyped (human-only) column while board_reconciler holds a
    live reservation would be re-handed every poll (fresh scan rejects it, the
    stale reservation re-issues it). Assert the reservation is dropped instead.
    """
    from app.models.kanban.card import Card
    from app.models.kanban.column import Column

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "board_reconciler"
    )
    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="dragged away"
    )
    card.labels = [RECONCILE_LABEL]
    await db_session.flush()

    # First poll: board_reconciler reserves the card (from a typed `active` col).
    first = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert first.status_code == 200
    assert first.json()["card"]["id"] == str(card.id)

    # A human drags the parked card into an untyped (human-only) column WITHOUT
    # expiring the reservation — fresh discovery would now reject it (line 723).
    untyped = await db_session.get(Column, cols["untyped"].id)
    assert untyped.column_type is None
    reload = await db_session.get(Card, card.id)
    reload.column_id = untyped.id
    await db_session.flush()

    # Second poll: the stale reservation must be dropped, not re-handed.
    second = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert second.status_code == 204, (
        "stale reservation re-handed a card in an UNTYPED column — the untyped "
        "invariant (column_type IS NOT NULL) is not mirrored into "
        "_reservation_still_eligible for column-filter-less roles"
    )
