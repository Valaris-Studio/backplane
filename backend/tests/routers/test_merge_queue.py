# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Integration tests for /api/workspaces/{slug}/merge-queue/* (PAR-2)."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.agents.merge_queue import _MERGE_QUEUE_STATES, MergeQueueEntry
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.routers.merge_queue import MERGED_LOOKBACK_MAX_HOURS
from app.utils import utcnow


URL_BASE = "/api/workspaces/{slug}/merge-queue"


async def _make_repo(db: AsyncSession, board: Board, user: User) -> GitRepo:
    repo = GitRepo(
        board_id=board.id,
        workspace_id=board.workspace_id,
        name="acme",
        slug="acme",
        url="https://github.com/acme/acme",
        provider=GitProvider.github,
        default_branch="main",
        integration_branch="develop",
        added_by=user.id,
    )
    db.add(repo)
    await db.flush()
    return repo


async def _make_card(
    db: AsyncSession, board: Board, column: Column, user: User
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title="card",
        description="",
        position=1024.0,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    return card


@pytest.mark.asyncio
async def test_enqueue_returns_200_with_entry(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    resp = await client.post(
        f"{URL_BASE.format(slug=test_workspace.slug)}/enqueue",
        json={
            "card_id": str(card.id),
            "repo_id": str(repo.id),
            "integration_branch": "develop",
            "pr_url": "https://github.com/acme/acme/pull/1",
            "pr_branch": "feat/widget",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "queued"
    assert body["card_id"] == str(card.id)
    assert body["pr_url"] == "https://github.com/acme/acme/pull/1"


@pytest.mark.asyncio
async def test_enqueue_is_idempotent(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    payload = {
        "card_id": str(card.id),
        "repo_id": str(repo.id),
        "integration_branch": "develop",
        "pr_url": "https://github.com/acme/acme/pull/1",
        "pr_branch": "feat/widget",
    }
    first = await client.post(
        f"{URL_BASE.format(slug=test_workspace.slug)}/enqueue", json=payload
    )
    second = await client.post(
        f"{URL_BASE.format(slug=test_workspace.slug)}/enqueue", json=payload
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]


@pytest.mark.asyncio
async def test_list_returns_active_entries(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    await client.post(
        f"{URL_BASE.format(slug=test_workspace.slug)}/enqueue",
        json={
            "card_id": str(card.id),
            "repo_id": str(repo.id),
            "integration_branch": "develop",
            "pr_url": "https://github.com/acme/acme/pull/1",
            "pr_branch": "feat/widget",
        },
    )

    resp = await client.get(URL_BASE.format(slug=test_workspace.slug))
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 1
    assert items[0]["card_id"] == str(card.id)


@pytest.mark.asyncio
async def test_get_one_entry(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    enqueue_resp = await client.post(
        f"{URL_BASE.format(slug=test_workspace.slug)}/enqueue",
        json={
            "card_id": str(card.id),
            "repo_id": str(repo.id),
            "integration_branch": "develop",
            "pr_url": "https://github.com/acme/acme/pull/1",
            "pr_branch": "feat/widget",
        },
    )
    entry_id = enqueue_resp.json()["id"]

    resp = await client.get(
        f"{URL_BASE.format(slug=test_workspace.slug)}/{entry_id}"
    )
    assert resp.status_code == 200
    assert resp.json()["id"] == entry_id


@pytest.mark.asyncio
async def test_cancel_admin_succeeds(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    enqueue_resp = await client.post(
        f"{URL_BASE.format(slug=test_workspace.slug)}/enqueue",
        json={
            "card_id": str(card.id),
            "repo_id": str(repo.id),
            "integration_branch": "develop",
            "pr_url": "https://github.com/acme/acme/pull/1",
            "pr_branch": "feat/widget",
        },
    )
    entry_id = enqueue_resp.json()["id"]

    resp = await client.post(
        f"{URL_BASE.format(slug=test_workspace.slug)}/{entry_id}/cancel"
    )
    assert resp.status_code in (200, 204)


@pytest.mark.asyncio
async def test_cancel_non_admin_member_returns_403(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    second_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    member = WorkspaceMember(
        workspace_id=test_workspace.id,
        user_id=second_user.id,
        role=WorkspaceRole.member,
    )
    db_session.add(member)
    await db_session.flush()

    from app.models.agents.merge_queue import MergeQueueEntry

    entry = MergeQueueEntry(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card.id,
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
        state="queued",
    )
    db_session.add(entry)
    await db_session.flush()

    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return second_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post(
            f"{URL_BASE.format(slug=test_workspace.slug)}/{entry.id}/cancel"
        )

    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_get_unknown_entry_returns_404(
    client: AsyncClient,
    test_workspace: Workspace,
):
    bogus = uuid.uuid4()
    resp = await client.get(
        f"{URL_BASE.format(slug=test_workspace.slug)}/{bogus}"
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_card_with_active_queue_entry_excluded_from_next_assignment(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """A queued or merging entry hides the card from /next-assignment.

    Once approve enqueues a card it shouldn't be re-handed to a fresh runner
    poll — the merge worker owns that card until merged or conflict.
    """
    from app.models.agents.agent import Agent
    from app.models.agents.merge_queue import MergeQueueEntry
    from app.models.agents.team import AgentTeam, AgentTeamMember
    from app.models.kanban.column import ColumnType
    from app.models.workspace_config import WorkspaceConfig
    from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG

    cfg = WorkspaceConfig(
        workspace_id=test_workspace.id,
        pipeline_config=DEFAULT_PIPELINE_CONFIG,
    )
    db_session.add(cfg)
    await db_session.flush()

    backlog_col = Column(
        board_id=test_board.id,
        name="To Do",
        position=1.0,
        color="#888",
        column_type=ColumnType.backlog,
    )
    db_session.add(backlog_col)
    await db_session.flush()

    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, backlog_col, test_user)

    agent_q = await db_session.execute(
        select(Agent).where(Agent.created_by_id == test_user.id)
    )
    agent = agent_q.scalars().first()
    assert agent is not None

    team = AgentTeam(
        name="orchestrator-team",
        workspace_id=test_workspace.id,
        created_by_id=test_user.id,
    )
    db_session.add(team)
    await db_session.flush()
    member = AgentTeamMember(
        team_id=team.id, agent_id=agent.id, roles=["orchestrator"]
    )
    db_session.add(member)
    await db_session.flush()

    entry = MergeQueueEntry(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card.id,
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
        state="queued",
    )
    db_session.add(entry)
    await db_session.flush()

    resp = await agent_client.post(
        f"/api/workspaces/{test_workspace.slug}/agents/{agent.id}/next-assignment",
        json={},
    )
    assert resp.status_code == 204, resp.text


@pytest.mark.asyncio
async def test_re_enqueue_endpoint_happy_path(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    from app.models.agents.merge_queue import MergeQueueEntry

    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    entry = MergeQueueEntry(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card.id,
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
        state="blocked_pending_consolidation",
    )
    db_session.add(entry)
    await db_session.flush()

    resp = await client.post(
        f"{URL_BASE.format(slug=test_workspace.slug)}/re-enqueue",
        json={"card_id": str(card.id)},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["state"] == "queued"
    assert body["card_id"] == str(card.id)


@pytest.mark.asyncio
async def test_re_enqueue_endpoint_404(
    client: AsyncClient,
    test_workspace: Workspace,
):
    """Re-enqueue with a card_id that has no queue entry returns 404."""
    bogus = uuid.uuid4()
    resp = await client.post(
        f"{URL_BASE.format(slug=test_workspace.slug)}/re-enqueue",
        json={"card_id": str(bogus)},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_re_enqueue_endpoint_membership_gated(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    second_user: User,
):
    """Non-member must not be able to re-enqueue another workspace's entry."""
    from app.models.agents.merge_queue import MergeQueueEntry

    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)
    entry = MergeQueueEntry(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card.id,
        pr_url="https://github.com/acme/acme/pull/1",
        pr_branch="feat/widget",
        workspace_id=test_workspace.id,
        state="blocked_pending_consolidation",
    )
    db_session.add(entry)
    await db_session.flush()

    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return second_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post(
            f"{URL_BASE.format(slug=test_workspace.slug)}/re-enqueue",
            json={"card_id": str(card.id)},
        )
    # second_user has no membership in test_workspace -> 403/404 from
    # get_workspace dep. Either signals "you can't reach this resource".
    assert resp.status_code in (403, 404)


@pytest.mark.asyncio
async def test_enqueue_uses_repo_integration_branch_when_omitted(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """When request omits integration_branch, fall back to repo.integration_branch."""
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    resp = await client.post(
        f"{URL_BASE.format(slug=test_workspace.slug)}/enqueue",
        json={
            "card_id": str(card.id),
            "repo_id": str(repo.id),
            "pr_url": "https://github.com/acme/acme/pull/1",
            "pr_branch": "feat/widget",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["integration_branch"] == "develop"


# --- loop-landing opt-in gate (card 51810501) --------------------------------
#
# Owner decision 2026-08-07: autonomous landing is per-board OPT-IN. An AGENT
# enqueue on a board that has a loop config is allowed only when that config
# says loop_landing="merge_queue". Boards without a loop config (pure pipeline
# boards) are untouched — their enqueue paths are already operator-gated
# (merge_via_queue / an explicit lifecycle step). Humans are never gated.

import hashlib
import secrets

from app.models.agents.agent import Agent, AgentType
from app.models.api_key import ApiKey
from app.services.loop_config_validation import LOOP_CONFIG_DEFAULTS


def _loop_config(landing: str) -> dict:
    return {
        **LOOP_CONFIG_DEFAULTS,
        "loop_prompt": "work the board",
        "loop_landing": landing,
        "disabled_reason": None,
        "version": 1,
        "updated_at": "2026-08-07T00:00:00",
    }


async def _mint_agent_key(db: AsyncSession, user: User, name: str) -> str:
    raw = "vlr_" + secrets.token_urlsafe(32)
    api_key = ApiKey(
        user_id=user.id,
        name=f"{name}-key",
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:8],
    )
    db.add(api_key)
    await db.flush()
    agent = Agent(
        name=name,
        agent_type=AgentType.coding,
        description="loop landing gate test agent",
        created_by_id=user.id,
        is_active=True,
        api_key_id=api_key.id,
    )
    db.add(agent)
    await db.flush()
    return raw


@pytest.fixture
async def raw_client(db_session: AsyncSession) -> AsyncClient:
    """No get_current_user override — the Bearer vlr_ agent path runs for real."""
    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


def _enqueue_body(card: Card, repo: GitRepo) -> dict:
    return {
        "card_id": str(card.id),
        "repo_id": str(repo.id),
        "integration_branch": "develop",
        "pr_url": "https://github.com/acme/acme/pull/9",
        "pr_branch": "feat/landing",
    }


@pytest.mark.asyncio
async def test_enqueue_agent_on_loop_board_without_optin_403(
    raw_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    test_board.loop_config = _loop_config("human")
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)
    raw = await _mint_agent_key(db_session, test_user, "no-optin-agent")

    resp = await raw_client.post(
        f"{URL_BASE.format(slug=test_workspace.slug)}/enqueue",
        json=_enqueue_body(card, repo),
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert resp.status_code == 403, resp.text
    assert resp.json().get("error_code") == "loop_landing_not_enabled"


@pytest.mark.asyncio
async def test_enqueue_agent_on_loop_board_with_optin_succeeds(
    raw_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    test_board.loop_config = _loop_config("merge_queue")
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)
    raw = await _mint_agent_key(db_session, test_user, "optin-agent")

    resp = await raw_client.post(
        f"{URL_BASE.format(slug=test_workspace.slug)}/enqueue",
        json=_enqueue_body(card, repo),
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["state"] == "queued"


@pytest.mark.asyncio
async def test_enqueue_agent_on_pipeline_board_without_loop_config_unaffected(
    raw_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    assert test_board.loop_config is None
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)
    raw = await _mint_agent_key(db_session, test_user, "pipeline-agent")

    resp = await raw_client.post(
        f"{URL_BASE.format(slug=test_workspace.slug)}/enqueue",
        json=_enqueue_body(card, repo),
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_enqueue_agent_under_self_merge_landing_403(
    raw_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """Card B9: `self_merge` names the agent-lands-its-own-PR mode, which is
    NOT queue landing. Only `merge_queue` opts a board into the executor —
    pinned rather than trusted, because a typo widening this comparison would
    silently open autonomous queue landing on every self-merging board."""
    test_board.loop_config = _loop_config("self_merge")
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)
    raw = await _mint_agent_key(db_session, test_user, "self-merge-agent")

    resp = await raw_client.post(
        f"{URL_BASE.format(slug=test_workspace.slug)}/enqueue",
        json=_enqueue_body(card, repo),
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert resp.status_code == 403, resp.text
    assert resp.json().get("error_code") == "loop_landing_not_enabled"


@pytest.mark.asyncio
async def test_enqueue_human_on_loop_board_without_optin_allowed(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    test_board.loop_config = _loop_config("human")
    await db_session.flush()
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    resp = await client.post(
        f"{URL_BASE.format(slug=test_workspace.slug)}/enqueue",
        json=_enqueue_body(card, repo),
    )
    assert resp.status_code == 200, resp.text


async def _seed_entry(
    db: AsyncSession,
    *,
    repo: GitRepo,
    board: Board,
    column: Column,
    user: User,
    state: str,
    merged_at: datetime | None = None,
) -> MergeQueueEntry:
    """One entry per state — the uq_..._card constraint forces a card each."""
    card = await _make_card(db, board, column, user)
    entry = MergeQueueEntry(
        repo_id=repo.id,
        integration_branch="develop",
        card_id=card.id,
        pr_url=f"https://github.com/acme/acme/pull/{state}",
        pr_branch=f"feat/{state}",
        workspace_id=board.workspace_id,
        state=state,
        merged_at=merged_at,
    )
    db.add(entry)
    await db.flush()
    return entry


@pytest.mark.asyncio
async def test_list_default_includes_blocked_pending_consolidation(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """PAR-3b parks entries here awaiting a consolidator — an operator must see them."""
    repo = await _make_repo(db_session, test_board, test_user)
    for state in _MERGE_QUEUE_STATES:
        await _seed_entry(
            db_session,
            repo=repo,
            board=test_board,
            column=test_column,
            user=test_user,
            state=state,
            merged_at=utcnow() if state == "merged" else None,
        )

    resp = await client.get(URL_BASE.format(slug=test_workspace.slug))

    assert resp.status_code == 200, resp.text
    states = {item["state"] for item in resp.json()}
    assert states == {
        "queued",
        "merging",
        "conflict",
        "failed",
        "blocked_pending_consolidation",
    }


@pytest.mark.asyncio
async def test_list_excludes_merged_unless_asked(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """`merged` is terminal: it stays out of the default listing."""
    repo = await _make_repo(db_session, test_board, test_user)
    await _seed_entry(
        db_session,
        repo=repo,
        board=test_board,
        column=test_column,
        user=test_user,
        state="merged",
        merged_at=utcnow(),
    )

    resp = await client.get(URL_BASE.format(slug=test_workspace.slug))

    assert resp.status_code == 200, resp.text
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_includes_recently_merged_when_window_given(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    repo = await _make_repo(db_session, test_board, test_user)
    recent = await _seed_entry(
        db_session,
        repo=repo,
        board=test_board,
        column=test_column,
        user=test_user,
        state="merged",
        merged_at=utcnow() - timedelta(hours=2),
    )

    resp = await client.get(
        URL_BASE.format(slug=test_workspace.slug),
        params={"merged_within_hours": 24},
    )

    assert resp.status_code == 200, resp.text
    ids = {item["id"] for item in resp.json()}
    assert str(recent.id) in ids


@pytest.mark.asyncio
async def test_list_merged_window_is_bounded(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """The window is a real filter, not a flag that dumps the whole table."""
    repo = await _make_repo(db_session, test_board, test_user)
    stale = await _seed_entry(
        db_session,
        repo=repo,
        board=test_board,
        column=test_column,
        user=test_user,
        state="merged",
        merged_at=utcnow() - timedelta(days=30),
    )

    resp = await client.get(
        URL_BASE.format(slug=test_workspace.slug),
        params={"merged_within_hours": 24},
    )

    assert resp.status_code == 200, resp.text
    ids = {item["id"] for item in resp.json()}
    assert str(stale.id) not in ids


@pytest.mark.asyncio
@pytest.mark.parametrize("hours", [0, MERGED_LOOKBACK_MAX_HOURS + 1])
async def test_list_rejects_out_of_range_merged_window(
    client: AsyncClient,
    test_workspace: Workspace,
    hours: int,
):
    """The 1..720 bound is the whole reason `merged` is safe to expose."""
    resp = await client.get(
        URL_BASE.format(slug=test_workspace.slug),
        params={"merged_within_hours": hours},
    )

    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_list_exposes_first_enqueued_at_for_client_staleness(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """The merge-queue panel derives staleness client-side and cannot use
    `enqueued_at`: `re_enqueue` bumps it to the back of the FIFO on every
    retry, so a hot-retry loop reads as permanently fresh. `first_enqueued_at`
    is the only wire field carrying the real stuck-duration clock."""
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    origin = utcnow() - timedelta(minutes=90)
    entry = MergeQueueEntry(
        workspace_id=test_workspace.id,
        repo_id=repo.id,
        card_id=card.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/9",
        pr_branch="feat/churn",
        state="queued",
        attempt_count=5,
        enqueued_at=utcnow(),
        first_enqueued_at=origin,
    )
    db_session.add(entry)
    await db_session.flush()

    resp = await client.get(URL_BASE.format(slug=test_workspace.slug))

    assert resp.status_code == 200, resp.text
    item = next(i for i in resp.json() if i["id"] == str(entry.id))
    assert item["first_enqueued_at"] is not None
    assert item["first_enqueued_at"] != item["enqueued_at"]
    assert item["first_enqueued_at"].startswith(origin.strftime("%Y-%m-%dT%H:%M"))


@pytest.mark.asyncio
async def test_list_first_enqueued_at_is_null_for_pre_088_rows(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """Migration 088 is nullable with no backfill, so the field must survive
    the wire as an explicit null rather than 500ing or being dropped."""
    repo = await _make_repo(db_session, test_board, test_user)
    card = await _make_card(db_session, test_board, test_column, test_user)

    entry = MergeQueueEntry(
        workspace_id=test_workspace.id,
        repo_id=repo.id,
        card_id=card.id,
        integration_branch="develop",
        pr_url="https://github.com/acme/acme/pull/10",
        pr_branch="feat/legacy",
        state="queued",
        attempt_count=0,
        enqueued_at=utcnow(),
        first_enqueued_at=None,
    )
    db_session.add(entry)
    await db_session.flush()

    resp = await client.get(URL_BASE.format(slug=test_workspace.slug))

    assert resp.status_code == 200, resp.text
    item = next(i for i in resp.json() if i["id"] == str(entry.id))
    assert item["first_enqueued_at"] is None
