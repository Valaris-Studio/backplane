# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Surgical section replace: rewrite one section of a note, leave the rest alone.

`append_note` covers the growing-tracker case. This covers the other half —
updating a status *inside* a long pinned note ("mark Cluster I done") without a
full-body round-trip. The invariant is the same one append pins, doubled: the
blocks before the anchor AND after the section's end survive byte-for-byte.

Anchor semantics pinned here (decided on card 8e39534a):
  - the anchor heading itself is kept; only the body beneath it is replaced
  - a section runs to the next heading of the SAME OR HIGHER level (a `###`
    nested under a `##` belongs to the `##` section)
  - matching is normalized (trimmed, case-folded) — headings are operator prose
  - an ambiguous anchor is a 409, never a silent guess at which one was meant
  - a missing anchor is a 404, never an upsert
"""
import json
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ConflictError, ForbiddenError, ResourceNotFoundError
from app.models.kanban.board import Board
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.notes.note import NoteCreate, NoteSectionReplace
from app.services.notes.note import NoteService

TRACKER = (
    "# Plan of Record\n\n"
    "Intro paragraph.\n\n"
    "## Cluster I\n\n"
    "In progress.\n\n"
    "## Cluster II\n\n"
    "Not started.\n"
)


async def _seed(service: NoteService, workspace: Workspace, user: User, board: Board, content: str):
    return await service.create_note(
        workspace.id, NoteCreate(title="Plan of Record", content=content), user.id, board.id
    )


def _texts(note) -> list[str]:
    return [
        "".join(part.get("text", "") for part in block.get("content") or [])
        for block in json.loads(note.content)["content"]
    ]


async def test_replace_section_keeps_prefix_and_suffix_byte_for_byte(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = NoteService(db_session)
    note = await _seed(service, test_workspace, test_user, test_board, TRACKER)
    before = json.loads(note.content)["content"]

    updated = await service.replace_note_section(
        note.id,
        test_workspace.id,
        NoteSectionReplace(anchor_heading="Cluster I", content="Done, shipped 2026-08-11."),
        actor_id=test_user.id,
        board_id=test_board.id,
    )

    after = json.loads(updated.content)["content"]
    # prefix: heading, intro, and the anchor heading itself are untouched
    assert after[:3] == before[:3]
    # suffix: everything from the next same-level heading on is untouched
    assert after[-2:] == before[-2:]
    assert _texts(updated) == [
        "Plan of Record",
        "Intro paragraph.",
        "Cluster I",
        "Done, shipped 2026-08-11.",
        "Cluster II",
        "Not started.",
    ]


async def test_replace_section_keeps_the_anchor_heading_itself(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    """The caller passes body content, not a replacement heading — replacing the
    heading too would make the anchor unaddressable on the next call."""
    service = NoteService(db_session)
    note = await _seed(service, test_workspace, test_user, test_board, TRACKER)

    updated = await service.replace_note_section(
        note.id,
        test_workspace.id,
        NoteSectionReplace(anchor_heading="Cluster I", content="Rewritten."),
        actor_id=test_user.id,
        board_id=test_board.id,
    )

    blocks = json.loads(updated.content)["content"]
    anchor = blocks[2]
    assert anchor["type"] == "heading"
    assert anchor["attrs"]["level"] == 2
    assert anchor["content"][0]["text"] == "Cluster I"


async def test_nested_heading_belongs_to_the_section_it_sits_under(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    """`### Sub` under `## Cluster I` must NOT terminate the section — otherwise
    replacing a parent section silently orphans its subsections."""
    service = NoteService(db_session)
    note = await _seed(
        service,
        test_workspace,
        test_user,
        test_board,
        "## Cluster I\n\nBody.\n\n### Sub A\n\nSub body.\n\n## Cluster II\n\nTail.\n",
    )

    updated = await service.replace_note_section(
        note.id,
        test_workspace.id,
        NoteSectionReplace(anchor_heading="Cluster I", content="Collapsed."),
        actor_id=test_user.id,
        board_id=test_board.id,
    )

    assert _texts(updated) == ["Cluster I", "Collapsed.", "Cluster II", "Tail."]


async def test_replacing_a_subsection_leaves_its_siblings_alone(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = NoteService(db_session)
    note = await _seed(
        service,
        test_workspace,
        test_user,
        test_board,
        "## Cluster I\n\nBody.\n\n### Sub A\n\nOld A.\n\n### Sub B\n\nB body.\n",
    )

    updated = await service.replace_note_section(
        note.id,
        test_workspace.id,
        NoteSectionReplace(anchor_heading="Sub A", content="New A."),
        actor_id=test_user.id,
        board_id=test_board.id,
    )

    assert _texts(updated) == ["Cluster I", "Body.", "Sub A", "New A.", "Sub B", "B body."]


async def test_trailing_section_replace_reaches_the_end_of_the_document(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = NoteService(db_session)
    note = await _seed(service, test_workspace, test_user, test_board, TRACKER)

    updated = await service.replace_note_section(
        note.id,
        test_workspace.id,
        NoteSectionReplace(anchor_heading="Cluster II", content="Now started."),
        actor_id=test_user.id,
        board_id=test_board.id,
    )

    assert _texts(updated)[-2:] == ["Cluster II", "Now started."]
    assert len(_texts(updated)) == 6


async def test_anchor_matching_is_trimmed_and_case_insensitive(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = NoteService(db_session)
    note = await _seed(service, test_workspace, test_user, test_board, TRACKER)

    updated = await service.replace_note_section(
        note.id,
        test_workspace.id,
        NoteSectionReplace(anchor_heading="  cluster i  ", content="Matched anyway."),
        actor_id=test_user.id,
        board_id=test_board.id,
    )

    assert _texts(updated)[3] == "Matched anyway."


async def test_ambiguous_anchor_is_rejected_rather_than_guessed(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    """Silently editing the wrong `## Session 5` of a pinned tracker is exactly
    the failure mode this tool family exists to prevent."""
    service = NoteService(db_session)
    note = await _seed(
        service,
        test_workspace,
        test_user,
        test_board,
        "## Session 5\n\nFirst.\n\n## Session 5\n\nSecond.\n",
    )
    before = note.content

    with pytest.raises(ConflictError):
        await service.replace_note_section(
            note.id,
            test_workspace.id,
            NoteSectionReplace(anchor_heading="Session 5", content="Which one?"),
            actor_id=test_user.id,
            board_id=test_board.id,
        )

    await db_session.refresh(note)
    assert note.content == before, "a rejected replace must not mutate the note"


async def test_missing_anchor_raises_not_found(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = NoteService(db_session)
    note = await _seed(service, test_workspace, test_user, test_board, TRACKER)

    with pytest.raises(ResourceNotFoundError):
        await service.replace_note_section(
            note.id,
            test_workspace.id,
            NoteSectionReplace(anchor_heading="Cluster IX", content="x"),
            actor_id=test_user.id,
            board_id=test_board.id,
        )


async def test_empty_replacement_body_clears_the_section(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    """Unlike append, an empty body is a legitimate intent here — "this section
    has no content yet" — so it empties the section instead of 422-ing."""
    service = NoteService(db_session)
    note = await _seed(service, test_workspace, test_user, test_board, TRACKER)

    updated = await service.replace_note_section(
        note.id,
        test_workspace.id,
        NoteSectionReplace(anchor_heading="Cluster I", content=""),
        actor_id=test_user.id,
        board_id=test_board.id,
    )

    assert _texts(updated) == ["Plan of Record", "Intro paragraph.", "Cluster I", "Cluster II", "Not started."]


