# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import json
import os
import uuid
from dataclasses import dataclass

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, insert, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.notes.history import (
    NoteMutationReceipt, NoteRevision, NoteRevisionChunk, NoteRevisionManifest,
)
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.repositories.notes.history import NoteHistoryRepository
from app.schemas.notes.note import NoteCreate, NoteEdit
from app.services.notes.history_content import revision_digest, snapshot
from app.services.notes.note import NoteService

pytestmark = pytest.mark.slow


@dataclass
class DeletionPlanFixture:
    db: AsyncSession
    client: AsyncClient
    owner: User
    workspace: Workspace


@pytest.fixture
async def deletion_plan_pg():
    raw_url = os.environ.get("DATABASE_URL")
    if not raw_url:
        pytest.skip("Root-owned disposable PostgreSQL is required for this plan regression")
    url = make_url(raw_url)
    assert url.drivername == "postgresql+asyncpg"
    assert (url.host, url.port, url.database, url.username) == (
        "127.0.0.1", 55446, "note_history_b03_20261018", "b03_test",
    ), "Refusing any database except the dedicated B03 fixture"
    engine = create_async_engine(raw_url, hide_parameters=True, connect_args={
        "server_settings": {"statement_timeout": "5000", "lock_timeout": "4000"},
    })
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory() as db:
            await db.begin()
            try:
                identity = (await db.execute(text(
                    "SELECT current_database(), current_user, inet_server_port()"
                ))).one()
                assert tuple(identity) == ("note_history_b03_20261018", "b03_test", 55446)
                assert db.bind.dialect.name == "postgresql"
                fixture_id = uuid.uuid4().hex
                owner = User(email=f"deletion-plan-{fixture_id}@example.test", name="History owner")
                db.add(owner)
                await db.flush()
                workspace = Workspace(
                    name="History deletion plan", slug=f"deletion-plan-{fixture_id}", created_by=owner.id,
                )
                db.add(workspace)
                await db.flush()
                db.add(WorkspaceMember(
                    workspace_id=workspace.id, user_id=owner.id, role=WorkspaceRole.owner,
                ))
                await db.flush()
                app = create_app()

                async def transaction():
                    yield db

                async def authenticated_user():
                    return owner

                app.dependency_overrides[get_db] = transaction
                app.dependency_overrides[get_current_user] = authenticated_user
                async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
                    yield DeletionPlanFixture(db, client, owner, workspace)
            finally:
                # Includes all synthetic identities, rows, plan DELETEs and lifecycle activity.
                await db.rollback()
    finally:
        await engine.dispose()


def _large_body():
    value = "".join(
        hashlib.sha256(f"deletion-plan-block-{index}".encode()).hexdigest()
        for index in range(16384)
    )
    return {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": value}]},
    ]}


