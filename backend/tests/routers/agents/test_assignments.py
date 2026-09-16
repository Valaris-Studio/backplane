# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Integration tests for POST /api/workspaces/{slug}/agents/{agent_id}/next-assignment.

Covers acceptance criteria from card 2f980d13:
  - Returns 200 with bundled context for the next eligible card.
  - 204 when no eligible card exists.
  - Reservation TTL: an expired reservation is reclaimable.
  - Concurrent calls cannot reserve the same card twice.
  - Priority + position ordering.
  - Untyped column exclusion (1ff4e9a invariant inheritance).
  - Role-scoped repo_has_no_open_pr precondition: orchestrator gated,
    reviewer not gated, even when the same PR is open on the repo.
  - 403 when the agent's owner is not a workspace member.
  - 409 when the agent has an in-flight execution on a different card.
  - Idempotent: repeated calls with an active reservation return the
    same card.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import current_agent_id, get_current_user
from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution
from app.models.agents.reservation import AgentReservation
from app.models.agents.team import AgentTeam, AgentTeamMember
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardParticipant, Priority
from app.models.kanban.column import Column, ColumnType
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.models.workspace_config import WorkspaceConfig
from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG


URL_TPL = "/api/workspaces/{slug}/agents/{agent_id}/next-assignment"


def _agent_bound_client(db_session: AsyncSession, user: User, agent: Agent) -> AsyncClient:
    """A second agent-key-authenticated client, bound to `agent` (not test_agent).

    Mirrors conftest's `agent_client` fixture override pattern. Needed once the
    IDOR fix (card f47816b9) makes the caller-bound agent identity load-bearing:
    a test simulating a SECOND runner polling its OWN agent must set
    current_agent_id to that agent's id, not reuse `agent_client`'s binding to
    test_agent under a different URL id (that shape is now the exact IDOR the
    fix blocks).
    """
    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        current_agent_id.set(agent.id)
        return user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


async def _seed_default_pipeline(db: AsyncSession, workspace: Workspace):
    cfg = WorkspaceConfig(
        workspace_id=workspace.id,
        pipeline_config=DEFAULT_PIPELINE_CONFIG,
    )
    db.add(cfg)
    await db.flush()


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
    member = AgentTeamMember(team_id=team.id, agent_id=agent.id, roles=[role])
    db.add(member)
    await db.flush()


async def _make_typed_columns(db: AsyncSession, board: Board) -> dict:
    cols = {
        "backlog": Column(board_id=board.id, name="To Do", position=1.0,
                          color="#888", column_type=ColumnType.backlog),
        "active": Column(board_id=board.id, name="In Progress", position=2.0,
                         color="#888", column_type=ColumnType.active),
        "review": Column(board_id=board.id, name="In Review", position=3.0,
                         color="#888", column_type=ColumnType.review),
        "done": Column(board_id=board.id, name="Done", position=4.0,
                       color="#888", column_type=ColumnType.done),
        "untyped": Column(board_id=board.id, name="Park", position=5.0,
                          color="#888", column_type=None),
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
    priority: Priority = Priority.medium,
    description: str = "",
    position: float = 1024.0,
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        description=description,
        position=position,
        priority=priority,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    return card


@pytest.mark.asyncio
async def test_next_assignment_returns_eligible_backlog_card(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    # Post-redesign: implementer scans `active` (planner scans backlog).
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")
    card = await _make_card(db_session, test_board, cols["active"], test_user, title="real work")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["card"]["id"] == str(card.id)
    assert body["role"] == "implementer"
    assert body["board"]["name"] == test_board.name
    assert body["column"]["column_type"] == "active"
    assert body["repo"]["url"] == "https://github.com/acme/acme"
    # PAR-1: integration_branch null by default preserves current behavior.
    assert body["repo"]["integration_branch"] is None
    assert body["stage_action"] == "implement_card"
    assert body["reservation"]["id"]
    assert body["reservation"]["expires_at"]


@pytest.mark.asyncio
async def test_next_assignment_bundles_integration_branch_when_set(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """When the repo opts into a staging branch, the runner sees it bundled.

    PAR-1: parallel runners base new branches on integration_branch when the
    stage's git.base_ref selects it. The field must round-trip through the
    /next-assignment response so the runner can read it.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    repo = await _make_repo(db_session, test_board, test_user)
    repo.integration_branch = "develop"
    await db_session.flush()
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    await _make_card(db_session, test_board, cols["backlog"], test_user, title="real work")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["repo"]["integration_branch"] == "develop"


@pytest.mark.asyncio
async def test_next_assignment_returns_204_when_no_work(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    await _seed_default_pipeline(db_session, test_workspace)
    await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_next_assignment_excludes_untyped_columns(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    await _make_card(db_session, test_board, cols["untyped"], test_user, title="parked")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["orchestrator", "reviewer", "documentator"])
async def test_next_assignment_never_returns_card_from_untyped_column(
    role: str,
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Safety invariant: untyped columns (column_type IS NULL) are human-only.

    No agent role may ever receive a card from such a column. To prove the
    explicit `Column.column_type IS NOT NULL` guard in `_candidate_cards`
    (assignment_service.py:414) does the work — and not some adjacent
    `column_type` / `column_type_exclude` filter that incidentally rejects
    NULL — this test installs a pipeline whose stages have empty
    column_type filters. The card is also engineered to satisfy every
    other filter: PR URL for reviewer, no `documented` label for
    documentator, no hero participant + `strategy=column_scan` (skipping
    the unassigned_or_rework hero gate) for orchestrator.

    Disabling line 414 in the service must make this test fail.
    """
    permissive_pipeline = {
        "version": 1,
        "stages": [
            {
                "role": r,
                "unique": True,
                "discover": {
                    # column_scan + no column_type/exclude filters: only
                    # the IS NOT NULL guard can keep the untyped card out.
                    "strategy": "column_scan",
                    "column_type": "",
                    "column_type_exclude": "",
                    "filters": {"require_git_repo": True},
                },
                "claim": {
                    "participant_role": "helper",
                    "execution_action": f"{r}_card",
                },
                "git": {"action": "create_branch", "create_pr": False},
                "llm": {"enabled": False},
                "sensors": [],
                "on_success": {},
                "on_failure": {},
            }
            for r in ("orchestrator", "reviewer", "documentator")
        ],
        "scheduling": {"mode": "priority", "priority_order": []},
    }
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=permissive_pipeline,
        )
    )
    await db_session.flush()

    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, role)
    await _make_card(
        db_session,
        test_board,
        cols["untyped"],
        test_user,
        title=f"would-match-{role}-if-typed",
        description="see https://github.com/acme/acme/pull/1",
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 204, (
        f"role={role}: untyped-column card was claimed; response={resp.text}"
    )


@pytest.mark.asyncio
async def test_next_assignment_documentator_excludes_labeled_card(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """FOLLOWUP-10: documentator stage has filters.exclude_label="documented".

    A card already carrying the `documented` label must be skipped even when
    it sits in a done column. Without this, the documentator re-documents
    cards on every run, burning LLM cost.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "documentator")

    documented = await _make_card(
        db_session, test_board, cols["done"], test_user,
        title="already documented", position=1.0,
    )
    documented.labels = ["documented", "backend"]
    await db_session.flush()

    fresh = await _make_card(
        db_session, test_board, cols["done"], test_user,
        title="needs docs", position=2.0,
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "documentator"},
    )
    assert resp.status_code == 200
    assert resp.json()["card"]["id"] == str(fresh.id), (
        f"expected fresh card; got {resp.json()['card']['title']}"
    )


@pytest.mark.asyncio
async def test_next_assignment_documentator_excludes_card_with_multiple_labels(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """FOLLOWUP-10 regression: card cab3f05b had labels
    ["documented", "documentation-failed", "backend", "mvp-wave-1", "seeding"]
    and was still claimed by the documentator. Test the exact label set.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "documentator")

    only_doc = await _make_card(
        db_session, test_board, cols["done"], test_user,
        title="cab3f05b clone", position=1.0,
    )
    only_doc.labels = ["documented", "documentation-failed", "backend", "mvp-wave-1", "seeding"]
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "documentator"},
    )
    assert resp.status_code == 204, f"expected 204; got {resp.status_code} body={resp.text}"


@pytest.mark.asyncio
async def test_next_assignment_documentator_excludes_when_only_labeled_card_exists(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """FOLLOWUP-10: with only an already-documented card present, response is 204."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "documentator")

    only_doc = await _make_card(
        db_session, test_board, cols["done"], test_user,
        title="already documented", position=1.0,
    )
    only_doc.labels = ["documented"]
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "documentator"},
    )
    assert resp.status_code == 204, f"expected 204 (no eligible work); got {resp.status_code} body={resp.text}"


# ---------------------------------------------------------------------------
# Cluster A (gate cells #3/#4/#5): an LLM-step FAILURE on planner / reviewer /
# rework_mediator must PARK the card (durable failure label that the role's
# discover excludes), not re-loop. Pre-cure the failure label was decorative
# (planner/rework: applied but not in exclude_label) or absent (reviewer), and
# every fail path removes the participant first (strips skip_if_pipeline_role)
# → the card was re-handed every poll, burning LLM budget. Each test uses a
# paired control card identical except the failure label, so a 200 on the
# control proves the LABEL is the gate (not under-seeding).
# ---------------------------------------------------------------------------


async def _make_review_verdict_note(
    db: AsyncSession, board: Board, card: Card, user: User
) -> Note:
    """A `review_verdict` note on the card — the rework_mediator discover gate
    requires one (and one newer than any rework_brief)."""
    note = Note(
        workspace_id=board.workspace_id,
        board_id=board.id,
        card_id=card.id,
        title="verdict",
        content="changes requested",
        kind="review_verdict",
        created_by=user.id,
    )
    db.add(note)
    await db.flush()
    return note


@pytest.mark.asyncio
async def test_next_assignment_planner_excludes_planning_failed_card(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Cell #5: a card the planner already failed to plan (`planning-failed`)
    must not be re-handed to the planner. Paired control proves the label gates."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")

    failed = await _make_card(
        db_session, test_board, cols["backlog"], test_user,
        title="planning failed", position=1.0,
    )
    failed.labels = ["planning-failed"]
    control = await _make_card(
        db_session, test_board, cols["backlog"], test_user,
        title="fresh plan work", position=2.0,
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "planner"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(control.id), (
        f"planner must skip the planning-failed card; got {resp.json()['card']['title']}"
    )


@pytest.mark.asyncio
async def test_next_assignment_planning_failed_park_is_reversible(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The failure park is REVERSIBLE: once a human (or board_reconciler) removes
    the failure label, the card is re-discoverable. Guards against the park
    becoming a permanent dead-end — removing the label is the recovery lane."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")

    card = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="recovered plan",
    )
    card.labels = ["planning-failed"]
    await db_session.flush()

    parked = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "planner"},
    )
    assert parked.status_code == 204, "parked card must be invisible while labeled"

    card.labels = []
    await db_session.flush()

    revived = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "planner"},
    )
    assert revived.status_code == 200, revived.text
    assert revived.json()["card"]["id"] == str(card.id), (
        "removing planning-failed must restore the card to the planner"
    )


@pytest.mark.asyncio
async def test_next_assignment_reviewer_excludes_review_failed_card(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Cell #3: a card whose review_diff LLM step failed (`review-failed`) must
    not be re-handed to the reviewer. Both cards carry an open PR so the only
    differentiator is the failure label."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    failed = await _make_card(
        db_session, test_board, cols["review"], test_user,
        title="review failed", position=1.0,
    )
    failed.labels = ["review-failed"]
    failed.pr_url = "https://github.com/acme/acme/pull/11"
    control = await _make_card(
        db_session, test_board, cols["review"], test_user,
        title="fresh review work", position=2.0,
    )
    control.pr_url = "https://github.com/acme/acme/pull/12"
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "reviewer"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(control.id), (
        f"reviewer must skip the review-failed card; got {resp.json()['card']['title']}"
    )


@pytest.mark.asyncio
async def test_next_assignment_rework_excludes_rework_mediation_failed_card(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Cell #4: a card whose produce_rework_brief LLM step failed
    (`rework-mediation-failed`) must not be re-handed to the rework_mediator.
    Both cards satisfy the full rework gate (open PR + review_verdict note), so
    the failure label is the sole differentiator."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "rework_mediator")

    failed = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="rework failed", position=1.0,
    )
    failed.labels = ["rework-mediation-failed"]
    failed.pr_url = "https://github.com/acme/acme/pull/21"
    await db_session.flush()
    await _make_review_verdict_note(db_session, test_board, failed, test_user)

    control = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="fresh rework work", position=2.0,
    )
    control.pr_url = "https://github.com/acme/acme/pull/22"
    await db_session.flush()
    await _make_review_verdict_note(db_session, test_board, control, test_user)

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "rework_mediator"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(control.id), (
        f"rework_mediator must skip the rework-mediation-failed card; "
        f"got {resp.json()['card']['title']}"
    )


@pytest.mark.asyncio
async def test_default_reviewer_fail_path_applies_review_failed_label():
    """Cell #3 Edit A: the reviewer's review_diff on_failure chain must apply a
    durable `review-failed` label (between the self-unassign and the terminal)
    so the loop-breaker has a signal to gate on — mirrors planner/rework."""
    reviewer = next(
        s for s in DEFAULT_PIPELINE_CONFIG["stages"] if s["role"] == "reviewer"
    )
    steps = {s["name"]: s for s in reviewer["lifecycle"]}
    label_steps = [
        s for s in reviewer["lifecycle"]
        if s.get("kind") == "apply_label"
        and s.get("params", {}).get("label") == "review-failed"
    ]
    assert label_steps, "reviewer fail path must apply a 'review-failed' label"
    # the unassign step must route INTO the label step (not straight to end)
    assert steps["review_fail_unassign"]["next"] == label_steps[0]["name"]


@pytest.mark.asyncio
async def test_next_assignment_board_reconciler_excludes_reconciliation_failed_card(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """FCH-1: a card whose decide_disposition LLM step failed
    (`reconciliation-failed`) must not be re-handed to board_reconciler — without
    this the failure path (which unassigns the participant) lets the card be
    re-discovered and re-fail every poll (cost-monotonic loop). Both cards carry
    `needs-reconcile` so the failure label is the sole differentiator."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "board_reconciler"
    )

    failed = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="reconcile failed", position=1.0,
    )
    failed.labels = ["needs-reconcile", "reconciliation-failed"]
    control = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="fresh reconcile work", position=2.0,
    )
    control.labels = ["needs-reconcile"]
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "board_reconciler"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(control.id), (
        f"board_reconciler must skip the reconciliation-failed card; "
        f"got {resp.json()['card']['title']}"
    )


