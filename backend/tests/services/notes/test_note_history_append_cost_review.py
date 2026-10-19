# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import json

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, update

from app.models.notes.history import NoteRevision, NoteRevisionChunk, NoteRevisionManifest
from app.models.notes.note import Note
from app.repositories.notes.history import NoteHistoryRepository
from app.schemas.notes.note import NoteAppend, NoteCreate, NoteUpdate
from app.services.notes import history_content
from app.services.notes.history import NoteHistoryService
from app.services.notes.note import NoteService


def _text_bytes(size):
    return "".join(
        hashlib.sha256(f"append-cost-review-{index}".encode()).hexdigest()
        for index in range((size + 63) // 64)
    )[:size]


def _document(text):
    return {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": text}]},
    ]}


async def _create(service, workspace, board, user, size=65536):
    return await service.create_note(
        workspace.id, NoteCreate(title="Append work budget", content=_document(_text_bytes(size))),
        user.id, board.id,
    )


class _GearWork:
    def __init__(self, values):
        self.values = values
        self.lookups = 0

    def __getitem__(self, value):
        self.lookups += 1
        return self.values[value]


async def _assert_exact_revision(db, note, user, revision, content):
    encoded = content.encode("utf-8")
    repo = NoteHistoryRepository(db)
    manifest = await repo.get_manifest(note.id, revision)
    # The full v1 encoder is the compatibility oracle for any incremental path.
    expected_chunks = list(history_content.content_chunks(encoded))
    assert [row.position for row in manifest] == list(range(len(expected_chunks)))
    assert [row.sha256 for row in manifest] == [
        hashlib.sha256(chunk).hexdigest() for chunk in expected_chunks
    ]
    row = await repo.get(note.id, revision)
    assert row.storage_version == 1
    assert row.chunk_count == len(expected_chunks)
    assert row.content_bytes == len(encoded)
    assert row.content_sha256 == hashlib.sha256(encoded).hexdigest()
    detail = await NoteHistoryService(db).detail(note.id, revision, note.workspace_id, user.id)
    assert detail["snapshot"]["content"] == content


async def _assert_unavailable_revision(db, note, user, revision):
    with pytest.raises(HTTPException) as caught:
        await NoteHistoryService(db).detail(note.id, revision, note.workspace_id, user.id)
    assert caught.value.status_code == 503
    assert caught.value.detail == "Recorded note revision is unavailable"
    assert caught.value.headers["Cache-Control"] == "private, no-store"


async def test_append_does_not_rescan_unchanged_prefix_for_gear_boundaries(
    db_session, test_workspace, test_board, test_user, monkeypatch,
):
    service = NoteService(db_session)
    note = await _create(service, test_workspace, test_board, test_user, 256 * 1024)
    before = note.content
    gear_work = _GearWork(history_content.GEAR_VALUES)
    with monkeypatch.context() as instrumentation:
        instrumentation.setattr(history_content, "GEAR_VALUES", gear_work)
        await service.append_note(
            note.id, note.workspace_id, NoteAppend(content=_document(_text_bytes(4096))),
            test_user.id,
        )
    after = note.content

    assert note.history_revision == 2
    assert before != after
    # Append moves the closing JSON suffix; the old complete body is not a prefix.
    assert not after.startswith(before)
    assert after.startswith(before[:-2])
    await _assert_exact_revision(db_session, note, test_user, 1, before)
    await _assert_exact_revision(db_session, note, test_user, 2, after)

    added_bytes = len(after.encode("utf-8")) - len(before.encode("utf-8"))
    # At most two old 16 KiB chunks cover an EOF fragment and changed JSON suffix.
    # Full-body digests, serialization and manifest writes remain outside this bound.
    boundary_work_budget = added_bytes + 2 * 16384
    assert gear_work.lookups <= boundary_work_budget, (
        f"Append rescanned {gear_work.lookups} byte positions for gear boundaries; "
        f"only {added_bytes} new bytes and a bounded old tail need rechunking "
        f"(budget {boundary_work_budget})"
    )


