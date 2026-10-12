# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""One-off rewrite of stored signed media URLs (WP2 §3, Run R).

Runs against prod only after an owner-reviewed dry run, so the guarantees are
the point: dry-run writes nothing, apply needs a snapshot and a backup
reference, writes are compare-and-swap (a row edited mid-run is skipped),
`updated_at` is preserved, each batch owns its transaction, a second run finds
nothing, and --restore puts back exactly what it changed.
"""

import json
import uuid
from datetime import datetime
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.definitions.definition import Definition
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.notes.note import Note
from app.models.resources.resource import Resource, ResourceType
from app.models.user import User
from app.models.workspace import Workspace
from scripts import rewrite_signed_media_links as script

BUCKET = "prod-media"
OLD = datetime(2026, 1, 2, 3, 4, 5)


def _signed(key: str) -> str:
    return f"https://storage.googleapis.com/{BUCKET}/{key}?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=f00d"


def _doc(src: str) -> str:
    return json.dumps({"type": "doc", "content": [{"type": "image", "attrs": {"src": src}}]})


@pytest.fixture
def factory(db_engine):
    return async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture
async def seeded(factory):
    """Commit a realistic spread of rows through a session of our own (the
    script commits through its own sessions too)."""
    ids = {}
    async with factory() as db, db.begin():
        user = User(email="ops@valaris.dev", name="Ops")
        db.add(user)
        await db.flush()
        ws = Workspace(name="Acme", slug="acme", created_by=user.id)
        other = Workspace(name="Other", slug="other", created_by=user.id)
        db.add_all([ws, other])
        await db.flush()
        media_key = f"media/{ws.id}/{uuid.uuid4()}/shot.png"
        resource_key = f"{ws.id}/{uuid.uuid4()}/spec.pdf"
        resource = Resource(
            workspace_id=ws.id, resource_type=ResourceType.file, name="spec.pdf",
            gcs_path=resource_key, uploaded_by=user.id, meta={},
        )
        board = Board(
            workspace_id=ws.id, name="B", slug="b", created_by=user.id,
            description=f"legacy markdown ![x]({_signed(media_key)})", updated_at=OLD,
        )
        db.add_all([resource, board])
        await db.flush()
        column = Column(board_id=board.id, name="Todo", position=1024.0)
        db.add(column)
        await db.flush()
        card = Card(
            board_id=board.id, column_id=column.id, title="c", position=1024.0,
            created_by=user.id, description=_doc(_signed(resource_key)), updated_at=OLD,
        )
        note = Note(
            workspace_id=ws.id, board_id=board.id, title="n", created_by=user.id,
            content=_doc(_signed(media_key)), updated_at=OLD,
        )
        untouched = Note(
            workspace_id=ws.id, title="plain", created_by=user.id,
            content=_doc("https://example.com/cat.png"), updated_at=OLD,
        )
        cross = Note(
            workspace_id=other.id, title="pasted", created_by=user.id,
            content=_doc(_signed(media_key)), updated_at=OLD,
        )
        definition = Definition(
            board_id=board.id, workspace_id=ws.id, updated_by=user.id,
            scope=_doc(_signed(media_key)),
            content={
                "objective": "ship",
                "decisions": [
                    {"decision": "a", "rationale": "plain"},
                    {"decision": "b", "rationale": _doc(_signed(resource_key))},
                ],
            },
            updated_at=OLD,
        )
        activity = Activity(
            workspace_id=ws.id, actor_id=user.id, entity_type=ActivityEntityType.note,
            entity_id=uuid.uuid4(), action=ActivityAction.updated, summary="s",
            message_params={"src": _signed(media_key)},
        )
        db.add_all([card, note, untouched, cross, definition, activity])
        await db.flush()
        ids.update(
            ws=ws.id, other=other.id, board=board.id, card=card.id, note=note.id,
            untouched=untouched.id, cross=cross.id, definition=definition.id,
            resource=resource.id, media_key=media_key,
        )
    return ids


async def _fetch(factory, model, pk):
    async with factory() as db:
        return (await db.execute(select(model).where(model.id == pk))).scalar_one()


async def test_dry_run_reports_changes_and_writes_nothing(factory, seeded):
    before = (await _fetch(factory, Note, seeded["note"])).content

    discovery = await script.discover(factory, bucket=BUCKET)

    by_table = {}
    for change in discovery.changes:
        by_table[f"{change.table}.{change.column}"] = by_table.get(f"{change.table}.{change.column}", 0) + 1
    assert by_table == {
        "notes.content": 1,
        "cards.description": 1,
        "boards.description": 1,
        "definitions.scope": 1,
        "definitions.content": 1,
    }
    assert [u.reason for u in discovery.unmapped] == ["cross_workspace"]
    assert discovery.report_only_hits["activities.message_params"] == 1
    assert (await _fetch(factory, Note, seeded["note"])).content == before


async def test_apply_rewrites_preserves_updated_at_and_persists(factory, seeded, tmp_path: Path):
    discovery = await script.discover(factory, bucket=BUCKET)
    snapshot = tmp_path / "snap.jsonl"
    script.write_snapshot(str(snapshot), discovery.changes, backup_ref="backup-123")

    result = await script.apply_changes(factory, discovery.changes, batch_size=2)

    assert (result.applied, result.skipped) == (5, 0)
    ws = seeded["ws"]
    note = await _fetch(factory, Note, seeded["note"])
    assert json.loads(note.content)["content"][0]["attrs"]["src"].startswith("/api/workspaces/acme/media/")
    assert note.updated_at.replace(tzinfo=None) == OLD
    card = await _fetch(factory, Card, seeded["card"])
    assert f"/api/workspaces/acme/resources/{seeded['resource']}/content" in card.description
    board = await _fetch(factory, Board, seeded["board"])
    assert board.description.startswith("legacy markdown ![x](/api/workspaces/acme/media/")
    definition = await _fetch(factory, Definition, seeded["definition"])
    assert "X-Goog" not in definition.scope
    assert "X-Goog" not in json.dumps(definition.content)
    assert definition.content["objective"] == "ship"
    assert definition.updated_at.replace(tzinfo=None) == OLD
    cross = await _fetch(factory, Note, seeded["cross"])
    assert "X-Goog-Signature" in cross.content
    assert ws  # rewritten rows above belong to the seeded workspace

    rerun = await script.discover(factory, bucket=BUCKET)
    assert rerun.changes == []


async def test_apply_skips_row_edited_after_discovery(factory, seeded):
    discovery = await script.discover(factory, bucket=BUCKET)
    async with factory() as db, db.begin():
        await db.execute(update(Note).where(Note.id == seeded["note"]).values(content="edited by a human"))

    result = await script.apply_changes(factory, discovery.changes)

    assert result.skipped == 1
    assert result.applied == 4
    assert (await _fetch(factory, Note, seeded["note"])).content == "edited by a human"


async def test_restore_round_trips_and_spares_later_edits(factory, seeded, tmp_path: Path):
    originals = {
        "note": (await _fetch(factory, Note, seeded["note"])).content,
        "board": (await _fetch(factory, Board, seeded["board"])).description,
        "definition": (await _fetch(factory, Definition, seeded["definition"])).content,
    }
    discovery = await script.discover(factory, bucket=BUCKET)
    snapshot = tmp_path / "snap.jsonl"
    script.write_snapshot(str(snapshot), discovery.changes, backup_ref="backup-123")
    await script.apply_changes(factory, discovery.changes)
    async with factory() as db, db.begin():
        await db.execute(update(Board).where(Board.id == seeded["board"]).values(description="newer edit"))

    dry = await script.restore(factory, str(snapshot), apply=False)
    assert (await _fetch(factory, Note, seeded["note"])).content != originals["note"]
    result = await script.restore(factory, str(snapshot), apply=True)

    assert dry.applied == 0
    assert (result.applied, result.skipped) == (4, 1)
    assert (await _fetch(factory, Note, seeded["note"])).content == originals["note"]
    assert (await _fetch(factory, Definition, seeded["definition"])).content == originals["definition"]
    assert (await _fetch(factory, Board, seeded["board"])).description == "newer edit"
    assert (await _fetch(factory, Note, seeded["note"])).updated_at.replace(tzinfo=None) == OLD


async def test_snapshot_lines_carry_everything_restore_needs(factory, seeded, tmp_path: Path):
    discovery = await script.discover(factory, bucket=BUCKET)
    snapshot = tmp_path / "snap.jsonl"
    script.write_snapshot(str(snapshot), discovery.changes, backup_ref="backup-123")

    lines = [json.loads(line) for line in snapshot.read_text().splitlines()]

    assert lines[0] == {"kind": "header", "backup_ref": "backup-123", "rows": 5}
    assert {"table", "pk", "column", "before", "after", "updated_at"} <= set(lines[1])


async def test_snapshot_refuses_to_overwrite(tmp_path: Path):
    snapshot = tmp_path / "snap.jsonl"
    snapshot.write_text("keep me")

    with pytest.raises(FileExistsError):
        script.write_snapshot(str(snapshot), [], backup_ref="b")
    assert snapshot.read_text() == "keep me"


async def test_main_apply_requires_snapshot_and_backup_ref(factory, seeded, tmp_path: Path):
    with pytest.raises(SystemExit):
        await script.run(script.parse_args(["--apply", "--bucket", BUCKET]), factory)
    with pytest.raises(SystemExit):
        await script.run(
            script.parse_args(["--apply", "--bucket", BUCKET, "--snapshot", str(tmp_path / "s.jsonl")]),
            factory,
        )
    assert "X-Goog-Signature" in (await _fetch(factory, Note, seeded["note"])).content


async def test_main_apply_writes_nothing_when_snapshot_fails(factory, seeded, tmp_path: Path):
    unwritable = tmp_path / "missing-dir" / "s.jsonl"

    with pytest.raises(OSError):
        await script.run(
            script.parse_args(
                ["--apply", "--bucket", BUCKET, "--snapshot", str(unwritable), "--backup-ref", "b"]
            ),
            factory,
        )
    assert "X-Goog-Signature" in (await _fetch(factory, Note, seeded["note"])).content


async def test_main_end_to_end_apply_then_dry_run_is_zero(factory, seeded, tmp_path: Path, capsys):
    snapshot = tmp_path / "s.jsonl"
    code = await script.run(
        script.parse_args(["--apply", "--bucket", BUCKET, "--snapshot", str(snapshot), "--backup-ref", "b"]),
        factory,
    )
    assert code == 0

    code = await script.run(script.parse_args(["--bucket", BUCKET]), factory)
    out = capsys.readouterr().out
    assert code == 0
    assert "changes: 0" in out


async def test_dry_run_is_the_default(factory, seeded, capsys):
    code = await script.run(script.parse_args(["--bucket", BUCKET]), factory)

    assert code == 0
    assert "DRY RUN" in capsys.readouterr().out
    assert "X-Goog-Signature" in (await _fetch(factory, Note, seeded["note"])).content


async def test_absolute_own_origin_stable_links_are_made_relative(factory, seeded, tmp_path: Path):
    """Uploads made between the PR-A and PR-B deploys stored
    `origin + stable path`; only the app's own origins are stripped."""
    stable = f"/api/workspaces/acme/media/{uuid.uuid4()}/late.png"
    foreign = "https://elsewhere.example" + stable
    async with factory() as db, db.begin():
        user_id = (await db.execute(select(User.id))).scalars().first()
        note = Note(
            workspace_id=seeded["ws"], title="gap", created_by=user_id, updated_at=OLD,
            content=json.dumps({"type": "doc", "content": [
                {"type": "image", "attrs": {"src": "https://app.example.test" + stable}},
                {"type": "image", "attrs": {"src": foreign}},
            ]}),
        )
        db.add(note)
        await db.flush()
        note_id = note.id

    without_origin = await script.discover(factory, bucket=BUCKET, app_origins=frozenset())
    assert note_id not in {uuid.UUID(c.pk) for c in without_origin.changes}

    code = await script.run(
        script.parse_args([
            "--apply", "--bucket", BUCKET, "--app-origin", "https://app.example.test",
            "--snapshot", str(tmp_path / "s.jsonl"), "--backup-ref", "b",
        ]),
        factory,
    )

    assert code == 0
    stored = json.loads((await _fetch(factory, Note, note_id)).content)["content"]
    assert [n["attrs"]["src"] for n in stored] == [stable, foreign]
    assert (await _fetch(factory, Note, note_id)).updated_at.replace(tzinfo=None) == OLD