@pytest.mark.asyncio
async def test_next_assignment_reconciliation_failed_park_is_reversible(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """FCH-1 park is REVERSIBLE: removing `reconciliation-failed` (a human or a
    future recovery lane) restores the card to board_reconciler — the park must
    not become a permanent dead-end. The `needs-reconcile` signal is retained."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "board_reconciler"
    )

    card = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="recovered reconcile",
    )
    card.labels = ["needs-reconcile", "reconciliation-failed"]
    await db_session.flush()

    parked = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "board_reconciler"},
    )
    assert parked.status_code == 204, "parked card must be invisible while labeled"

    card.labels = ["needs-reconcile"]
    await db_session.flush()

    revived = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "board_reconciler"},
    )
    assert revived.status_code == 200, revived.text
    assert revived.json()["card"]["id"] == str(card.id), (
        "removing reconciliation-failed must restore the card to board_reconciler"
    )


@pytest.mark.asyncio
async def test_default_board_reconciler_fail_path_applies_reconciliation_failed_label():
    """FCH-1: board_reconciler's decide_disposition on_failure chain must apply a
    durable `reconciliation-failed` label between the self-unassign and the
    terminal (mirrors reviewer/planner/rework) so the loop-breaker has a signal to
    gate on. The label must be in the discover exclude_label too (both the
    role-level filter and the lifecycle discover step, byte-consistent)."""
    rec = next(
        s for s in DEFAULT_PIPELINE_CONFIG["stages"]
        if s["role"] == "board_reconciler"
    )
    steps = {s["name"]: s for s in rec["lifecycle"]}
    label_steps = [
        s for s in rec["lifecycle"]
        if s.get("kind") == "apply_label"
        and s.get("params", {}).get("label") == "reconciliation-failed"
    ]
    assert label_steps, (
        "board_reconciler fail path must apply a 'reconciliation-failed' label"
    )
    # the unassign step must route INTO the label step (not straight to end)
    assert steps["reconcile_fail_unassign"]["next"] == label_steps[0]["name"]

    # both discover surfaces must exclude the failure label (no split-brain)
    role_excl = rec["discover"]["filters"]["exclude_label"]
    lifecycle_discover = next(
        s for s in rec["lifecycle"] if s.get("kind") == "discover"
    )
    lifecycle_excl = lifecycle_discover["params"]["filters"]["exclude_label"]
    assert "reconciliation-failed" in role_excl, (
        "role-level discover must exclude reconciliation-failed"
    )
    assert "reconciliation-failed" in lifecycle_excl, (
        "lifecycle discover step must exclude reconciliation-failed"
    )
    assert role_excl == lifecycle_excl, (
        "role-level and lifecycle discover exclude_label must be byte-consistent"
    )


@pytest.mark.asyncio
async def test_next_assignment_priority_order(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")

    await _make_card(db_session, test_board, cols["backlog"], test_user,
                     title="medium one", priority=Priority.medium, position=1.0)
    urgent = await _make_card(db_session, test_board, cols["backlog"], test_user,
                              title="urgent one", priority=Priority.urgent, position=99.0)

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200
    assert resp.json()["card"]["id"] == str(urgent.id)


@pytest.mark.asyncio
async def test_next_assignment_repeated_call_is_idempotent(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    card = await _make_card(db_session, test_board, cols["backlog"], test_user, title="single")

    first = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert first.status_code == 200
    assert first.json()["card"]["id"] == str(card.id)

    second = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert second.status_code == 200
    assert second.json()["card"]["id"] == str(card.id)
    assert second.json()["reservation"]["id"] == first.json()["reservation"]["id"]


@pytest.mark.asyncio
async def test_next_assignment_two_agents_get_different_cards(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")

    a = await _make_card(db_session, test_board, cols["backlog"], test_user,
                         title="card a", priority=Priority.urgent, position=1.0)
    b = await _make_card(db_session, test_board, cols["backlog"], test_user,
                         title="card b", priority=Priority.urgent, position=2.0)

    from app.models.agents.agent import AgentType
    other_agent = Agent(
        name="other", agent_type=AgentType.coding,
        created_by_id=test_user.id, is_active=True,
    )
    db_session.add(other_agent)
    await db_session.flush()
    await _add_team_role(db_session, test_workspace, other_agent, test_user, "orchestrator")

    first = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert first.status_code == 200
    assert first.json()["card"]["id"] == str(a.id)

    # A real second runner authenticates with ITS OWN agent's API key — reusing
    # agent_client (bound to test_agent) against other_agent's URL id is the
    # exact IDOR the f47816b9 fix now blocks (403), so this needs its own
    # agent-bound client, not agent_client.
    async with _agent_bound_client(db_session, test_user, other_agent) as other_client:
        second = await other_client.post(
            URL_TPL.format(slug=test_workspace.slug, agent_id=other_agent.id),
            json={},
        )
    assert second.status_code == 200
    assert second.json()["card"]["id"] == str(b.id)


@pytest.mark.asyncio
async def test_next_assignment_reclaims_after_reservation_expires(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    card = await _make_card(db_session, test_board, cols["backlog"], test_user, title="abandoned")

    from app.models.agents.agent import AgentType
    other = Agent(
        name="ghost", agent_type=AgentType.coding,
        created_by_id=test_user.id, is_active=True,
    )
    db_session.add(other)
    await db_session.flush()
    expired = AgentReservation(
        agent_id=other.id,
        card_id=card.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="orchestrator",
        expires_at=datetime.utcnow() - timedelta(minutes=1),
    )
    db_session.add(expired)
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200
    assert resp.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_next_assignment_409_when_busy(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    other_card = await _make_card(db_session, test_board, cols["backlog"], test_user, title="busy")

    execution = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement_card",
        status="running",
        cards_affected=[str(other_card.id)],
    )
    db_session.add(execution)
    await db_session.flush()

    await _make_card(db_session, test_board, cols["backlog"], test_user, title="next")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 409
    body = resp.json()
    assert body["error_code"] == "agent_busy"
    assert body["active_card_id"] == str(other_card.id)


@pytest.mark.asyncio
async def test_next_assignment_reaps_execution_older_than_reap_horizon(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A running execution older than the reap horizon is a zombie (crashed
    runner or a tick that never closed it — the budget-suspend leak) and must
    be reaped (aborted) so the poll proceeds, NOT 409 the pipeline forever.

    Age — not liveness — is the signal: the runner heartbeats only between
    ticks, so a genuinely-busy long tick looks offline; only an execution
    open PAST the longest-possible tick is certainly abandoned.
    """
    from app.models.agents.execution import ExecutionStatus
    from app.services.scheduling.assignment_service import (
        STALE_EXECUTION_REAP_SECONDS,
    )
    from app.utils import utcnow

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")

    zombie_card = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="zombie"
    )
    zombie = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement_card",
        status="running",
        cards_affected=[str(zombie_card.id)],
        # Opened well past the reap horizon — certainly abandoned.
        started_at=utcnow() - timedelta(seconds=STALE_EXECUTION_REAP_SECONDS + 600),
    )
    db_session.add(zombie)
    await db_session.flush()
    zombie_id = zombie.id

    await _make_card(db_session, test_board, cols["backlog"], test_user, title="next")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    # No 409: the stale execution did not gate the poll.
    assert resp.status_code in (200, 204)

    # And it was reaped to a terminal status so it can never 409 again.
    refetched = await db_session.get(AgentExecution, zombie_id)
    await db_session.refresh(refetched)
    assert refetched.status == ExecutionStatus.aborted
    assert refetched.completed_at is not None


@pytest.mark.asyncio
async def test_next_assignment_409_when_busy_within_reap_horizon(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A recently-started running execution is a genuine in-flight tick —
    even a long one that hasn't heartbeated. The busy-guard must still 409;
    the age reaper must not abort live work out from under a running tick."""
    from app.utils import utcnow

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")

    busy_card = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="busy-live"
    )
    db_session.add(AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement_card",
        status="running",
        cards_affected=[str(busy_card.id)],
        # Started 5 minutes ago — a normal in-flight tick, within horizon.
        started_at=utcnow() - timedelta(seconds=300),
    ))
    await db_session.flush()

    await _make_card(db_session, test_board, cols["backlog"], test_user, title="next")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 409
    assert resp.json()["error_code"] == "agent_busy"


@pytest.mark.asyncio
async def test_next_assignment_reaps_stale_execution_with_null_cards_affected(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A leaked `running` execution whose cards_affected was never populated
    (the runner opened it but the tick died before recording the card, or the
    close that would have set it never ran) is STILL a zombie. Field incident:
    three such rows sat `running` for hours, invisible to the busy-guard's
    card-bound 409 (correct — a null-cards row can't conflict with a specific
    card claim) AND skipped by the age-reaper (the bug: `if not
    cards_affected: continue` short-circuited before the age check), so they
    never closed — polluting analytics and masking real liveness.

    The reaper must abort an age-stale running/started execution regardless of
    cards_affected. The 409 path stays card-bound and unchanged.
    """
    from app.models.agents.execution import ExecutionStatus
    from app.services.scheduling.assignment_service import (
        STALE_EXECUTION_REAP_SECONDS,
    )
    from app.utils import utcnow

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")

    leaked = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement_card",
        status="running",
        cards_affected=None,  # never populated — the leak shape
        started_at=utcnow() - timedelta(seconds=STALE_EXECUTION_REAP_SECONDS + 600),
    )
    db_session.add(leaked)
    await db_session.flush()
    leaked_id = leaked.id

    await _make_card(db_session, test_board, cols["backlog"], test_user, title="next")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    # No 409 (the row is not card-bound), and the poll proceeds.
    assert resp.status_code in (200, 204)

    # The leaked row was reaped to a terminal status, not left running forever.
    refetched = await db_session.get(AgentExecution, leaked_id)
    await db_session.refresh(refetched)
    assert refetched.status == ExecutionStatus.aborted
    assert refetched.completed_at is not None


