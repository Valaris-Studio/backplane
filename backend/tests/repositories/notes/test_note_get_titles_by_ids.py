# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Batch note-title lookup for activity entity_title enrichment.

`get_titles_by_ids` resolves a set of note UUIDs to {id: title} in a single
scalar tuple-select, mirroring CardRepository.get_refs_by_ids.
"""
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notes.note import Note
from app.repositories.notes.note import NoteRepository


async def test_get_titles_by_ids_returns_titles(
    db_session: AsyncSession, test_note: Note
):
    repo = NoteRepository(db_session)
    titles = await repo.get_titles_by_ids({test_note.id})
    assert titles == {test_note.id: test_note.title}


async def test_get_titles_by_ids_empty_input_returns_empty_no_query(
    db_session: AsyncSession,
):
    repo = NoteRepository(db_session)
    assert await repo.get_titles_by_ids(set()) == {}


async def test_get_titles_by_ids_omits_missing_ids(
    db_session: AsyncSession, test_note: Note
):
    repo = NoteRepository(db_session)
    ghost = uuid.uuid4()
    titles = await repo.get_titles_by_ids({test_note.id, ghost})
    assert test_note.id in titles
    assert ghost not in titles
