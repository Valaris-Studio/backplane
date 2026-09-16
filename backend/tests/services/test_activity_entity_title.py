# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""ActivityService resolves entity_title for card + note rows.

Card and note entities have a title AND a route, so the activity feed can link
them. Title-less entity types (board/column/workspace/...) leave entity_title
None. Resolution is batched: one card query + one note query per list call,
regardless of row count.
"""
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace
from app.services.activity import ActivityService


def _add_activity(db, *, workspace, user, entity_type, entity_id, board=None, summary="s"):
    db.add(Activity(
        workspace_id=workspace.id,
        actor_id=user.id,
        board_id=board.id if board else None,
        entity_type=entity_type,
        entity_id=entity_id,
        action=ActivityAction.created,
        summary=summary,
    ))


async def test_list_workspace_activity_sets_entity_title_for_card(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    _add_activity(
        db_session, workspace=test_workspace, user=test_user,
        entity_type=ActivityEntityType.card, entity_id=test_card.id, board=test_board,
    )
    await db_session.flush()

    rows = await ActivityService(db_session).list_workspace_activity(test_workspace.id)
    assert len(rows) == 1
    assert rows[0].entity_title == test_card.title


async def test_list_workspace_activity_sets_entity_title_for_note(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
    test_note: Note,
):
    _add_activity(
        db_session, workspace=test_workspace, user=test_user,
        entity_type=ActivityEntityType.note, entity_id=test_note.id, board=test_board,
    )
    await db_session.flush()

    rows = await ActivityService(db_session).list_workspace_activity(test_workspace.id)
    assert rows[0].entity_title == test_note.title


async def test_list_workspace_activity_entity_title_none_for_titleless_type(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    _add_activity(
        db_session, workspace=test_workspace, user=test_user,
        entity_type=ActivityEntityType.board, entity_id=test_board.id, board=test_board,
    )
    await db_session.flush()

    rows = await ActivityService(db_session).list_workspace_activity(test_workspace.id)
    assert rows[0].entity_title is None


async def test_list_workspace_activity_deleted_card_entity_title_none(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
):
    # entity_id points at a card that no longer exists — must not 500, title None.
    _add_activity(
        db_session, workspace=test_workspace, user=test_user,
        entity_type=ActivityEntityType.card, entity_id=uuid.uuid4(), board=test_board,
    )
    await db_session.flush()

    rows = await ActivityService(db_session).list_workspace_activity(test_workspace.id)
    assert rows[0].entity_title is None


async def test_list_board_activity_sets_entity_title(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    _add_activity(
        db_session, workspace=test_workspace, user=test_user,
        entity_type=ActivityEntityType.card, entity_id=test_card.id, board=test_board,
    )
    await db_session.flush()

    rows = await ActivityService(db_session).list_board_activity(test_board.id)
    assert rows[0].entity_title == test_card.title


async def test_entity_title_batched_single_query_per_type(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    cards = []
    for i in range(4):
        card = Card(
            board_id=test_board.id,
            column_id=test_column.id,
            title=f"Card {i}",
            position=1024.0 * (i + 1),
            created_by=test_user.id,
        )
        db_session.add(card)
        cards.append(card)
    await db_session.flush()

    for card in cards:
        _add_activity(
            db_session, workspace=test_workspace, user=test_user,
            entity_type=ActivityEntityType.card, entity_id=card.id, board=test_board,
        )
    await db_session.flush()

    service = ActivityService(db_session)

    card_query_count = 0
    original = service.card_repo.get_refs_by_ids

    async def counting(ids):
        nonlocal card_query_count
        card_query_count += 1
        return await original(ids)

    service.card_repo.get_refs_by_ids = counting

    rows = await service.list_workspace_activity(test_workspace.id)

    assert len(rows) == 4
    assert card_query_count == 1, "all card titles resolved in one batch query"
    assert {r.entity_title for r in rows} == {c.title for c in cards}
