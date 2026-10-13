# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio
import uuid
from dataclasses import dataclass

import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.event_bus import Event, event_bus
from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.base import Base
from app.models.kanban.board import Board
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.schemas.notes.note import NoteCreate
from app.services.notes.note import NoteService

pytestmark = pytest.mark.slow


@dataclass
class NoteTransactions:
    db: AsyncSession
    sessions: async_sessionmaker[AsyncSession]
    workspace_id: uuid.UUID
    board_id: uuid.UUID
    user_id: uuid.UUID

    async def create(self, title: str) -> Note:
        return await NoteService(self.db).create_note(
            self.workspace_id,
            NoteCreate(title=title, content="Reviewed snapshot"),
            self.user_id,
            self.board_id,
        )

    async def persisted(self, note_id: uuid.UUID) -> tuple[bool, bool]:
        async with self.sessions() as observer:
            note_id_in_db = await observer.scalar(
                select(Note.id).where(Note.id == note_id)
            )
            activity_id = await observer.scalar(
                select(Activity.id).where(
                    Activity.entity_type == ActivityEntityType.note,
                    Activity.action == ActivityAction.created,
                    Activity.entity_id == note_id,
                )
            )
            return note_id_in_db is not None, activity_id is not None


@pytest_asyncio.fixture
async def note_transactions(tmp_path):
    # A separate connection must observe only committed rows. StaticPool's
    # shared in-memory connection would hide the visibility race being tested.
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'notes.sqlite'}")

    @event.listens_for(engine.sync_engine, "connect")
    def configure_connection(connection, _record):
        connection.isolation_level = None
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    @event.listens_for(engine.sync_engine, "begin")
    def begin_transaction(connection):
        # SQLite's legacy mode otherwise lets the first SAVEPOINT become the
        # outer transaction, making RELEASE durable before session.commit().
        connection.exec_driver_sql("BEGIN")

    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as seed:
            user = User(email="note-events@example.test", name="Note owner")
            seed.add(user)
            await seed.flush()
            workspace = Workspace(name="Notes", slug="notes", created_by=user.id)
            seed.add(workspace)
            await seed.flush()
            seed.add(
                WorkspaceMember(
                    workspace_id=workspace.id, user_id=user.id, role=WorkspaceRole.owner
                )
            )
            board = Board(
                workspace_id=workspace.id,
                name="Notes",
                slug="notes",
                created_by=user.id,
            )
            seed.add(board)
            await seed.commit()
            workspace_id, board_id, user_id = workspace.id, board.id, user.id

        async with sessions() as db:
            yield NoteTransactions(db, sessions, workspace_id, board_id, user_id)
    finally:
        await engine.dispose()


@pytest.fixture
def note_events(note_transactions):
    events: list[Event] = []

    async def receive(event: Event):
        events.append(event)

    unsubscribe = event_bus.subscribe(
        receive,
        workspace_id=note_transactions.workspace_id,
        event_pattern="activity.note.created",
    )
    try:
        yield events
    finally:
        unsubscribe()


async def settle_publications():
    # Post-commit hooks may schedule the async bus on the next loop turn.
    await asyncio.sleep(0.01)


async def test_note_create_does_not_publish_before_outer_commit(
    note_transactions, note_events
):
    note = await note_transactions.create("Pending")
    note_id = note.id
    assert note_transactions.db.in_transaction()
    assert await note_transactions.persisted(note_id) == (False, False)
    await settle_publications()

    assert note_events == [], "A note event exposed an uncommitted mutation"


async def test_note_create_savepoint_release_does_not_publish(
    note_transactions, note_events
):
    async with note_transactions.db.begin():
        async with note_transactions.db.begin_nested():
            note = await note_transactions.create("Nested pending")
            note_id = note.id
        assert not note_transactions.db.in_nested_transaction()
        assert await note_transactions.persisted(note_id) == (False, False)
        await settle_publications()
        assert note_events == [], "SAVEPOINT release must not publish an outer mutation"

    await settle_publications()
    assert [event.payload["entity_id"] for event in note_events] == [str(note_id)]


async def test_note_create_commit_publishes_once_with_matching_activity(
    note_transactions, note_events
):
    note = await note_transactions.create("Committed")
    note_id = note.id
    await note_transactions.db.commit()
    await settle_publications()

    assert await note_transactions.persisted(note_id) == (True, True)
    assert len(note_events) == 1
    published = note_events[0]
    assert published.workspace_id == note_transactions.workspace_id
    assert published.payload == {
        "entity_type": "note",
        "entity_id": str(note_id),
        "action": "created",
        "actor_id": str(note_transactions.user_id),
        "board_id": str(note_transactions.board_id),
        "summary": "created note 'Committed'",
        "message_key": "activity.note.created",
        "message_params": {"note_title": "Committed"},
        "changes": None,
    }
    await note_transactions.db.commit()
    await settle_publications()
    assert note_events == [published], "A later empty commit replayed the note event"


