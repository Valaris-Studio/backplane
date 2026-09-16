# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Loop starvation 1/3 — GET /loop/readiness board-level starvation probe.

The loop runner needs a $0 way to ask "is there anything to do?" before paying
for an agent session. The probe reuses `attach_dependency_counts` semantics
(single source of truth for the dependency predicate) and reports:

  - ready_count:         cards in backlog/active-typed columns whose
                         dependency_status != "blocked"
  - blocked_count:       the rest of those cards
  - awaiting_merge_count: blocked cards whose blocking (non-done) deps ALL sit
                         in review-typed columns AND carry a PR url
  - review_open_pr_count: cards in review-typed columns carrying a PR url
  - pending_completion: outstanding completion candidates, separate from source work
  - failed_completion:  completion candidates whose latest attempt failed
  - actionable:          ready_count > 0

"Carries a PR url" follows the done-merge gate doctrine: the structured
`Card.pr_url` column wins, `extract_pr_url(description)` is the fallback.
Untyped columns are excluded everywhere (human scratchpads). The probe is a
pure board read: it works with NO loop config stored (404 is reserved for the
unconfigured-loop GET /loop, which the runner treats as fatal — readiness must
never be conflated with it).
"""

import hashlib
import secrets
from unittest.mock import patch

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType
from app.models.api_key import ApiKey
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardDependency
from app.models.kanban.column import Column, ColumnType
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


BASE = "/api/workspaces/default/boards"

GITHUB_PR = "https://github.com/valaris/repo/pull/7"


def _url(board: Board) -> str:
    return f"{BASE}/{board.id}/loop/readiness"


async def _new_column(
    db: AsyncSession,
    *,
    board: Board,
    name: str,
    column_type: ColumnType | None,
    position: float,
) -> Column:
    col = Column(
        board_id=board.id,
        name=name,
        position=position,
        color="#6b7280",
        column_type=column_type,
    )
    db.add(col)
    await db.flush()
    return col


async def _new_card(
    db: AsyncSession,
    *,
    board: Board,
    column: Column,
    user: User,
    title: str,
    position: float = 1024.0,
    description: str = "",
    pr_url: str | None = None,
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        description=description,
        position=position,
        created_by=user.id,
        pr_url=pr_url,
    )
    db.add(card)
    await db.flush()
    return card


async def _add_dep(
    db: AsyncSession, *, card: Card, depends_on: Card, user: User
) -> None:
    db.add(
        CardDependency(
            card_id=card.id,
            depends_on_card_id=depends_on.id,
            created_by=user.id,
        )
    )
    await db.flush()


@pytest_asyncio.fixture
async def backlog_col(db_session: AsyncSession, test_board: Board) -> Column:
    return await _new_column(
        db_session,
        board=test_board,
        name="Backlog",
        column_type=ColumnType.backlog,
        position=1024.0,
    )


@pytest_asyncio.fixture
async def active_col(db_session: AsyncSession, test_board: Board) -> Column:
    return await _new_column(
        db_session,
        board=test_board,
        name="Doing",
        column_type=ColumnType.active,
        position=2048.0,
    )


@pytest_asyncio.fixture
async def review_col(db_session: AsyncSession, test_board: Board) -> Column:
    return await _new_column(
        db_session,
        board=test_board,
        name="Review",
        column_type=ColumnType.review,
        position=3072.0,
    )


@pytest_asyncio.fixture
async def done_col(db_session: AsyncSession, test_board: Board) -> Column:
    return await _new_column(
        db_session,
        board=test_board,
        name="Done",
        column_type=ColumnType.done,
        position=4096.0,
    )


async def test_readiness_empty_board_zeros_not_actionable(
    client: AsyncClient, test_board: Board
):
    resp = await client.get(_url(test_board))
    assert resp.status_code == 200
    assert resp.json() == {
        "ready_count": 0,
        "blocked_count": 0,
        "explicitly_blocked_count": 0,
        "explicitly_blocked_card_ids": [],
        "awaiting_merge_count": 0,
        "review_open_pr_count": 0,
        "pending_completion": 0,
        "failed_completion": 0,
        "actionable": False,
    }


async def test_readiness_serves_without_loop_config(
    client: AsyncClient, test_board: Board
):
    """Readiness is a board read, NOT a loop-config read: it must answer even
    before the board's first PUT /loop (the runner falls back to always_run on
    404, so a spurious 404 here would silently disable parking)."""
    assert test_board.loop_config is None
    resp = await client.get(_url(test_board))
    assert resp.status_code == 200


async def test_readiness_counts_ready_and_blocked(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
    backlog_col: Column,
    active_col: Column,
):
    await _new_card(
        db_session, board=test_board, column=backlog_col, user=test_user,
        title="free",
    )
    upstream = await _new_card(
        db_session, board=test_board, column=active_col, user=test_user,
        title="upstream",
    )
    blocked = await _new_card(
        db_session, board=test_board, column=backlog_col, user=test_user,
        title="blocked", position=2048.0,
    )
    await _add_dep(db_session, card=blocked, depends_on=upstream, user=test_user)

    resp = await client.get(_url(test_board))
    assert resp.status_code == 200
    data = resp.json()
    # "free" and "upstream" are ready; "blocked" is blocked by "upstream".
    assert data["ready_count"] == 2
    assert data["blocked_count"] == 1
    assert data["awaiting_merge_count"] == 0
    assert data["actionable"] is True


async def test_readiness_unblocked_dep_counts_as_ready(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
    backlog_col: Column,
    done_col: Column,
):
    shipped = await _new_card(
        db_session, board=test_board, column=done_col, user=test_user,
        title="shipped",
    )
    downstream = await _new_card(
        db_session, board=test_board, column=backlog_col, user=test_user,
        title="downstream",
    )
    await _add_dep(db_session, card=downstream, depends_on=shipped, user=test_user)

    resp = await client.get(_url(test_board))
    data = resp.json()
    # dependency_status == "unblocked" != "blocked" -> ready. The done-column
    # card itself is outside backlog/active and never counted.
    assert data["ready_count"] == 1
    assert data["blocked_count"] == 0
    assert data["actionable"] is True


async def test_readiness_excludes_untyped_columns(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,  # conftest column: column_type=None
    test_card: Card,  # lives in the untyped column
    test_user: User,
):
    resp = await client.get(_url(test_board))
    data = resp.json()
    assert data["ready_count"] == 0
    assert data["actionable"] is False


async def test_readiness_awaiting_merge_all_blockers_in_review_with_pr(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
    backlog_col: Column,
    review_col: Column,
):
    in_review = await _new_card(
        db_session, board=test_board, column=review_col, user=test_user,
        title="awaiting human merge", description=f"PR: {GITHUB_PR}",
    )
    blocked = await _new_card(
        db_session, board=test_board, column=backlog_col, user=test_user,
        title="blocked on merge",
    )
    await _add_dep(db_session, card=blocked, depends_on=in_review, user=test_user)

    resp = await client.get(_url(test_board))
    data = resp.json()
    assert data["blocked_count"] == 1
    assert data["awaiting_merge_count"] == 1
    assert data["review_open_pr_count"] == 1
    assert data["actionable"] is False


async def test_readiness_awaiting_merge_requires_pr_on_every_blocker(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
    backlog_col: Column,
    review_col: Column,
):
    with_pr = await _new_card(
        db_session, board=test_board, column=review_col, user=test_user,
        title="has pr", description=f"PR: {GITHUB_PR}",
    )
    without_pr = await _new_card(
        db_session, board=test_board, column=review_col, user=test_user,
        title="no pr", position=2048.0,
    )
    blocked = await _new_card(
        db_session, board=test_board, column=backlog_col, user=test_user,
        title="blocked",
    )
    await _add_dep(db_session, card=blocked, depends_on=with_pr, user=test_user)
    await _add_dep(db_session, card=blocked, depends_on=without_pr, user=test_user)

    resp = await client.get(_url(test_board))
    data = resp.json()
    assert data["blocked_count"] == 1
    assert data["awaiting_merge_count"] == 0


async def test_readiness_mixed_blockers_not_awaiting_merge(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
    backlog_col: Column,
    review_col: Column,
    done_col: Column,
):
    """A done blocker is satisfied (ignored); the awaiting-merge test is over
    the UNSATISFIED blockers only — here one review+PR and one backlog card."""
    in_review = await _new_card(
        db_session, board=test_board, column=review_col, user=test_user,
        title="mergeable", description=f"PR: {GITHUB_PR}",
    )
    shipped = await _new_card(
        db_session, board=test_board, column=done_col, user=test_user,
        title="shipped",
    )
    in_backlog = await _new_card(
        db_session, board=test_board, column=backlog_col, user=test_user,
        title="not started",
    )
    blocked_on_merge = await _new_card(
        db_session, board=test_board, column=backlog_col, user=test_user,
        title="blocked on merge only", position=2048.0,
    )
    await _add_dep(
        db_session, card=blocked_on_merge, depends_on=in_review, user=test_user
    )
    await _add_dep(
        db_session, card=blocked_on_merge, depends_on=shipped, user=test_user
    )
    blocked_mixed = await _new_card(
        db_session, board=test_board, column=backlog_col, user=test_user,
        title="blocked on work too", position=3072.0,
    )
    await _add_dep(
        db_session, card=blocked_mixed, depends_on=in_review, user=test_user
    )
    await _add_dep(
        db_session, card=blocked_mixed, depends_on=in_backlog, user=test_user
    )

    resp = await client.get(_url(test_board))
    data = resp.json()
    assert data["blocked_count"] == 2
    # done blocker ignored -> blocked_on_merge qualifies; blocked_mixed has a
    # backlog blocker -> does not.
    assert data["awaiting_merge_count"] == 1


async def test_readiness_review_open_pr_count_structured_and_description(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
    review_col: Column,
):
    await _new_card(
        db_session, board=test_board, column=review_col, user=test_user,
        title="structured", pr_url=GITHUB_PR,
    )
    await _new_card(
        db_session, board=test_board, column=review_col, user=test_user,
        title="in description", position=2048.0,
        description=f"see {GITHUB_PR}",
    )
    await _new_card(
        db_session, board=test_board, column=review_col, user=test_user,
        title="no pr yet", position=3072.0,
    )

    resp = await client.get(_url(test_board))
    assert resp.json()["review_open_pr_count"] == 2


async def test_readiness_soft_pass_without_dependency_table(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
    backlog_col: Column,
    active_col: Column,
):
    """Pre-DEP-1 deployment parity: no card_dependencies table -> every
    backlog/active card counts ready (mirrors attach_dependency_counts)."""
    upstream = await _new_card(
        db_session, board=test_board, column=active_col, user=test_user,
        title="upstream",
    )
    downstream = await _new_card(
        db_session, board=test_board, column=backlog_col, user=test_user,
        title="downstream",
    )
    await _add_dep(db_session, card=downstream, depends_on=upstream, user=test_user)

    with patch(
        "app.services.kanban.card._card_dependencies_table_exists",
        return_value=False,
    ):
        resp = await client.get(_url(test_board))
    data = resp.json()
    assert data["ready_count"] == 2
    assert data["blocked_count"] == 0
    assert data["awaiting_merge_count"] == 0
    assert data["actionable"] is True


async def test_readiness_nonexistent_board_404(client: AsyncClient):
    resp = await client.get(
        f"{BASE}/00000000-0000-0000-0000-000000000000/loop/readiness"
    )
    assert resp.status_code == 404


# --- authz matrix: member / viewer / agent key / non-member -----------------


@pytest_asyncio.fixture
async def raw_client(db_session: AsyncSession) -> AsyncClient:
    """No get_current_user override: dev-tier X-User-Email and the real
    Bearer vlr_ agent path both run through app.core.auth as in prod."""
    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def _make_member(
    db: AsyncSession, workspace: Workspace, email: str, role: WorkspaceRole
) -> User:
    user = User(email=email, name=email.split("@")[0])
    db.add(user)
    await db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=role))
    await db.flush()
    return user


async def test_readiness_member_and_viewer_can_read(
    raw_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
):
    member = await _make_member(
        db_session, test_workspace, "member-r@valaris.dev", WorkspaceRole.member
    )
    viewer = await _make_member(
        db_session, test_workspace, "viewer-r@valaris.dev", WorkspaceRole.viewer
    )
    for user in (member, viewer):
        resp = await raw_client.get(
            _url(test_board), headers={"X-User-Email": user.email}
        )
        assert resp.status_code == 200, f"{user.email}: {resp.text}"


async def test_readiness_agent_key_can_read(
    raw_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    raw = "vlr_" + secrets.token_urlsafe(32)
    api_key = ApiKey(
        user_id=test_user.id,
        name="readiness-key",
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:8],
    )
    db_session.add(api_key)
    await db_session.flush()
    agent = Agent(
        name="readiness-agent",
        agent_type=AgentType.coding,
        description="loop readiness probe agent",
        created_by_id=test_user.id,
        is_active=True,
        api_key_id=api_key.id,
    )
    db_session.add(agent)
    await db_session.flush()

    resp = await raw_client.get(
        _url(test_board), headers={"Authorization": f"Bearer {raw}"}
    )
    assert resp.status_code == 200, resp.text


async def test_readiness_non_member_403(
    raw_client: AsyncClient, test_board: Board
):
    resp = await raw_client.get(
        _url(test_board), headers={"X-User-Email": "stranger@valaris.dev"}
    )
    assert resp.status_code == 403
