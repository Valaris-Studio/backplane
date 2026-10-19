# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import json
import os

import pytest
from sqlalchemy import LargeBinary, delete, func, select, update

from app.models.base import Base
from app.models.notes.note import Note


def _text_bytes(size):
    blocks = [hashlib.sha256(f"note-history-block-{index}".encode()).hexdigest()
              for index in range((size + 63) // 64)]
    return "".join(blocks)[:size]


async def _seed(client, workspace, board, size=32768):
    response = await client.post(f"/api/workspaces/{workspace.slug}/boards/{board.id}/notes", json={
        "title": "Measured history", "content": {"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": _text_bytes(size)}]},
        ]},
    })
    assert response.status_code == 201, response.text
    saved = response.json()
    assert saved.get("history_revision") == 1, "Existing create must record history before storage is measured"
    return f"/api/workspaces/{workspace.slug}/notes/{saved['id']}", saved


def _storage():
    names = ("note_revisions", "note_revision_chunks", "note_revision_manifest")
    assert all(name in Base.metadata.tables for name in names), "Durable history storage is absent"
    revisions, chunks, manifest = [Base.metadata.tables[name] for name in names]
    binary = [column for column in chunks.columns if isinstance(column.type, LargeBinary)]
    assert len(binary) == 1, "Measure the actual single binary chunk payload, not estimates or text previews"
    return revisions, chunks, manifest, binary[0]


async def _metrics(db, note_id):
    import uuid

    revisions, chunks, manifest, payload = _storage()
    identity = uuid.UUID(note_id)
    result = {}
    for name, table in (("revisions", revisions), ("chunks", chunks), ("manifest_rows", manifest)):
        result[name] = await db.scalar(select(func.count()).select_from(table).where(table.c.note_id == identity))
    result["chunk_payload_bytes"] = await db.scalar(select(func.coalesce(func.sum(func.length(payload)), 0)).where(chunks.c.note_id == identity))
    result["max_chunk_bytes"] = await db.scalar(select(func.max(func.length(payload))).where(chunks.c.note_id == identity))
    # Serialized manifest rows are a portable logical-size measure, not PostgreSQL physical bytes.
    rows = (await db.execute(select(manifest).where(manifest.c.note_id == identity))).mappings().all()
    result["manifest_serialized_bytes"] = sum(len(json.dumps(dict(row), default=str, sort_keys=True).encode()) for row in rows)
    return result


async def _roundtrip_all(client, url, expected):
    for revision, (length, digest) in enumerate(expected, 1):
        response = await client.get(f"{url}/revisions/{revision}")
        assert response.status_code == 200, response.text
        content = response.json()["snapshot"]["content"].encode()
        assert len(content) == length
        assert hashlib.sha256(content).hexdigest() == digest


def _identity(content):
    value = content.encode()
    return len(value), hashlib.sha256(value).hexdigest()


@pytest.mark.slow
async def test_append_storage_shares_prefix_and_reconstructs_every_logical_revision(
    client, db_session, test_workspace, test_board,
):
    url, saved = await _seed(client, test_workspace, test_board, 65536)
    expected = [_identity(saved["content"])]
    for index in range(12):
        response = await client.post(url + "/append", json={"content": f"{index:04d}" + _text_bytes(4092)})
        assert response.status_code == 200, response.text
        expected.append(_identity(response.json()["content"]))
    metrics = await _metrics(db_session, saved["id"])
    assert metrics["revisions"] == 13
    assert metrics["max_chunk_bytes"] <= 16384
    assert metrics["chunk_payload_bytes"] <= expected[-1][0] + 12 * 16384
    assert metrics["manifest_rows"] > metrics["revisions"]
    await _roundtrip_all(client, url, expected)
    print(json.dumps({"case": "bounded_append", **metrics, "current_note_bytes": expected[-1][0]}))


