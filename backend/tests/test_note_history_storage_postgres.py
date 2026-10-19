# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio
import hashlib
import json
import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

from app import database
from app.core import rate_limit
from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.kanban.board import Board
from app.models.notes.history import NoteRevision, NoteRevisionChunk, NoteRevisionManifest
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.schemas.notes.note import NoteAppend, NoteCreate, NoteUpdate
from app.services import committed_events
from app.services.notes.note import NoteService

pytestmark = pytest.mark.slow
DATABASE_IDENTITY = ("note_history_b03_storage_20261019", "b03_test", 55446)
STORAGE_RELATIONS = (
    "notes", "note_revisions", "note_revision_chunks", "note_revision_manifest",
    "note_mutation_receipts",
)


@dataclass
class StoragePostgres:
    engine: AsyncEngine
    factory: async_sessionmaker
    client: AsyncClient
    owner_id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID
    notes_url: str
    server: dict


@pytest.fixture
async def storage_pg(monkeypatch):
    raw_url = os.environ.get("DATABASE_URL")
    assert raw_url, "Root must supply the explicit migrated disposable storage database"
    url = make_url(raw_url)
    assert url.drivername == "postgresql+asyncpg" and not url.query
    assert (url.host, url.port, url.database, url.username) == (
        "127.0.0.1", DATABASE_IDENTITY[2], DATABASE_IDENTITY[0], DATABASE_IDENTITY[1],
    ), "Refusing any database except the dedicated root-owned B03 storage fixture"
    assert os.environ.get("EVENT_BUS_BACKEND", "memory") == "memory"
    engine = create_async_engine(raw_url, hide_parameters=True, pool_size=1, max_overflow=0)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    # Keep any service-owned sessions in the same explicitly guarded database.
    monkeypatch.setattr(database, "async_session", factory)
    # Only this synthetic API readback uses an overridden identity and the IP
    # bucket. Storage qualification is not a throttle measurement (<=1012 GETs).
    monkeypatch.setattr(rate_limit, "UNAUTHENTICATED_LIMIT", 2 * (1000 + 1))
    owner_id, workspace_id, board_id = (uuid.uuid4() for _ in range(3))
    slug = "b03-storage-" + workspace_id.hex
    seeded = False
    try:
        async with factory() as db:
            assert db.bind.dialect.name == "postgresql"
            identity = (await db.execute(text(
                "SELECT current_database(), current_user, inet_server_port()"
            ))).one()
            assert tuple(identity) == DATABASE_IDENTITY
            assert (await db.execute(text("SELECT version_num FROM alembic_version"))).scalars().all() == ["125"]
            server = dict((await db.execute(text(
                "SELECT current_database() AS database, current_user AS username, "
                "inet_server_port() AS port, version() AS version, "
                "current_setting('block_size')::integer AS block_size, "
                "current_setting('default_toast_compression') AS default_toast_compression"
            ))).mappings().one())
            # Previous cases can leave allocated pages after cleanup, but no
            # visible note/history rows from other actors may enter the sample.
            for relation in STORAGE_RELATIONS:
                assert await db.scalar(text(f'SELECT count(*) FROM public."{relation}"')) == 0
        async with factory.begin() as db:
            owner = User(id=owner_id, email=f"{slug}@example.test", name="Storage owner")
            db.add(owner)
            await db.flush()
            db.add(Workspace(id=workspace_id, name="Storage measurement", slug=slug, created_by=owner_id))
            await db.flush()
            db.add_all([
                WorkspaceMember(workspace_id=workspace_id, user_id=owner_id, role=WorkspaceRole.owner),
                Board(id=board_id, workspace_id=workspace_id, created_by=owner_id,
                      name="Storage measurement", slug="storage"),
            ])
        seeded = True
        app = create_app()

        async def transaction():
            async with factory.begin() as db:
                yield db

        async def authenticated_user():
            return owner

        app.dependency_overrides[get_db] = transaction
        app.dependency_overrides[get_current_user] = authenticated_user
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            yield StoragePostgres(engine, factory, client, owner_id, workspace_id, board_id,
                                  f"/api/workspaces/{slug}/notes", server)
    finally:
        try:
            pending = committed_events._latest_dispatch.get(workspace_id)
            if pending is not None:
                await asyncio.shield(pending)
            if seeded:
                async with factory.begin() as db:
                    await db.execute(delete(Workspace).where(Workspace.id == workspace_id))
                    await db.execute(delete(User).where(User.id == owner_id))
                async with factory() as db:
                    for relation in STORAGE_RELATIONS:
                        assert await db.scalar(text(f'SELECT count(*) FROM public."{relation}"')) == 0
        finally:
            await engine.dispose()


