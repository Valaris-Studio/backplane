# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""`notes.content_text` must be rewritten by EVERY content write path.

A path that forgets it leaves a note searchable by its old body forever — the
failure is silent, which is why each write path gets its own test here rather
than one round-trip test through the happy path.
"""
import uuid

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.notes.note import Note
from app.models.workspace import Workspace

WS_URL = "/api/workspaces/default/notes"


async def read_content_text(db: AsyncSession, note_id: str) -> str | None:
    """Re-read straight from the DB so we assert what was PERSISTED, not what
    the in-session ORM instance happens to hold.

    A scalar column select bypasses the identity map without `expire_all()`,
    which would also expire the shared fixtures the next request needs (an
    expired `test_user` makes the workspace dependency lazy-load mid-request
    and blow up under async)."""
    return await db.scalar(
        select(Note.content_text).where(Note.id == uuid.UUID(str(note_id)))
    )


async def test_create_sets_content_text(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    response = await client.post(WS_URL, json={"title": "T", "content": "hello world"})
    assert response.status_code == 201
    assert await read_content_text(db_session, response.json()["id"]) == "hello world"


async def test_create_with_empty_content_sets_empty_text(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    response = await client.post(WS_URL, json={"title": "T"})
    assert await read_content_text(db_session, response.json()["id"]) == ""


async def test_create_with_markdown_extracts_prose_not_syntax(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    response = await client.post(
        WS_URL, json={"title": "T", "content": "# Heading\n\nSome **bold** body"}
    )
    text = await read_content_text(db_session, response.json()["id"])
    assert "Heading" in text
    assert "bold" in text
    assert "#" not in text
    assert "**" not in text


async def test_update_content_rewrites_content_text(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    note_id = (await client.post(WS_URL, json={"title": "T", "content": "original body"})).json()["id"]

    await client.put(f"{WS_URL}/{note_id}", json={"content": "replaced body"})
    text = await read_content_text(db_session, note_id)
    assert text == "replaced body"
    assert "original" not in text


async def test_update_title_only_leaves_content_text_intact(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    """A title-only PUT must not blank the body text — `content` is unset, not
    empty, and the two mean different things."""
    note_id = (await client.post(WS_URL, json={"title": "T", "content": "keep me"})).json()["id"]

    await client.put(f"{WS_URL}/{note_id}", json={"title": "New title"})
    assert await read_content_text(db_session, note_id) == "keep me"


async def test_append_extends_content_text(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    note_id = (await client.post(WS_URL, json={"title": "Tracker", "content": "first entry"})).json()["id"]

    response = await client.post(f"{WS_URL}/{note_id}/append", json={"content": "second entry"})
    assert response.status_code == 200
    text = await read_content_text(db_session, note_id)
    assert "first entry" in text
    assert "second entry" in text


async def test_replace_section_rewrites_content_text(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    note_id = (
        await client.post(
            WS_URL,
            json={"title": "Tracker", "content": "## Status\n\nold status\n\n## Other\n\nkeep this"},
        )
    ).json()["id"]

    response = await client.post(
        f"{WS_URL}/{note_id}/replace-section",
        json={"anchor_heading": "Status", "content": "new status"},
    )
    assert response.status_code == 200
    text = await read_content_text(db_session, note_id)
    assert "new status" in text
    assert "old status" not in text
    assert "keep this" in text


async def test_board_note_write_paths_maintain_content_text(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    """The board router is a second entry point to the same service — it must
    not have its own, staler, write path."""
    base = f"/api/workspaces/default/boards/{test_board.id}/notes"
    note_id = (await client.post(base, json={"title": "B", "content": "board body"})).json()["id"]
    assert await read_content_text(db_session, note_id) == "board body"

    await client.post(f"{base}/{note_id}/append", json={"content": "appended"})
    assert "appended" in await read_content_text(db_session, note_id)


async def test_content_text_is_searchable_immediately_after_write(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    """The end-to-end contract: write through the API, find it by body text."""
    await client.post(WS_URL, json={"title": "Unrelated title", "content": "needle in a haystack"})

    rows = (await client.get(WS_URL, params={"q": "needle"})).json()
    assert [r["title"] for r in rows] == ["Unrelated title"]


async def test_updated_body_is_searchable_and_old_body_is_not(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    note_id = (await client.post(WS_URL, json={"title": "T", "content": "obsolete keyword"})).json()["id"]
    await client.put(f"{WS_URL}/{note_id}", json={"content": "current keyword"})

    assert (await client.get(WS_URL, params={"q": "obsolete"})).json() == []
    assert len((await client.get(WS_URL, params={"q": "current"})).json()) == 1