async def test_replace_is_idempotent_for_the_same_body(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    """The contrast with append: replaying a replace converges, it does not
    accumulate. A retried call whose result the caller never saw is safe."""
    service = NoteService(db_session)
    note = await _seed(service, test_workspace, test_user, test_board, TRACKER)

    once = await service.replace_note_section(
        note.id, test_workspace.id,
        NoteSectionReplace(anchor_heading="Cluster I", content="Done."),
        actor_id=test_user.id, board_id=test_board.id,
    )
    first = once.content
    twice = await service.replace_note_section(
        note.id, test_workspace.id,
        NoteSectionReplace(anchor_heading="Cluster I", content="Done."),
        actor_id=test_user.id, board_id=test_board.id,
    )

    assert twice.content == first


async def test_replace_unknown_note_raises_not_found(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = NoteService(db_session)
    with pytest.raises(ResourceNotFoundError):
        await service.replace_note_section(
            uuid.uuid4(),
            test_workspace.id,
            NoteSectionReplace(anchor_heading="Cluster I", content="x"),
            actor_id=test_user.id,
        )


async def test_replace_foreign_workspace_note_raises_not_found(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = NoteService(db_session)
    note = await _seed(service, test_workspace, test_user, test_board, TRACKER)

    with pytest.raises(ResourceNotFoundError):
        await service.replace_note_section(
            note.id,
            uuid.uuid4(),
            NoteSectionReplace(anchor_heading="Cluster I", content="x"),
            actor_id=test_user.id,
        )


async def test_replace_rejected_on_immutable_kind(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    from app.models.notes.kinds import IMMUTABLE_KINDS

    note = Note(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        title="Review: card — approve",
        content=json.dumps(
            {
                "type": "doc",
                "content": [
                    {
                        "type": "heading",
                        "attrs": {"level": 2},
                        "content": [{"type": "text", "text": "Cluster I"}],
                    }
                ],
            }
        ),
        kind=next(iter(IMMUTABLE_KINDS)),
        created_by=test_user.id,
    )
    db_session.add(note)
    await db_session.flush()

    service = NoteService(db_session)
    with pytest.raises(ForbiddenError):
        await service.replace_note_section(
            note.id,
            test_workspace.id,
            NoteSectionReplace(anchor_heading="Cluster I", content="x"),
            actor_id=test_user.id,
        )


async def test_replace_records_activity_with_its_own_mode(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    from sqlalchemy import select

    from app.models.activity import Activity, ActivityAction, ActivityEntityType

    service = NoteService(db_session)
    note = await _seed(service, test_workspace, test_user, test_board, TRACKER)

    await service.replace_note_section(
        note.id,
        test_workspace.id,
        NoteSectionReplace(anchor_heading="Cluster I", content="Done."),
        actor_id=test_user.id,
        board_id=test_board.id,
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
    assert rows[0].changes == {
        "fields": ["content"],
        "mode": "replace_section",
        "anchor_heading": "Cluster I",
    }