async def test_metadata_only_edits_reuse_all_body_chunks_and_preserve_exact_utf8(
    client, db_session, test_workspace, test_board,
):
    url, saved = await _seed(client, test_workspace, test_board)
    body = {"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "é漢🐙\r\n" * 4096},
    ]}]}
    changed = await client.put(url, json={"content": body})
    assert changed.status_code == 200
    # Old writers may persist raw UTF-8; history must concatenate bytes before decoding.
    import uuid

    exact_utf8 = json.dumps(body, ensure_ascii=False)
    await db_session.execute(update(Note).where(Note.id == uuid.UUID(saved["id"])).values(content=exact_utf8))
    gap_edit = await client.put(url, json={"title": "After raw UTF-8 writer"})
    assert gap_edit.status_code == 200
    before = await _metrics(db_session, saved["id"])
    metadata = await client.put(url, json={"title": "Only title", "pinned": True})
    assert metadata.status_code == 200
    after = await _metrics(db_session, saved["id"])
    assert after["chunk_payload_bytes"] == before["chunk_payload_bytes"]
    assert after["chunks"] == before["chunks"]
    await _roundtrip_all(client, url, [
        _identity(saved["content"]), _identity(changed.json()["content"]),
        _identity(exact_utf8), _identity(gap_edit.json()["content"]), _identity(metadata.json()["content"]),
    ])


@pytest.mark.parametrize("damage", ["corrupt_payload", "missing_manifest"])
async def test_damaged_historical_storage_never_falls_back_to_current_note(
    damage, client, db_session, test_workspace, test_board,
):
    import uuid

    url, saved = await _seed(client, test_workspace, test_board)
    assert (await client.put(url, json={"content": "Unrelated current body"})).status_code == 200
    _, chunks, manifest, payload = _storage()
    note_id = uuid.UUID(saved["id"])
    if damage == "missing_manifest":
        await db_session.execute(delete(manifest).where(manifest.c.note_id == note_id))
    else:
        rows = (await db_session.execute(select(chunks).where(chunks.c.note_id == note_id))).mappings().all()
        for chunk in rows:
            original = bytes(chunk[payload.name])
            corrupted = bytes([original[0] ^ 1]) + original[1:]
            identity = [column == chunk[column.name] for column in chunks.primary_key.columns]
            await db_session.execute(update(chunks).where(*identity).values({payload.name: corrupted}))
    response = await client.get(url + "/revisions/1")
    assert response.status_code == 503, response.text
    assert "Unrelated current body" not in response.text
    assert "no-store" in response.headers.get("cache-control", "")


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("RUN_NOTE_HISTORY_STORAGE_MEASUREMENTS") != "1", reason="Root owns the full B03 storage qualification")
@pytest.mark.timeout(300)
@pytest.mark.parametrize("mode,iterations", [("append", 1000), ("top_edit", 200)])
async def test_full_accepted_storage_growth_fixture(
    mode, iterations, client, db_session, test_workspace, test_board, monkeypatch,
):
    from app.core import rate_limit

    # This synthetic storage measurement uses the auth-overridden fixture's IP
    # bucket: one write and one exact read per revision, not a rate-limit test.
    monkeypatch.setattr(rate_limit, "UNAUTHENTICATED_LIMIT", 2 * (iterations + 1))
    url, saved = await _seed(client, test_workspace, test_board, 1024 * 1024)
    expected = [_identity(saved["content"])]
    initial = await _metrics(db_session, saved["id"])
    source = json.loads(saved["content"])
    original_text = source["content"][0]["content"][0]["text"]
    for index in range(iterations):
        if mode == "append":
            response = await client.post(url + "/append", json={"content": f"{index:04d}" + _text_bytes(4092)})
        else:
            source["content"][0]["content"][0]["text"] = f"edit-{index:03d}:" + ("x" * (index % 80)) + original_text
            response = await client.put(url, json={"content": source})
        assert response.status_code == 200, response.text
        expected.append(_identity(response.json()["content"]))
    metrics = await _metrics(db_session, saved["id"])
    assert metrics["revisions"] == iterations + 1
    if mode == "append":
        assert metrics["chunk_payload_bytes"] <= expected[-1][0] + iterations * 16384
    else:
        assert metrics["chunk_payload_bytes"] - initial["chunk_payload_bytes"] <= iterations * (32768 + 100)
    await _roundtrip_all(client, url, expected)
    print(json.dumps({"case": mode, **metrics, "current_note_bytes": expected[-1][0],
                      "physical_postgres_bytes": "not measured by SQLite fixture"}))
