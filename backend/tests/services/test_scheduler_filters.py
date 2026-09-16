# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Discover-filter evaluator: new role+note-attribute primitives.

These integration tests exercise AssignmentService through the same
in-process harness as tests/routers/agents/test_assignments.py — we drive
through the HTTP endpoint so the full filter path (router -> service ->
candidate query) is covered without re-mocking the SQL layer.
"""

from __future__ import annotations

import logging

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent
from app.models.agents.team import AgentTeam, AgentTeamMember
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardParticipant, Priority
from app.models.kanban.column import Column, ColumnType
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace
from app.models.workspace_config import WorkspaceConfig


URL_TPL = "/api/workspaces/{slug}/agents/{agent_id}/next-assignment"


# --- helpers -----------------------------------------------------------------


async def _add_team_role(
    db: AsyncSession, workspace: Workspace, agent: Agent, user: User, role: str
):
    team = AgentTeam(
        name=f"{role}-team",
        workspace_id=workspace.id,
        created_by_id=user.id,
    )
    db.add(team)
    await db.flush()
    db.add(AgentTeamMember(team_id=team.id, agent_id=agent.id, roles=[role]))
    await db.flush()


async def _make_typed_columns(db: AsyncSession, board: Board) -> dict[str, Column]:
    cols = {
        "backlog": Column(board_id=board.id, name="To Do", position=1.0,
                          color="#888", column_type=ColumnType.backlog),
        "active": Column(board_id=board.id, name="In Progress", position=2.0,
                         color="#888", column_type=ColumnType.active),
        "review": Column(board_id=board.id, name="In Review", position=3.0,
                         color="#888", column_type=ColumnType.review),
        "done": Column(board_id=board.id, name="Done", position=4.0,
                       color="#888", column_type=ColumnType.done),
    }
    for c in cols.values():
        db.add(c)
    await db.flush()
    return cols


async def _make_repo(db: AsyncSession, board: Board, user: User) -> GitRepo:
    repo = GitRepo(
        board_id=board.id,
        workspace_id=board.workspace_id,
        name="acme",
        slug="acme",
        url="https://github.com/acme/acme",
        provider=GitProvider.github,
        default_branch="main",
        added_by=user.id,
    )
    db.add(repo)
    await db.flush()
    return repo


async def _make_card(
    db: AsyncSession,
    board: Board,
    column: Column,
    user: User,
    *,
    title: str = "card",
    description: str = "",
    labels: list[str] | None = None,
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        description=description,
        position=1024.0,
        priority=Priority.medium,
        created_by=user.id,
    )
    if labels is not None:
        card.labels = labels
    db.add(card)
    await db.flush()
    return card


def _stage_with_filters(
    role: str,
    column_type: str,
    filters: dict,
    *,
    execution_action: str = "implement_card",
) -> dict:
    return {
        "role": role,
        "unique": False,
        "discover": {
            "strategy": "column_scan",
            "column_type": column_type,
            "filters": filters,
        },
        "claim": {
            "participant_role": "helper",
            "execution_action": execution_action,
            "pipeline_role": role,
        },
        "git": {"action": "none", "create_pr": False},
        "llm": {"enabled": False, "stage": ""},
        "sensors": [],
        "on_success": {},
    }


async def _seed_pipeline(db: AsyncSession, workspace: Workspace, stages: list[dict]):
    config = {
        "version": 1,
        "stages": stages,
        "scheduling": {
            "mode": "priority",
            "priority_order": [s["role"] for s in stages],
        },
    }
    db.add(WorkspaceConfig(workspace_id=workspace.id, pipeline_config=config))
    await db.flush()


# --- skip_if_pipeline_role ---------------------------------------------------


@pytest.mark.asyncio
async def test_skip_if_pipeline_role_skips_cards_with_matching_pipeline_role(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A card whose participants include pipeline_role='reviewer' is filtered
    out when the discover filter sets skip_if_pipeline_role: reviewer."""
    await _seed_pipeline(
        db_session,
        test_workspace,
        [_stage_with_filters(
            "reviewer", "review",
            {"require_git_repo": True, "skip_if_pipeline_role": "reviewer"},
            execution_action="review_card",
        )],
    )
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    already_reviewed = await _make_card(
        db_session, test_board, cols["review"], test_user, title="seen",
    )
    db_session.add(CardParticipant(
        card_id=already_reviewed.id,
        user_id=test_user.id,
        agent_id=test_agent.id,
        role="helper",
        pipeline_role="reviewer",
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_skip_if_pipeline_role_returns_card_when_pipeline_role_differs(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A card touched by a participant with a different pipeline_role is
    still eligible."""
    await _seed_pipeline(
        db_session,
        test_workspace,
        [_stage_with_filters(
            "reviewer", "review",
            {"require_git_repo": True, "skip_if_pipeline_role": "reviewer"},
            execution_action="review_card",
        )],
    )
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    fresh = await _make_card(
        db_session, test_board, cols["review"], test_user, title="fresh",
    )
    db_session.add(CardParticipant(
        card_id=fresh.id,
        user_id=test_user.id,
        agent_id=test_agent.id,
        role="hero",
        pipeline_role="implementer",
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(fresh.id)


# --- skip_if_participant_role back-compat ------------------------------------


@pytest.mark.asyncio
async def test_skip_if_participant_role_alias_still_works(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
    caplog,
):
    """Legacy filter name still matches participants by display role and
    emits a deprecation warning. Pre-migration cards have pipeline_role=NULL
    and were matched on participant_role; that behaviour is preserved."""
    await _seed_pipeline(
        db_session,
        test_workspace,
        [_stage_with_filters(
            "reviewer", "review",
            {"require_git_repo": True, "skip_if_participant_role": "helper"},
            execution_action="review_card",
        )],
    )
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    seen = await _make_card(db_session, test_board, cols["review"], test_user, title="seen")
    db_session.add(CardParticipant(
        card_id=seen.id,
        user_id=test_user.id,
        agent_id=test_agent.id,
        role="helper",
    ))
    await db_session.flush()

    caplog.set_level(logging.WARNING)
    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text
    assert any(
        "skip_if_participant_role" in rec.message and "deprecat" in rec.message.lower()
        for rec in caplog.records
    ), f"expected deprecation warning, got {[r.message for r in caplog.records]}"


# --- require_note_kind / require_note_failure_class --------------------------


@pytest.mark.asyncio
async def test_require_note_kind_filters_in_cards_with_matching_note(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    await _seed_pipeline(
        db_session,
        test_workspace,
        [_stage_with_filters(
            "rework_mediator", "active",
            {"require_git_repo": True, "require_note_kind": "review_verdict"},
            execution_action="mediate_rework",
        )],
    )
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "rework_mediator"
    )

    fresh = await _make_card(
        db_session, test_board, cols["active"], test_user, title="fresh",
    )
    with_verdict = await _make_card(
        db_session, test_board, cols["active"], test_user, title="rework",
    )
    db_session.add(Note(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        card_id=with_verdict.id,
        title="Review",
        content="needs work",
        kind="review_verdict",
        created_by=test_user.id,
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(with_verdict.id)
    assert resp.json()["card"]["id"] != str(fresh.id)


@pytest.mark.asyncio
async def test_require_note_failure_class_composes_with_note_kind(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """AND semantics: only cards whose review_verdict note carries
    failure_class=needs_rework are returned. An approve verdict (no failure_class)
    on a different card must NOT match."""
    await _seed_pipeline(
        db_session,
        test_workspace,
        [_stage_with_filters(
            "rework_mediator", "active",
            {
                "require_git_repo": True,
                "require_note_kind": "review_verdict",
                "require_note_failure_class": "needs_rework",
            },
            execution_action="mediate_rework",
        )],
    )
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "rework_mediator"
    )

    approved = await _make_card(
        db_session, test_board, cols["active"], test_user, title="approved",
    )
    db_session.add(Note(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        card_id=approved.id,
        title="Review: approve",
        content="lgtm",
        kind="review_verdict",
        created_by=test_user.id,
    ))
    rework = await _make_card(
        db_session, test_board, cols["active"], test_user, title="rework",
    )
    db_session.add(Note(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        card_id=rework.id,
        title="Review: request_changes",
        content="redo",
        kind="review_verdict",
        failure_class="needs_rework",
        created_by=test_user.id,
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(rework.id)


# --- require_label -----------------------------------------------------------


@pytest.mark.asyncio
async def test_require_label_filters_in_cards_with_matching_label(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    await _seed_pipeline(
        db_session,
        test_workspace,
        [_stage_with_filters(
            "rework_mediator", "active",
            {"require_git_repo": True, "require_label": "needs-rework"},
            execution_action="mediate_rework",
        )],
    )
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "rework_mediator"
    )

    plain = await _make_card(
        db_session, test_board, cols["active"], test_user, title="plain",
    )
    labelled = await _make_card(
        db_session, test_board, cols["active"], test_user, title="needs-rework",
        labels=["needs-rework"],
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(labelled.id)
    assert resp.json()["card"]["id"] != str(plain.id)


# --- require_note_kind_newer_than (Cluster II Gap 2) -------------------------
#
# Mediator eligibility deep fix. require_note_kind only checks a review_verdict
# EXISTS — so after the mediator wrote a rework_brief, the card still matched
# and the mediator re-spun (client pilot 2026-05-27, papered over by the live
# exclude_label: rework-brief-ready workaround). The correct gate: the card is
# eligible only when its NEWEST review_verdict is newer than its newest
# rework_brief — i.e. a fresh review has landed since the last brief.

from datetime import datetime, timedelta, timezone  # noqa: E402

from app.models.approvals.approval import (  # noqa: E402
    ApprovalCategory,
    ApprovalRequest,
    ApprovalStatus,
)


async def _make_pending_approval(
    db: AsyncSession,
    *,
    workspace: Workspace,
    agent: Agent,
    card: Card,
    status: ApprovalStatus = ApprovalStatus.pending,
    expires_at: datetime | None = None,
) -> ApprovalRequest:
    """A workspace approval referencing `card` via action_payload.card_id —
    the canonical linkage the scheduler reads to park the card."""
    req = ApprovalRequest(
        agent_id=agent.id,
        workspace_id=workspace.id,
        board_id=card.board_id,
        category=ApprovalCategory.schema_change,
        action_description="needs human decision",
        action_payload={"card_id": str(card.id)},
        risk_score=70,
        status=status,
        expires_at=expires_at
        or (datetime.now(timezone.utc) + timedelta(hours=24)),
    )
    db.add(req)
    await db.flush()
    return req


def _mediator_freshness_stage() -> dict:
    return _stage_with_filters(
        "rework_mediator", "active",
        {
            "require_git_repo": True,
            "require_note_kind_newer_than": {
                "kind": "review_verdict",
                "than_kind": "rework_brief",
            },
        },
        execution_action="mediate_rework",
    )


@pytest.mark.asyncio
async def test_require_note_kind_newer_than_eligible_when_verdict_after_brief(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A new review_verdict written AFTER the last rework_brief re-opens the
    card for mediation."""
    await _seed_pipeline(db_session, test_workspace, [_mediator_freshness_stage()])
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "rework_mediator"
    )

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="re-reviewed",
    )
    base = datetime(2026, 5, 28, 12, 0, 0)
    db_session.add(Note(
        workspace_id=test_workspace.id, board_id=test_board.id, card_id=card.id,
        title="Rework brief", content="do this", kind="rework_brief",
        created_by=test_user.id, created_at=base,
    ))
    db_session.add(Note(
        workspace_id=test_workspace.id, board_id=test_board.id, card_id=card.id,
        title="Review: request_changes", content="still broken", kind="review_verdict",
        created_by=test_user.id, created_at=base + timedelta(minutes=30),
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_require_note_kind_newer_than_skips_when_brief_after_verdict(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The mediator already briefed this verdict (brief is newer) → NOT eligible.
    This is the re-spin the live exclude_label workaround was guarding against."""
    await _seed_pipeline(db_session, test_workspace, [_mediator_freshness_stage()])
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "rework_mediator"
    )

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="already briefed",
    )
    base = datetime(2026, 5, 28, 12, 0, 0)
    db_session.add(Note(
        workspace_id=test_workspace.id, board_id=test_board.id, card_id=card.id,
        title="Review: request_changes", content="broken", kind="review_verdict",
        created_by=test_user.id, created_at=base,
    ))
    db_session.add(Note(
        workspace_id=test_workspace.id, board_id=test_board.id, card_id=card.id,
        title="Rework brief", content="here's how", kind="rework_brief",
        created_by=test_user.id, created_at=base + timedelta(minutes=30),
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_require_note_kind_newer_than_skips_after_two_cycles(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Two consecutive review→mediate cycles: after the SECOND brief, the
    mediator must NOT be eligible (M-07 infinite mediate loop, 2026-06-06).

    Live note timeline reproduced:
      1. verdict @ t1  (cycle-1 request_changes)
      2. brief   @ t2  (cycle-1 rework_brief)
      3. verdict @ t3  (cycle-2 request_changes)
      4. brief   @ t4  (cycle-2 rework_brief)   ← after this, gate must be FALSE

    With t1<t2<t3<t4: newest(review_verdict)=t3 < newest(rework_brief)=t4 →
    the freshness gate should exclude the card. If this returns 200 the
    predicate has a multi-cycle bug; if 204 the predicate is correct and the
    live re-loop came from a different path (reservation re-issue / race).
    """
    await _seed_pipeline(db_session, test_workspace, [_mediator_freshness_stage()])
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "rework_mediator"
    )

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="two-cycle",
    )
    base = datetime(2026, 6, 7, 0, 54, 4)
    timeline = [
        ("review_verdict", "request_changes #1", base),
        ("rework_brief", "brief #1", base + timedelta(minutes=3, seconds=40)),
        ("review_verdict", "request_changes #2", base + timedelta(hours=2, minutes=38)),
        ("rework_brief", "brief #2", base + timedelta(hours=2, minutes=41)),
    ]
    for kind, content, ts in timeline:
        db_session.add(Note(
            workspace_id=test_workspace.id, board_id=test_board.id, card_id=card.id,
            title=kind, content=content, kind=kind,
            created_by=test_user.id, created_at=ts,
        ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_reservation_still_eligible_drops_when_brief_lands_after_reserve(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """SPLIT-BRAIN guard: a live mediator reservation made when the freshness
    gate was TRUE must be DROPPED once a newer rework_brief makes it FALSE.

    Reproduces the M-07 re-loop via the existing-reservation re-issue path:
      - cycle-2 verdict (t3) exists, no brief newer than it yet → gate TRUE.
      - the mediator reserves the card (mediate#2 in flight).
      - mediate#2 writes its brief (t4 > t3) → gate is now FALSE.
      - on the next poll the scheduler sees the live reservation FIRST and
        re-issues it via _reservation_still_eligible, which (today) does NOT
        re-check require_note_kind_newer_than → the card is re-handed forever.

    The fix mirrors the freshness predicate into _reservation_still_eligible,
    so this poll must return 204 (reservation dropped, no re-issue).
    """
    from datetime import datetime as _dt
    from datetime import timedelta as _td

    from app.models.agents.reservation import AgentReservation

    await _seed_pipeline(db_session, test_workspace, [_mediator_freshness_stage()])
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "rework_mediator"
    )

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="reserved-then-briefed",
    )
    base = _dt(2026, 6, 7, 3, 32, 36)
    # cycle-1 pair (already mediated), then cycle-2 verdict.
    for kind, ts in [
        ("review_verdict", base - _td(hours=2, minutes=38)),
        ("rework_brief", base - _td(hours=2, minutes=34, seconds=20)),
        ("review_verdict", base),
    ]:
        db_session.add(Note(
            workspace_id=test_workspace.id, board_id=test_board.id, card_id=card.id,
            title=kind, content=kind, kind=kind,
            created_by=test_user.id, created_at=ts,
        ))
    # Live reservation: mediate#2 was reserved when the gate was TRUE.
    db_session.add(AgentReservation(
        agent_id=test_agent.id,
        card_id=card.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="rework_mediator",
        expires_at=_dt.utcnow() + _td(seconds=600),
    ))
    # ...then mediate#2 wrote its cycle-2 brief (newer than the verdict).
    db_session.add(Note(
        workspace_id=test_workspace.id, board_id=test_board.id, card_id=card.id,
        title="rework_brief", content="brief #2", kind="rework_brief",
        created_by=test_user.id, created_at=base + _td(minutes=3, seconds=19),
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_require_note_kind_newer_than_eligible_when_no_brief_yet(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A verdict with no prior rework_brief is eligible (first mediation pass)."""
    await _seed_pipeline(db_session, test_workspace, [_mediator_freshness_stage()])
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "rework_mediator"
    )

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="first review",
    )
    db_session.add(Note(
        workspace_id=test_workspace.id, board_id=test_board.id, card_id=card.id,
        title="Review: request_changes", content="fix", kind="review_verdict",
        created_by=test_user.id, created_at=datetime(2026, 5, 28, 12, 0, 0),
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_require_note_kind_newer_than_skips_when_no_verdict(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """No review_verdict at all → not eligible (nothing to mediate)."""
    await _seed_pipeline(db_session, test_workspace, [_mediator_freshness_stage()])
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "rework_mediator"
    )

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="no verdict",
    )
    db_session.add(Note(
        workspace_id=test_workspace.id, board_id=test_board.id, card_id=card.id,
        title="Plan", content="planned", kind="plan",
        created_by=test_user.id, created_at=datetime(2026, 5, 28, 12, 0, 0),
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


# --- Cluster I: pending-approval candidate gating ----------------------------
#
# A card with an undecided pending approval is parked structurally: the
# scheduler must not hand it to any role. This kills the M6-03 duplicate
# re-spin (every fresh pickup re-derived the analysis and filed ANOTHER
# approval). Role-agnostic — the gate lives in the candidate scan, not a
# per-role filter. Reuses CardRepository.pending_approvals_by_card so the
# expiry + done-column-moot semantics match the operator-facing flag.


def _planner_stage() -> dict:
    """A minimal backlog-scanning stage with no special filters."""
    return _stage_with_filters(
        "planner", "backlog",
        {"require_git_repo": True},
        execution_action="plan_card",
    )


@pytest.mark.asyncio
async def test_pending_approval_card_is_not_reservable(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A card with an undecided pending approval is excluded from the
    candidate set entirely → 204."""
    await _seed_pipeline(db_session, test_workspace, [_planner_stage()])
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")

    card = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="awaiting decision",
    )
    await _make_pending_approval(
        db_session, workspace=test_workspace, agent=test_agent, card=card,
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_card_reservable_again_once_approval_decided(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A decided (approved) approval no longer parks the card — it becomes
    reservable again. Mirrors rejected/expired: only *pending* parks."""
    await _seed_pipeline(db_session, test_workspace, [_planner_stage()])
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")

    card = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="decided",
    )
    await _make_pending_approval(
        db_session, workspace=test_workspace, agent=test_agent, card=card,
        status=ApprovalStatus.approved,
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_expired_pending_approval_does_not_park_card(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A `pending` row whose expires_at has passed must not park the card —
    self-correcting, matching pending_approvals_by_card's expiry read."""
    await _seed_pipeline(db_session, test_workspace, [_planner_stage()])
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")

    card = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="stale approval",
    )
    await _make_pending_approval(
        db_session, workspace=test_workspace, agent=test_agent, card=card,
        expires_at=datetime.now(timezone.utc) - timedelta(hours=1),
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_pending_approval_on_other_card_does_not_park_sibling(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The gate is per-card: an approval on card A must not park card B."""
    await _seed_pipeline(db_session, test_workspace, [_planner_stage()])
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")

    parked = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="parked",
    )
    parked.position = 100.0  # earlier in scan order
    free = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="free",
    )
    free.position = 200.0
    await db_session.flush()
    await _make_pending_approval(
        db_session, workspace=test_workspace, agent=test_agent, card=parked,
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(free.id)


# --- Cluster I: parked-label exclusion (needs_research non-blocking) ----------
#
# Outcome-taxonomy "park" states ride on labels (matching the existing
# needs-advisor stuck-loop park). A card flipped to `needs-research` by the
# planner is parked — not failed — so it must be excluded from the role's
# candidate set without burning a rework attempt. Config-driven: the role's
# discover.filters.exclude_label lists the parked labels.


@pytest.mark.asyncio
async def test_needs_research_label_parks_card_from_planner(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A `needs-research` card is excluded when the planner's discover filter
    lists it in exclude_label (parked, not failed)."""
    await _seed_pipeline(
        db_session,
        test_workspace,
        [_stage_with_filters(
            "planner", "backlog",
            {"require_git_repo": True, "exclude_label": ["needs-research"]},
            execution_action="plan_card",
        )],
    )
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")

    parked = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="parked",
        labels=["needs-research"],
    )
    parked.position = 100.0
    fresh = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="fresh",
    )
    fresh.position = 200.0
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(fresh.id)


# ---------------------------------------------------------------------------
# Cell #10 (Cluster B): _reservation_still_eligible must mirror EVERY advanced
# _candidate_cards discover predicate. A reservation made when a predicate was
# TRUE keeps being re-issued after board state flips it FALSE (the re-issue path
# bypasses the fresh-scan filter) → a stale reservation re-runs a paid stage on
# work that is no longer eligible. Each test reserves an eligible card, flips one
# predicate FALSE, and asserts the next poll returns 204 (reservation dropped).
# ---------------------------------------------------------------------------


def _reservation(agent, card, workspace, board, role: str):
    from datetime import datetime as _dt
    from datetime import timedelta as _td

    from app.models.agents.reservation import AgentReservation

    return AgentReservation(
        agent_id=agent.id,
        card_id=card.id,
        workspace_id=workspace.id,
        board_id=board.id,
        role=role,
        expires_at=_dt.utcnow() + _td(seconds=600),
    )


@pytest.mark.asyncio
async def test_reservation_dropped_when_sibling_goes_in_flight(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """no_other_card_in_flight: a reservation made when no sibling was in-flight
    must be dropped once a sibling card gains a participant (goes in-flight)."""
    await _seed_pipeline(
        db_session, test_workspace,
        [_stage_with_filters("planner", "backlog", {"no_other_card_in_flight": True})],
    )
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")

    reserved = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="reserved",
    )
    db_session.add(_reservation(test_agent, reserved, test_workspace, test_board, "planner"))
    # A sibling enters active AND becomes in-flight (gains a participant) AFTER
    # the reservation — the gate is now FALSE for `reserved`.
    sibling = await _make_card(
        db_session, test_board, cols["active"], test_user, title="sibling in flight",
    )
    db_session.add(CardParticipant(
        card_id=sibling.id, user_id=test_user.id, role="hero", pipeline_role="implementer",
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_reservation_dropped_when_dependency_becomes_unsatisfied(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """all_dependencies_done: a reservation made when all deps were done must be
    dropped once a new dependency on a not-done card is added."""
    from app.models.kanban.card import CardDependency

    await _seed_pipeline(
        db_session, test_workspace,
        [_stage_with_filters("planner", "backlog", {"all_dependencies_done": True})],
    )
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")

    reserved = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="reserved",
    )
    db_session.add(_reservation(test_agent, reserved, test_workspace, test_board, "planner"))
    # A new dependency on a not-done card lands AFTER the reservation.
    blocker = await _make_card(
        db_session, test_board, cols["active"], test_user, title="unfinished blocker",
    )
    db_session.add(CardDependency(
        card_id=reserved.id, depends_on_card_id=blocker.id, created_by=test_user.id,
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_reservation_dropped_when_pr_url_cleared(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """require_pr_url: a reservation made while the card carried a PR url must be
    dropped once the pr_url is cleared (the PR was closed/removed)."""
    await _seed_pipeline(
        db_session, test_workspace,
        [_stage_with_filters("reviewer", "review", {"require_pr_url": True},
                             execution_action="review_card")],
    )
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    reserved = await _make_card(
        db_session, test_board, cols["review"], test_user, title="reserved",
    )
    reserved.pr_url = "https://github.com/acme/acme/pull/31"
    db_session.add(_reservation(test_agent, reserved, test_workspace, test_board, "reviewer"))
    await db_session.flush()
    # The PR url is cleared AFTER the reservation.
    reserved.pr_url = None
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_reservation_dropped_when_approval_becomes_pending(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """approval-park: a reservation made before an approval was raised must be
    dropped once a pending approval references the card (awaiting a human)."""
    await _seed_pipeline(
        db_session, test_workspace,
        [_stage_with_filters("planner", "backlog", {})],
    )
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")

    reserved = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="reserved",
    )
    db_session.add(_reservation(test_agent, reserved, test_workspace, test_board, "planner"))
    await _make_pending_approval(
        db_session, workspace=test_workspace, agent=test_agent, card=reserved,
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_reservation_still_reissued_when_predicates_hold(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Guard against an always-drop regression: a reservation whose advanced
    predicates ALL still hold must be RE-ISSUED (200), not dropped. Without this,
    a cure that always returned False would pass every drop-test above."""
    await _seed_pipeline(
        db_session, test_workspace,
        [_stage_with_filters(
            "reviewer", "review",
            {"require_pr_url": True, "no_other_card_in_flight": True,
             "all_dependencies_done": True},
            execution_action="review_card",
        )],
    )
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    reserved = await _make_card(
        db_session, test_board, cols["review"], test_user, title="still eligible",
    )
    reserved.pr_url = "https://github.com/acme/acme/pull/41"
    db_session.add(_reservation(test_agent, reserved, test_workspace, test_board, "reviewer"))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(reserved.id)


@pytest.mark.asyncio
async def test_reservation_dropped_when_required_note_removed(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """require_note_kind: a reservation made while the card carried the required
    note must be dropped once that note is removed."""
    from sqlalchemy import delete as _delete

    await _seed_pipeline(
        db_session, test_workspace,
        [_stage_with_filters("rework_mediator", "active",
                             {"require_note_kind": "review_verdict"},
                             execution_action="mediate_rework")],
    )
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "rework_mediator")

    reserved = await _make_card(
        db_session, test_board, cols["active"], test_user, title="reserved",
    )
    note = Note(
        workspace_id=test_workspace.id, board_id=test_board.id, card_id=reserved.id,
        title="v", content="v", kind="review_verdict", created_by=test_user.id,
    )
    db_session.add(note)
    db_session.add(_reservation(test_agent, reserved, test_workspace, test_board, "rework_mediator"))
    await db_session.flush()
    # The required note is removed AFTER the reservation.
    await db_session.execute(_delete(Note).where(Note.card_id == reserved.id))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_reservation_dropped_when_board_repo_removed(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """require_git_repo (default True): a reservation made while the board had a
    repo must be dropped once the board's last repo is removed."""
    from sqlalchemy import delete as _delete

    await _seed_pipeline(
        db_session, test_workspace,
        [_stage_with_filters("planner", "backlog", {})],
    )
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")

    reserved = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="reserved",
    )
    db_session.add(_reservation(test_agent, reserved, test_workspace, test_board, "planner"))
    await db_session.flush()
    # The board's repo is removed AFTER the reservation.
    await db_session.execute(_delete(GitRepo).where(GitRepo.board_id == test_board.id))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


# --- column_id (wave gating across same-typed columns) -----------------------


async def _make_second_backlog_column(db: AsyncSession, board: Board) -> Column:
    """A sibling column sharing column_type=backlog — the operator's wave-gating
    shape (Backlog parked, To Do released) that column_type alone cannot narrow."""
    col = Column(
        board_id=board.id, name="Backlog", position=0.5, color="#888",
        column_type=ColumnType.backlog,
    )
    db.add(col)
    await db.flush()
    return col


@pytest.mark.asyncio
async def test_column_id_filter_restricts_discovery_to_the_gated_column(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Two columns share column_type=backlog. A role filtered to col-A never
    receives a col-B card, even one ordered ahead of it."""
    cols = await _make_typed_columns(db_session, test_board)
    parked = await _make_second_backlog_column(db_session, test_board)
    await _seed_pipeline(
        db_session,
        test_workspace,
        [_stage_with_filters(
            "implementer", "backlog", {"column_id": str(cols["backlog"].id)},
        )],
    )
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")

    # Ordered FIRST (lower position) — wins the scan without a column filter.
    ahead = await _make_card(
        db_session, test_board, parked, test_user, title="parked-wave-2",
    )
    ahead.position = 1.0
    released = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="released",
    )
    released.position = 999.0
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(released.id)


@pytest.mark.asyncio
async def test_column_id_filter_list_form_unions_columns(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The list form admits cards from every listed column."""
    cols = await _make_typed_columns(db_session, test_board)
    parked = await _make_second_backlog_column(db_session, test_board)
    await _seed_pipeline(
        db_session,
        test_workspace,
        [_stage_with_filters(
            "implementer", "backlog",
            {"column_id": [str(cols["backlog"].id), str(parked.id)]},
        )],
    )
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")

    only_in_parked = await _make_card(
        db_session, test_board, parked, test_user, title="in-union",
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(only_in_parked.id)


@pytest.mark.asyncio
async def test_reservation_dropped_when_card_leaves_the_gated_column(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Mirror in _reservation_still_eligible: a human dragging the reserved card
    back into the parked column must not have it re-issued until the TTL drains."""
    cols = await _make_typed_columns(db_session, test_board)
    parked = await _make_second_backlog_column(db_session, test_board)
    await _seed_pipeline(
        db_session,
        test_workspace,
        [_stage_with_filters(
            "implementer", "backlog", {"column_id": str(cols["backlog"].id)},
        )],
    )
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")

    reserved = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="reserved",
    )
    db_session.add(
        _reservation(test_agent, reserved, test_workspace, test_board, "implementer")
    )
    await db_session.flush()
    reserved.column_id = parked.id
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text
