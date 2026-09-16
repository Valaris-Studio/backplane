# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Repo-slug resolution in next-assignment.

An unknown `git_repo_slug` must NOT silently degrade to an arbitrary board
repo (proven misroute: cards get implemented against the wrong codebase).
Required behavior:
  - Slug matches a registered repo -> resolve to that repo (unchanged).
  - Slug set but matches NO board repo -> PARK the card loudly: stamp the
    `repo-slug-unresolved` label, skip it as a candidate, never reserve it.
  - NULL slug (legacy) -> keep degrade-to-a-repo, but DETERMINISTIC
    (oldest created_at), never DB default order.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity
from app.models.agents.agent import Agent
from app.models.agents.reservation import AgentReservation
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace
from tests.routers.agents.test_assignments import (
    URL_TPL,
    _add_team_role,
    _make_card,
    _make_typed_columns,
    _seed_default_pipeline,
)

PARK_LABEL = "repo-slug-unresolved"


async def _make_slugged_repo(
    db: AsyncSession,
    board: Board,
    user: User,
    *,
    slug: str,
    created_at: datetime | None = None,
) -> GitRepo:
    repo = GitRepo(
        board_id=board.id,
        workspace_id=board.workspace_id,
        name=slug,
        slug=slug,
        url=f"https://github.com/acme/{slug}",
        provider=GitProvider.github,
        default_branch="main",
        added_by=user.id,
    )
    if created_at is not None:
        repo.created_at = created_at
    db.add(repo)
    await db.flush()
    return repo


async def _make_slugged_card(
    db: AsyncSession,
    board: Board,
    column: Column,
    user: User,
    *,
    title: str = "card",
    git_repo_slug: str | None = None,
    labels: list[str] | None = None,
    position: float = 1024.0,
) -> Card:
    card = await _make_card(
        db, board, column, user, title=title, position=position
    )
    card.git_repo_slug = git_repo_slug
    if labels is not None:
        card.labels = labels
    await db.flush()
    return card


