# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.definitions.definition import Definition
from app.models.git.git_repo import GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card, Priority
from app.models.kanban.column import Column
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace


def _context_url(board_id: uuid.UUID) -> str:
    return f"/api/workspaces/default/boards/{board_id}/context"


async def test_get_board_context_success(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    """Minimal board with one column and two cards returns correct summary."""
    card1 = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Card A",
        position=1024.0,
        priority=Priority.high,
        status="working",
        created_by=test_user.id,
    )
    card2 = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Card B",
        position=2048.0,
        priority=Priority.none,
        status=None,
        created_by=test_user.id,
    )
    db_session.add_all([card1, card2])
    await db_session.flush()

    response = await client.get(_context_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    # Board summary
    board = data["board"]
    assert board["id"] == str(test_board.id)
    assert board["name"] == "Test Board"
    assert board["total_cards"] == 2

    # Column summary
    assert len(board["columns"]) == 1
    col = board["columns"][0]
    assert col["id"] == str(test_column.id)
    assert col["card_count"] == 2
    assert col["priority_distribution"]["high"] == 1
    assert col["priority_distribution"]["none"] == 1
    assert col["status_distribution"]["working"] == 1
    assert col["status_distribution"]["null"] == 1

    # Empty sub-collections by default
    assert data["definition"] is None
    assert data["notes"] == []
    assert data["git_repos"] == []
    assert data["recent_activity"] == []


async def test_get_board_context_with_definition(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_definition: Definition,
):
    response = await client.get(_context_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    defn = data["definition"]
    assert defn is not None
    assert defn["scope"] == "Build the MVP"
    assert defn["content"] == {"tech_stack": ["Python"]}


async def test_get_board_context_with_notes_and_activity(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_note: Note,
    test_user: User,
    db_session: AsyncSession,
):
    activity = Activity(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.card,
        entity_id=uuid.uuid4(),
        action=ActivityAction.created,
        summary="created card 'Test'",
    )
    db_session.add(activity)
    await db_session.flush()

    response = await client.get(_context_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    assert len(data["notes"]) == 1
    assert data["notes"][0]["title"] == "Test Note"

    assert len(data["recent_activity"]) == 1
    act = data["recent_activity"][0]
    assert act["action"] == "created"
    assert act["summary"] == "created card 'Test'"


async def test_get_board_context_with_git_repos(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_git_repo: GitRepo,
):
    response = await client.get(_context_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    assert len(data["git_repos"]) == 1
    repo = data["git_repos"][0]
    assert repo["name"] == "Test Repo"
    assert repo["url"] == "https://github.com/valaris/test-repo"
    assert repo["provider"] == "github"
    assert repo["default_branch"] == "main"


async def test_get_board_context_nonexistent_board(
    client: AsyncClient,
    test_workspace: Workspace,
):
    fake_id = uuid.uuid4()
    response = await client.get(_context_url(fake_id))
    assert response.status_code == 404


async def _seed_prose_statuses(
    db_session: AsyncSession,
    board: Board,
    column: Column,
    user: User,
    distinct_status_count: int,
) -> int:
    """Agents that log progress into card.status leave one distinct ~200-char
    status per card (a real board had 164 in one column). Two short
    statuses repeat so the top of the ranking is predictable."""
    cards = []
    for i in range(distinct_status_count):
        prose = f"Progress log {i:03d}: " + "deployed, verified, notified client " * 6
        cards.append(prose[:255])
    cards += ["working"] * 5 + ["blocked"] * 3
    db_session.add_all(
        [
            Card(
                board_id=board.id,
                column_id=column.id,
                title=f"Card {i}",
                position=1024.0 * (i + 1),
                status=status,
                created_by=user.id,
            )
            for i, status in enumerate(cards)
        ]
    )
    await db_session.flush()
    return len(cards)


async def test_get_board_context_caps_status_distribution(
    client: AsyncClient,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    from app.services.kanban.board_context import (
        OTHER_STATUS_KEY,
        STATUS_DISTRIBUTION_TOP_N,
        STATUS_KEY_MAX_CHARS,
    )

    card_count = await _seed_prose_statuses(
        db_session, test_board, test_column, test_user, distinct_status_count=164
    )

    response = await client.get(_context_url(test_board.id))
    assert response.status_code == 200
    col = response.json()["board"]["columns"][0]
    distribution = col["status_distribution"]

    assert len(distribution) == STATUS_DISTRIBUTION_TOP_N + 1
    assert distribution["working"] == 5
    assert distribution["blocked"] == 3
    assert all(len(key) <= STATUS_KEY_MAX_CHARS for key in distribution)
    assert sum(distribution.values()) == card_count == col["card_count"]
    assert distribution[OTHER_STATUS_KEY] == card_count - sum(
        v for k, v in distribution.items() if k != OTHER_STATUS_KEY
    )
    # The whole briefing stays small however much prose lives in card.status:
    # 172 cards of ~200-char statuses used to serialize to ~37K chars here.
    assert len(response.text) < 4_000


async def test_get_board_context_status_distribution_small_column_untouched(
    client: AsyncClient,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    from app.services.kanban.board_context import (
        OTHER_STATUS_KEY,
        STATUS_DISTRIBUTION_TOP_N,
    )

    statuses = [f"s{i}" for i in range(STATUS_DISTRIBUTION_TOP_N + 1)]
    db_session.add_all(
        [
            Card(
                board_id=test_board.id,
                column_id=test_column.id,
                title=f"Card {i}",
                position=1024.0 * (i + 1),
                status=status,
                created_by=test_user.id,
            )
            for i, status in enumerate(statuses)
        ]
    )
    await db_session.flush()

    response = await client.get(_context_url(test_board.id))
    distribution = response.json()["board"]["columns"][0]["status_distribution"]
    assert distribution == {s: 1 for s in statuses}
    assert OTHER_STATUS_KEY not in distribution


async def test_get_board_context_truncated_status_keys_merge(
    client: AsyncClient,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    from app.services.kanban.board_context import STATUS_KEY_MAX_CHARS

    shared_prefix = "x" * STATUS_KEY_MAX_CHARS
    db_session.add_all(
        [
            Card(
                board_id=test_board.id,
                column_id=test_column.id,
                title=f"Card {i}",
                position=1024.0 * (i + 1),
                status=shared_prefix + suffix,
                created_by=test_user.id,
            )
            for i, suffix in enumerate(["-a", "-b"])
        ]
    )
    await db_session.flush()

    response = await client.get(_context_url(test_board.id))
    distribution = response.json()["board"]["columns"][0]["status_distribution"]
    assert list(distribution.values()) == [2]
    (key,) = distribution
    assert len(key) == STATUS_KEY_MAX_CHARS
    assert key.endswith("…")


FAMILY_EMOJI = "\U0001f468‍\U0001f469‍\U0001f467"


def test_status_key_never_splits_a_zwj_emoji_sequence():
    from app.services.kanban.board_context import (
        STATUS_KEY_MAX_CHARS,
        bounded_status_distribution,
    )

    # The raw cut lands right after the first person of the family emoji.
    status = "a" * (STATUS_KEY_MAX_CHARS - 2) + FAMILY_EMOJI + "tail"
    (key,) = bounded_status_distribution([status])
    assert key == "a" * (STATUS_KEY_MAX_CHARS - 2) + "…"
    assert "‍" not in key


def test_status_key_never_leaves_a_dangling_combining_mark_or_modifier():
    from app.services.kanban.board_context import (
        STATUS_KEY_MAX_CHARS,
        bounded_status_distribution,
    )

    accented = "a" * (STATUS_KEY_MAX_CHARS - 2) + "é" + "tail"
    waving = "b" * (STATUS_KEY_MAX_CHARS - 2) + "\U0001f44b\U0001f3fd" + "tail"
    keys = list(bounded_status_distribution([accented, waving]))
    assert "a" * (STATUS_KEY_MAX_CHARS - 2) + "…" in keys
    assert "b" * (STATUS_KEY_MAX_CHARS - 2) + "…" in keys


def test_status_distribution_breaks_count_ties_by_key():
    from app.services.kanban.board_context import (
        OTHER_STATUS_KEY,
        STATUS_DISTRIBUTION_TOP_N,
        bounded_status_distribution,
    )

    statuses = [f"s{i:02d}" for i in reversed(range(STATUS_DISTRIBUTION_TOP_N + 4))]
    distribution = bounded_status_distribution(statuses)
    assert list(distribution) == [
        f"s{i:02d}" for i in range(STATUS_DISTRIBUTION_TOP_N)
    ] + [OTHER_STATUS_KEY]
    assert distribution[OTHER_STATUS_KEY] == 4


def test_status_distribution_merges_a_literal_other_status_into_the_bucket():
    from app.services.kanban.board_context import (
        OTHER_STATUS_KEY,
        STATUS_DISTRIBUTION_TOP_N,
        bounded_status_distribution,
    )

    tail = [f"s{i:02d}" for i in range(STATUS_DISTRIBUTION_TOP_N + 3)]
    statuses = [OTHER_STATUS_KEY] * 50 + tail
    distribution = bounded_status_distribution(statuses)
    assert len(distribution) == STATUS_DISTRIBUTION_TOP_N + 1
    assert sum(distribution.values()) == len(statuses)
    assert distribution[OTHER_STATUS_KEY] == 50 + 3


def test_status_distribution_counts_empty_and_missing_status_as_null():
    from app.services.kanban.board_context import (
        NO_STATUS_KEY,
        bounded_status_distribution,
    )

    assert bounded_status_distribution(["", None, "done"]) == {
        NO_STATUS_KEY: 2,
        "done": 1,
    }