async def test_note_create_event_subscriber_can_read_committed_rows(note_transactions):
    visibility: list[tuple[bool, bool]] = []
    received = asyncio.Event()

    async def read_published_note(published: Event):
        visibility.append(
            await note_transactions.persisted(uuid.UUID(published.payload["entity_id"]))
        )
        received.set()

    unsubscribe = event_bus.subscribe(
        read_published_note,
        workspace_id=note_transactions.workspace_id,
        event_pattern="activity.note.created",
    )
    try:
        await note_transactions.create("Visible on push")
        await note_transactions.db.commit()
        await asyncio.wait_for(received.wait(), timeout=1)
        assert visibility == [
            (True, True)
        ], "Subscriber refetched before note/activity commit"
    finally:
        unsubscribe()


async def test_note_create_outer_rollback_publishes_nothing(
    note_transactions, note_events
):
    note = await note_transactions.create("Rolled back")
    note_id = note.id
    await note_transactions.db.rollback()
    await settle_publications()

    assert await note_transactions.persisted(note_id) == (False, False)
    assert note_events == [], "A rolled-back note produced a phantom event"


async def test_note_create_failure_after_activity_publishes_nothing(
    note_transactions, note_events, monkeypatch
):
    class InjectedFailure(Exception):
        pass

    written_note_ids: list[uuid.UUID] = []

    async def fail_after_activity(db, **kwargs):
        note_id = kwargs["entity_id"]
        assert await db.scalar(select(Activity.id).where(Activity.entity_id == note_id))
        written_note_ids.append(note_id)
        raise InjectedFailure("Failure before the outer commit")

    monkeypatch.setattr(
        "app.services.notes.note.notify_new_mentions", fail_after_activity
    )
    with pytest.raises(InjectedFailure, match="before the outer commit"):
        async with note_transactions.db.begin():
            await note_transactions.create("Failed after activity")
    await settle_publications()

    assert len(written_note_ids) == 1
    assert await note_transactions.persisted(written_note_ids[0]) == (False, False)
    assert note_events == [], "A later service failure left a phantom note event"


async def test_note_create_commit_failure_publishes_nothing(
    note_transactions, note_events
):
    class InjectedCommitFailure(Exception):
        pass

    def fail_commit(_session):
        raise InjectedCommitFailure("Outer transaction could not commit")

    note = await note_transactions.create("Commit failed")
    note_id = note.id
    session = note_transactions.db.sync_session
    event.listen(session, "before_commit", fail_commit)
    try:
        with pytest.raises(InjectedCommitFailure, match="could not commit"):
            await note_transactions.db.commit()
    finally:
        event.remove(session, "before_commit", fail_commit)
        await note_transactions.db.rollback()
    await settle_publications()

    assert await note_transactions.persisted(note_id) == (False, False)
    assert note_events == [], "A failed commit published the rejected note"


async def test_note_create_savepoint_rollback_does_not_publish_on_outer_commit(
    note_transactions, note_events
):
    async with note_transactions.db.begin():
        savepoint = await note_transactions.db.begin_nested()
        note = await note_transactions.create("Discarded savepoint")
        note_id = note.id
        await savepoint.rollback()
    await settle_publications()

    assert await note_transactions.persisted(note_id) == (False, False)
    assert (
        note_events == []
    ), "Outer commit published an event discarded by its savepoint"


async def test_note_create_outer_rollback_then_session_reuse_drops_stale_events(
    note_transactions, note_events
):
    discarded = await note_transactions.create("Discarded transaction")
    discarded_id = discarded.id
    await note_transactions.db.rollback()
    kept = await note_transactions.create("Next transaction")
    kept_id = kept.id
    await note_transactions.db.commit()
    await settle_publications()

    assert await note_transactions.persisted(discarded_id) == (False, False)
    assert await note_transactions.persisted(kept_id) == (True, True)
    assert [event.payload["entity_id"] for event in note_events] == [str(kept_id)]


async def test_note_create_savepoint_rollback_preserves_outer_events(
    note_transactions, note_events
):
    async with note_transactions.db.begin():
        before = await note_transactions.create("Kept before savepoint")
        before_id = before.id
        savepoint = await note_transactions.db.begin_nested()
        discarded = await note_transactions.create("Discarded within savepoint")
        discarded_id = discarded.id
        await savepoint.rollback()
        after = await note_transactions.create("Kept after savepoint")
        after_id = after.id
    await settle_publications()

    assert await note_transactions.persisted(before_id) == (True, True)
    assert await note_transactions.persisted(discarded_id) == (False, False)
    assert await note_transactions.persisted(after_id) == (True, True)
    assert [event.payload["entity_id"] for event in note_events] == [
        str(before_id),
        str(after_id),
    ]