@pytest.mark.asyncio
async def test_next_assignment_resolves_matching_repo_slug(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A card targeting a registered slug resolves to exactly that repo."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_slugged_repo(db_session, test_board, test_user, slug="alpha")
    await _make_slugged_repo(db_session, test_board, test_user, slug="beta")
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    await _make_slugged_card(
        db_session, test_board, cols["active"], test_user,
        title="targets beta", git_repo_slug="beta",
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200
    assert resp.json()["repo"]["slug"] == "beta"


@pytest.mark.asyncio
async def test_next_assignment_parks_card_with_unknown_repo_slug(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Unknown slug -> card parked with the reason label, NOT handed out."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_slugged_repo(db_session, test_board, test_user, slug="alpha")
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    card = await _make_slugged_card(
        db_session, test_board, cols["active"], test_user,
        title="bad slug", git_repo_slug="ghost",
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 204
    await db_session.refresh(card)
    assert PARK_LABEL in (card.labels or [])
    reservation = await db_session.scalar(
        select(AgentReservation).where(AgentReservation.card_id == card.id)
    )
    assert reservation is None


@pytest.mark.asyncio
async def test_next_assignment_skips_parked_card_and_serves_next(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A card already stamped with the park label is invisible to the scan;
    an eligible sibling is served instead."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_slugged_repo(db_session, test_board, test_user, slug="alpha")
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    await _make_slugged_card(
        db_session, test_board, cols["active"], test_user,
        title="parked", git_repo_slug="ghost", labels=[PARK_LABEL],
        position=1.0,
    )
    good = await _make_slugged_card(
        db_session, test_board, cols["active"], test_user,
        title="good", git_repo_slug="alpha", position=2.0,
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200
    assert resp.json()["card"]["id"] == str(good.id)


@pytest.mark.asyncio
async def test_next_assignment_null_slug_single_repo_unchanged(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Legacy NULL-slug card on a single-repo board: default repo, as today."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_slugged_repo(db_session, test_board, test_user, slug="alpha")
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    await _make_slugged_card(
        db_session, test_board, cols["active"], test_user,
        title="legacy", git_repo_slug=None,
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200
    assert resp.json()["repo"]["slug"] == "alpha"


@pytest.mark.asyncio
async def test_next_assignment_null_slug_resolves_oldest_repo_deterministically(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """NULL slug on a multi-repo board pins to the OLDEST repo (created_at),
    regardless of insertion order — never DB default order."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    now = datetime.utcnow()
    # Insert the NEWER repo first so insertion order disagrees with
    # created_at order — pins the ORDER BY, not accidental row order.
    await _make_slugged_repo(
        db_session, test_board, test_user, slug="newer", created_at=now
    )
    await _make_slugged_repo(
        db_session, test_board, test_user,
        slug="older", created_at=now - timedelta(days=1),
    )
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    await _make_slugged_card(
        db_session, test_board, cols["active"], test_user,
        title="legacy multi-repo", git_repo_slug=None,
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200
    assert resp.json()["repo"]["slug"] == "older"


@pytest.mark.asyncio
async def test_next_assignment_park_activity_includes_recovery_instruction(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The park activity (what operators actually see) must carry the
    recovery instruction, not just the diagnosis."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_slugged_repo(db_session, test_board, test_user, slug="alpha")
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    card = await _make_slugged_card(
        db_session, test_board, cols["active"], test_user,
        title="bad slug", git_repo_slug="ghost",
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 204
    activity = await db_session.scalar(
        select(Activity).where(Activity.entity_id == card.id)
    )
    assert activity is not None
    assert "fix the card's git_repo_slug" in activity.summary
    assert f"remove the `{PARK_LABEL}` label to resume" in activity.summary
    assert activity.message_key == "activity.card.parked_unresolved_git_repo"
    assert activity.message_params == {
        "card_title": "bad slug",
        "git_repo_slug": "ghost",
        "label": PARK_LABEL,
    }


@pytest.mark.asyncio
async def test_next_assignment_park_activity_surfaces_pr_url_wedge_risk(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A parked card holding an open PR can wedge repo_has_no_open_pr-gated
    roles board-wide — the activity detail must surface the PR URL."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_slugged_repo(db_session, test_board, test_user, slug="alpha")
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    pr_url = "https://github.com/acme/alpha/pull/77"
    card = await _make_slugged_card(
        db_session, test_board, cols["active"], test_user,
        title="bad slug with PR", git_repo_slug="ghost",
    )
    card.pr_url = pr_url
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 204
    activity = await db_session.scalar(
        select(Activity).where(Activity.entity_id == card.id)
    )
    assert activity is not None
    assert activity.changes is not None
    assert activity.changes.get("pr_url") == pr_url


@pytest.mark.asyncio
async def test_next_assignment_park_activity_no_changes_without_pr_url(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """No PR on the parked card → no wedge-risk detail payload."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_slugged_repo(db_session, test_board, test_user, slug="alpha")
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    card = await _make_slugged_card(
        db_session, test_board, cols["active"], test_user,
        title="bad slug no PR", git_repo_slug="ghost",
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 204
    activity = await db_session.scalar(
        select(Activity).where(Activity.entity_id == card.id)
    )
    assert activity is not None
    assert activity.changes is None


@pytest.mark.asyncio
async def test_next_assignment_existing_reservation_on_unknown_slug_card_parks(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A live reservation must not resurrect a card whose slug is unknown:
    the re-issue path refuses the bundle, drops the reservation, and the
    fresh scan parks the card."""
    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_slugged_repo(db_session, test_board, test_user, slug="alpha")
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    card = await _make_slugged_card(
        db_session, test_board, cols["active"], test_user,
        title="reserved bad slug", git_repo_slug="ghost",
    )
    db_session.add(AgentReservation(
        agent_id=test_agent.id,
        card_id=card.id,
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

    assert resp.status_code == 204
    await db_session.refresh(card)
    assert PARK_LABEL in (card.labels or [])
    reservation = await db_session.scalar(
        select(AgentReservation).where(AgentReservation.card_id == card.id)
    )
    assert reservation is None


@pytest.mark.asyncio
async def test_slug_park_summary_stays_within_the_column_cap_for_a_long_title(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The PERSISTED park summary must fit `Activity.summary`'s String(500).

    This pins the CALL SITE, not just the composition helper: without it, a
    refactor that inlines an unbounded f-string here again would leave every
    helper unit test green while restoring a prod-only 500. SQLite does not
    enforce String(N), so the assertion is on the stored length rather than on
    the write raising.
    """
    cap = Activity.__table__.c.summary.type.length
    long_title = "T" * 500

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_slugged_repo(db_session, test_board, test_user, slug="alpha")
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )
    card = await _make_slugged_card(
        db_session, test_board, cols["active"], test_user,
        title=long_title, git_repo_slug="ghost",
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 204
    await db_session.refresh(card)
    assert PARK_LABEL in (card.labels or [])

    summary = await db_session.scalar(
        select(Activity.summary).where(Activity.entity_id == card.id)
    )
    assert summary is not None
    assert len(summary) <= cap
    # Truncation must eat the title, never the slug the operator needs.
    assert "ghost" in summary


# --- Cell #2: the parked-PR board-wide wedge ---------------------------------
# Parking a bad-slug card (above) keeps IT out of discovery, but the card's own
# open PR still sits on the repo. `repo_has_no_open_pr` lists every open PR on
# the board's repos and excuses only the ASKING card's own branch — it has no
# card-state awareness. So a parked card holding an open PR makes the gate
# return False for every HEALTHY sibling → a board-wide implementer wedge that
# park alone does not clear. The cure: the precondition must treat a PR whose
# branch belongs to an out-of-play (parked/blocked/needs-reconcile) card as
# not-competing, exactly as it already excuses the asker's own branch.


class _OpenPRStub:
    """A github client returning a fixed set of open PRs, regardless of repo."""

    def __init__(self, prs):
        self._prs = prs

    async def list_open_prs(self, repo_url):
        return list(self._prs)


def _patch_open_prs(monkeypatch, prs):
    from app.services.scheduling import assignment_service as svc

    monkeypatch.setattr(
        svc.AssignmentService,
        "_github_client_factory",
        lambda self, board_id: (lambda: _OpenPRStub(prs)),
    )


@pytest.mark.asyncio
async def test_parked_card_open_pr_does_not_wedge_healthy_sibling(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
    monkeypatch,
):
    """A card parked with `repo-slug-unresolved` holding an open PR must NOT
    gate a HEALTHY sibling on the same board.

    Before the cure, `repo_has_no_open_pr` saw the parked card's open PR (its
    branch != the healthy card's branch) and returned False → the healthy card
    got 204 forever: the board-wide implementer wedge the ledger names as cell
    #2. After the cure, the parked card's PR is recognized as out-of-play and
    the sibling is served (200).
    """
    from app.services.github_client import OpenPR

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_slugged_repo(db_session, test_board, test_user, slug="alpha")
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )

    # The parked card: bad slug, already stamped, holding an open PR on its branch.
    parked = await _make_slugged_card(
        db_session, test_board, cols["active"], test_user,
        title="parked, holds PR", git_repo_slug="ghost",
        labels=[PARK_LABEL], position=1024.0,
    )
    parked.pr_url = "https://github.com/acme/alpha/pull/77"
    parked.branch_name = "feat/ghost-card"
    await db_session.flush()

    # The healthy sibling: valid (NULL slug → board repo), its own branch, no PR.
    healthy = await _make_slugged_card(
        db_session, test_board, cols["active"], test_user,
        title="healthy work", git_repo_slug=None, position=2048.0,
    )
    healthy.branch_name = "feat/healthy"
    await db_session.flush()

    # The only open PR on the repo belongs to the PARKED card.
    _patch_open_prs(monkeypatch, [
        OpenPR(
            number=77,
            head_branch="feat/ghost-card",
            url="https://github.com/acme/alpha/pull/77",
        )
    ])

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 200, (
        "a parked card's open PR wedged a healthy sibling board-wide — "
        "repo_has_no_open_pr is not skipping out-of-play cards' PRs (cell #2)"
    )
    assert resp.json()["card"]["id"] == str(healthy.id)


@pytest.mark.asyncio
async def test_live_card_open_pr_still_wedges_sibling(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
    monkeypatch,
):
    """Guard the cure's blast radius: a LIVE (not parked) card's open PR MUST
    still gate the implementer board-wide. The fix narrows the gate to ignore
    only out-of-play cards' PRs — it must not turn the open-PR gate off.
    """
    from app.services.github_client import OpenPR

    await _seed_default_pipeline(db_session, test_workspace)
    cols = await _make_typed_columns(db_session, test_board)
    await _make_slugged_repo(db_session, test_board, test_user, slug="alpha")
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )

    # A live in-review card with an open PR — normal competing work.
    review = await _make_slugged_card(
        db_session, test_board, cols["review"], test_user,
        title="live review", git_repo_slug=None, position=1024.0,
    )
    review.branch_name = "feat/live-review"
    review.pr_url = "https://github.com/acme/alpha/pull/88"
    await db_session.flush()

    # A new active card the implementer would pick up if not gated.
    sibling = await _make_slugged_card(
        db_session, test_board, cols["active"], test_user,
        title="new work", git_repo_slug=None, position=2048.0,
    )
    sibling.branch_name = "feat/new-work"
    await db_session.flush()

    _patch_open_prs(monkeypatch, [
        OpenPR(
            number=88,
            head_branch="feat/live-review",
            url="https://github.com/acme/alpha/pull/88",
        )
    ])

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )

    assert resp.status_code == 204, (
        "a LIVE card's open PR no longer gates the implementer — the cure "
        "widened too far and disabled the open-PR gate"
    )