@pytest.mark.parametrize("change", ["replace_prefix", "append_normalizes_old_prefix"])
async def test_record_reuses_only_byte_identical_prefix_after_canonicalization(
    change, db_session, test_workspace, test_board, test_user,
):
    service = NoteService(db_session)
    note = await _create(service, test_workspace, test_board, test_user)
    before = note.content
    if change == "replace_prefix":
        replacement = _document("Changed prefix 🐙\n" + _text_bytes(65536))
        await service.update_note(
            note.id, note.workspace_id, NoteUpdate(content=replacement), test_user.id,
        )
        assert note.history_revision == 2
        await _assert_exact_revision(db_session, note, test_user, 1, before)
        await _assert_exact_revision(db_session, note, test_user, 2, note.content)
    else:
        # A rolling old writer can leave raw UTF-8 that the next append canonicalizes.
        raw_preimage = json.dumps(_document("é漢🐙\r\n" + _text_bytes(65536)), ensure_ascii=False)
        await db_session.execute(update(Note).where(Note.id == note.id).values(content=raw_preimage))
        await service.append_note(
            note.id, note.workspace_id, NoteAppend(content="Appended after old writer"),
            test_user.id,
        )
        assert note.history_revision == 3
        assert "é漢🐙" in raw_preimage and "é漢🐙" not in note.content
        await _assert_exact_revision(db_session, note, test_user, 1, before)
        await _assert_exact_revision(db_session, note, test_user, 2, raw_preimage)
        await _assert_exact_revision(db_session, note, test_user, 3, note.content)
        gap = await NoteHistoryRepository(db_session).get(note.id, 2)
        assert gap.capture_kind == "gap_baseline"
        assert gap.actor is None


async def test_corrupt_shared_prefix_stays_explicitly_unavailable_after_append(
    db_session, test_workspace, test_board, test_user,
):
    service = NoteService(db_session)
    note = await _create(service, test_workspace, test_board, test_user)
    before = note.content
    repo = NoteHistoryRepository(db_session)
    first = (await repo.get_manifest(note.id, 1))[0]
    chunk = (await repo.get_chunks(note.id, [first.sha256]))[first.sha256]
    damaged = bytes([chunk.payload[0] ^ 1]) + chunk.payload[1:]
    await db_session.execute(update(NoteRevisionChunk).where(
        NoteRevisionChunk.note_id == note.id, NoteRevisionChunk.sha256 == first.sha256,
    ).values(payload=damaged))

    await service.append_note(
        note.id, note.workspace_id, NoteAppend(content="An otherwise valid append"), test_user.id,
    )
    assert note.history_revision == 2
    assert note.content.startswith(before[:-2])
    assert (await repo.get_manifest(note.id, 2))[0].sha256 == first.sha256
    await _assert_unavailable_revision(db_session, note, test_user, 1)
    await _assert_unavailable_revision(db_session, note, test_user, 2)

    await service.update_note(
        note.id, note.workspace_id, NoteUpdate(content="Independent replacement"), test_user.id,
    )
    assert note.history_revision == 3
    await _assert_exact_revision(db_session, note, test_user, 3, note.content)
    await _assert_unavailable_revision(db_session, note, test_user, 1)


@pytest.mark.parametrize("damage", ["missing_prefix_manifest", "unsupported_storage_version"])
async def test_append_falls_back_when_previous_manifest_cannot_be_reused(
    damage, db_session, test_workspace, test_board, test_user,
):
    service = NoteService(db_session)
    note = await _create(service, test_workspace, test_board, test_user)
    before = note.content
    if damage == "missing_prefix_manifest":
        await db_session.execute(delete(NoteRevisionManifest).where(
            NoteRevisionManifest.note_id == note.id,
            NoteRevisionManifest.revision == 1,
            NoteRevisionManifest.position == 0,
        ))
    else:
        await db_session.execute(update(NoteRevision).where(
            NoteRevision.note_id == note.id, NoteRevision.revision == 1,
        ).values(storage_version=99))

    await service.append_note(
        note.id, note.workspace_id, NoteAppend(content="Append with a conservative fallback"),
        test_user.id,
    )
    assert note.history_revision == 2
    assert note.content.startswith(before[:-2])
    await _assert_unavailable_revision(db_session, note, test_user, 1)
    await _assert_exact_revision(db_session, note, test_user, 2, note.content)
