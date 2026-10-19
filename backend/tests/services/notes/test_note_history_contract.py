# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import func, select

from app.exceptions import ResourceNotFoundError
from app.models.activity import Activity, ActivityAction
from app.models.base import Base
from app.schemas.notes.note import NoteAppend, NoteCreate, NoteSectionReplace, NoteUpdate
from app.services.notes.note import NoteService


async def _updates(db, note_id):
    return await db.scalar(select(func.count()).select_from(Activity).where(
        Activity.entity_id == note_id, Activity.action == ActivityAction.updated,
    ))


def _history_table(name):
    assert name in Base.metadata.tables, f"Committed note history requires {name}"
    return Base.metadata.tables[name]


async def test_existing_append_and_section_controls_preserve_unrelated_blocks(
    db_session, test_workspace, test_board, test_user,
):
    service = NoteService(db_session)
    note = await service.create_note(test_workspace.id, NoteCreate(
        title="History controls", content="# First\n\nOriginal\n\n# Second\n\nUntouched",
    ), test_user.id, test_board.id)
    await service.append_note(note.id, test_workspace.id, NoteAppend(content="Tail"), test_user.id)
    await service.replace_note_section(note.id, test_workspace.id, NoteSectionReplace(
        anchor_heading="First", content="Replacement",
    ), test_user.id)
    blocks = json.loads(note.content)["content"]
    assert [b["content"][0]["text"] for b in blocks] == [
        "First", "Replacement", "Second", "Untouched", "Tail",
    ]
    assert await _updates(db_session, note.id) == 2


async def test_creation_records_revision_one_in_the_existing_shared_service(
    db_session, test_workspace, test_board, test_user,
):
    service = NoteService(db_session)
    note = await service.create_note(test_workspace.id, NoteCreate(
        title="Exact creation", content="Unicode café 🐙",
    ), test_user.id, test_board.id)
    persisted = await service.get_note_read(note.id, test_workspace.id)
    assert persisted.content == note.content
    assert persisted.model_dump().get("history_revision") == 1, (
        "Successful existing creation must record its first logical revision"
    )
    revisions = _history_table("note_revisions")
    assert await db_session.scalar(select(func.count()).select_from(revisions).where(
        revisions.c.note_id == note.id,
    )) == 1


@pytest.mark.parametrize("operation", ["empty_update", "equal_update", "equal_section"])
async def test_legacy_noop_does_not_change_time_activity_or_notify(
    operation, db_session, test_note, test_user, monkeypatch,
):
    test_note.content = NoteCreate(content="# State\n\nUnchanged", title="x").content
    await db_session.flush()
    await db_session.refresh(test_note)
    before = (test_note.content, test_note.updated_at)
    notify = AsyncMock()
    monkeypatch.setattr("app.services.notes.note.notify_new_mentions", notify)
    service = NoteService(db_session)
    if operation == "equal_section":
        await service.replace_note_section(test_note.id, test_note.workspace_id,
            NoteSectionReplace(anchor_heading="State", content="Unchanged"), test_user.id)
    else:
        data = NoteUpdate() if operation == "empty_update" else NoteUpdate(
            title=test_note.title, content=test_note.content, pinned=test_note.pinned,
        )
        await service.update_note(test_note.id, test_note.workspace_id, data, test_user.id)
    assert await _updates(db_session, test_note.id) == 0, "No-op emitted a misleading edit activity"
    assert (test_note.content, test_note.updated_at) == before
    notify.assert_not_awaited()
    revisions = _history_table("note_revisions")
    assert await db_session.scalar(select(func.count()).select_from(revisions).where(
        revisions.c.note_id == test_note.id,
    )) == 0, "No-op must not materialize a legacy baseline"


@pytest.mark.parametrize("mode", ["replace", "append", "section"])
async def test_workspace_mutations_attribute_mentions_to_loaded_board(
    mode, db_session, test_note, test_user, monkeypatch,
):
    test_note.content = NoteCreate(title="x", content="# State\n\nBefore").content
    await db_session.flush()
    notify = AsyncMock()
    monkeypatch.setattr("app.services.notes.note.notify_new_mentions", notify)
    service = NoteService(db_session)
    if mode == "replace":
        await service.update_note(test_note.id, test_note.workspace_id,
            NoteUpdate(content="Changed"), test_user.id)
    elif mode == "append":
        await service.append_note(test_note.id, test_note.workspace_id,
            NoteAppend(content="Added"), test_user.id)
    else:
        await service.replace_note_section(test_note.id, test_note.workspace_id,
            NoteSectionReplace(anchor_heading="State", content="Changed"), test_user.id)
    notify.assert_awaited_once()
    assert notify.await_args.kwargs["board_id"] == test_note.board_id


async def test_failed_section_preserves_legacy_content_and_activity_control(
    db_session, test_note, test_user,
):
    test_note.content = NoteCreate(title="x", content="# Present\n\nBefore").content
    await db_session.flush()
    await db_session.refresh(test_note)
    before = (test_note.content, test_note.updated_at)
    with pytest.raises(ResourceNotFoundError):
        await NoteService(db_session).replace_note_section(
            test_note.id, test_note.workspace_id,
            NoteSectionReplace(anchor_heading="Missing", content="Never stored"), test_user.id,
        )
    assert (test_note.content, test_note.updated_at) == before
    assert await _updates(db_session, test_note.id) == 0


async def test_first_legacy_edit_records_exact_preimage_and_edit_in_same_transaction(
    db_session, test_note, test_user,
):
    before = test_note.content
    await NoteService(db_session).update_note(test_note.id, test_note.workspace_id,
        NoteUpdate(title="First actual edit"), test_user.id)
    assert test_note.content == before
    assert getattr(test_note, "history_revision", None) == 2, (
        "First meaningful legacy edit needs a baseline and an edit, not invented creation"
    )
    revisions = _history_table("note_revisions")
    assert await db_session.scalar(select(func.count()).select_from(revisions).where(
        revisions.c.note_id == test_note.id,
    )) == 2
