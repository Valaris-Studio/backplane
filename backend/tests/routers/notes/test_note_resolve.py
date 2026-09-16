# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""GET .../notes/resolve?prefix=... — resolve a note by UUID prefix.

Mirrors the cards resolver (test_card_resolve.py): additive read-only route on
both note scopes, strict `{note_id}` UUID routes untouched.
- Unique match  → 200 with the full NoteRead.
- Zero matches  → 404.
- >1 matches    → 409 listing candidate ids + titles.
- prefix < 4    → 422.

SQLite gotcha (test DB only): an all-numeric hyphenated UUID coerces to an
integer under SQLite's flexible typing, so we use ids with hex LETTERS.
"""
import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace

BOARD_BASE = "/api/workspaces/default/boards"
WS_BASE = "/api/workspaces/default/notes"


async def _insert_note(
    db: AsyncSession,
    workspace: Workspace,
    user: User,
    note_id: uuid.UUID,
    title: str,
    board: Board | None = None,
) -> Note:
    note = Note(
        id=note_id,
        workspace_id=workspace.id,
        board_id=board.id if board else None,
        title=title,
        content="{}",
        created_by=user.id,
    )
    db.add(note)
    await db.flush()
    return note


async def test_resolve_board_note_by_prefix_unique(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    nid = uuid.UUID("aaaabbbb-0000-0000-0000-0000000000aa")
    await _insert_note(db_session, test_workspace, test_user, nid, "Run log", test_board)

    prefix = str(nid)[:12]
    response = await client.get(
        f"{BOARD_BASE}/{test_board.id}/notes/resolve?prefix={prefix}"
    )

    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(nid)
    assert data["title"] == "Run log"


async def test_resolve_workspace_note_by_prefix_unique(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    nid = uuid.UUID("ccccdddd-0000-0000-0000-0000000000cc")
    await _insert_note(db_session, test_workspace, test_user, nid, "Workspace memo")

    prefix = str(nid)[:12]
    response = await client.get(f"{WS_BASE}/resolve?prefix={prefix}")

    assert response.status_code == 200
    assert response.json()["id"] == str(nid)


async def test_resolve_note_by_prefix_ambiguous(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    shared = "abcd1111"
    first = uuid.UUID("abcd1111-0000-0000-0000-0000000000aa")
    second = uuid.UUID("abcd1111-0000-0000-0000-0000000000bb")
    await _insert_note(db_session, test_workspace, test_user, first, "One", test_board)
    await _insert_note(db_session, test_workspace, test_user, second, "Two", test_board)

    response = await client.get(
        f"{BOARD_BASE}/{test_board.id}/notes/resolve?prefix={shared}"
    )

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert str(first) in detail
    assert str(second) in detail


async def test_resolve_note_by_prefix_not_found(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.get(
        f"{BOARD_BASE}/{test_board.id}/notes/resolve?prefix=deadbeef"
    )
    assert response.status_code == 404


async def test_resolve_note_prefix_too_short(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.get(f"{BOARD_BASE}/{test_board.id}/notes/resolve?prefix=ab")
    assert response.status_code == 422


async def test_board_resolve_does_not_leak_notes_from_another_board(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    other_board = Board(
        id=uuid.uuid4(),
        workspace_id=test_workspace.id,
        name="Other",
        slug="other-board",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()

    nid = uuid.UUID("eeeeffff-0000-0000-0000-0000000000ee")
    await _insert_note(
        db_session, test_workspace, test_user, nid, "Elsewhere", other_board
    )

    response = await client.get(
        f"{BOARD_BASE}/{test_board.id}/notes/resolve?prefix={str(nid)[:12]}"
    )
    assert response.status_code == 404


async def test_strict_note_route_still_wins_over_resolve_literal(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """`resolve` must not be swallowed by the `{note_id}` UUID route."""
    nid = uuid.UUID("12ab34cd-0000-0000-0000-0000000000ff")
    await _insert_note(db_session, test_workspace, test_user, nid, "Strict", test_board)

    strict = await client.get(f"{BOARD_BASE}/{test_board.id}/notes/{nid}")
    assert strict.status_code == 200
    assert strict.json()["id"] == str(nid)
