# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Excerpt note saves on a real PostgreSQL: concurrent retries of one
client_request_id, and failures injected mid-save, observed as durable rows
and published events rather than mock calls.

EXCERPT_NOTE_TEST_DATABASE_URL names a disposable database migrated to head.
Each test creates its own synthetic users and workspace and deletes only
those, receipts included."""

import asyncio
import os
import re
import uuid
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, event, func, select, text, update

from app.core.auth import get_current_user
from app.core.event_bus import Event, event_bus
from app.database import get_db
from app.main import create_app
from app.models.activity import Activity
from app.models.agent_session import AgentSession
from app.models.companion import CompanionInstallation, CompanionProjectMapping
from app.models.kanban.board import Board
from app.models.notes.note import Note
from app.models.notifications.notification import Notification
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.schemas.companion import InstallationCreate, MappingCreate
from app.services.companion import CompanionService
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from tests.rich_capture import (
    RICH_SINCE,
    declaration,
    integration_leg_unavailable,
    rich_record,
)

pytestmark = [pytest.mark.slow, pytest.mark.usefixtures("content_storage")]

# PROPOSED receipt schema, not yet approved: table `note_save_receipts`, one
# row per (principal, client_request_id), with a `workspace_id` column naming
# the destination. Every raw-SQL coupling to it goes through these names.
RECEIPTS = "note_save_receipts"
RECEIPT_WORKSPACE_COLUMN = "workspace_id"


def database_url() -> str:
    url = os.environ.get("EXCERPT_NOTE_TEST_DATABASE_URL")
    if not url:
        integration_leg_unavailable(
            "Requires explicit disposable PostgreSQL database migrated to head"
        )
    return url


class FailAfterInsert:
    """Raise once, right after the first INSERT into `table` succeeds, while
    armed: a crash between that write and the outer commit."""

    def __init__(self, engine):
        self.table: str | None = None
        self.fired = False
        event.listen(engine.sync_engine, "after_cursor_execute", self._after)

    def arm(self, table: str) -> None:
        self.table, self.fired = table, False

    def _after(self, conn, cursor, statement, parameters, context, executemany):
        if self.table is None or self.fired:
            return
        if re.match(rf'\s*INSERT INTO "?{self.table}"?\b', statement, re.IGNORECASE):
            self.fired = True
            raise RuntimeError(f"injected failure after INSERT INTO {self.table}")


@pytest.fixture
async def pg():
    url = database_url()
    engine = create_async_engine(url, hide_parameters=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    owner_id, reader_id = uuid.uuid4(), uuid.uuid4()
    workspace_id, board_id = uuid.uuid4(), uuid.uuid4()
    slug = "excerpt-note-" + workspace_id.hex
    async with factory.begin() as db:
        owner = User(id=owner_id, email=slug + "@example.test", name="Synthetic owner")
        reader = User(
            id=reader_id, email=slug + "-reader@example.test", name="Synthetic reader"
        )
        db.add_all([owner, reader])
        await db.flush()
        db.add(
            Workspace(id=workspace_id, name="Synthetic", slug=slug, created_by=owner_id)
        )
        await db.flush()
        db.add_all(
            [
                WorkspaceMember(
                    workspace_id=workspace_id,
                    user_id=owner_id,
                    role=WorkspaceRole.owner,
                ),
                WorkspaceMember(
                    workspace_id=workspace_id,
                    user_id=reader_id,
                    role=WorkspaceRole.member,
                ),
                Board(
                    id=board_id,
                    workspace_id=workspace_id,
                    name="Synthetic board",
                    slug="synthetic",
                    created_by=owner_id,
                ),
            ]
        )
        await db.flush()
        enrollment, _ = await CompanionService(db).enroll(
            owner_id,
            InstallationCreate(
                installation_id=uuid.uuid4(), name="Synthetic", platform="linux"
            ),
        )
        mapping, _ = await CompanionService(db).create_mapping(
            owner_id,
            enrollment.installation_id,
            MappingCreate(
                workspace_id=workspace_id,
                board_id=board_id,
                root_path="/synthetic/project",
                content_level="rich",
            ),
        )
        await db.execute(
            update(CompanionProjectMapping)
            .where(CompanionProjectMapping.id == mapping.id)
            .values(rich_since=RICH_SINCE)
        )
        await db.execute(
            update(CompanionInstallation)
            .where(CompanionInstallation.id == enrollment.installation_id)
            .values(
                capture_capabilities=["rich_capture_v1"],
                capture_capabilities_at=datetime.now(timezone.utc),
            )
        )
    injector = FailAfterInsert(engine)
    app = create_app()

    async def request_transaction():
        async with factory.begin() as db:
            yield db
            if injector.table == "before_outer_commit" and not injector.fired:
                # The note, receipt, activity and actual mention already exist
                # here; request failure must roll all of them back together.
                assert (
                    await db.scalar(
                        select(func.count())
                        .select_from(Notification)
                        .where(
                            Notification.workspace_id == workspace_id,
                            Notification.category == "mention",
                        )
                    )
                    == 1
                )
                injector.fired = True
                raise RuntimeError("injected request failure before outer commit")

    async def the_owner():
        return owner

    app.dependency_overrides[get_db] = request_transaction
    app.dependency_overrides[get_current_user] = the_owner
    client = AsyncClient(
        transport=ASGITransport(app, raise_app_exceptions=False),
        base_url="http://test",
    )
    events: list[Event] = []

    async def receive(published: Event):
        events.append(published)

    unsubscribe = event_bus.subscribe(receive, workspace_id=workspace_id)
    try:
        ingested = await client.post(
            "/api/companion/ingest",
            json={
                "records": [
                    rich_record(
                        mapping.id,
                        [
                            declaration(b"first selected body", order=1),
                            declaration(b"second selected body", order=2),
                        ],
                        events=[],
                    )
                ]
            },
            headers={"Authorization": "Bearer " + enrollment.device_token},
        )
        assert ingested.status_code == 200, ingested.text
        async with factory.begin() as db:
            session_id = await db.scalar(
                select(AgentSession.id).where(AgentSession.owner_id == owner_id)
            )
        listed = await client.get(
            f"/api/workspaces/{slug}/sessions/{session_id}/contents"
        )
        assert listed.status_code == 200, listed.text
        yield {
            "factory": factory,
            "client": client,
            "injector": injector,
            "events": events,
            "workspace_id": workspace_id,
            "reader_id": reader_id,
            "notes_url": f"/api/workspaces/{slug}/boards/{board_id}/notes",
            "source": {
                "workspace_id": str(workspace_id),
                "session_id": str(session_id),
                "items": [
                    {"content_id": item["id"], "sha256": item["sha256"]}
                    for item in listed.json()["items"]
                ],
            },
        }
    finally:
        unsubscribe()
        injector.arm(None)
        await client.aclose()
        async with factory.begin() as db:
            # Explicit, so teardown assumes no ON DELETE CASCADE from receipts.
            if await db.scalar(text("SELECT to_regclass(:t)"), {"t": RECEIPTS}):
                await db.execute(
                    text(
                        f"DELETE FROM {RECEIPTS} "
                        f"WHERE {RECEIPT_WORKSPACE_COLUMN} = :workspace"
                    ),
                    {"workspace": workspace_id},
                )
            await db.execute(delete(Workspace).where(Workspace.id == workspace_id))
            await db.execute(delete(User).where(User.id.in_([owner_id, reader_id])))
        await engine.dispose()


def excerpt_save(env, *, title="Reviewed handoff", key=None) -> dict:
    return {
        "title": title,
        "content": {
            "type": "doc",
            "content": [
                {
                    "type": "codeBlock",
                    "content": [{"type": "text", "text": "first selected body"}],
                },
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "mention",
                            "attrs": {
                                "id": str(env["reader_id"]),
                                "label": "Synthetic reader",
                            },
                        }
                    ],
                },
            ],
        },
        "client_request_id": str(key or uuid.uuid4()),
        "excerpt_source": env["source"],
    }


async def durable(env) -> dict[str, int]:
    """Note, activity and mention rows committed for this workspace, read on
    a separate connection."""
    workspace_id = env["workspace_id"]
    async with env["factory"]() as observer:
        notes = await observer.scalar(
            select(func.count())
            .select_from(Note)
            .where(Note.workspace_id == workspace_id)
        )
        activities = await observer.scalar(
            select(func.count())
            .select_from(Activity)
            .where(
                Activity.workspace_id == workspace_id, Activity.entity_type == "note"
            )
        )
        mentions = await observer.scalar(
            select(func.count())
            .select_from(Notification)
            .where(
                Notification.workspace_id == workspace_id,
                Notification.category == "mention",
            )
        )
    return {"notes": notes, "activities": activities, "mentions": mentions}


async def receipt_count(env) -> int:
    async with env["factory"]() as observer:
        return await observer.scalar(
            text(
                f"SELECT count(*) FROM {RECEIPTS} "
                f"WHERE {RECEIPT_WORKSPACE_COLUMN} = :workspace"
            ),
            {"workspace": env["workspace_id"]},
        )


ONE_SAVE = {"notes": 1, "activities": 1, "mentions": 1}
NOTHING = {"notes": 0, "activities": 0, "mentions": 0}


async def settled_note_events(env) -> list[Event]:
    await asyncio.sleep(0.05)
    return [e for e in env["events"] if e.event_type.startswith("activity.note.")]


async def test_concurrent_identical_retries_save_exactly_once(pg):
    payload = excerpt_save(pg)
    responses = await asyncio.wait_for(
        asyncio.gather(
            *(pg["client"].post(pg["notes_url"], json=payload) for _ in range(8))
        ),
        60,
    )
    assert sorted(r.status_code for r in responses) == [200] * 7 + [201], [
        r.text for r in responses
    ]
    assert len({r.json()["id"] for r in responses}) == 1
    assert await durable(pg) == ONE_SAVE
    assert len(await settled_note_events(pg)) == 1
    assert len([e for e in pg["events"] if e.event_type == "notification.created"]) == 1
    assert await receipt_count(pg) == 1


async def test_a_conflicting_payload_race_has_one_winner(pg):
    key = uuid.uuid4()
    titles = ["Winner A", "Winner B"] * 4
    responses = await asyncio.wait_for(
        asyncio.gather(
            *(
                pg["client"].post(
                    pg["notes_url"], json=excerpt_save(pg, title=title, key=key)
                )
                for title in titles
            )
        ),
        60,
    )
    saved = [r for r in responses if r.status_code in (200, 201)]
    refused = [r for r in responses if r.status_code == 409]
    assert len(saved) + len(refused) == len(responses), [r.text for r in responses]
    assert len({r.json()["id"] for r in saved}) == 1
    assert len({r.json()["title"] for r in saved}) == 1
    assert {r.json()["error_code"] for r in refused} == {"client_request_conflict"}
    assert len(refused) == 4
    assert sorted(r.status_code for r in saved) == [200, 200, 200, 201]
    assert await durable(pg) == ONE_SAVE
    assert len(await settled_note_events(pg)) == 1
    assert len([e for e in pg["events"] if e.event_type == "notification.created"]) == 1
    assert await receipt_count(pg) == 1


@pytest.mark.parametrize(
    "table", ["notes", RECEIPTS, "activities", "before_outer_commit"]
)
async def test_a_failure_mid_save_leaves_no_rows_and_no_events(pg, table):
    payload = excerpt_save(pg)
    pg["injector"].arm(table)
    failed = await pg["client"].post(pg["notes_url"], json=payload)
    fired = pg["injector"].fired
    pg["injector"].arm(None)
    assert fired, f"The failure injection never reached {table}"
    assert failed.status_code == 500, failed.text
    assert await durable(pg) == NOTHING
    assert await settled_note_events(pg) == []
    assert [e for e in pg["events"] if e.event_type == "notification.created"] == []
    assert await receipt_count(pg) == 0

    recovered = await pg["client"].post(pg["notes_url"], json=payload)
    assert recovered.status_code == 201, recovered.text
    assert await durable(pg) == ONE_SAVE
    assert len(await settled_note_events(pg)) == 1
    assert len([e for e in pg["events"] if e.event_type == "notification.created"]) == 1
    assert await receipt_count(pg) == 1


async def test_the_receipt_key_is_unique_per_principal_and_request_id(pg):
    """The database, not request timing, makes concurrent saves of one key
    collapse: a unique index or primary key over exactly the principal and the
    request id, never scoped by destination (a reused key elsewhere must
    conflict)."""
    async with pg["factory"]() as observer:
        rows = (
            await observer.execute(
                text(
                    """
                    SELECT array_agg(a.attname::text ORDER BY a.attname)
                    FROM pg_index i
                    JOIN pg_class t ON t.oid = i.indrelid
                    JOIN pg_attribute a
                      ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
                    WHERE t.relname = :table AND i.indisunique
                      AND i.indpred IS NULL
                    GROUP BY i.indexrelid
                    """
                ),
                {"table": RECEIPTS},
            )
        ).scalars()
        unique_keys = [set(columns) for columns in rows]
        principal_columns = set(
            (
                await observer.execute(
                    text("""
            SELECT a.attname
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_class referenced ON referenced.oid = c.confrelid
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
            WHERE t.relname = :table AND c.contype = 'f'
              AND referenced.relname = 'users' AND a.attnotnull
        """),
                    {"table": RECEIPTS},
                )
            ).scalars()
        )
    # A human principal is a non-null users FK, whatever the column is named.
    # An unrelated surrogate id plus request id does not enforce this contract.
    assert any(
        key == {"client_request_id", principal}
        for key in unique_keys
        for principal in principal_columns
    ), (unique_keys, principal_columns)
