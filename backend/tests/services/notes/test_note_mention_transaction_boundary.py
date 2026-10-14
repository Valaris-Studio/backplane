# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest
from sqlalchemy import select

from app.core.event_bus import event_bus
from app.models.notifications.notification import Notification
from app.models.user import User
from app.models.workspace import WorkspaceMember, WorkspaceRole
from app.schemas.notes.note import NoteCreate
from app.services.notes.note import NoteService
from tests.services.notes import test_note_event_transactions as committed_contract

pytestmark = pytest.mark.slow
note_transactions = committed_contract.note_transactions


@pytest.mark.parametrize(
    "discard_savepoint", [False, True], ids=["committed", "rolled-back"]
)
async def test_note_mention_push_matches_its_durable_note_and_notification(
    note_transactions, discard_savepoint
):
    async with note_transactions.sessions() as seed:
        recipient = User(email="mention-recipient@example.test", name="Recipient")
        seed.add(recipient)
        await seed.flush()
        seed.add(
            WorkspaceMember(
                workspace_id=note_transactions.workspace_id,
                user_id=recipient.id,
                role=WorkspaceRole.member,
            )
        )
        await seed.commit()
        recipient_id = recipient.id

    received = []

    async def receive(event):
        received.append(event)

    unsubscribe = event_bus.subscribe(
        receive,
        workspace_id=note_transactions.workspace_id,
        event_pattern="notification.created",
    )
    try:
        db = note_transactions.db
        async with db.begin():
            savepoint = await db.begin_nested()
            note = await NoteService(db).create_note(
                note_transactions.workspace_id,
                NoteCreate(
                    title="Reviewed excerpt with mention",
                    content={
                        "type": "doc",
                        "content": [
                            {
                                "type": "paragraph",
                                "content": [
                                    {
                                        "type": "mention",
                                        "attrs": {
                                            "id": str(recipient_id),
                                            "label": "Recipient",
                                        },
                                    }
                                ],
                            }
                        ],
                    },
                ),
                note_transactions.user_id,
                note_transactions.board_id,
            )
            note_id = note.id
            notification = await db.scalar(
                select(Notification).where(Notification.entity_id == note_id)
            )
            assert (
                notification is not None
            ), "The real note save must generate a mention"
            notification_id = notification.id
            assert received == []
            if discard_savepoint:
                await savepoint.rollback()
            else:
                await savepoint.commit()
            await note_transactions.create("Unrelated committed note")

        await committed_contract.settle_publications()
        async with note_transactions.sessions() as observer:
            persisted_notification = await observer.scalar(
                select(Notification.id).where(Notification.id == notification_id)
            )
        if discard_savepoint:
            assert persisted_notification is None
            assert await note_transactions.persisted(note_id) == (False, False)
            assert (
                received == []
            ), "A rejected note save leaked its mention notification"
        else:
            assert persisted_notification == notification_id
            assert await note_transactions.persisted(note_id) == (True, True)
            assert len(received) == 1
            assert received[0].payload["notification_id"] == str(notification_id)
            assert received[0].payload["recipient_user_id"] == str(recipient_id)
            assert received[0].payload["category"] == "mention"
            assert received[0].payload["link"]["note_id"] == str(note_id)
            assert received[0].payload["unread_delta"] == 1
    finally:
        unsubscribe()