def _text_bytes(size):
    blocks = [hashlib.sha256(f"note-history-block-{index}".encode()).hexdigest()
              for index in range((size + 63) // 64)]
    return "".join(blocks)[:size]


def _identity(content):
    encoded = content.encode("utf-8")
    return {"content_bytes": len(encoded), "content_sha256": hashlib.sha256(encoded).hexdigest()}


async def _relations(db):
    rows = await db.execute(text("""
        SELECT c.relname AS relation, c.oid::bigint AS oid,
               pg_relation_size(c.oid, 'main') AS main_heap_bytes,
               pg_relation_size(c.oid, 'fsm') AS free_space_map_bytes,
               pg_relation_size(c.oid, 'vm') AS visibility_map_bytes,
               pg_table_size(c.oid) AS table_bytes_including_toast,
               pg_indexes_size(c.oid) AS base_indexes_bytes,
               pg_total_relation_size(c.oid) AS total_relation_bytes,
               c.reltoastrelid::bigint AS toast_oid,
               CASE WHEN c.reltoastrelid <> 0 THEN pg_relation_size(c.reltoastrelid, 'main') ELSE 0 END AS toast_main_heap_bytes,
               CASE WHEN c.reltoastrelid <> 0 THEN pg_table_size(c.reltoastrelid) ELSE 0 END AS toast_table_bytes,
               CASE WHEN c.reltoastrelid <> 0 THEN pg_indexes_size(c.reltoastrelid) ELSE 0 END AS toast_indexes_bytes,
               CASE WHEN c.reltoastrelid <> 0 THEN pg_total_relation_size(c.reltoastrelid) ELSE 0 END AS toast_total_relation_bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY(CAST(:relations AS text[]))
        ORDER BY c.relname
    """), {"relations": list(STORAGE_RELATIONS)})
    result = {row["relation"]: dict(row) for row in rows.mappings()}
    assert set(result) == set(STORAGE_RELATIONS)
    block_size = await db.scalar(text("SELECT current_setting('block_size')::integer"))
    for relation in result.values():
        relation["allocated_main_heap_pages"] = relation["main_heap_bytes"] // block_size
    return result


async def _logical_and_current(db, note_id):
    result = {}
    for name, model in (("revisions", NoteRevision), ("chunks", NoteRevisionChunk),
                        ("manifest_rows", NoteRevisionManifest)):
        result[name] = await db.scalar(select(func.count()).select_from(model).where(model.note_id == note_id))
    result["chunk_payload_bytes"] = await db.scalar(select(
        func.coalesce(func.sum(func.octet_length(NoteRevisionChunk.payload)), 0)
    ).where(NoteRevisionChunk.note_id == note_id))
    result["max_chunk_payload_bytes"] = await db.scalar(select(
        func.coalesce(func.max(func.octet_length(NoteRevisionChunk.payload)), 0)
    ).where(NoteRevisionChunk.note_id == note_id))
    for label, relation in (("revision_metadata", "note_revisions"),
                            ("manifest_metadata", "note_revision_manifest"),
                            ("mutation_receipt_metadata", "note_mutation_receipts")):
        # This is the UTF-8 JSON representation of actual visible metadata rows,
        # not heap/TOAST/index allocation or an invented per-row density.
        result[label + "_json_utf8_bytes"] = await db.scalar(text(
            f'SELECT coalesce(sum(octet_length(convert_to(row_to_json(r)::text, \'UTF8\'))), 0) '
            f'FROM public."{relation}" r WHERE r.note_id = :note_id'
        ), {"note_id": note_id})
    current = dict((await db.execute(text("""
        SELECT history_revision, octet_length(content) AS logical_content_bytes,
               pg_column_size(content) AS stored_content_datum_bytes,
               octet_length(content_text) AS logical_content_text_bytes,
               pg_column_size(content_text) AS stored_content_text_datum_bytes,
               pg_column_size(n) AS row_datum_bytes
        FROM public.notes n WHERE id = :note_id
    """), {"note_id": note_id})).mappings().one())
    return {"logical_history": result, "current_row": current}


async def _snapshot(env, note_id=None):
    async with env.factory() as db:
        result = {"relations": await _relations(db)}
        if note_id is not None:
            result.update(await _logical_and_current(db, note_id))
        return result


def _source_hashes():
    backend = Path(__file__).resolve().parents[1]
    paths = (
        "app/services/notes/history_content.py", "app/services/notes/note.py",
        "app/repositories/notes/history.py", "app/models/notes/history.py",
        "alembic/versions/125_note_history.py", "app/routers/notes/history.py",
        "tests/test_note_history_storage_postgres.py",
    )
    return {path: hashlib.sha256((backend / path).read_bytes()).hexdigest() for path in paths}


@pytest.mark.skipif(os.environ.get("RUN_NOTE_HISTORY_STORAGE_POSTGRES") != "1",
                    reason="Root owns explicit full PostgreSQL storage qualification")
@pytest.mark.timeout(0)
@pytest.mark.parametrize("mode,iterations", [("append", 1000), ("top_edit", 200)])
async def test_full_accepted_note_history_physical_storage(mode, iterations, storage_pg, tmp_path):
    # This opt-in fixture measures storage without a speed-acceptance threshold.
    # The separate unchanged SQLite qualification retains its 300-second cap.
    env = storage_pg
    expected = []
    report = {
        "case": mode, "iterations_required": iterations, "server": env.server,
        "source_sha256": _source_hashes(), "last_committed_revision": 0,
        "revisions_reconstructed": 0, "status": "incomplete", "phases": {},
        "measurement_scope": {
            "transactions": "One real NoteService mutation per committed transaction; fresh session per write",
            "history_reads": "Every revision through actual FastAPI history route; overridden synthetic identity, real current membership authorization",
            "logical_metadata": "Actual visible row JSON UTF-8 lengths, separate from binary chunk payload",
            "physical": "Absolute PostgreSQL relation allocation at baseline/seed/final; table_bytes includes TOAST, total_relation_bytes includes base indexes; TOAST fields overlap these totals",
            "current_row": "pg_column_size reports the current stored datum/compression representation, not an isolated share of relation pages",
            "allocation_caveat": "Committed old tuples, page overhead, autovacuum and free-page reuse can affect allocation; cleanup does not shrink relations; no density or minimal-live-storage claim",
            "excluded_relations": "Activity/notifications and workspace/user scaffolding are not included in note-storage relation totals",
        },
    }
    started = time.perf_counter()
    receipt = tmp_path / f"note-history-postgres-storage-{mode}.json"
    try:
        report["phases"]["baseline_empty_visible_rows"] = await _snapshot(env)
        body = {"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": _text_bytes(1024 * 1024)}]},
        ]}
        async with env.factory.begin() as db:
            note = await NoteService(db).create_note(env.workspace_id,
                NoteCreate(title="Measured history", content=body), env.owner_id, env.board_id)
            assert note.history_revision == 1, "History must exist before storage is measured"
            note_id = note.id
            expected.append(_identity(note.content))
            source = json.loads(note.content)
        report["last_committed_revision"] = 1
        report["phases"]["seed"] = await _snapshot(env, note_id)
        original_text = source["content"][0]["content"][0]["text"]
        writes_started = time.perf_counter()
        for index in range(iterations):
            async with env.factory.begin() as db:
                service = NoteService(db)
                if mode == "append":
                    note = await service.append_note(note_id, env.workspace_id,
                        NoteAppend(content=f"{index:04d}" + _text_bytes(4092)), env.owner_id)
                else:
                    prefix = f"edit-{index:03d}:" + ("x" * (index % 80))
                    assert len(prefix.encode()) <= 100
                    source["content"][0]["content"][0]["text"] = prefix + original_text
                    note = await service.update_note(note_id, env.workspace_id,
                        NoteUpdate(content=source), env.owner_id)
                assert note.history_revision == index + 2
                identity = _identity(note.content)
            expected.append(identity)
            report["last_committed_revision"] = index + 2
        report["write_seconds_observed_not_a_gate"] = time.perf_counter() - writes_started
        report["phases"]["final"] = await _snapshot(env, note_id)
        final = report["phases"]["final"]["logical_history"]
        assert final["revisions"] == iterations + 1
        assert final["max_chunk_payload_bytes"] <= 16384
        assert report["phases"]["final"]["current_row"]["logical_content_bytes"] == expected[-1]["content_bytes"]
        if mode == "append":
            bound = expected[-1]["content_bytes"] + iterations * 16384
            report["payload_bound"] = {"kind": "absolute", "bytes": bound}
            assert final["chunk_payload_bytes"] <= bound
        else:
            initial_payload = report["phases"]["seed"]["logical_history"]["chunk_payload_bytes"]
            bound = iterations * (32768 + 100)
            report["payload_bound"] = {"kind": "growth_from_seed", "bytes": bound}
            assert final["chunk_payload_bytes"] - initial_payload <= bound

        url = f"{env.notes_url}/{note_id}/revisions"
        listed = []
        cursor = None
        for _ in range((iterations + 100) // 100):
            params = {"limit": 100}
            if cursor is not None:
                params["before_revision"] = cursor
            response = await env.client.get(url, params=params)
            assert response.status_code == 200, response.text
            page = response.json()
            assert page["latest_recorded_revision"] == iterations + 1
            listed.extend(row["revision"] for row in page["items"])
            next_cursor = page["next_before_revision"]
            if next_cursor is None:
                break
            assert next_cursor > 0 and (cursor is None or next_cursor < cursor)
            cursor = next_cursor
        else:
            pytest.fail("History pagination exceeded the exact retained-revision count")
        assert listed == list(range(iterations + 1, 0, -1))
        reads_started = time.perf_counter()
        for revision, identity in enumerate(expected, 1):
            response = await env.client.get(f"{url}/{revision}")
            assert response.status_code == 200, response.text
            assert "no-store" in response.headers.get("cache-control", "")
            detail = response.json()
            assert detail["revision"] == revision
            assert _identity(detail["snapshot"]["content"]) == identity
            assert {key: detail[key] for key in identity} == identity
            report["revisions_reconstructed"] = revision
        report["readback_seconds_observed_not_a_gate"] = time.perf_counter() - reads_started
        report["status"] = "passed"
    except BaseException as exc:
        report["status"] = "failed"
        report["failure_type"] = type(exc).__name__
        raise
    finally:
        report["total_seconds_observed_not_a_gate"] = time.perf_counter() - started
        report["expected_revisions"] = expected
        receipt.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"case": mode, "status": report["status"],
                          "last_committed_revision": report["last_committed_revision"],
                          "revisions_reconstructed": report["revisions_reconstructed"],
                          "receipt": str(receipt), "phases": report["phases"]}))
