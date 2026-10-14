# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio
import logging
import uuid

import pytest

from app.core.event_bus import Event, event_bus
from app.models.kanban.board import Board
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.schemas.notes.note import NoteCreate, NoteUpdate
from app.services import committed_events
from app.services.notes.note import NoteService
from tests.services.notes import test_note_event_transactions as committed_contract

pytestmark = pytest.mark.slow

note_transactions = committed_contract.note_transactions


async def test_sequential_note_commits_deliver_in_commit_order(note_transactions):
    delivered: list[str] = []
    both_delivered = asyncio.Event()

    async def slow_on_create(published: Event):
        # Suspending on the first event lets a later commit's dispatch overtake
        # it unless dispatch is serialized in commit order.
        if published.event_type == "activity.note.created":
            await asyncio.sleep(0.05)
        delivered.append(published.event_type)
        if len(delivered) == 2:
            both_delivered.set()

    unsubscribe = event_bus.subscribe(
        slow_on_create,
        workspace_id=note_transactions.workspace_id,
        event_pattern="activity.note.*",
    )
    try:
        note = await note_transactions.create("Ordered")
        await note_transactions.db.commit()
        await NoteService(note_transactions.db).update_note(
            note.id,
            note_transactions.workspace_id,
            NoteUpdate(title="Ordered, renamed"),
            note_transactions.user_id,
            note_transactions.board_id,
        )
        await note_transactions.db.commit()
        await asyncio.wait_for(both_delivered.wait(), timeout=1)
    finally:
        unsubscribe()

    assert delivered == ["activity.note.created", "activity.note.updated"]


async def seed_second_workspace(note_transactions) -> tuple[uuid.UUID, uuid.UUID]:
    async with note_transactions.sessions() as seed:
        workspace = Workspace(
            name="Other", slug="other", created_by=note_transactions.user_id
        )
        seed.add(workspace)
        await seed.flush()
        seed.add(
            WorkspaceMember(
                workspace_id=workspace.id,
                user_id=note_transactions.user_id,
                role=WorkspaceRole.owner,
            )
        )
        board = Board(
            workspace_id=workspace.id,
            name="Other",
            slug="other",
            created_by=note_transactions.user_id,
        )
        seed.add(board)
        await seed.commit()
        return workspace.id, board.id


async def test_stalled_subscriber_in_one_workspace_does_not_delay_another(
    note_transactions,
):
    other_workspace_id, other_board_id = await seed_second_workspace(note_transactions)
    release_stalled = asyncio.Event()
    other_delivered = asyncio.Event()

    async def stall_forever(_published: Event):
        await release_stalled.wait()

    async def mark_other_delivered(_published: Event):
        other_delivered.set()

    unsubscribe_stalled = event_bus.subscribe(
        stall_forever,
        workspace_id=note_transactions.workspace_id,
        event_pattern="activity.note.*",
    )
    unsubscribe_other = event_bus.subscribe(
        mark_other_delivered,
        workspace_id=other_workspace_id,
        event_pattern="activity.note.*",
    )
    try:
        await note_transactions.create("Stalled workspace")
        await note_transactions.db.commit()
        await NoteService(note_transactions.db).create_note(
            other_workspace_id,
            NoteCreate(title="Unrelated workspace", content="Independent"),
            note_transactions.user_id,
            other_board_id,
        )
        await note_transactions.db.commit()
        await asyncio.wait_for(other_delivered.wait(), timeout=0.5)
    finally:
        release_stalled.set()
        unsubscribe_stalled()
        unsubscribe_other()
        await committed_contract.settle_publications()


async def test_stalled_subscriber_delays_its_own_workspace_only_until_the_bound(
    note_transactions, monkeypatch, caplog
):
    monkeypatch.setattr(committed_events, "_ORDERED_DISPATCH_WAIT_SECONDS", 0.2)
    release_stalled = asyncio.Event()
    delivered: list[str] = []
    second_delivered = asyncio.Event()

    async def stall_on_first(published: Event):
        delivered.append(published.payload["message_params"]["note_title"])
        if len(delivered) == 1:
            await release_stalled.wait()
        else:
            second_delivered.set()

    unsubscribe = event_bus.subscribe(
        stall_on_first,
        workspace_id=note_transactions.workspace_id,
        event_pattern="activity.note.created",
    )
    try:
        with caplog.at_level(logging.WARNING, logger=committed_events.__name__):
            await note_transactions.create("First, stalled")
            await note_transactions.db.commit()
            await note_transactions.create("Second, bounded")
            await note_transactions.db.commit()
            await asyncio.wait_for(second_delivered.wait(), timeout=0.2 + 0.5)
    finally:
        release_stalled.set()
        unsubscribe()
        await committed_contract.settle_publications()

    assert delivered == ["First, stalled", "Second, bounded"]
    assert any(
        record.levelno == logging.WARNING for record in caplog.records
    ), "A dispatch that gave up waiting for its predecessor logged nothing"