@pytest.mark.asyncio
async def test_next_assignment_keeps_recent_null_cards_execution_running(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A RECENT null-cards running execution (a live tick that hasn't recorded
    its card yet) must NOT be reaped — only age past the horizon reaps. And it
    must NOT 409 either (not card-bound). The poll just proceeds."""
    from app.models.agents.execution import ExecutionStatus
    from app.utils import utcnow

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")

    recent = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement_card",
        status="running",
        cards_affected=None,
        started_at=utcnow() - timedelta(seconds=120),  # well within horizon
    )
    db_session.add(recent)
    await db_session.flush()
    recent_id = recent.id

    await _make_card(db_session, test_board, cols["backlog"], test_user, title="next")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code in (200, 204)

    refetched = await db_session.get(AgentExecution, recent_id)
    await db_session.refresh(refetched)
    assert refetched.status == ExecutionStatus.running  # untouched


@pytest.mark.asyncio
async def test_next_assignment_404_for_unknown_agent(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    db_session: AsyncSession,
):
    await _seed_default_pipeline(db_session, test_workspace)
    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=uuid.uuid4()),
        json={},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_next_assignment_403_when_owner_not_in_workspace(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    second_user: User,
    db_session: AsyncSession,
):
    await _seed_default_pipeline(db_session, test_workspace)
    from app.models.agents.agent import AgentType
    foreign_agent = Agent(
        name="foreign", agent_type=AgentType.coding,
        created_by_id=second_user.id, is_active=True,
    )
    db_session.add(foreign_agent)
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=foreign_agent.id),
        json={},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_idempotent_call_preserves_role_and_stage_action(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Re-issuing without role_override must use the reservation's stored role.

    Otherwise stage_action comes back empty on every retry. Regression
    guard for code-review Major #2.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")
    await _make_card(db_session, test_board, cols["active"], test_user, title="x")

    first = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "implementer"},
    )
    assert first.status_code == 200
    assert first.json()["stage_action"] == "implement_card"

    second = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert second.status_code == 200
    assert second.json()["role"] == "implementer"
    assert second.json()["stage_action"] == "implement_card"


@pytest.mark.asyncio
async def test_existing_reservation_isolated_per_workspace(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A reservation in workspace A must not leak into a request to workspace B.

    Regression guard for code-review Major #3.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")

    other_ws = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    db_session.add(WorkspaceMember(
        workspace_id=other_ws.id, user_id=test_user.id, role=WorkspaceRole.owner,
    ))
    await db_session.flush()

    other_board = Board(
        workspace_id=other_ws.id, name="Other", slug="other",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()
    other_cols = await _make_typed_columns(db_session, other_board)
    await _make_repo(db_session, other_board, test_user)
    await _make_card(db_session, other_board, other_cols["backlog"], test_user, title="other-card")

    db_session.add(AgentReservation(
        agent_id=test_agent.id,
        card_id=(await _make_card(db_session, test_board, cols["backlog"], test_user, title="ws-a")).id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="orchestrator",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=other_ws.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200
    assert resp.json()["card"]["title"] == "other-card"


@pytest.mark.asyncio
async def test_repo_has_no_open_pr_blocks_orchestrator_but_not_reviewer(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
    monkeypatch,
):
    """Role-scoped precondition test from card 9bb8ba47.

    Post-redesign: the implementer role inherits the orchestrator's
    preconditions=[repo_has_no_open_pr], so when ANY open PR exists on
    the repo, implementer gets 204. Reviewer's discover does not declare
    the precondition, so reviewer can still pick up the In-Review card
    whose PR is the open one.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")

    review_card = await _make_card(
        db_session, test_board, cols["review"], test_user,
        title="awaiting review",
        description=(
            "Look at this PR.\n"
            "Branch: feat/awaiting-review\n"
            "PR: https://github.com/acme/acme/pull/42"
        ),
    )
    # Review cards in real workflows always have an implementer hero —
    # without it, implementer scans would keep re-claiming the same card.
    implementer_user = User(email="implementer@valaris.dev", name="Impl")
    db_session.add(implementer_user)
    await db_session.flush()
    db_session.add(
        CardParticipant(card_id=review_card.id, user_id=implementer_user.id, role="hero")
    )
    await db_session.flush()
    await _make_card(db_session, test_board, cols["active"], test_user, title="new work")

    class _StubClient:
        async def list_open_prs(self, repo_url):
            from app.services.github_client import OpenPR
            return [
                OpenPR(
                    number=42,
                    head_branch="feat/awaiting-review",
                    url="https://github.com/acme/acme/pull/42",
                )
            ]

    from app.services.scheduling import assignment_service as svc

    monkeypatch.setattr(
        svc.AssignmentService,
        "_github_client_factory",
        lambda self, board_id: (lambda: _StubClient()),
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.json() if resp.content else "no body"

    from app.models.agents.agent import AgentType
    reviewer_agent = Agent(
        name="reviewer", agent_type=AgentType.coding,
        created_by_id=test_user.id, is_active=True,
    )
    db_session.add(reviewer_agent)
    await db_session.flush()
    await _add_team_role(db_session, test_workspace, reviewer_agent, test_user, "reviewer")

    # The reviewer is a distinct runner with its own agent API key — reusing
    # agent_client (bound to test_agent) against reviewer_agent's URL id is the
    # IDOR shape the f47816b9 fix now blocks (403), so it needs its own
    # agent-bound client.
    async with _agent_bound_client(db_session, test_user, reviewer_agent) as reviewer_client:
        resp = await reviewer_client.post(
            URL_TPL.format(slug=test_workspace.slug, agent_id=reviewer_agent.id),
            json={},
        )
    assert resp.status_code == 200
    assert resp.json()["card"]["id"] == str(review_card.id)
    assert resp.json()["role"] == "reviewer"


@pytest.mark.asyncio
async def test_mcp_session_in_other_workspace_does_not_block(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Regression for card d8797e78 / smoke Obs 2.

    An `mcp_session` execution row in workspace A must never block a
    /next-assignment call for the same agent in workspace B. The runner
    and the MCP client share the agent identity; their executions do not.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    card = await _make_card(db_session, test_board, cols["backlog"], test_user, title="work")

    other_ws = Workspace(name="Other", slug="other-mcp", created_by=test_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    db_session.add(WorkspaceMember(
        workspace_id=other_ws.id, user_id=test_user.id, role=WorkspaceRole.owner,
    ))
    await db_session.flush()

    db_session.add(AgentExecution(
        agent_id=test_agent.id,
        workspace_id=other_ws.id,
        board_id=None,
        action="mcp_session",
        status="started",
        cards_affected=[],
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200
    assert resp.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_mcp_session_in_same_workspace_does_not_block(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """An mcp_session row isn't work — it's instrumentation.

    Even in the same workspace, it must not count as "busy". The busy-
    gate exists to stop a runner from claiming a second card while still
    executing on the first — only card-bound executions qualify.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    card = await _make_card(db_session, test_board, cols["backlog"], test_user, title="work")

    db_session.add(AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="mcp_session",
        status="started",
        cards_affected=[],
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200
    assert resp.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_card_bound_execution_in_same_workspace_still_blocks(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The fix must narrow the gate, not delete it.

    A real implement_card execution on a card in this workspace must
    still 409 — that's what prevents a runner from claiming two cards at
    once.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    busy_card = await _make_card(db_session, test_board, cols["active"], test_user, title="busy")
    await _make_card(db_session, test_board, cols["backlog"], test_user, title="next")

    db_session.add(AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement_card",
        status="running",
        cards_affected=[str(busy_card.id)],
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 409
    assert resp.json()["error_code"] == "agent_busy"
    assert resp.json()["active_card_id"] == str(busy_card.id)


@pytest.mark.asyncio
async def test_card_bound_execution_in_other_workspace_does_not_block(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Busy is per-workspace.

    An agent that happens to be running a card in workspace A should be
    able to pick up fresh work in workspace B without waiting. The
    runner-identity-is-global problem is solved by scoping here, mirroring
    the existing workspace scoping on `_existing_active_reservation`.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    card = await _make_card(db_session, test_board, cols["backlog"], test_user, title="fresh")

    other_ws = Workspace(name="Other", slug="other-busy", created_by=test_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    db_session.add(WorkspaceMember(
        workspace_id=other_ws.id, user_id=test_user.id, role=WorkspaceRole.owner,
    ))
    await db_session.flush()

    db_session.add(AgentExecution(
        agent_id=test_agent.id,
        workspace_id=other_ws.id,
        board_id=None,
        action="implement_card",
        status="running",
        cards_affected=[str(uuid.uuid4())],
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200
    assert resp.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_next_assignment_skips_stale_reservation_when_card_moved_out(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Idempotent re-issue must re-validate column eligibility (card 69270bf2).

    The reservation TTL is 600s. If a card finishes its stage (e.g., reviewer
    moved In Review -> Done) before the reservation expires, the next poll
    must NOT return the now-Done card to the reviewer. The bug: idempotent
    re-issue returned the cached reservation without re-checking that the
    card's current column matches the role's discover filter, producing a
    cost-monotonic re-claim loop until the 10min TTL drained.

    Fix: before returning an existing reservation's bundle, verify the
    card's column.column_type still matches the role's stage discover.
    If not, delete the reservation and fall through to a fresh scan.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    finished_card = await _make_card(
        db_session, test_board, cols["done"], test_user,
        title="already-merged-and-done",
    )
    db_session.add(AgentReservation(
        agent_id=test_agent.id,
        card_id=finished_card.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="reviewer",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 204, (
        "stale reservation on a Done card must not be re-issued to reviewer; "
        f"got {resp.status_code} body={resp.content!r}"
    )

    from sqlalchemy import select as _select
    rows = (await db_session.execute(
        _select(AgentReservation).where(
            AgentReservation.agent_id == test_agent.id,
            AgentReservation.card_id == finished_card.id,
        )
    )).scalars().all()
    assert rows == [], (
        "stale reservation must be deleted so the next poll cannot re-fetch it"
    )


@pytest.mark.asyncio
async def test_next_assignment_orchestrator_reservation_invalidates_when_card_now_heroed(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Idempotent re-issue must honor the heroed-card filter for unassigned_or_rework.

    The orchestrator's discover strategy is `unassigned_or_rework`, which
    excludes any card that already has a `hero` participant. After the
    orchestrator ships a card, the card carries `hero=this agent` and moves
    to In Review — the orchestrator's job is done.

    Bug observed in a field smoke run 2026-04-26: the existing reservation
    from the just-shipped card was re-issued on the very next poll because
    `_reservation_still_eligible` only checked column_type. The orchestrator
    column_type_exclude is "done"; the card sat in "review" and passed the
    column check, so the bundle was returned. The runner then called
    claim_card on the heroed card → HTTP 409 already_claimed, every poll,
    until the 600s TTL drained. Cost-monotonic re-claim loop.

    Fix: when the role's discover strategy is `unassigned_or_rework`, treat
    a card that now has any `hero` participant as ineligible — mirror the
    SQL filter in `_candidate_cards`. Delete the reservation and fall
    through so the runner can advance to the next role (reviewer).
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )

    shipped_card = await _make_card(
        db_session, test_board, cols["review"], test_user,
        title="implementer-shipped-now-in-review",
        description=(
            "Implementation done.\n"
            "Branch: runner/some-card/lifespan-wiring\n"
            "PR: https://github.com/acme/acme/pull/48"
        ),
    )
    db_session.add(CardParticipant(
        card_id=shipped_card.id, agent_id=test_agent.id, user_id=test_user.id,
        role="hero",
    ))
    db_session.add(AgentReservation(
        agent_id=test_agent.id,
        card_id=shipped_card.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="implementer",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "implementer"},
    )

    assert resp.status_code == 204, (
        "implementer reservation on a now-heroed card must NOT be re-issued; "
        f"got {resp.status_code} body={resp.content!r}"
    )

    from sqlalchemy import select as _select
    rows = (await db_session.execute(
        _select(AgentReservation).where(
            AgentReservation.agent_id == test_agent.id,
            AgentReservation.card_id == shipped_card.id,
        )
    )).scalars().all()
    assert rows == [], (
        "stale reservation on a heroed card must be deleted so the next "
        "poll cannot re-fetch it and 409-loop"
    )


@pytest.mark.asyncio
async def test_next_assignment_reservation_invalidates_when_include_label_removed(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Idempotent re-issue must honor the role's label filters, not just column_type.

    Live ui_validator re-loop, client pilot Console run 2026-06-03: the
    ui_validator stage discovers `done`-column cards carrying
    `include_label: needs-ui-validation`. After a PASS the stage clears that
    label (apply `ui-validated`, remove `needs-ui-validation`) — the card is
    no longer discover-eligible. But the reservation row, created when the
    card still had the label, outlives the label change. On the very next
    poll `_reservation_still_eligible` re-validated ONLY column_type (`done`
    still matches), re-issued the same bundle, and the runner re-ran a full
    $3.64 opus visual-validation pass on an already-validated card — every
    poll, until the 600s TTL drained. Cost-monotonic re-claim loop.

    Fix: `_reservation_still_eligible` must mirror `_candidate_cards`' label
    predicates — a card missing a required `include_label` (or carrying an
    `exclude_label`) is ineligible. Delete the stale reservation and fall
    through so the runner advances instead of re-validating forever.
    """
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_label_filter_pipeline(
                "reviewer", {"include_label": "needs-ui-validation"}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    # Card was reserved while it still carried the include label, then the
    # stage cleared it on a successful pass (now carries only `ui-validated`).
    validated_card = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="already-validated-label-cleared",
    )
    validated_card.labels = ["ui-validated"]
    db_session.add(AgentReservation(
        agent_id=test_agent.id,
        card_id=validated_card.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="reviewer",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "reviewer"},
    )

    assert resp.status_code == 204, (
        "reservation on a card that no longer carries the required "
        f"include_label must NOT be re-issued; got {resp.status_code} "
        f"body={resp.content!r}"
    )

    from sqlalchemy import select as _select
    rows = (await db_session.execute(
        _select(AgentReservation).where(
            AgentReservation.agent_id == test_agent.id,
            AgentReservation.card_id == validated_card.id,
        )
    )).scalars().all()
    assert rows == [], (
        "stale reservation must be deleted so the next poll cannot re-fetch "
        "it and re-run a paid validation pass on an already-validated card"
    )


@pytest.mark.asyncio
async def test_next_assignment_reservation_invalidates_when_exclude_label_added(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Twin of the include-label case: an exclude_label gained mid-reservation.

    Same root cause as the live ui_validator loop — a discover label predicate
    changes after the reservation is created and `_reservation_still_eligible`
    never re-checks it. Here the card gains a label the role excludes; it must
    become ineligible, the reservation deleted, the poll a 204.
    """
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_label_filter_pipeline(
                "reviewer", {"exclude_label": "blocked-on-human"}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    parked_card = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="parked-after-reservation",
    )
    parked_card.labels = ["blocked-on-human"]
    db_session.add(AgentReservation(
        agent_id=test_agent.id,
        card_id=parked_card.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="reviewer",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "reviewer"},
    )

    assert resp.status_code == 204, (
        "reservation on a card that gained an exclude_label must NOT be "
        f"re-issued; got {resp.status_code} body={resp.content!r}"
    )

    from sqlalchemy import select as _select
    rows = (await db_session.execute(
        _select(AgentReservation).where(
            AgentReservation.agent_id == test_agent.id,
            AgentReservation.card_id == parked_card.id,
        )
    )).scalars().all()
    assert rows == [], "stale reservation on an excluded card must be deleted"


@pytest.mark.asyncio
async def test_next_assignment_reservation_invalidates_when_now_same_pipeline_role(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """skip_if_pipeline_role must also be re-checked on idempotent re-issue.

    The live ui_validator stage carries `skip_if_pipeline_role: ui_validator`.
    Once the agent has done the work it is attached as a `ui_validator`
    participant — so a fresh `_candidate_cards` scan would skip the card. But
    the reservation predates that participant row, and `_reservation_still_eligible`
    never checked pipeline_role, so the card was re-handed anyway (a second
    independent reason the live loop survived). A reservation whose card now
    carries a participant with the role's `skip_if_pipeline_role` must be
    treated as ineligible.
    """
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_label_filter_pipeline(
                "reviewer", {"skip_if_pipeline_role": "reviewer"}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    done_card = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="already-handled-by-this-pipeline-role",
    )
    db_session.add(CardParticipant(
        card_id=done_card.id, agent_id=test_agent.id, user_id=test_user.id,
        role="helper", pipeline_role="reviewer",
    ))
    db_session.add(AgentReservation(
        agent_id=test_agent.id,
        card_id=done_card.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="reviewer",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "reviewer"},
    )

    assert resp.status_code == 204, (
        "reservation on a card the agent already handled (skip_if_pipeline_role "
        f"match) must NOT be re-issued; got {resp.status_code} body={resp.content!r}"
    )

    from sqlalchemy import select as _select
    rows = (await db_session.execute(
        _select(AgentReservation).where(
            AgentReservation.agent_id == test_agent.id,
            AgentReservation.card_id == done_card.id,
        )
    )).scalars().all()
    assert rows == [], "stale reservation on a same-pipeline-role card must be deleted"


@pytest.mark.asyncio
async def test_next_assignment_stale_reservation_falls_through_to_fresh_card(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """When the cached reservation is stale, fall through and pick a fresh card.

    The reviewer just finished a card that's now in Done. There's another
    review-eligible card on the board. The runner's next poll must return
    that fresh card, not the stale one.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    finished_card = await _make_card(
        db_session, test_board, cols["done"], test_user, title="finished",
    )
    db_session.add(AgentReservation(
        agent_id=test_agent.id,
        card_id=finished_card.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="reviewer",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.flush()

    fresh_review_card = await _make_card(
        db_session, test_board, cols["review"], test_user,
        title="awaiting-review-fresh",
        description=(
            "PR up.\n"
            "Branch: feat/fresh\n"
            "PR: https://github.com/acme/acme/pull/77"
        ),
    )
    implementer = User(email="impl-fresh@valaris.dev", name="Impl")
    db_session.add(implementer)
    await db_session.flush()
    db_session.add(CardParticipant(
        card_id=fresh_review_card.id, user_id=implementer.id, role="hero",
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.content
    assert resp.json()["card"]["id"] == str(fresh_review_card.id)
    assert resp.json()["role"] == "reviewer"


@pytest.mark.asyncio
async def test_next_assignment_does_not_return_other_roles_reservation(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Multi-role runner: reviewer poll must not get orchestrator's reservation.

    Card 40369bc9. Forensics from the field smoke run 2026-04-25 03:46-03:54 UTC:
    a multi-role runner (priority=[reviewer, orchestrator, documentator])
    asked the backend for `role_override=reviewer`, but the backend returned
    a card from a stale orchestrator reservation that hadn't been swept yet.
    The card was in Backlog (orchestrator-eligible) and reviewer's discover
    requires column_type=review. The backend handed it back anyway, the
    runner ran an LLM reviewer prompt against a Backlog card with no PR,
    and burned ~$0.61 in 90 seconds before the loop was killed.

    Fix: when role_override is supplied and disagrees with an existing
    reservation's stored role, do NOT re-issue the reservation. Fall
    through to a fresh candidate scan with the requested role's filters.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")

    # Multi-role team: one team carrying BOTH roles for this agent.
    # _add_team_role creates a fresh single-role team each call, but the
    # backend's get_agent_team_info returns only the first team it finds.
    # Reproducing the field runner's [orchestrator, reviewer]
    # team_member.roles list requires editing that one team's roles in
    # place after the orchestrator team is created.
    from sqlalchemy import select as _select
    member_row = (await db_session.execute(
        _select(AgentTeamMember).where(AgentTeamMember.agent_id == test_agent.id)
    )).scalar_one()
    member_row.roles = ["orchestrator", "reviewer"]
    await db_session.flush()

    backlog_card = await _make_card(
        db_session, test_board, cols["backlog"], test_user,
        title="orchestrator-claimed-card",
    )
    db_session.add(AgentReservation(
        agent_id=test_agent.id,
        card_id=backlog_card.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="orchestrator",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "reviewer"},
    )

    assert resp.status_code == 204, (
        f"reviewer poll must not consume orchestrator reservation. "
        f"got {resp.status_code} body={resp.content!r}"
    )

    from sqlalchemy import select as _select
    rows = (await db_session.execute(
        _select(AgentReservation).where(
            AgentReservation.agent_id == test_agent.id,
            AgentReservation.card_id == backlog_card.id,
        )
    )).scalars().all()
    assert len(rows) == 1 and rows[0].role == "orchestrator", (
        "another role's reservation must NOT be deleted by a cross-role poll; "
        "it stays alive for its rightful role until TTL or natural release"
    )


@pytest.mark.asyncio
async def test_next_assignment_idempotent_reissue_when_role_matches(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Regression guard: matching-role re-issue still returns the same card.

    The cross-role fix must not break the existing single-role idempotent
    contract. implementer reservation + implementer poll = same card back.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")

    active_card = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="my-implementer-card",
    )
    db_session.add(AgentReservation(
        agent_id=test_agent.id,
        card_id=active_card.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="implementer",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "implementer"},
    )

    assert resp.status_code == 200, resp.content
    assert resp.json()["card"]["id"] == str(active_card.id)
    assert resp.json()["role"] == "implementer"


@pytest.mark.asyncio
async def test_next_assignment_no_override_uses_existing_reservation(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Single-role retry: no role_override + active reservation = same card back.

    Regression guard. The "trust the reservation's stored role" path must
    survive for runners that don't pass role_override (legacy single-role
    runners still re-poll mid-stage).
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")

    active_card = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="single-role-retry-card",
    )
    db_session.add(AgentReservation(
        agent_id=test_agent.id,
        card_id=active_card.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="implementer",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.content
    assert resp.json()["card"]["id"] == str(active_card.id)
    assert resp.json()["role"] == "implementer"


# ---------------------------------------------------------------------------
# Cost circuit breaker integration with /next-assignment (card e244867f)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_next_assignment_returns_423_when_breaker_paused(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """When workspace cost over the rolling window exceeds threshold and
    action=pause, /next-assignment short-circuits with 423 Locked."""
    from app.models.agents.execution import AgentExecution, ExecutionStatus
    from app.services.agents.cost import reset_breaker_dedupe

    cfg = WorkspaceConfig(
        workspace_id=test_workspace.id,
        pipeline_config=DEFAULT_PIPELINE_CONFIG,
        cost_circuit_breaker={
            "enabled": True,
            "threshold_usd_per_15min": 0.01,
            "action": "pause",
        },
    )
    db_session.add(cfg)
    await db_session.flush()

    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    await _make_card(db_session, test_board, cols["backlog"], test_user, title="cardx")

    db_session.add(AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        action="implement_card",
        status=ExecutionStatus.completed,
        cost_usd=5.0,
        started_at=datetime.utcnow() - timedelta(minutes=1),
    ))
    await db_session.flush()

    reset_breaker_dedupe(test_workspace.id)
    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 423, resp.text
    body = resp.json()
    assert body.get("error_code") == "circuit_breaker_active"
    assert body.get("threshold_usd") == pytest.approx(0.01)
    assert body.get("current_usd") == pytest.approx(5.0)


@pytest.mark.asyncio
async def test_next_assignment_proceeds_when_breaker_disabled(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Sanity: with breaker disabled, /next-assignment behaves normally."""
    cfg = WorkspaceConfig(
        workspace_id=test_workspace.id,
        pipeline_config=DEFAULT_PIPELINE_CONFIG,
        cost_circuit_breaker={
            "enabled": False,
            "threshold_usd_per_15min": 0.01,
            "action": "pause",
        },
    )
    db_session.add(cfg)
    await db_session.flush()

    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    card = await _make_card(db_session, test_board, cols["backlog"], test_user, title="ok")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_next_assignment_alert_action_does_not_block(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """action=alert emits the event but never returns 423."""
    from app.models.agents.execution import AgentExecution, ExecutionStatus
    from app.services.agents.cost import reset_breaker_dedupe

    cfg = WorkspaceConfig(
        workspace_id=test_workspace.id,
        pipeline_config=DEFAULT_PIPELINE_CONFIG,
        cost_circuit_breaker={
            "enabled": True,
            "threshold_usd_per_15min": 0.01,
            "action": "alert",
        },
    )
    db_session.add(cfg)
    await db_session.flush()

    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    card = await _make_card(db_session, test_board, cols["backlog"], test_user, title="alerted")

    db_session.add(AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        action="implement_card",
        status=ExecutionStatus.completed,
        cost_usd=5.0,
        started_at=datetime.utcnow() - timedelta(minutes=1),
    ))
    await db_session.flush()

    reset_breaker_dedupe(test_workspace.id)
    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(card.id)


# ---------------------------------------------------------------------------
# CTX-1: backend-rendered llm.context_sources injected into the response
# ---------------------------------------------------------------------------


def _pipeline_with_orchestrator_context_sources(sources: list[dict]) -> dict:
    import copy as _copy
    cfg = _copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["llm"]["context_sources"] = sources
    return cfg


@pytest.mark.asyncio
async def test_next_assignment_response_has_empty_context_when_sources_empty(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    # The default pipeline's planner declares CardNotes; an unset source list
    # needs an explicit pipeline.
    cfg = WorkspaceConfig(
        workspace_id=test_workspace.id,
        pipeline_config=_pipeline_with_orchestrator_context_sources([]),
    )
    db_session.add(cfg)
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    await _make_card(db_session, test_board, cols["backlog"], test_user, title="x")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["context"] == {}


@pytest.mark.asyncio
async def test_next_assignment_response_renders_configured_context_sources(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    from app.models.definitions.definition import Definition
    from app.models.notes.note import Note

    cfg = WorkspaceConfig(
        workspace_id=test_workspace.id,
        pipeline_config=_pipeline_with_orchestrator_context_sources([
            {"kind": "card_notes", "filter": {"kind": "user_note"}, "as": "notes"},
            {"kind": "board_definition"},
            {"kind": "pinned_notes"},
        ]),
    )
    db_session.add(cfg)
    await db_session.flush()

    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    card = await _make_card(db_session, test_board, cols["backlog"], test_user, title="ctx")

    db_session.add_all([
        Note(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            card_id=card.id,
            title="hint",
            content="prefer kebab-case",
            kind="user_note",
            created_by=test_user.id,
        ),
        Note(
            workspace_id=test_workspace.id,
            board_id=None,
            title="House Rule",
            content="no emojis in code",
            pinned=True,
            kind="user_note",
            created_by=test_user.id,
        ),
        Definition(
            board_id=test_board.id,
            workspace_id=test_workspace.id,
            scope="MVP",
            content={"coding_standards": "type hints everywhere"},
            updated_by=test_user.id,
        ),
    ])
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body["context"].keys()) == {"notes", "board_definition", "pinned_notes"}
    assert "kebab-case" in body["context"]["notes"]
    assert "type hints" in body["context"]["board_definition"]
    assert "House Rule" in body["context"]["pinned_notes"]


# ---------------------------------------------------------------------------
# Wave 2 / CRIT-2: assignment payload exposes per-stage LLM provider+model
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_next_assignment_payload_includes_llm_provider_model_slug(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The runner must receive the assigned stage's provider + model + prompt
    slug so it can pick the right LLM without consulting its local yaml.
    `prompt_slug` falls back to the stage name when no operator override has
    been authored yet."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")
    await _make_card(db_session, test_board, cols["active"], test_user, title="real work")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "llm" in body, "assignment payload must expose llm block"
    llm = body["llm"]
    assert isinstance(llm.get("provider"), str) and llm["provider"]
    assert isinstance(llm.get("model"), str) and llm["model"]
    # prompt_slug defaults to the stage name when no AgentPromptConfig override
    # exists. Implementer's stage is "implement".
    assert llm.get("prompt_slug") == "implement"


@pytest.mark.asyncio
async def test_next_assignment_payload_includes_tool_policy_deny(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The runner must receive the assigned stage's tool deny-list so it can
    launch the claude subprocess with `--disallowedTools`. The implementer is a
    git-capable stage, so its assignment payload carries the eight-entry
    security floor at llm.tool_policy.deny (a list of opaque CLI-pattern
    strings)."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")
    await _make_card(db_session, test_board, cols["active"], test_user, title="real work")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.text
    llm = resp.json()["llm"]
    assert "tool_policy" in llm, "assignment llm block must expose tool_policy"
    deny = llm["tool_policy"]["deny"]
    assert isinstance(deny, list) and all(isinstance(e, str) for e in deny)
    floor = {
        "Bash(gh pr merge:*)",
        "Bash(gh pr review:*)",
        "Bash(gh pr close:*)",
        "Bash(git push --force:*)",
        "Bash(git push --force-with-lease:*)",
        "Bash(git push origin main:*)",
        "Bash(git push origin master:*)",
        "Bash(git reset --hard:*)",
    }
    assert floor <= set(deny), f"deny floor not surfaced in payload: missing {floor - set(deny)}"


# --- SWE-AF #2: needs-advisor exclusion in the scheduler ---


@pytest.mark.asyncio
async def test_next_assignment_skips_needs_advisor_card_for_reviewer(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Stuck-loop parked cards must not be re-handed to the reviewer."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    parked = await _make_card(
        db_session, test_board, cols["review"], test_user,
        title="parked", description="https://github.com/acme/acme/pull/1",
    )
    parked.labels = ["needs-advisor"]
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role": "reviewer"},
    )

    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_next_assignment_returns_unparked_card_for_reviewer(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Cards without the needs-advisor label keep flowing to the reviewer."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    available = await _make_card(
        db_session, test_board, cols["review"], test_user,
        title="reviewable", description="https://github.com/acme/acme/pull/2",
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role": "reviewer"},
    )

    assert resp.status_code == 200
    assert resp.json()["card"]["id"] == str(available.id)


# ---------------------------------------------------------------------------
# LIFECYCLE-1 A.1: stage.lifecycle passthrough.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_next_assignment_passes_stage_lifecycle_through_verbatim(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """When the workspace stage carries a lifecycle array, the runner sees it.

    Lane A.2 walks the array; lane A.1 only guarantees it reaches the runner
    via the assignment payload exactly as authored.
    """
    lifecycle_steps = [
        {
            "name": "find",
            "kind": "discover",
            "params": {"strategy": "unassigned_or_rework", "column_type": "backlog"},
            "next": "grab",
        },
        {
            "name": "grab",
            "kind": "claim",
            "params": {"participant_role": "hero", "execution_action": "implement_card"},
            "next": "ship",
        },
        {
            "name": "ship",
            "kind": "move_card",
            "params": {"to_column_type": "active"},
        },
    ]
    pipeline = {
        "version": 1,
        "stages": [
            {
                "role": "orchestrator",
                "discover": {
                    "strategy": "unassigned_or_rework",
                    "column_type": "backlog",
                    "filters": {"require_git_repo": True},
                },
                "claim": {
                    "participant_role": "hero",
                    "execution_action": "implement_card",
                },
                "git": {"action": "create_branch", "create_pr": False},
                "llm": {"enabled": False},
                "sensors": [],
                "on_success": {},
                "on_failure": {},
                "lifecycle": lifecycle_steps,
            }
        ],
        "scheduling": {"mode": "priority", "priority_order": ["orchestrator"]},
    }
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=pipeline,
        )
    )
    await db_session.flush()

    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "orchestrator"
    )
    await _make_card(db_session, test_board, cols["backlog"], test_user, title="x")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["lifecycle"] == lifecycle_steps


@pytest.mark.asyncio
async def test_next_assignment_lifecycle_absent_when_stage_omits_it(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Legacy stages with no lifecycle key produce a null/absent lifecycle field.

    Preserves pre-LIFECYCLE-1 wire shape for runners on a custom pipeline_config
    that hasn't been migrated. Note: DEFAULT_PIPELINE_CONFIG itself now carries
    `lifecycle` per role (LIFECYCLE-1 A.3); the default-pipeline pass-through
    case is covered by ``test_next_assignment_default_pipeline_passes_lifecycle``.
    """
    legacy_only = {
        "version": 1,
        "stages": [
            {
                "role": "orchestrator",
                "discover": {
                    "strategy": "unassigned_or_rework",
                    "column_type": "backlog",
                    "filters": {"require_git_repo": True},
                },
                "claim": {
                    "participant_role": "hero",
                    "execution_action": "implement_card",
                },
                "git": {"action": "create_branch", "create_pr": False},
                "llm": {"enabled": False},
                "sensors": [],
                "on_success": {},
                "on_failure": {},
            }
        ],
        "scheduling": {"mode": "priority", "priority_order": ["orchestrator"]},
    }
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=legacy_only,
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "orchestrator"
    )
    await _make_card(db_session, test_board, cols["backlog"], test_user, title="x")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("lifecycle") is None


@pytest.mark.asyncio
async def test_next_assignment_default_pipeline_passes_lifecycle(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """LIFECYCLE-1 A.3: the default pipeline ships a lifecycle per stage.

    Asserts the implementer's lifecycle reaches the runner end-to-end through
    /next-assignment. Spot-checks boundary step names rather than comparing
    the full blob — the structural test in
    test_default_pipeline_config_lifecycle.py owns the per-step shape contract.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    await _make_card(db_session, test_board, cols["active"], test_user, title="x")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    lifecycle = body.get("lifecycle")
    assert isinstance(lifecycle, list) and lifecycle, "default lifecycle absent"
    step_names = [s["name"] for s in lifecycle]
    assert "discover_active" in step_names
    assert "implement_code" in step_names
    assert "ship_to_review" in step_names
    # Success path tail: ship is the terminal node for the happy path.
    ship_step = next(s for s in lifecycle if s["name"] == "ship_to_review")
    assert ship_step["kind"] == "ship"


# ---------------------------------------------------------------------------
# Tier-aware LLM resolution (forward-looking model-tier abstraction)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_next_assignment_resolves_tier_premium_to_opus(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """When a stage's llm.model is the tier identifier 'premium' the payload
    must carry the resolved provider+model (claude-cli, opus) rather than the
    raw tier string."""
    pipeline = {
        "version": 1,
        "stages": [
            {
                "role": "orchestrator",
                "unique": True,
                "discover": {
                    "strategy": "unassigned_or_rework",
                    "column_type": "",
                    "column_type_exclude": "done",
                    "filters": {"require_git_repo": True},
                },
                "claim": {
                    "participant_role": "hero",
                    "execution_action": "implement_card",
                },
                "git": {"action": "create_branch", "create_pr": True},
                "llm": {
                    "enabled": True,
                    "stage": "implement",
                    "provider": "claude-cli",
                    "model": "premium",
                    "tools": [],
                    "inject_directives": True,
                    "approval_enabled": True,
                },
                "sensors": [],
                "on_success": {"move_to_column_type": "review"},
            },
        ],
        "scheduling": {"mode": "priority", "priority_order": ["orchestrator"]},
    }
    db_session.add(
        WorkspaceConfig(workspace_id=test_workspace.id, pipeline_config=pipeline)
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "orchestrator"
    )
    await _make_card(db_session, test_board, cols["backlog"], test_user, title="x")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["llm"]["provider"] == "claude-cli"
    assert body["llm"]["model"] == "opus"


@pytest.mark.asyncio
async def test_next_assignment_emits_raw_tier_alongside_resolved_model(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A stage whose llm.model is a tier alias must forward the RAW tier name
    (premium) on llm.tier so a runner can remap it to a locally-available
    coding agent, while provider+model still carry the backend-resolved
    (claude-cli, opus) as the hint/fallback."""
    pipeline = {
        "version": 1,
        "stages": [
            {
                "role": "orchestrator",
                "unique": True,
                "discover": {
                    "strategy": "unassigned_or_rework",
                    "column_type": "",
                    "column_type_exclude": "done",
                    "filters": {"require_git_repo": True},
                },
                "claim": {
                    "participant_role": "hero",
                    "execution_action": "implement_card",
                },
                "git": {"action": "create_branch", "create_pr": True},
                "llm": {
                    "enabled": True,
                    "stage": "implement",
                    "provider": "claude-cli",
                    "model": "premium",
                    "tools": [],
                    "inject_directives": True,
                    "approval_enabled": True,
                },
                "sensors": [],
                "on_success": {"move_to_column_type": "review"},
            },
        ],
        "scheduling": {"mode": "priority", "priority_order": ["orchestrator"]},
    }
    db_session.add(
        WorkspaceConfig(workspace_id=test_workspace.id, pipeline_config=pipeline)
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "orchestrator"
    )
    await _make_card(db_session, test_board, cols["backlog"], test_user, title="x")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["llm"]["tier"] == "premium"
    assert body["llm"]["provider"] == "claude-cli"
    assert body["llm"]["model"] == "opus"


@pytest.mark.asyncio
async def test_next_assignment_tier_empty_for_concrete_model(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A stage that pins a concrete model (not a tier alias) carries an empty
    llm.tier — the runner then has no tier to remap and uses provider/model."""
    pipeline = {
        "version": 1,
        "stages": [
            {
                "role": "orchestrator",
                "unique": True,
                "discover": {
                    "strategy": "unassigned_or_rework",
                    "column_type": "",
                    "column_type_exclude": "done",
                    "filters": {"require_git_repo": True},
                },
                "claim": {
                    "participant_role": "hero",
                    "execution_action": "implement_card",
                },
                "git": {"action": "create_branch", "create_pr": True},
                "llm": {
                    "enabled": True,
                    "stage": "implement",
                    "provider": "claude-cli",
                    "model": "opus",
                    "tools": [],
                    "inject_directives": True,
                    "approval_enabled": True,
                },
                "sensors": [],
                "on_success": {"move_to_column_type": "review"},
            },
        ],
        "scheduling": {"mode": "priority", "priority_order": ["orchestrator"]},
    }
    db_session.add(
        WorkspaceConfig(workspace_id=test_workspace.id, pipeline_config=pipeline)
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "orchestrator"
    )
    await _make_card(db_session, test_board, cols["backlog"], test_user, title="x")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["llm"]["tier"] == ""
    assert body["llm"]["model"] == "opus"


def _lifecycle_only_model_pipeline(model: str | None) -> dict:
    """A stage whose flat llm block omits provider/model (the split-brain the
    frontend creates: the pipeline builder writes lifecycle[llm].params.model
    but leaves the flat llm.model empty). When `model` is None the lifecycle
    step also omits it — no model anywhere."""
    llm_params = {
        "stage": "implement",
        "provider": "claude-cli",
        "post_process_kind": "writes_code",
        "tools": [],
        "inject_directives": True,
        "approval_enabled": True,
    }
    if model is not None:
        llm_params["model"] = model
    return {
        "version": 1,
        "stages": [
            {
                "role": "implementer",
                "unique": True,
                "discover": {
                    "strategy": "column_scan",
                    "column_type": "active",
                    "filters": {"require_git_repo": True},
                },
                "claim": {
                    "participant_role": "hero",
                    "execution_action": "implement_card",
                },
                "git": {"action": "create_branch", "create_pr": True},
                "llm": {
                    "enabled": True,
                    "stage": "implement",
                    "provider": "",
                    "model": "",
                    "tools": [],
                    "inject_directives": True,
                    "approval_enabled": True,
                },
                "sensors": [],
                "lifecycle": [
                    {
                        "name": "discover_active",
                        "kind": "discover",
                        "params": {
                            "strategy": "column_scan",
                            "column_type": "active",
                            "filters": {"require_git_repo": True},
                        },
                        "next": "claim_for_implementation",
                    },
                    {
                        "name": "claim_for_implementation",
                        "kind": "claim",
                        "params": {
                            "pipeline_role": "implementer",
                            "participant_role": "hero",
                            "execution_action": "implement_card",
                        },
                        "next": "implement_code",
                    },
                    {
                        "name": "implement_code",
                        "kind": "llm",
                        "params": llm_params,
                    },
                ],
                "on_success": {"move_to_column_type": "review"},
            },
        ],
        "scheduling": {"mode": "priority", "priority_order": ["implementer"]},
    }


@pytest.mark.asyncio
async def test_next_assignment_resolves_model_from_lifecycle_params_when_flat_empty(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """BUG b8024b15 escalation: the frontend writes the model into
    lifecycle[llm].params.model, leaving the flat stage.llm.model empty. The
    dispatch must fall back to the lifecycle params instead of emitting an empty
    model (which made the runner silently fall back to its yaml sonnet)."""
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_lifecycle_only_model_pipeline("premium"),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    await _make_card(db_session, test_board, cols["active"], test_user, title="x")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["llm"]["model"] == "opus", (
        "model from lifecycle params did not reach the assignment payload"
    )
    assert body["llm"]["provider"] == "claude-cli"


def _disagreeing_model_pipeline(flat_model: str, lifecycle_model: str) -> dict:
    """A stage where the flat llm.model and the lifecycle[llm].params.model
    DISAGREE — the exact M1-05 split-brain: the frontend builder bumped the
    lifecycle step's model (premium) but left the stale flat default (mid). The
    frontend-authored lifecycle value must win; flat-first silently shadowed it
    and ran sonnet against a premium-configured implementer (2026-05-26)."""
    pipeline = _lifecycle_only_model_pipeline(lifecycle_model)
    stage = pipeline["stages"][0]
    stage["llm"]["provider"] = "claude-cli"
    stage["llm"]["model"] = flat_model
    return pipeline


@pytest.mark.asyncio
async def test_next_assignment_lifecycle_model_wins_when_flat_disagrees(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """M1-05 bug: flat stage.llm.model='mid' and lifecycle[llm].params.model=
    'premium' disagree. The frontend builder writes the lifecycle step, so its
    value is authoritative — the dispatch must resolve premium→opus, not the
    stale flat mid→sonnet."""
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_disagreeing_model_pipeline(
                flat_model="mid", lifecycle_model="premium"
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    await _make_card(db_session, test_board, cols["active"], test_user, title="x")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["llm"]["model"] == "opus", (
        "lifecycle-authored premium model lost to the stale flat 'mid' — "
        "the frontend builder's edit must win when the two representations "
        "disagree"
    )


def _dispatch_extras_pipeline(
    *,
    flat_deny: list[str] | None = None,
    lifecycle_deny: list[str] | None = None,
    flat_schema: str | None = None,
    lifecycle_schema: str | None = None,
) -> dict:
    """A stage carrying tool_policy/output_schema on either representation.

    Both fields follow the same lifecycle-first, flat-fallback precedence as
    provider/model — `None` means the key is absent from that representation,
    which is what makes the fallback fire.
    """
    pipeline = _lifecycle_only_model_pipeline("premium")
    stage = pipeline["stages"][0]
    lifecycle_params = stage["lifecycle"][2]["params"]
    if flat_deny is not None:
        stage["llm"]["tool_policy"] = {"deny": flat_deny}
    if lifecycle_deny is not None:
        lifecycle_params["tool_policy"] = {"deny": lifecycle_deny}
    if flat_schema is not None:
        stage["llm"]["output_schema"] = flat_schema
    if lifecycle_schema is not None:
        lifecycle_params["output_schema"] = lifecycle_schema
    return pipeline


async def _dispatch_llm_block(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
    pipeline: dict,
) -> dict:
    """Seed `pipeline` as the workspace config and return the assignment's llm block."""
    db_session.add(
        WorkspaceConfig(workspace_id=test_workspace.id, pipeline_config=pipeline)
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    await _make_card(db_session, test_board, cols["active"], test_user, title="x")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["llm"]


@pytest.mark.asyncio
async def test_next_assignment_tool_deny_prefers_lifecycle_over_flat(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """tool_policy.deny follows provider/model precedence: the frontend builder
    writes it into the lifecycle llm step, so that list wins outright over the
    backend-authored flat block — it is not merged."""
    llm = await _dispatch_llm_block(
        agent_client,
        test_workspace,
        test_board,
        test_user,
        test_agent,
        db_session,
        _dispatch_extras_pipeline(
            flat_deny=["Bash(flat:*)"], lifecycle_deny=["Bash(lifecycle:*)"]
        ),
    )

    assert llm["tool_policy"]["deny"] == ["Bash(lifecycle:*)"]


@pytest.mark.asyncio
async def test_next_assignment_tool_deny_falls_back_to_flat(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """With no lifecycle tool_policy, the flat block's deny-list is carried
    verbatim — pre-lifecycle and backend-default-only configs keep working."""
    llm = await _dispatch_llm_block(
        agent_client,
        test_workspace,
        test_board,
        test_user,
        test_agent,
        db_session,
        _dispatch_extras_pipeline(flat_deny=["Bash(flat:*)"]),
    )

    assert llm["tool_policy"]["deny"] == ["Bash(flat:*)"]


@pytest.mark.asyncio
async def test_next_assignment_tool_deny_empty_when_neither_declares_it(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A stage declaring no deny-list anywhere yields an empty list, never null
    — the runner splices it straight into --disallowedTools."""
    llm = await _dispatch_llm_block(
        agent_client,
        test_workspace,
        test_board,
        test_user,
        test_agent,
        db_session,
        _dispatch_extras_pipeline(),
    )

    assert llm["tool_policy"]["deny"] == []


@pytest.mark.asyncio
async def test_next_assignment_output_schema_prefers_lifecycle_over_flat(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """output_schema resolves lifecycle-first like tool_policy: a stage whose
    decision enum differs from the default approve/request_changes envelope
    declares it on the lifecycle step the builder writes."""
    llm = await _dispatch_llm_block(
        agent_client,
        test_workspace,
        test_board,
        test_user,
        test_agent,
        db_session,
        _dispatch_extras_pipeline(
            flat_schema="flat_envelope", lifecycle_schema="board_reconciler_decision"
        ),
    )

    assert llm["output_schema"] == "board_reconciler_decision"


@pytest.mark.asyncio
async def test_next_assignment_output_schema_falls_back_to_flat(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """With no lifecycle output_schema the flat declaration is used."""
    llm = await _dispatch_llm_block(
        agent_client,
        test_workspace,
        test_board,
        test_user,
        test_agent,
        db_session,
        _dispatch_extras_pipeline(flat_schema="flat_envelope"),
    )

    assert llm["output_schema"] == "flat_envelope"


@pytest.mark.asyncio
async def test_next_assignment_output_schema_empty_when_undeclared(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Every stage that does not declare an output_schema gets an empty string,
    which is the runner's signal to use its built-in decisionOutputSchema."""
    llm = await _dispatch_llm_block(
        agent_client,
        test_workspace,
        test_board,
        test_user,
        test_agent,
        db_session,
        _dispatch_extras_pipeline(),
    )

    assert llm["output_schema"] == ""


@pytest.mark.asyncio
async def test_next_assignment_logs_error_when_no_model_anywhere(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
    caplog,
):
    """When an enabled LLM stage declares no model in either the flat llm block
    or the lifecycle params, the dispatch must FAIL LOUD (ERROR log naming the
    workspace + role) instead of silently emitting an empty model and letting
    the runner fall back to its yaml default."""
    import logging

    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_lifecycle_only_model_pipeline(None),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    await _make_card(db_session, test_board, cols["active"], test_user, title="x")

    with caplog.at_level(logging.ERROR):
        resp = await agent_client.post(
            URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
            json={},
        )

    assert resp.status_code == 200, resp.text
    error_logs = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert any("model" in r.getMessage().lower() for r in error_logs), (
        "expected a loud ERROR log naming the missing model; got: "
        f"{[r.getMessage() for r in error_logs]}"
    )
    assert any("implementer" in r.getMessage() for r in error_logs), (
        "ERROR log should name the role with the missing model"
    )


# ---------------------------------------------------------------------------
# [BUG ab0f39e4] require_pipeline_role / require_participant_role consumers.
# Validator declared these keys; scheduler ignored them. These tests pin the
# symmetric semantics: a card is eligible only if at least one participant
# matches the required role.
# ---------------------------------------------------------------------------


def _require_pipeline_role_pipeline(required: str) -> dict:
    return {
        "version": 1,
        "stages": [
            {
                "role": "implementer",
                "unique": True,
                "discover": {
                    "strategy": "column_scan",
                    "column_type": "active",
                    "filters": {
                        "require_git_repo": True,
                        "require_pipeline_role": required,
                    },
                },
                "claim": {
                    "participant_role": "hero",
                    "execution_action": "implement_card",
                },
                "git": {"action": "create_branch", "create_pr": False},
                "llm": {"enabled": False},
                "sensors": [],
                "on_success": {},
            }
        ],
        "scheduling": {"mode": "priority", "priority_order": ["implementer"]},
    }


def _require_participant_role_pipeline(required: str) -> dict:
    return {
        "version": 1,
        "stages": [
            {
                "role": "implementer",
                "unique": True,
                "discover": {
                    "strategy": "column_scan",
                    "column_type": "active",
                    "filters": {
                        "require_git_repo": True,
                        "require_participant_role": required,
                    },
                },
                "claim": {
                    "participant_role": "hero",
                    "execution_action": "implement_card",
                },
                "git": {"action": "create_branch", "create_pr": False},
                "llm": {"enabled": False},
                "sensors": [],
                "on_success": {},
            }
        ],
        "scheduling": {"mode": "priority", "priority_order": ["implementer"]},
    }


@pytest.mark.asyncio
async def test_require_pipeline_role_excludes_card_without_matching_participant(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_require_pipeline_role_pipeline("planner"),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")
    await _make_card(db_session, test_board, cols["active"], test_user, title="no planner")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_require_pipeline_role_includes_card_with_matching_participant(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_require_pipeline_role_pipeline("planner"),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")
    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="planned card"
    )
    db_session.add(
        CardParticipant(
            card_id=card.id,
            user_id=test_user.id,
            role="helper",
            pipeline_role="planner",
        )
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_require_participant_role_excludes_card_without_matching_role(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_require_participant_role_pipeline("hero"),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")
    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="helper only"
    )
    db_session.add(
        CardParticipant(
            card_id=card.id,
            user_id=test_user.id,
            role="helper",
            pipeline_role="planner",
        )
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_require_participant_role_includes_card_with_matching_role(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_require_participant_role_pipeline("hero"),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")
    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="has hero"
    )
    db_session.add(
        CardParticipant(
            card_id=card.id,
            user_id=test_user.id,
            role="hero",
            pipeline_role="planner",
        )
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(card.id)


# ---------------------------------------------------------------------------
# SCH-1: sequential-scheduling discover filters (spec note 233e4429 §Part B).
# Opt-in primitives. No DEFAULT_PIPELINE_CONFIG change here — SCH-2 backfills.
# ---------------------------------------------------------------------------


def _planner_pipeline_with_filter(extra_filter: dict) -> dict:
    return {
        "version": 1,
        "stages": [
            {
                "role": "planner",
                "unique": True,
                "discover": {
                    "strategy": "column_scan",
                    "column_type": "backlog",
                    "filters": {"require_git_repo": True, **extra_filter},
                },
                "claim": {
                    "participant_role": "hero",
                    "execution_action": "plan_card",
                },
                "git": {"action": "none", "create_pr": False},
                "llm": {"enabled": False},
                "sensors": [],
                "on_success": {},
            }
        ],
        "scheduling": {"mode": "priority", "priority_order": ["planner"]},
    }


@pytest.mark.asyncio
async def test_no_other_card_in_flight_blocks_when_active_sibling_present(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_planner_pipeline_with_filter(
                {"no_other_card_in_flight": True}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")
    await _make_card(db_session, test_board, cols["backlog"], test_user, title="next")
    sibling = await _make_card(
        db_session, test_board, cols["active"], test_user, title="in flight"
    )
    db_session.add(
        CardParticipant(
            card_id=sibling.id,
            user_id=test_user.id,
            role="hero",
            pipeline_role="implementer",
        )
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_no_other_card_in_flight_blocks_when_review_sibling_present(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_planner_pipeline_with_filter(
                {"no_other_card_in_flight": True}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")
    await _make_card(db_session, test_board, cols["backlog"], test_user, title="next")
    sibling = await _make_card(
        db_session, test_board, cols["review"], test_user, title="awaiting review"
    )
    db_session.add(
        CardParticipant(
            card_id=sibling.id,
            user_id=test_user.id,
            role="helper",
            pipeline_role="reviewer",
        )
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_no_other_card_in_flight_allows_when_only_done_or_backlog(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_planner_pipeline_with_filter(
                {"no_other_card_in_flight": True}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")
    candidate = await _make_card(
        db_session, test_board, cols["backlog"], test_user,
        title="next", position=2.0,
    )
    await _make_card(db_session, test_board, cols["done"], test_user, title="shipped", position=1.0)

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(candidate.id)


@pytest.mark.asyncio
async def test_no_other_card_in_flight_allows_when_active_sibling_unworked(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A card parked in active with no participant and no live reservation is
    NOT in flight — no role can act on it, so it must not freeze the planner.

    Regression for the run-B deadlock: a fail-path moved a dep-blocked card
    back to active (0 participants), the implementer skipped it
    (all_dependencies_done), and this filter froze ALL planning board-wide.
    """
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_planner_pipeline_with_filter(
                {"no_other_card_in_flight": True}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")
    candidate = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="next", position=2.0
    )
    await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="stranded by fail-path", position=1.0,
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(candidate.id)


@pytest.mark.asyncio
async def test_no_other_card_in_flight_blocks_when_active_sibling_reserved(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A freshly reserved sibling (reservation held, participant not yet
    written) is in flight even with zero participants."""
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_planner_pipeline_with_filter(
                {"no_other_card_in_flight": True}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")
    await _make_card(db_session, test_board, cols["backlog"], test_user, title="next")
    sibling = await _make_card(
        db_session, test_board, cols["active"], test_user, title="just reserved"
    )
    db_session.add(
        AgentReservation(
            agent_id=test_agent.id,
            card_id=sibling.id,
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            role="implementer",
            expires_at=datetime.utcnow() + timedelta(minutes=5),
        )
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_no_other_card_in_flight_ignores_expired_sibling_reservation(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """An expired reservation on a participant-less sibling is dead state —
    the sibling is not in flight."""
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_planner_pipeline_with_filter(
                {"no_other_card_in_flight": True}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")
    candidate = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="next", position=2.0
    )
    sibling = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="reservation lapsed", position=1.0,
    )
    db_session.add(
        AgentReservation(
            agent_id=test_agent.id,
            card_id=sibling.id,
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            role="implementer",
            expires_at=datetime.utcnow() - timedelta(minutes=5),
        )
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(candidate.id)


@pytest.mark.asyncio
async def test_no_other_card_in_flight_is_board_scoped(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Cards in flight on a sibling board must not block this board's planner."""
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_planner_pipeline_with_filter(
                {"no_other_card_in_flight": True}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")
    candidate = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="next"
    )

    other_board = Board(
        workspace_id=test_workspace.id,
        name="Other Board",
        slug="other-board",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()
    other_cols = await _make_typed_columns(db_session, other_board)
    await _make_repo(db_session, other_board, test_user)
    await _make_card(db_session, other_board, other_cols["active"], test_user, title="other in flight")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(candidate.id)


@pytest.mark.asyncio
async def test_no_other_card_in_flight_excludes_self(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The candidate card itself in active must not count against the gate."""
    pipeline = _planner_pipeline_with_filter({"no_other_card_in_flight": True})
    pipeline["stages"][0]["discover"]["column_type"] = "active"
    db_session.add(
        WorkspaceConfig(workspace_id=test_workspace.id, pipeline_config=pipeline)
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")
    only_one = await _make_card(
        db_session, test_board, cols["active"], test_user, title="just me"
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(only_one.id)


@pytest.mark.asyncio
async def test_all_dependencies_done_allows_card_with_no_dependencies(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A card with zero dependency rows trivially satisfies the gate
    (NOT EXISTS over the empty set)."""
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_planner_pipeline_with_filter(
                {"all_dependencies_done": True}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")
    candidate = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="next"
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(candidate.id)


@pytest.mark.asyncio
async def test_all_dependencies_done_blocks_when_prerequisite_not_done(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    from app.models.kanban.card import CardDependency

    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_planner_pipeline_with_filter(
                {"all_dependencies_done": True}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")
    candidate = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="dependent", position=2.0,
    )
    prereq = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="prereq", position=3.0,
    )
    db_session.add(
        CardDependency(
            card_id=candidate.id,
            depends_on_card_id=prereq.id,
            created_by=test_user.id,
        )
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    # Only the prereq itself (no deps) should be eligible. The candidate
    # is blocked by its undone prerequisite.
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(prereq.id)


@pytest.mark.asyncio
async def test_all_dependencies_done_allows_when_prerequisite_landed(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    from app.models.kanban.card import CardDependency

    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_planner_pipeline_with_filter(
                {"all_dependencies_done": True}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")
    candidate = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="dependent"
    )
    prereq = await _make_card(
        db_session, test_board, cols["done"], test_user, title="prereq landed"
    )
    db_session.add(
        CardDependency(
            card_id=candidate.id,
            depends_on_card_id=prereq.id,
            created_by=test_user.id,
        )
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(candidate.id)


@pytest.mark.asyncio
async def test_default_pipeline_planner_skips_card_with_open_dependency(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """End-to-end regression for the client pilot (2026-05-25) chain-race: the
    SHIPPED DEFAULT_PIPELINE_CONFIG planner must refuse a backlog card whose
    prerequisite is still in backlog, and instead claim the prerequisite. This
    guards the wiring (flat discover.filters.all_dependencies_done) end-to-end,
    not just the literal config value."""
    import copy

    from app.models.kanban.card import CardDependency

    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=copy.deepcopy(DEFAULT_PIPELINE_CONFIG),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "planner")
    # dependent sorts ahead by position but is gated; prereq must be picked.
    dependent = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="M1-02", position=1.0,
    )
    prereq = await _make_card(
        db_session, test_board, cols["backlog"], test_user, title="M1-01", position=2.0,
    )
    db_session.add(
        CardDependency(
            card_id=dependent.id,
            depends_on_card_id=prereq.id,
            created_by=test_user.id,
        )
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(prereq.id), (
        "planner claimed the dependency-gated card instead of its prerequisite"
    )


# ---------------------------------------------------------------------------
# Cluster II — Gap 3: list-valued label filters.
#
# exclude_label / include_label / label / require_label accept string-or-list.
# A plain string keeps working (back-compat). A list AND-composes per token:
#   - exclude_label list: reject a card carrying ANY listed label.
#   - include_label / require_label list: keep only cards carrying EVERY token.
# Discovered while designing ui_validator label routing; per
# feedback_extensibility_no_limits a single-string ceiling is a bug.
# ---------------------------------------------------------------------------


def _label_filter_pipeline(role: str, filters: dict) -> dict:
    """A single-role column_scan pipeline over `active` with custom filters."""
    return {
        "version": 1,
        "stages": [
            {
                "role": role,
                "unique": True,
                "discover": {
                    "strategy": "column_scan",
                    "column_type": "active",
                    "column_type_exclude": "",
                    "filters": {"require_git_repo": True, **filters},
                },
                "claim": {
                    "participant_role": "helper",
                    "execution_action": f"{role}_card",
                },
                "git": {"action": "none", "create_pr": False},
                "llm": {"enabled": False},
                "sensors": [],
            }
        ],
        "scheduling": {"mode": "priority", "priority_order": [role]},
    }


@pytest.mark.asyncio
async def test_next_assignment_exclude_label_list_rejects_any_listed_label(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """exclude_label as a list rejects a card carrying ANY of the labels."""
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_label_filter_pipeline(
                "reviewer", {"exclude_label": ["planned", "needs-ui-validation"]}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    has_second = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="carries the 2nd excluded label", position=1.0,
    )
    has_second.labels = ["needs-ui-validation", "backend"]
    clean = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="carries neither", position=2.0,
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "reviewer"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(clean.id), (
        "card carrying a 2nd excluded label should have been skipped"
    )


@pytest.mark.asyncio
async def test_next_assignment_exclude_label_string_still_works(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Back-compat: a plain-string exclude_label keeps rejecting that one label."""
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_label_filter_pipeline(
                "reviewer", {"exclude_label": "planned"}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    labeled = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="planned", position=1.0,
    )
    labeled.labels = ["planned"]
    clean = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="unlabeled", position=2.0,
    )
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "reviewer"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(clean.id)


@pytest.mark.asyncio
async def test_next_assignment_include_label_list_requires_all_tokens(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """include_label as a list keeps only cards carrying EVERY listed label."""
    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id,
            pipeline_config=_label_filter_pipeline(
                "reviewer", {"include_label": ["ui", "needs-validation"]}
            ),
        )
    )
    await db_session.flush()
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    partial = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="has only one required label", position=1.0,
    )
    partial.labels = ["ui"]
    both = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="has both required labels", position=2.0,
    )
    both.labels = ["ui", "needs-validation", "backend"]
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "reviewer"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(both.id), (
        "card missing one required include label should have been skipped"
    )


# ---------------------------------------------------------------------------
# require_pr_url reads the structured pr_url column (Cluster IV ui_validator).
# ---------------------------------------------------------------------------


def _ui_validator_pipeline() -> dict:
    """A single-stage pipeline whose discover filter requires a PR url and scans
    the done column — the live ui_validator shape (workspace v20)."""
    return {
        "version": 20,
        "stages": [
            {
                "role": "ui_validator",
                "discover": {
                    "strategy": "column_scan",
                    "column_type": "done",
                    "filters": {"require_pr_url": True},
                },
                "claim": {
                    "participant_role": "helper",
                    "execution_action": "validate_ui",
                },
                "llm": {"enabled": True, "stage": "validate_ui"},
            }
        ],
        "scheduling": {"priority_order": ["ui_validator"], "mode": "priority"},
    }


async def _seed_pipeline(db: AsyncSession, workspace: Workspace, pipeline: dict):
    cfg = WorkspaceConfig(workspace_id=workspace.id, pipeline_config=pipeline)
    db.add(cfg)
    await db.flush()


@pytest.mark.asyncio
async def test_next_assignment_require_pr_url_reads_structured_pr_url_column(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Cluster IV / F0-04: a done card whose `pr_url` COLUMN is set but whose
    description carries NO `github.com/.../pull/N` footer must satisfy the
    require_pr_url discover filter. The old description-only scan dropped it,
    so ui_validator never reserved F0-04 even after its strategy existed.

    Mirrors preconditions.pr_is_open which already prefers the structured
    column — the two gates must agree on the same card.
    """
    await _seed_pipeline(db_session, test_workspace, _ui_validator_pipeline())
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "ui_validator")

    # F0-04 shape: title-only description, structured pr_url column set.
    card = await _make_card(
        db_session, test_board, cols["done"], test_user,
        title="F0-04: Error envelope normalizer",
        description="F0-04: Error envelope normalizer",  # no PR footer
    )
    card.pr_url = "https://github.com/acme/acme/pull/2"
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "ui_validator"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_next_assignment_require_pr_url_drops_card_with_no_pr_anywhere(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Negative control: a card with neither a pr_url column nor a description
    footer must still be dropped by require_pr_url."""
    await _seed_pipeline(db_session, test_workspace, _ui_validator_pipeline())
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "ui_validator")

    await _make_card(
        db_session, test_board, cols["done"], test_user,
        title="no pr at all", description="just a description",
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "ui_validator"},
    )
    assert resp.status_code == 204, resp.text


# Cell #11 (white-label leak): the require_pr_url description-footer fallback
# only recognized `github.com/.../pull/N`. The runner also ships a Gitea forge
# (self-hosted `<host>/<owner>/<repo>/pulls/N`); a card whose structured pr_url
# column is NULL but whose description carries a non-GitHub PR footer was
# silently dropped from discovery → invisible to the reviewer/ui_validator.
@pytest.mark.asyncio
async def test_next_assignment_require_pr_url_reads_gitea_pulls_url_in_description(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    await _seed_pipeline(db_session, test_workspace, _ui_validator_pipeline())
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "ui_validator")

    # Pre-UX-3 / hand-authored shape: NULL pr_url column, PR url only in the footer.
    card = await _make_card(
        db_session, test_board, cols["done"], test_user,
        title="Gitea-hosted card",
        description="done\n\nPR: https://gitea.example.com/acme/widgets/pulls/7",
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "ui_validator"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(card.id)


# ---------------------------------------------------------------------------
# Multi-repo per board: a card selects WHICH of the board's repos it targets
# via Card.git_repo_slug. NULL = the board's primary/first repo (preserves the
# pre-feature single-repo behavior bit-for-bit). See
# project_consolidation_and_fe_revamp_2026_06_04.
# ---------------------------------------------------------------------------


async def _make_named_repo(
    db: AsyncSession, board: Board, user: User, *, name: str, slug: str, url: str
) -> GitRepo:
    repo = GitRepo(
        board_id=board.id,
        workspace_id=board.workspace_id,
        name=name,
        slug=slug,
        url=url,
        provider=GitProvider.github,
        default_branch="main",
        added_by=user.id,
    )
    db.add(repo)
    await db.flush()
    return repo


@pytest.mark.asyncio
async def test_next_assignment_card_repo_slug_selects_that_repo(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Two repos on one board; the card names the SECOND via git_repo_slug.
    The bundle must resolve to that repo, not the arbitrary .limit(1) first."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    # Insert backend first so a naive .limit(1) would return it.
    await _make_named_repo(
        db_session, test_board, test_user,
        name="backend", slug="backend", url="https://github.com/acme/backend",
    )
    await _make_named_repo(
        db_session, test_board, test_user,
        name="frontend", slug="frontend", url="https://github.com/acme/frontend",
    )
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")
    card = await _make_card(db_session, test_board, cols["active"], test_user, title="fe card")
    card.git_repo_slug = "frontend"
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["card"]["id"] == str(card.id)
    assert body["repo"]["url"] == "https://github.com/acme/frontend", (
        "card.git_repo_slug must select that repo, not the board's first repo"
    )


@pytest.mark.asyncio
async def test_next_assignment_null_repo_slug_falls_back_to_board_repo(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Regression guard: a card with NULL git_repo_slug (every existing card)
    still resolves to the board's repo exactly as before the feature."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)  # slug="acme"
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")
    card = await _make_card(db_session, test_board, cols["active"], test_user, title="legacy card")
    # git_repo_slug left unset (NULL) — the universal pre-feature state.

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["repo"]["url"] == "https://github.com/acme/acme"


@pytest.mark.asyncio
async def test_next_assignment_unknown_repo_slug_parks_instead_of_degrading(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A card naming a slug that doesn't exist on the board must NOT degrade
    to the board's first repo (silent misroute → wrong-repo work). It parks
    with the repo-slug-unresolved label and is not handed out. Full coverage
    in test_assignment_repo_slug.py."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_named_repo(
        db_session, test_board, test_user,
        name="backend", slug="backend", url="https://github.com/acme/backend",
    )
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")
    card = await _make_card(db_session, test_board, cols["active"], test_user, title="typo card")
    card.git_repo_slug = "frontnd"  # typo, no such repo
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 204, resp.text
    await db_session.refresh(card)
    assert "repo-slug-unresolved" in (card.labels or [])


# --- Budget-suspend strand reaper --------------------------------------------
# A card the runner budget-suspends sheds its hero (budget_suspend.go), but the
# storm/re-claim race can re-attach a hero and then die mid-tick (cost breaker
# paused), leaving the card: in `active`, carrying a hero, `budget-suspended`,
# no live execution. The ONLY role that re-picks it (implementer,
# unassigned_or_rework) is gated board-wide by repo_has_no_open_pr — so without
# an independent reaper it strands until a human intervenes (field incident:
# a client production run, 15h). The scheduler reaps the stale hero on ANY role's poll so
# the implementer can resume from branch HEAD (the suspend label drives the
# resume brief). The reaper does NOT move the card or strip the suspend label —
# resuming from HEAD is the whole point of suspend.


@pytest.mark.asyncio
async def test_next_assignment_reaps_stranded_budget_suspended_hero(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A budget-suspended card in `active` carrying a stale hero, no live
    execution, stranded past the horizon → the hero is shed on ANY role's poll
    so the implementer can re-discover it. The polling agent here is a REVIEWER
    (not the implementer that would normally re-pick), proving the reaper is
    independent of the implementer's preconditions/gating."""
    from app.services.scheduling.assignment_service import (
        STRAND_REAP_SECONDS,
    )
    from app.utils import utcnow

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    # The poller is a reviewer — it cannot itself act on an active card.
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    # A DIFFERENT agent is the stranded hero (the implementer that died mid-tick).
    stranded_hero = Agent(
        name="stranded-implementer", agent_type=test_agent.agent_type,
        created_by_id=test_user.id,
    )
    db_session.add(stranded_hero)
    await db_session.flush()

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="C3a-like"
    )
    card.labels = ["budget-pass-1", "budget-suspended"]
    db_session.add(CardParticipant(
        card_id=card.id, user_id=test_user.id, role="hero",
        agent_id=stranded_hero.id, pipeline_role="implementer",
    ))
    await db_session.flush()
    # Stranded well past the horizon (no activity / label write since suspend).
    card.updated_at = utcnow() - timedelta(seconds=STRAND_REAP_SECONDS + 600)
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    # The reviewer poll itself finds no review-column work → 204; the point is
    # the side-effect reap, not what the reviewer gets.
    assert resp.status_code in (200, 204), resp.text

    await db_session.refresh(card, ["participants"])
    hero_ids = [p.agent_id for p in card.participants if p.role == "hero"]
    assert hero_ids == [], (
        "the stranded hero must be shed so the implementer can re-discover the "
        f"suspended card; still present: {hero_ids}"
    )
    # The suspend label + column are preserved — resume from HEAD, not a reset.
    await db_session.refresh(card)
    assert "budget-suspended" in (card.labels or [])
    assert card.column_id == cols["active"].id


@pytest.mark.asyncio
async def test_next_assignment_does_not_reap_recently_suspended_card(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A card suspended JUST NOW (within the strand horizon) is not yet
    stranded — the implementer may still be about to re-pick it on its own next
    poll. The reaper must not race that, so a recently-suspended hero is kept."""
    from app.utils import utcnow

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    hero_agent = Agent(
        name="fresh-implementer", agent_type=test_agent.agent_type,
        created_by_id=test_user.id,
    )
    db_session.add(hero_agent)
    await db_session.flush()

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="fresh-suspend"
    )
    card.labels = ["budget-suspended"]
    db_session.add(CardParticipant(
        card_id=card.id, user_id=test_user.id, role="hero",
        agent_id=hero_agent.id, pipeline_role="implementer",
    ))
    await db_session.flush()
    card.updated_at = utcnow() - timedelta(seconds=60)  # just suspended
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code in (200, 204), resp.text

    await db_session.refresh(card, ["participants"])
    hero_ids = [p.agent_id for p in card.participants if p.role == "hero"]
    assert hero_ids == [hero_agent.id], (
        "a freshly-suspended card's hero must be kept — the reaper must not "
        "race the implementer's own re-pickup"
    )


@pytest.mark.asyncio
async def test_next_assignment_does_not_reap_suspended_card_with_live_execution(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A budget-suspended card that got re-claimed and is mid-tick RIGHT NOW
    (live execution) is genuinely working again — even if its `updated_at` is
    old. A live execution means the hero is real; the reaper must not pull the
    card out from under an active tick."""
    from app.utils import utcnow

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    hero_agent = Agent(
        name="live-implementer", agent_type=test_agent.agent_type,
        created_by_id=test_user.id,
    )
    db_session.add(hero_agent)
    await db_session.flush()

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="suspended-but-live"
    )
    card.labels = ["budget-suspended"]
    db_session.add(CardParticipant(
        card_id=card.id, user_id=test_user.id, role="hero",
        agent_id=hero_agent.id, pipeline_role="implementer",
    ))
    db_session.add(AgentExecution(
        agent_id=hero_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement_card",
        status="running",
        cards_affected=[str(card.id)],
        started_at=utcnow() - timedelta(seconds=120),  # live tick now
    ))
    await db_session.flush()
    card.updated_at = utcnow() - timedelta(seconds=99999)  # old label write
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code in (200, 204), resp.text

    await db_session.refresh(card, ["participants"])
    hero_ids = [p.agent_id for p in card.participants if p.role == "hero"]
    assert hero_ids == [hero_agent.id], (
        "a suspended card with a LIVE execution is working again — the reaper "
        "must not shed its hero"
    )



# ===========================================================================
# FCH-2 — completed-no-commit money-loop: a card whose implement stage keeps
# returning a SUCCESS decision but produces no artifact (no pr_url, never leaves
# active) is re-reserved every poll until the 600s TTL drains, burning a full
# implement pass each cycle (a live run: 249× / $250+). No existing park covers
# it — every other park keys on the stage FLAGGING trouble; this one signals
# success. The backend caps it: after N terminal code-writing executions on a
# card that produced no artifact, park (durable `blocked`) instead of re-reserve.
# Persisted (execution rows) so it survives the runner restart that defeats the
# Go in-memory counter. Keyed on the SIGNAL (artifact-less terminal executions),
# never on role/project.
# ===========================================================================
NO_PROGRESS_CAP_LABEL = "blocked"


async def _seed_artifact_less_implements(
    db: AsyncSession,
    *,
    agent: Agent,
    workspace: Workspace,
    board: Board,
    card: Card,
    count: int,
):
    """Seed `count` terminal `implement_card` executions that touched `card`,
    mimicking the loop: each finished (status=completed) but the card still has
    no pr_url and never left its active column."""
    from app.models.agents.execution import ExecutionStatus
    from app.utils import utcnow

    for i in range(count):
        db.add(
            AgentExecution(
                agent_id=agent.id,
                workspace_id=workspace.id,
                board_id=board.id,
                action="implement_card",
                role="implementer",
                status=ExecutionStatus.completed,
                cards_affected=[str(card.id)],
                completed_at=utcnow() - timedelta(minutes=count - i),
            )
        )
    await db.flush()


@pytest.mark.asyncio
async def test_next_assignment_parks_card_after_n_artifact_less_implements(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """FCH-2: a card with >= cap terminal implement executions that produced no
    artifact (no pr_url, still in active) must be PARKED, not re-reserved. Without
    the cap the scheduler re-hands it every poll — the $250 money-loop."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="stub no-op"
    )
    # 3 prior artifact-less implements (cap default = 3) — the 4th poll must park.
    await _seed_artifact_less_implements(
        db_session,
        agent=test_agent,
        workspace=test_workspace,
        board=test_board,
        card=card,
        count=3,
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204, (
        f"a card with 3 artifact-less implements must be parked, not re-handed; "
        f"got {resp.status_code}: {resp.text}"
    )

    await db_session.refresh(card)
    assert NO_PROGRESS_CAP_LABEL in (card.labels or []), (
        f"the parked card must carry the durable `{NO_PROGRESS_CAP_LABEL}` label "
        f"so it stays out of discovery; labels={card.labels}"
    )


@pytest.mark.asyncio
async def test_reservation_summary_stays_within_the_column_cap_for_a_long_title(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The reservation summary is written on EVERY successful next_assignment,
    so an unbounded title here fails the hot path, not just a rare park.

    Pins the CALL SITE: a helper unit test alone cannot catch a re-inlined
    f-string. SQLite does not enforce String(N), hence the length assertion.
    """
    from sqlalchemy import select

    from app.models.activity import Activity

    cap = Activity.__table__.c.summary.type.length

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="T" * 500
    )
    card_id = card.id

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200

    summary = await db_session.scalar(
        select(Activity.summary).where(Activity.entity_id == card_id)
    )
    assert summary is not None
    assert len(summary) <= cap
    # Truncation must eat the title, never the role the operator reads.
    assert "implementer" in summary


@pytest.mark.asyncio
async def test_fch2_park_summary_stays_within_the_column_cap_for_a_long_title(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The PERSISTED FCH-2 park summary must fit `Activity.summary`'s String(500)
    and still carry the marker.

    This pins the CALL SITE, not just the composition helper: without it, a
    refactor that inlines an unbounded f-string here again would leave every
    helper unit test green while restoring a prod-only 500 (Postgres raises
    StringDataRightTruncation and fails the whole next_assignment request).
    SQLite does not enforce String(N), so the assertion is on the stored length
    rather than on the write raising.

    The marker must survive too: `_executions_spent_before_last_park` finds this
    park with a SQL LIKE on it, and a park it cannot find loses the card's
    reset boundary.
    """
    from sqlalchemy import select

    from app.models.activity import Activity
    from app.services.scheduling.assignment_service import (
        _NO_PROGRESS_PARK_SUMMARY_MARKER,
    )

    cap = Activity.__table__.c.summary.type.length

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="T" * 500
    )
    await _seed_artifact_less_implements(
        db_session,
        agent=test_agent,
        workspace=test_workspace,
        board=test_board,
        card=card,
        count=3,
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204

    await db_session.refresh(card)
    assert NO_PROGRESS_CAP_LABEL in (card.labels or [])

    summary = await db_session.scalar(
        select(Activity.summary).where(Activity.entity_id == card.id)
    )
    assert summary is not None
    assert len(summary) <= cap
    assert _NO_PROGRESS_PARK_SUMMARY_MARKER in summary


@pytest.mark.asyncio
async def test_next_assignment_no_progress_cap_does_not_overpark_card_with_artifact(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """FCH-2 no-over-park guard: a card that DID produce an artifact (pr_url set)
    after its implements must still be eligible — the cap counts only
    artifact-LESS cycles. Proves the cap keys on the no-artifact signal, not on
    raw execution count."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="real progress"
    )
    await _seed_artifact_less_implements(
        db_session,
        agent=test_agent,
        workspace=test_workspace,
        board=test_board,
        card=card,
        count=3,
    )
    # The card DID advance: a PR landed. The cap must not fire.
    card.pr_url = "https://github.com/acme/acme/pull/77"
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, (
        f"a card with a real artifact (pr_url) must not be over-parked; "
        f"got {resp.status_code}: {resp.text}"
    )
    assert resp.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_next_assignment_no_progress_park_is_reversible(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """FCH-2 park is REVERSIBLE: removing the `blocked` label (a human re-scopes
    the stub to runnable) restores the card to the implementer — the park is a
    human-gate, not a permanent dead-end."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="re-scopable stub"
    )
    await _seed_artifact_less_implements(
        db_session,
        agent=test_agent,
        workspace=test_workspace,
        board=test_board,
        card=card,
        count=3,
    )

    parked = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert parked.status_code == 204, "must park at the cap"
    await db_session.refresh(card)
    assert NO_PROGRESS_CAP_LABEL in (card.labels or [])

    # A human removes the block (re-scoped the card to be runnable).
    card.labels = [lbl for lbl in (card.labels or []) if lbl != NO_PROGRESS_CAP_LABEL]
    await db_session.flush()

    revived = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert revived.status_code == 200, revived.text
    assert revived.json()["card"]["id"] == str(
        card.id
    ), "removing the block must restore the card to the implementer"


@pytest.mark.asyncio
async def test_next_assignment_no_progress_park_survives_backwards_clock_step(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The unpark reset must be immune to a BACKWARDS clock step.

    The reset boundary used to be a wall-clock timestamp (the park Activity's
    `created_at`) compared against each execution's `completed_at`. Both come
    from the app clock, so the comparison silently assumes the clock only ever
    moves forward. A container whose clock is stepped back — NTP correction on
    a freshly-booted CI VM is the observed case — drags the boundary BEFORE the
    executions it is supposed to exclude, so every pre-park execution counts
    again and the just-unparked card re-parks instantly. That is a dead-end
    park, the one outcome FCH-2 forbids, and it surfaced as a CI-only flake in
    `..._park_is_reversible` (green everywhere the clock never stepped).

    Pinned by stepping the clock back a full hour at the moment of the park:
    the boundary must still exclude the older executions, because it is derived
    from the executions the park COUNTED, not from a timestamp comparison.
    """
    from datetime import timedelta as _timedelta

    from app.repositories import activity as activity_repo_module

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="clock-stepped stub"
    )
    await _seed_artifact_less_implements(
        db_session,
        agent=test_agent,
        workspace=test_workspace,
        board=test_board,
        card=card,
        count=3,
    )

    real_datetime = activity_repo_module.datetime

    class _SteppedBackClock(real_datetime):
        """Clock that jumps an hour into the past — the CI VM's NTP correction.

        Applied only while the PARK is written, so the park Activity's
        `created_at` (the reset boundary) lands BEFORE the executions the park
        counted — the exact inversion a backwards step produces in production.
        """

        @classmethod
        def utcnow(cls):
            return real_datetime.utcnow() - _timedelta(hours=1)

    activity_repo_module.datetime = _SteppedBackClock
    try:
        parked = await agent_client.post(
            URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
            json={},
        )
    finally:
        activity_repo_module.datetime = real_datetime

    assert parked.status_code == 204, "must park at the cap"
    await db_session.refresh(card)
    assert NO_PROGRESS_CAP_LABEL in (card.labels or [])

    # A human removes the block. The pre-park executions must stay excluded even
    # though the recorded boundary now predates them.
    card.labels = [lbl for lbl in (card.labels or []) if lbl != NO_PROGRESS_CAP_LABEL]
    await db_session.flush()

    revived = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert revived.status_code == 200, (
        "a backwards clock step must not resurrect pre-park executions and "
        f"re-park the card; got {revived.status_code}"
    )
    assert revived.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_next_assignment_no_progress_second_park_keeps_first_parks_spent_ids(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A card parked TWICE must carry both generations of spent executions.

    Each park records the executions it spent so a later unpark can subtract
    them. If the second park recorded only its own generation, the first
    generation would come back into scope on the next unpark and re-park the
    card instantly — the dead-end the reset exists to prevent. The recorded set
    must be the UNION, so the third unpark still yields a fresh budget.
    """
    from datetime import timedelta as _timedelta

    from sqlalchemy import delete as _delete
    from sqlalchemy import select as _select

    from app.models.activity import Activity, ActivityEntityType
    from app.models.agents.execution import ExecutionStatus
    from app.utils import utcnow

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="twice-parked stub"
    )
    await _seed_artifact_less_implements(
        db_session,
        agent=test_agent,
        workspace=test_workspace,
        board=test_board,
        card=card,
        count=3,
    )

    async def _unpark():
        await db_session.refresh(card)
        card.labels = [
            lbl for lbl in (card.labels or []) if lbl != NO_PROGRESS_CAP_LABEL
        ]
        await db_session.execute(
            _delete(AgentReservation).where(AgentReservation.agent_id == test_agent.id)
        )
        await db_session.flush()

    async def _poll():
        return await agent_client.post(
            URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id), json={}
        )

    first_park = await _poll()
    assert first_park.status_code == 204, "first park at the cap"
    await _unpark()
    assert (await _poll()).status_code == 200, "fresh budget after the first unpark"

    # A second generation of artifact-less loops spends the fresh budget.
    for i in range(3):
        db_session.add(
            AgentExecution(
                agent_id=test_agent.id,
                workspace_id=test_workspace.id,
                board_id=test_board.id,
                action="implement_card",
                role="implementer",
                status=ExecutionStatus.completed,
                cards_affected=[str(card.id)],
                completed_at=utcnow() + _timedelta(minutes=i + 1),
            )
        )
    await db_session.execute(
        _delete(AgentReservation).where(AgentReservation.agent_id == test_agent.id)
    )
    await db_session.flush()

    second_park = await _poll()
    assert second_park.status_code == 204, "re-parks once the fresh budget is spent"

    parks = (
        await db_session.execute(
            _select(Activity.changes).where(
                Activity.entity_type == ActivityEntityType.card,
                Activity.entity_id == card.id,
            )
        )
    ).all()
    spent_sets = [
        set(c["spent_execution_ids"])
        for (c,) in parks
        if isinstance(c, dict) and c.get("fch2_park") is True
    ]
    assert len(spent_sets) == 2, f"expected two parks, got {len(spent_sets)}"
    first_spent, second_spent = spent_sets
    assert first_spent < second_spent, (
        "the second park must record the UNION of both generations, not just its "
        f"own; first={sorted(first_spent)} second={sorted(second_spent)}"
    )
    assert len(second_spent) == 6, (
        f"both generations must be spent; got {len(second_spent)}"
    )

    # The union is what keeps the THIRD unpark a fresh budget rather than an
    # instant re-park on the resurrected first generation.
    await _unpark()
    assert (await _poll()).status_code == 200, (
        "third unpark must still grant a fresh budget"
    )


@pytest.mark.asyncio
async def test_next_assignment_no_progress_legacy_park_without_spent_ids_still_resets(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A park recorded BEFORE `spent_execution_ids` existed must still reset.

    Cards parked by the previous release carry only the timestamp boundary, so
    the reader falls back to translating it into the spent set. Without that
    fallback a card parked just before the deploy would re-park on its first
    post-deploy unpark — a dead-end introduced by the upgrade itself.
    """
    from sqlalchemy import select as _select
    from sqlalchemy import update as _update

    from app.models.activity import Activity, ActivityEntityType

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="pre-upgrade stub"
    )
    await _seed_artifact_less_implements(
        db_session,
        agent=test_agent,
        workspace=test_workspace,
        board=test_board,
        card=card,
        count=3,
    )

    parked = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id), json={}
    )
    assert parked.status_code == 204

    # Rewrite the park Activity into its pre-upgrade shape: sentinel + counters,
    # no `spent_execution_ids`.
    park_rows = (
        await db_session.execute(
            _select(Activity.id, Activity.changes).where(
                Activity.entity_type == ActivityEntityType.card,
                Activity.entity_id == card.id,
            )
        )
    ).all()
    legacy_ids = [
        aid
        for aid, changes in park_rows
        if isinstance(changes, dict) and changes.get("fch2_park") is True
    ]
    assert legacy_ids, "the park activity must exist to be downgraded"
    for aid in legacy_ids:
        await db_session.execute(
            _update(Activity)
            .where(Activity.id == aid)
            .values(changes={"fch2_park": True, "artifact_less_attempts": 3, "cap": 3})
        )
    await db_session.flush()

    await db_session.refresh(card)
    card.labels = [lbl for lbl in (card.labels or []) if lbl != NO_PROGRESS_CAP_LABEL]
    await db_session.flush()

    revived = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id), json={}
    )
    assert revived.status_code == 200, (
        "a legacy park must still grant a fresh budget on unpark; "
        f"got {revived.status_code}"
    )
    assert revived.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_next_assignment_no_progress_reset_gives_fresh_budget_then_reparks(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """FCH-2 reset is a FRESH BUDGET, not permanent immunity: after a human
    unparks, the OLD artifact-less executions no longer count, but NEW ones
    accumulate and the card RE-parks once it loops `cap` more times. Proves the
    note-based reset (count only executions newer than the last park) is correct
    in BOTH directions — it neither re-parks instantly (dead-end) nor grants a
    card that keeps looping a free pass forever."""
    from app.utils import utcnow

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )

    card = await _make_card(
        db_session, test_board, cols["active"], test_user, title="chronic stub"
    )
    await _seed_artifact_less_implements(
        db_session,
        agent=test_agent,
        workspace=test_workspace,
        board=test_board,
        card=card,
        count=3,
    )

    parked = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id), json={}
    )
    assert parked.status_code == 204
    await db_session.refresh(card)
    park_at = utcnow()  # the park's Activity is now the reset boundary

    # Human unparks. Immediately, the OLD executions must not re-park it.
    card.labels = [lbl for lbl in (card.labels or []) if lbl != NO_PROGRESS_CAP_LABEL]
    await db_session.flush()
    first = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id), json={}
    )
    assert first.status_code == 200, "fresh budget — old executions must not re-park"

    # The card keeps looping: `cap` NEW artifact-less executions land AFTER the
    # park boundary. Now the reset budget is spent and it must re-park.
    from app.models.agents.execution import ExecutionStatus

    for i in range(3):
        db_session.add(
            AgentExecution(
                agent_id=test_agent.id,
                workspace_id=test_workspace.id,
                board_id=test_board.id,
                action="implement_card",
                role="implementer",
                status=ExecutionStatus.completed,
                cards_affected=[str(card.id)],
                completed_at=park_at + timedelta(minutes=i + 1),
            )
        )
    # The reservation from `first` would make the agent look busy; clear it so the
    # next poll re-scans candidates (mirrors the TTL expiry / stage-finish drain).
    from sqlalchemy import delete

    await db_session.execute(
        delete(AgentReservation).where(AgentReservation.agent_id == test_agent.id)
    )
    await db_session.flush()

    reparked = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id), json={}
    )
    assert reparked.status_code == 204, (
        "after a fresh budget of artifact-less loops, the card must re-park — "
        f"the reset is not permanent immunity; got {reparked.status_code}"
    )
    await db_session.refresh(card)
    assert NO_PROGRESS_CAP_LABEL in (card.labels or [])


# ---------------------------------------------------------------------------
# IDOR (card f47816b9): next_assignment fetched ANY agent by the URL id with
# no caller binding — any workspace member could reserve cards and mutate
# another member's agent reservation/execution state. Two caller shapes:
#   - agent-key caller (current_agent_id set): URL agent_id must equal it.
#   - plain user caller (no linked agent): allowed only for agents they
#     created (created_by_id == caller), matching the platform's
#     created_by-only agent authz model (agent.py, execution.py).
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_next_assignment_403_when_agent_key_targets_different_agent(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """An agent-key caller (bound to test_agent) must not reserve work — or
    mutate reservation/execution state — under a sibling agent's identity,
    even one it owns. Same-owner is not the same-caller; the API key linkage
    IS the identity for an agent-key caller."""
    await _seed_default_pipeline(db_session, test_workspace)
    await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)

    from app.models.agents.agent import AgentType

    sibling_agent = Agent(
        name="sibling", agent_type=AgentType.coding,
        created_by_id=test_user.id, is_active=True,
    )
    db_session.add(sibling_agent)
    await db_session.flush()
    await _add_team_role(db_session, test_workspace, sibling_agent, test_user, "orchestrator")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=sibling_agent.id),
        json={},
    )
    assert resp.status_code == 403, (
        f"agent-key caller must not target a different agent_id in the URL; "
        f"got {resp.status_code} body={resp.text}"
    )


@pytest.mark.asyncio
async def test_next_assignment_user_caller_403_for_agent_they_do_not_own(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    second_user: User,
    db_session: AsyncSession,
):
    """A plain user (no linked agent key) must not reserve work through an
    agent they did not create, even as a fellow workspace member — this was
    the IDOR: any member could drive any agent's next-assignment."""
    await _seed_default_pipeline(db_session, test_workspace)
    await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)

    from app.models.agents.agent import AgentType

    other_users_agent = Agent(
        name="not-mine", agent_type=AgentType.coding,
        created_by_id=second_user.id, is_active=True,
    )
    db_session.add(other_users_agent)
    await db_session.flush()
    db_session.add(WorkspaceMember(
        workspace_id=test_workspace.id, user_id=second_user.id, role=WorkspaceRole.member,
    ))
    await db_session.flush()
    await _add_team_role(db_session, test_workspace, other_users_agent, second_user, "orchestrator")

    resp = await client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=other_users_agent.id),
        json={},
    )
    assert resp.status_code == 403, (
        f"user caller must not drive an agent they did not create; "
        f"got {resp.status_code} body={resp.text}"
    )


@pytest.mark.asyncio
async def test_next_assignment_agent_key_caller_against_own_agent_still_works(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Control: the caller-binding check must not break the normal runner
    path — an agent key polling its own agent_id keeps working."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    card = await _make_card(db_session, test_board, cols["backlog"], test_user, title="own work")

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_next_assignment_user_caller_against_own_agent_still_works(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Control: a plain user (no linked agent key) driving an agent they
    created themselves — the legacy human/admin/MCP-triggered path — keeps
    working. test_agent.created_by_id == test_user.id."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    card = await _make_card(db_session, test_board, cols["backlog"], test_user, title="own work via user")

    resp = await client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(card.id)


# ---------------------------------------------------------------------------
# SWE-AF #2 surfacing: needs-advisor must also park a LIVE reservation.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_next_assignment_reservation_invalidates_when_needs_advisor_added_for_reviewer(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A card parked WHILE reserved must not be re-issued to the reviewer.

    The fresh-scan predicate in `_candidate_cards` excludes needs-advisor
    cards for reviewer/coder roles, but `_reservation_still_eligible` never
    re-checks that label. Consequence: the stuck-loop detector flips the
    label mid-reservation and the same reviewer keeps getting the card
    re-issued every poll until the 600s TTL drains — exactly the loop the
    park exists to break. Mirror the scan predicate: reviewer reservation on
    a now-parked card -> 204 and the reservation deleted.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    parked = await _make_card(
        db_session, test_board, cols["review"], test_user,
        title="parked-mid-reservation",
        description="https://github.com/acme/acme/pull/7",
    )
    parked.labels = ["needs-advisor"]
    db_session.add(AgentReservation(
        agent_id=test_agent.id,
        card_id=parked.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="reviewer",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "reviewer"},
    )

    assert resp.status_code == 204, (
        "reviewer reservation on a card parked with needs-advisor must NOT "
        f"be re-issued; got {resp.status_code} body={resp.content!r}"
    )

    from sqlalchemy import select as _select
    rows = (await db_session.execute(
        _select(AgentReservation).where(
            AgentReservation.agent_id == test_agent.id,
            AgentReservation.card_id == parked.id,
        )
    )).scalars().all()
    assert rows == [], "stale reservation on a parked card must be deleted"


@pytest.mark.asyncio
async def test_next_assignment_reservation_survives_needs_advisor_for_implementer(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Role-scoping mirror: the park only binds reviewer/coder.

    The scan predicate excludes needs-advisor cards ONLY for reviewer/coder;
    an implementer scan still sees them. The reservation re-check must mirror
    that scoping, not blanket-exclude — an implementer reservation on a card
    that gained the label keeps being re-issued. (Guard against an over-broad
    fix; expected to pass both before and after the change.)
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")

    card = await _make_card(
        db_session, test_board, cols["active"], test_user,
        title="parked-but-not-for-implementer",
    )
    card.labels = ["needs-advisor"]
    reservation = AgentReservation(
        agent_id=test_agent.id,
        card_id=card.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="implementer",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    )
    db_session.add(reservation)
    await db_session.flush()
    original_reservation_id = reservation.id

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "implementer"},
    )

    assert resp.status_code == 200, (
        "needs-advisor must not park roles outside reviewer/coder; "
        f"got {resp.status_code} body={resp.content!r}"
    )
    body = resp.json()
    assert body["card"]["id"] == str(card.id)
    # Reservation identity: the card must come back via the SAME reservation
    # row, not a delete + fresh-scan re-claim. An over-broad re-check would
    # drop the row and the scan (which does not park implementers) would
    # re-issue the card under a NEW reservation — same 200/card id, different
    # path. Pin the row id so that mutation cannot hide.
    assert body["reservation"]["id"] == str(original_reservation_id), (
        "implementer must be re-issued its ORIGINAL reservation, not a "
        "fresh-scan replacement"
    )

    from sqlalchemy import select as _select
    rows = (await db_session.execute(
        _select(AgentReservation).where(
            AgentReservation.agent_id == test_agent.id,
            AgentReservation.card_id == card.id,
        )
    )).scalars().all()
    assert [r.id for r in rows] == [original_reservation_id], (
        "the original reservation row must survive the needs-advisor label"
    )


def test_needs_advisor_label_constant_shared_with_stuck_loop():
    """The scheduler must import NEEDS_ADVISOR_LABEL from stuck_loop, not
    duplicate the string literal — one flip site, one filter site, one name.
    """
    from app.services.reviews import stuck_loop
    from app.services.scheduling import assignment_service

    assert getattr(assignment_service, "NEEDS_ADVISOR_LABEL", None) == (
        stuck_loop.NEEDS_ADVISOR_LABEL
    ), (
        "assignment_service must reference stuck_loop.NEEDS_ADVISOR_LABEL "
        "instead of hardcoding 'needs-advisor'"
    )


@pytest.mark.asyncio
async def test_next_assignment_offers_needs_advisor_lookalike_to_reviewer(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Only the EXACT `needs-advisor` label parks; lookalikes still flow.

    The scan predicate matches the JSON-quoted label (`%"needs-advisor"%`) —
    the embedded double quotes are load-bearing. A bare substring match would
    silently park every card whose label merely CONTAINS the park label
    (e.g. `needs-advisor-review`), with no operator-visible reason.
    """
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "reviewer")

    lookalike = await _make_card(
        db_session, test_board, cols["review"], test_user,
        title="lookalike-labeled", description="https://github.com/acme/acme/pull/3",
    )
    lookalike.labels = ["needs-advisor-review"]
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={"role_override": "reviewer"},
    )

    assert resp.status_code == 200, (
        "a needs-advisor-review lookalike label must not park the card; "
        f"got {resp.status_code} body={resp.content!r}"
    )
    assert resp.json()["card"]["id"] == str(lookalike.id)
