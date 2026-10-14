# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from sqlalchemy import select

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.schemas.kanban.card import CardCreate
from app.services.kanban.card import CardService
from app.services.kanban.column import ColumnService
from app.services.timeline_replay import fold_events


async def test_bulk_created_siblings_each_have_independent_replay_evidence(
    db_session, test_board, test_column, test_workspace, test_user,
):
    service = CardService(db_session)
    cards = await service.bulk_create_cards(
        test_board.id,
        [CardCreate(title=title, column_id=test_column.id) for title in ("First", "Second")],
        test_user.id,
        workspace_id=test_workspace.id,
    )
    activities = list((await db_session.scalars(
        select(Activity).where(
            Activity.board_id == test_board.id,
            Activity.entity_type == ActivityEntityType.card,
            Activity.action == ActivityAction.created,
        ).order_by(Activity.seq)
    )).all())

    assert {row.entity_id for row in activities} == {card.id for card in cards}
    for row, card in zip(activities, cards, strict=True):
        assert row.after_state["id"] == str(card.id)
        assert row.after_state["title"] == card.title
        assert row.after_state["column_id"] == str(test_column.id)
        assert row.after_state["participants"] == []
        assert row.before_state is None

    reconstructed = fold_events([
        {"entity_type": row.entity_type.value, "entity_id": str(row.entity_id),
         "action": row.action.value, "after_state": row.after_state}
        for row in activities
    ])
    assert {card["title"] for card in reconstructed["state"]["cards"]} == {"First", "Second"}
    assert reconstructed["coverage"]["missing_structural_snapshots"] == "0"


async def test_column_deletion_records_its_card_cascade_semantics(
    db_session, test_board, test_column, test_workspace, test_user,
):
    await ColumnService(db_session).delete_column(
        test_column.id, test_board.id,
        workspace_id=test_workspace.id, actor_id=test_user.id,
    )
    row = await db_session.scalar(select(Activity).where(
        Activity.entity_id == test_column.id,
        Activity.entity_type == ActivityEntityType.column,
        Activity.action == ActivityAction.deleted,
    ))
    assert row is not None
    assert row.before_state["id"] == str(test_column.id)
    assert row.after_state is None
    assert row.changes == {"cascade_card_deletion": True}