async def _seed_representative_history(env):
    service = NoteService(env.db)
    note = await service.create_note(
        env.workspace.id, NoteCreate(title="Metadata revision 1", content=_large_body()), env.owner.id,
    )
    repo = NoteHistoryRepository(env.db)
    first = await repo.get(note.id, 1, with_snapshot=True)
    manifest = await repo.get_manifest(note.id, 1)
    value = snapshot(note)
    revisions, references = [], []
    # Seed valid metadata-only revisions over the real service's exact v1 chunks;
    # this measures the FK shape without rerunning a 1000-write growth fixture.
    for sequence in range(2, 64):
        value = {**value, "title": f"Metadata revision {sequence}"}
        revisions.append({
            "note_id": note.id, "revision": sequence, "capture_kind": "edit",
            "operation": "replace", "changed_fields": ["title"],
            "content_bytes": first.content_bytes, "content_sha256": first.content_sha256,
            "revision_digest": revision_digest(value), "storage_version": first.storage_version,
            "chunk_count": first.chunk_count, "title": value["title"], "pinned": value["pinned"],
            "card_id": None, "kind": value["kind"], "source_execution_id": None,
            "failure_class": None, "findings": None, "actor": first.actor, "invocation_id": None,
        })
        references.extend({
            "note_id": note.id, "revision": sequence, "position": row.position, "sha256": row.sha256,
        } for row in manifest)
    await env.db.execute(insert(NoteRevision), revisions)
    for start in range(0, len(references), 500):
        await env.db.execute(insert(NoteRevisionManifest), references[start:start + 500])
    note.title, note.history_revision = value["title"], 63
    await env.db.flush()
    await service.edit_note(note.id, env.workspace.id, NoteEdit(
        mode="replace", title="Metadata revision 64", client_request_id=uuid.uuid4(),
    ), env.owner.id)
    assert note.history_revision == 64
    control = await service.create_note(
        env.workspace.id, NoteCreate(title="Unrelated note", content="Must survive the other deletion"),
        env.owner.id,
    )
    return note, control, manifest[len(manifest) // 2].sha256


def _heap_scans(plan):
    if (plan.get("Relation Name") == "note_revision_manifest"
            and plan.get("Node Type") in {"Seq Scan", "Index Scan", "Index Only Scan", "Bitmap Heap Scan"}):
        yield plan
    for child in plan.get("Plans", []):
        yield from _heap_scans(child)


async def _history_counts(db, note_id):
    return {
        model.__tablename__: await db.scalar(
            select(func.count()).select_from(model).where(model.note_id == note_id)
        )
        for model in (NoteRevision, NoteRevisionChunk, NoteRevisionManifest, NoteMutationReceipt)
    }


async def test_note_deletion_chunk_lookup_examines_only_bounded_matching_references(
    deletion_plan_pg, tmp_path, record_property,
):
    env = deletion_plan_pg
    note, control, digest = await _seed_representative_history(env)
    counts = await _history_counts(env.db, note.id)
    assert counts["note_revisions"] == 64
    assert all(count > 0 for count in counts.values())
    assert counts["note_revision_manifest"] >= 4096
    payload_bytes = await env.db.scalar(select(func.sum(NoteRevisionChunk.content_bytes)).where(
        NoteRevisionChunk.note_id == note.id,
    ))
    assert payload_bytes >= 1024 * 1024
    matching_rows = await env.db.scalar(select(func.count()).select_from(NoteRevisionManifest).where(
        NoteRevisionManifest.note_id == note.id, NoteRevisionManifest.sha256 == digest,
    ))
    assert matching_rows == 64
    constraints = (await env.db.execute(text(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE contype = 'f' AND conrelid = 'note_revision_manifest'::regclass "
        "AND confrelid = 'note_revision_chunks'::regclass"
    ))).scalars().all()
    assert len(constraints) == 1
    assert constraints[0].startswith("FOREIGN KEY (note_id, sha256)")
    assert "ON DELETE CASCADE" in constraints[0]

    savepoint = await env.db.begin_nested()
    try:
        raw_plan = (await env.db.execute(text(
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "
            "DELETE FROM ONLY note_revision_manifest WHERE note_id = :note_id AND sha256 = :digest"
        ), {"note_id": note.id, "digest": digest})).scalar_one()
        plan = json.loads(raw_plan) if isinstance(raw_plan, str) else raw_plan
    finally:
        await savepoint.rollback()
    scans = list(_heap_scans(plan[0]["Plan"]))
    assert scans, plan
    examined_rows = sum(
        (scan["Actual Rows"] + scan.get("Rows Removed by Filter", 0)
         + scan.get("Rows Removed by Index Recheck", 0)) * scan["Actual Loops"]
        for scan in scans
    )
    assert examined_rows >= matching_rows > 0
    receipt = {
        "case": "manifest_chunk_fk_delete", "counts": counts, "payload_bytes": payload_bytes,
        "matching_rows": matching_rows, "examined_rows": examined_rows,
        "examined_row_budget": 4 * matching_rows, "constraint": constraints[0], "plan": plan,
    }
    (tmp_path / "manifest-fk-delete-plan.json").write_text(json.dumps(receipt, indent=2))
    record_property("manifest_fk_delete_plan", json.dumps(receipt))
    print(json.dumps(receipt, sort_keys=True))

    # The EXPLAIN really deletes rows; its savepoint rollback must restore all of them.
    assert await _history_counts(env.db, note.id) == counts
    control_counts = await _history_counts(env.db, control.id)
    deleted = await env.client.delete(f"/api/workspaces/{env.workspace.slug}/notes/{note.id}")
    assert deleted.status_code == 204, deleted.text
    assert all(count == 0 for count in (await _history_counts(env.db, note.id)).values())
    assert await _history_counts(env.db, control.id) == control_counts
    surviving = await env.client.get(
        f"/api/workspaces/{env.workspace.slug}/notes/{control.id}/revisions/1"
    )
    assert surviving.status_code == 200, surviving.text
    assert surviving.json()["snapshot"]["content"] == control.content
    print(json.dumps({"case": "authorized_note_deletion", "all_history_removed": True,
                      "unrelated_history_preserved": True, "outer_transaction": "rollback at teardown"}))
    assert examined_rows <= 4 * matching_rows, (
        f"One chunk's FK cascade examined {examined_rows} manifest rows to delete "
        f"{matching_rows} matching references; unrelated references dominate deletion work"
    )
