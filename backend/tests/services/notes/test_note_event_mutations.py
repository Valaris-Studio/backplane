# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.core.event_bus import Event, event_bus
from app.models.activity import Activity, ActivityEntityType
from app.models.notes.note import Note
from app.schemas.notes.note import (
    NoteAppend,
    NoteCreate,
    NoteSectionReplace,
    NoteUpdate,
)
from app.services.notes.note import NoteService
from tests.services.notes import test_note_event_transactions as committed_contract

pytestmark = pytest.mark.slow

note_transactions = committed_contract.note_transactions

# (title, content_text) as an independent connection sees it; None once deleted.
NoteSnapshot = tuple[str, str] | None


@dataclass(frozen=True)
class NoteMutation:
    apply: Callable[[NoteService, uuid.UUID, object], Awaitable[object]]
    committed: Callable[[NoteSnapshot], bool]


def _scope(tx) -> dict:
    return {
        "workspace_id": tx.workspace_id,
        "actor_id": tx.user_id,
        "board_id": tx.board_id,
    }


MUTATIONS: dict[str, NoteMutation] = {
    "activity.note.updated": NoteMutation(
        apply=lambda service, note_id, tx: service.update_note(
            note_id, data=NoteUpdate(title="Renamed"), **_scope(tx)
        ),
        committed=lambda snapshot: snapshot is not None and snapshot[0] == "Renamed",
    ),
    "activity.note.appended": NoteMutation(
        apply=lambda service, note_id, tx: service.append_note(
            note_id, data=NoteAppend(content="Appended line"), **_scope(tx)
        ),
        committed=lambda snapshot: (
            snapshot is not None and "Appended line" in snapshot[1]
        ),
    ),
    "activity.note.section_replaced": NoteMutation(
        apply=lambda service, note_id, tx: service.replace_note_section(
            note_id,
            data=NoteSectionReplace(anchor_heading="Status", content="Replaced body"),
            **_scope(tx),
        ),
        committed=lambda snapshot: (
            snapshot is not None
            and "Replaced body" in snapshot[1]
            and "Original body" not in snapshot[1]
        ),
    ),
    "activity.note.deleted": NoteMutation(
        apply=lambda service, note_id, tx: service.delete_note(note_id, **_scope(tx)),
        committed=lambda snapshot: snapshot is None,
    ),
}


async def observe(
    tx, note_id: uuid.UUID, message_key: str
) -> tuple[NoteSnapshot, bool]:
    async with tx.sessions() as observer:
        row = (
            await observer.execute(
                select(Note.title, Note.content_text).where(Note.id == note_id)
            )
        ).first()
        activity_id = await observer.scalar(
            select(Activity.id).where(
                Activity.entity_type == ActivityEntityType.note,
                Activity.entity_id == note_id,
                Activity.message_key == message_key,
            )
        )
    return (tuple(row) if row else None), activity_id is not None


@pytest_asyncio.fixture
async def committed_note_id(note_transactions) -> uuid.UUID:
    note = await NoteService(note_transactions.db).create_note(
        note_transactions.workspace_id,
        NoteCreate(title="Tracked", content="## Status\n\nOriginal body"),
        note_transactions.user_id,
        note_transactions.board_id,
    )
    await note_transactions.db.commit()
    return note.id


@pytest.fixture
def mutation_events(note_transactions):
    events: list[Event] = []

    async def receive(event: Event):
        events.append(event)

    unsubscribe = event_bus.subscribe(
        receive,
        workspace_id=note_transactions.workspace_id,
        event_pattern="activity.note.*",
    )
    try:
        yield events
    finally:
        unsubscribe()


@pytest.mark.parametrize("message_key", list(MUTATIONS))
async def test_note_mutation_rollback_publishes_nothing(
    note_transactions, committed_note_id, mutation_events, message_key
):
    await committed_contract.settle_publications()
    mutation_events.clear()
    mutation = MUTATIONS[message_key]

    await mutation.apply(
        NoteService(note_transactions.db), committed_note_id, note_transactions
    )
    await committed_contract.settle_publications()
    assert mutation_events == [], f"{message_key} published before the outer commit"

    await note_transactions.db.rollback()
    await committed_contract.settle_publications()

    snapshot, activity_recorded = await observe(
        note_transactions, committed_note_id, message_key
    )
    assert snapshot is not None and snapshot[0] == "Tracked"
    assert "Original body" in snapshot[1]
    assert not activity_recorded
    assert mutation_events == [], f"A rolled-back {message_key} produced an event"


@pytest.mark.parametrize("message_key", list(MUTATIONS))
async def test_note_mutation_commit_publishes_once_after_rows_are_visible(
    note_transactions, committed_note_id, message_key
):
    await committed_contract.settle_publications()
    mutation = MUTATIONS[message_key]
    seen_at_delivery: list[tuple[NoteSnapshot, bool]] = []
    received = asyncio.Event()

    async def read_on_delivery(published: Event):
        if published.payload["message_key"] != message_key:
            return
        assert published.payload["entity_id"] == str(committed_note_id)
        seen_at_delivery.append(
            await observe(note_transactions, committed_note_id, message_key)
        )
        received.set()

    unsubscribe = event_bus.subscribe(
        read_on_delivery,
        workspace_id=note_transactions.workspace_id,
        event_pattern="activity.note.*",
    )
    try:
        await mutation.apply(
            NoteService(note_transactions.db), committed_note_id, note_transactions
        )
        await note_transactions.db.commit()
        await asyncio.wait_for(received.wait(), timeout=1)
        await note_transactions.db.commit()
        await committed_contract.settle_publications()
    finally:
        unsubscribe()

    assert len(seen_at_delivery) == 1, f"{message_key} was not published exactly once"
    snapshot, activity_recorded = seen_at_delivery[0]
    assert activity_recorded, f"Subscriber saw {message_key} before its activity row"
    assert mutation.committed(
        snapshot
    ), f"Subscriber saw {message_key} before the note mutation committed: {snapshot}"
