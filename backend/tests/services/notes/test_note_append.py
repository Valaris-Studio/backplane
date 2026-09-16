# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Surgical append: add blocks to a note without reserializing its whole body.

The pinned plan-of-record pattern (a long tracker note that gains one Session
log entry per session) was previously a full-body `update_note` round-trip
through markdown — every append risked mangling the existing document. These
tests pin the property that makes append safe: the stored prefix is byte-for-byte
unchanged.
"""
import json
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ForbiddenError, ResourceNotFoundError
from app.models.kanban.board import Board
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.notes.note import NoteAppend, NoteCreate
from app.services.notes.note import NoteService


async def _seed(service: NoteService, workspace: Workspace, user: User, board: Board, content: str):
    return await service.create_note(
        workspace.id, NoteCreate(title="Plan of Record", content=content), user.id, board.id
    )


async def test_append_preserves_existing_blocks_byte_for_byte(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = NoteService(db_session)
    note = await _seed(
        service, test_workspace, test_user, test_board,
        "# Plan\n\nCluster I is done.\n\n- item one\n- item two",
    )
    before = json.loads(note.content)["content"]

    updated = await service.append_note(
        note.id, test_workspace.id, NoteAppend(content="## Session 5\n\nShipped the append tool."),
        actor_id=test_user.id, board_id=test_board.id,
    )

    after = json.loads(updated.content)["content"]
    assert after[: len(before)] == before, "existing blocks must survive untouched"
    assert len(after) == len(before) + 2
    assert after[len(before)]["type"] == "heading"
    assert after[len(before)]["content"][0]["text"] == "Session 5"
    assert after[-1]["content"][0]["text"] == "Shipped the append tool."


async def test_append_to_empty_note_yields_only_the_new_blocks(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = NoteService(db_session)
    note = await _seed(service, test_workspace, test_user, test_board, "")

    updated = await service.append_note(
        note.id, test_workspace.id, NoteAppend(content="First entry."),
        actor_id=test_user.id, board_id=test_board.id,
    )

    blocks = json.loads(updated.content)["content"]
    assert len(blocks) == 1
    assert blocks[0]["content"][0]["text"] == "First entry."


async def test_append_accepts_prosemirror_json_input(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = NoteService(db_session)
    note = await _seed(service, test_workspace, test_user, test_board, "Existing.")
    fragment = {
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "From PM JSON."}]}],
    }

    updated = await service.append_note(
        note.id, test_workspace.id, NoteAppend(content=json.dumps(fragment)),
        actor_id=test_user.id, board_id=test_board.id,
    )

    blocks = json.loads(updated.content)["content"]
    assert blocks[-1]["content"][0]["text"] == "From PM JSON."


async def test_append_repeated_accumulates_in_order(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    """Append is additive, not idempotent — two identical appends produce two
    entries. That is the point: a journal records every session."""
    service = NoteService(db_session)
    note = await _seed(service, test_workspace, test_user, test_board, "Header.")

    await service.append_note(
        note.id, test_workspace.id, NoteAppend(content="Session A"),
        actor_id=test_user.id, board_id=test_board.id,
    )
    updated = await service.append_note(
        note.id, test_workspace.id, NoteAppend(content="Session B"),
        actor_id=test_user.id, board_id=test_board.id,
    )

    texts = [b["content"][0]["text"] for b in json.loads(updated.content)["content"]]
    assert texts == ["Header.", "Session A", "Session B"]


async def test_append_rejects_whitespace_only_content(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    """An empty append is a caller bug (a lost variable), not an intent. Failing
    loudly beats silently succeeding and leaving the operator to wonder."""
    service = NoteService(db_session)
    note = await _seed(service, test_workspace, test_user, test_board, "Header.")

    with pytest.raises(ValueError):
        NoteAppend(content="   \n  ")


async def test_append_unknown_note_raises_not_found(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = NoteService(db_session)
    with pytest.raises(ResourceNotFoundError):
        await service.append_note(
            uuid.uuid4(), test_workspace.id, NoteAppend(content="x"), actor_id=test_user.id
        )


async def test_append_foreign_workspace_note_raises_not_found(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = NoteService(db_session)
    note = await _seed(service, test_workspace, test_user, test_board, "Header.")

    with pytest.raises(ResourceNotFoundError):
        await service.append_note(
            note.id, uuid.uuid4(), NoteAppend(content="x"), actor_id=test_user.id
        )


async def test_append_rejected_on_immutable_kind(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    """Append must honour the same immutability floor as update — a review
    verdict is an audit record, not a journal."""
    from app.models.notes.kinds import IMMUTABLE_KINDS

    note = Note(
        workspace_id=test_workspace.id, board_id=test_board.id,
        title="Review: card — approve", content=json.dumps({"type": "doc", "content": []}),
        kind=next(iter(IMMUTABLE_KINDS)), created_by=test_user.id,
    )
    db_session.add(note)
    await db_session.flush()

    service = NoteService(db_session)
    with pytest.raises(ForbiddenError):
        await service.append_note(
            note.id, test_workspace.id, NoteAppend(content="x"), actor_id=test_user.id
        )


async def test_append_records_activity(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    from sqlalchemy import select

    from app.models.activity import Activity, ActivityAction, ActivityEntityType

    service = NoteService(db_session)
    note = await _seed(service, test_workspace, test_user, test_board, "Header.")

    await service.append_note(
        note.id, test_workspace.id, NoteAppend(content="Session 5"),
        actor_id=test_user.id, board_id=test_board.id,
    )

    rows = (
        await db_session.execute(
            select(Activity).where(
                Activity.entity_type == ActivityEntityType.note,
                Activity.entity_id == note.id,
                Activity.action == ActivityAction.updated,
            )
        )
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].changes == {"fields": ["content"], "mode": "append"}
