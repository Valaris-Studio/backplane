# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Rich capture on a real PostgreSQL migrated to 119 or later: row locks,
counter arithmetic, cascades and constraints that SQLite cannot show.

SESSION_CAPTURE_TEST_DATABASE_URL names a database on a disposable server.
The tests create synthetic users/workspaces and delete only those; the
migration test creates its own uniquely named database on that server, which
goes with the server. Run this file serially (no -n): the purge it drives
processes every pending deletion in the database."""

import asyncio
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.agent_session import (
    AgentSession,
    AgentSessionCaptureGeneration,
    AgentSessionContent,
    AgentSessionContentDeletion,
)
from app.models.companion import CompanionInstallation, CompanionProjectMapping
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.schemas.companion import InstallationCreate, MappingCreate
from app.services.companion import CompanionService
from app.services.session_retention import SessionRetentionService
from tests.test_migration_119_session_contents import (
    CAPTURE_LEVELS_ROLLBACK,
    LAST_STATUS_ROLLBACK,
)
from tests.rich_capture import (
    RICH_SINCE,
    declaration,
    integration_leg_unavailable,
    rich_record,
    sha256,
)

pytestmark = [pytest.mark.slow, pytest.mark.usefixtures("content_storage")]
CONTENTS = "/api/companion/contents"


def database_url() -> str:
    url = os.environ.get("SESSION_CAPTURE_TEST_DATABASE_URL")
    if not url:
        integration_leg_unavailable(
            "Requires explicit disposable migrated PostgreSQL database"
        )
    return url


@pytest.fixture
async def pg():
    url = database_url()
    engine = create_async_engine(url, hide_parameters=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    owner_id, workspace_id, board_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    slug = "rich-capture-" + workspace_id.hex
    async with factory.begin() as db:
        version = await db.scalar(text("select version_num from alembic_version"))
        assert int(version) >= 119
        owner = User(id=owner_id, email=slug + "@example.test", name="Synthetic owner")
        db.add(owner)
        await db.flush()
        db.add(
            Workspace(id=workspace_id, name="Synthetic", slug=slug, created_by=owner_id)
        )
        await db.flush()
        db.add(
            WorkspaceMember(
                workspace_id=workspace_id, user_id=owner_id, role=WorkspaceRole.owner
            )
        )
        db.add(
            Board(
                id=board_id,
                workspace_id=workspace_id,
                name="Synthetic board",
                slug="synthetic",
                created_by=owner_id,
            )
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
    app = create_app()

    async def request_transaction():
        async with factory.begin() as db:
            yield db

    async def the_owner():
        return owner

    app.dependency_overrides[get_db] = request_transaction
    app.dependency_overrides[get_current_user] = the_owner
    client = AsyncClient(transport=ASGITransport(app), base_url="http://test")
    try:
        yield {
            "factory": factory,
            "client": client,
            "owner_id": owner_id,
            "workspace_id": workspace_id,
            "slug": slug,
            "installation_id": enrollment.installation_id,
            "mapping_id": mapping.id,
            "headers": {"Authorization": "Bearer " + enrollment.device_token},
        }
    finally:
        await client.aclose()
        async with factory.begin() as db:
            await db.execute(
                delete(AgentSessionContentDeletion).where(
                    AgentSessionContentDeletion.storage_prefix.like(
                        f"%/{enrollment.installation_id}/%"
                    )
                )
            )
            await db.execute(delete(Workspace).where(Workspace.id == workspace_id))
            await db.execute(delete(User).where(User.id == owner_id))
        await engine.dispose()


async def post_batch(env, records):
    response = await env["client"].post(
        "/api/companion/ingest", json={"records": records}, headers=env["headers"]
    )
    assert response.status_code == 200, response.text
    return response.json()


async def installation_bytes(env) -> int:
    async with env["factory"].begin() as db:
        return await db.scalar(
            select(CompanionInstallation.content_bytes).where(
                CompanionInstallation.id == env["installation_id"]
            )
        )


def session_record(env, native_session: str, contents, **overrides):
    return rich_record(
        env["mapping_id"],
        contents,
        events=[],
        native_session_id=native_session,
        **overrides,
    )


async def test_ingest_upload_finalize_and_read_round_trip(pg):
    body = ("ü" * 30_000).encode()
    [ack] = (
        await post_batch(
            pg, [session_record(pg, "pg-1", [declaration(body, delivery="upload")])]
        )
    )["contents"]
    chunk = await pg["client"].put(
        f"{CONTENTS}/{ack['content_id']}/chunks/0",
        content=body,
        headers={
            **pg["headers"],
            "Content-Type": "application/octet-stream",
            "Backplane-Chunk-SHA256": sha256(body),
        },
    )
    assert chunk.status_code == 200, chunk.text
    final = await pg["client"].post(
        f"{CONTENTS}/{ack['content_id']}/finalize",
        json={"byte_count": len(body), "sha256": sha256(body)},
        headers=pg["headers"],
    )
    assert final.json()["state"] == "available", final.text
    async with pg["factory"].begin() as db:
        session_id = await db.scalar(
            select(AgentSession.id).where(AgentSession.owner_id == pg["owner_id"])
        )
    base = f"/api/workspaces/{pg['slug']}/sessions/{session_id}/contents"
    page = await pg["client"].get(f"{base}/{ack['content_id']}/body")
    assert page.json()["text"] == body.decode()
    assert await installation_bytes(pg) == len(body)


async def test_concurrent_batches_of_one_device_never_deadlock_or_lose_bytes(pg):
    """Each batch locks its sessions, then the device row; overlapping
    batches over the same sessions serialize instead of deadlocking."""
    sessions = [f"pg-concurrent-{index}" for index in range(4)]

    def batch(order):
        return [
            session_record(pg, name, [declaration(f"{name}-{uuid.uuid4()}".encode())])
            for name in order
        ]

    results = await asyncio.wait_for(
        asyncio.gather(
            *(post_batch(pg, batch(sessions)) for _ in range(3)),
            *(post_batch(pg, batch(list(reversed(sessions)))) for _ in range(3)),
        ),
        60,
    )
    for result in results:
        assert result["rejected"] == []
        assert {ack["outcome"] for ack in result["contents"]} == {"available"}
    async with pg["factory"].begin() as db:
        total = await db.scalar(
            select(func.sum(AgentSession.content_bytes)).where(
                AgentSession.installation_id == pg["installation_id"]
            )
        )
        stored = await db.scalar(
            select(func.sum(AgentSessionContent.byte_count)).where(
                AgentSessionContent.installation_id == pg["installation_id"]
            )
        )
    assert total == stored
    assert await installation_bytes(pg) == total


async def queued_for(env) -> int:
    async with env["factory"].begin() as db:
        return await db.scalar(
            select(func.count())
            .select_from(AgentSessionContentDeletion)
            .where(
                AgentSessionContentDeletion.storage_prefix.like(
                    f"%/{env['installation_id']}/%"
                )
            )
        )


async def put_body(env, content_id, body: bytes):
    response = await env["client"].put(
        f"{CONTENTS}/{content_id}/chunks/0",
        content=body,
        headers={
            **env["headers"],
            "Content-Type": "application/octet-stream",
            "Backplane-Chunk-SHA256": sha256(body),
        },
    )
    assert response.status_code == 200, response.text


async def finalize(env, content_id, body: bytes):
    return await env["client"].post(
        f"{CONTENTS}/{content_id}/finalize",
        json={"byte_count": len(body), "sha256": sha256(body)},
        headers=env["headers"],
    )


async def declared_upload(env, native_session: str, body: bytes) -> str:
    [ack] = (
        await post_batch(
            env,
            [
                session_record(
                    env, native_session, [declaration(body, delivery="upload")]
                )
            ],
        )
    )["contents"]
    assert ack["outcome"] == "upload_required", ack
    return ack["content_id"]


async def test_a_delete_racing_inline_ingests_leaves_counters_exact(pg):
    await post_batch(pg, [session_record(pg, "pg-race", [declaration(b"seed")])])
    async with pg["factory"].begin() as db:
        session_id = await db.scalar(
            select(AgentSession.id).where(
                AgentSession.installation_id == pg["installation_id"],
                AgentSession.native_session_id == "pg-race",
            )
        )
    path = f"/api/workspaces/{pg['slug']}/sessions/{session_id}"
    await asyncio.wait_for(
        asyncio.gather(
            pg["client"].delete(path),
            *(
                post_batch(
                    pg,
                    [
                        session_record(
                            pg, "pg-race", [declaration(f"r{i}".encode() * 50)]
                        )
                    ],
                )
                for i in range(4)
            ),
        ),
        60,
    )
    async with pg["factory"].begin() as db:
        remaining = await db.scalar(
            select(func.coalesce(func.sum(AgentSession.content_bytes), 0)).where(
                AgentSession.installation_id == pg["installation_id"]
            )
        )
    assert await installation_bytes(pg) == remaining
    assert await queued_for(pg) >= 1


async def test_the_installation_quota_overshoots_by_at_most_one_batch(pg):
    """The device total is checked against the value each batch read and
    applied once per batch, atomically: N concurrent batches may overshoot the
    limit by at most N - 1 batches, and never lose an update."""
    limit = 10 << 30
    async with pg["factory"].begin() as db:
        await db.execute(
            update(CompanionInstallation)
            .where(CompanionInstallation.id == pg["installation_id"])
            .values(content_bytes=limit - 1000)
        )
    batches, batch_bytes = 4, 4 * 600
    await asyncio.wait_for(
        asyncio.gather(
            *(
                post_batch(
                    pg,
                    [
                        session_record(
                            pg,
                            f"pg-quota-{batch}",
                            [declaration(b"q" * 600) for _ in range(4)],
                        )
                    ],
                )
                for batch in range(batches)
            )
        ),
        60,
    )
    async with pg["factory"].begin() as db:
        sessions = await db.scalar(
            select(func.coalesce(func.sum(AgentSession.content_bytes), 0)).where(
                AgentSession.installation_id == pg["installation_id"]
            )
        )
    total = await installation_bytes(pg)
    assert total == limit - 1000 + sessions
    assert total <= limit + (batches - 1) * batch_bytes


async def test_concurrent_finalizes_of_one_upload_settle_it_once(pg):
    body = b"f" * 30_000
    content_id = await declared_upload(pg, "pg-finalize", body)
    await put_body(pg, content_id, body)
    answers = await asyncio.wait_for(
        asyncio.gather(*(finalize(pg, content_id, body) for _ in range(3))), 60
    )
    for answer in answers:
        assert answer.status_code == 200, answer.text
        assert answer.json()["state"] == "available"
    async with pg["factory"].begin() as db:
        session = await db.scalar(
            select(AgentSession).where(
                AgentSession.installation_id == pg["installation_id"]
            )
        )
    assert session.content_bytes == len(body)
    assert await installation_bytes(pg) == len(body)


async def test_a_finalize_racing_an_owner_delete_leaves_no_body(pg, content_storage):
    body = b"x" * 30_000
    content_id = await declared_upload(pg, "pg-finalize-delete", body)
    await put_body(pg, content_id, body)
    async with pg["factory"].begin() as db:
        session_id = await db.scalar(
            select(AgentSession.id).where(
                AgentSession.installation_id == pg["installation_id"]
            )
        )
    await asyncio.wait_for(
        asyncio.gather(
            finalize(pg, content_id, body),
            pg["client"].delete(f"/api/workspaces/{pg['slug']}/sessions/{session_id}"),
        ),
        60,
    )
    await SessionRetentionService(pg["factory"]).run_purge()
    async with pg["factory"].begin() as db:
        assert await db.get(AgentSessionContent, uuid.UUID(content_id)) is None
    assert not any(content_storage.rglob("body"))
    assert await installation_bytes(pg) == 0


async def test_reconciliation_after_a_workspace_cascade_and_the_staging_sweep(pg):
    """R2-7 on PostgreSQL, with the purge's own transactions and lock."""
    await post_batch(
        pg,
        [
            session_record(
                pg, "pg-sweep", [declaration(b"z" * 20_000, delivery="upload")]
            )
        ],
    )
    async with pg["factory"].begin() as db:
        await db.execute(
            update(AgentSessionContent)
            .where(AgentSessionContent.installation_id == pg["installation_id"])
            .values(upload_expires_at=datetime.now(timezone.utc) - timedelta(seconds=1))
        )
    await SessionRetentionService(pg["factory"]).run_purge()
    async with pg["factory"].begin() as db:
        expired = await db.scalar(
            select(AgentSessionContent).where(
                AgentSessionContent.installation_id == pg["installation_id"]
            )
        )
        assert (expired.state, expired.coverage) == ("recorded", "expired")
    assert await installation_bytes(pg) == 0

    await post_batch(pg, [session_record(pg, "pg-cascade", [declaration(b"k" * 900)])])
    assert await installation_bytes(pg) == 900
    async with pg["factory"].begin() as db:
        await db.execute(delete(Workspace).where(Workspace.id == pg["workspace_id"]))
    assert await installation_bytes(pg) == 900
    await SessionRetentionService(pg["factory"]).run_purge()
    assert await installation_bytes(pg) == 0


async def test_constraints_hold_on_postgresql(pg):
    async with pg["factory"].begin() as db:
        await db.execute(
            update(CompanionProjectMapping)
            .where(CompanionProjectMapping.id == pg["mapping_id"])
            .values(content_level="rich")
        )
    with pytest.raises(IntegrityError):
        async with pg["factory"].begin() as db:
            await db.execute(
                update(CompanionProjectMapping)
                .where(CompanionProjectMapping.id == pg["mapping_id"])
                .values(content_level="raw")
            )
    await post_batch(pg, [session_record(pg, "pg-check", [declaration(b"c")])])
    with pytest.raises(IntegrityError):
        async with pg["factory"].begin() as db:
            await db.execute(
                update(AgentSessionContent)
                .where(AgentSessionContent.installation_id == pg["installation_id"])
                .values(state="deleted")
            )
    with pytest.raises(IntegrityError):
        async with pg["factory"].begin() as db:
            content = await db.scalar(
                select(AgentSessionContent).where(
                    AgentSessionContent.installation_id == pg["installation_id"]
                )
            )
            db.add(
                AgentSessionContent(
                    **{
                        column.key: getattr(content, column.key)
                        for column in AgentSessionContent.__table__.columns
                        if column.key != "id"
                    }
                )
            )
            await db.flush()


async def test_one_installation_delete_cascades_through_generations_and_contents(pg):
    """A single statement removes the device, its sessions, their contents and
    its generations: only a NO ACTION generation key lets it through."""
    await post_batch(pg, [session_record(pg, "pg-device", [declaration(b"o")])])
    async with pg["factory"].begin() as db:
        assert (
            await db.scalar(
                select(func.count())
                .select_from(AgentSessionCaptureGeneration)
                .where(
                    AgentSessionCaptureGeneration.installation_id
                    == pg["installation_id"]
                )
            )
            == 1
        )
        await db.execute(
            delete(CompanionInstallation).where(
                CompanionInstallation.id == pg["installation_id"]
            )
        )
    async with pg["factory"].begin() as db:
        for model in (AgentSessionCaptureGeneration, AgentSessionContent):
            assert (
                await db.scalar(
                    select(func.count())
                    .select_from(model)
                    .where(model.installation_id == pg["installation_id"])
                )
                == 0
            )


def _alembic(database: str, *args: str) -> None:
    backend = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=backend,
        env={**os.environ, "DATABASE_URL": database},
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert result.returncode == 0, result.stderr[-4000:]


async def _seed_rich(connection, owner, workspace, installation, sessions) -> None:
    """What a candidate with rich capture on leaves behind that the previous
    release cannot read: a rich mapping, rich capture levels and receipts,
    and heartbeats carrying a rich_capture member (null and an object)."""
    await connection.execute(
        text("UPDATE companion_project_mappings SET content_level = 'rich'")
    )
    for index, (levels, _) in enumerate(CAPTURE_LEVELS_ROLLBACK):
        await connection.execute(
            text(
                "INSERT INTO agent_sessions (id, workspace_id, owner_id, "
                "installation_id, harness, native_session_id, started_at, "
                "last_event_at, capture_levels) VALUES (:id, :ws, :owner, :inst, "
                "'claude_code', :native, now(), now(), CAST(:levels AS json))"
            ),
            {
                "id": sessions[index],
                "ws": workspace,
                "owner": owner,
                "inst": installation,
                "native": f"rich-{index}",
                "levels": None if levels is None else json.dumps(levels),
            },
        )
    await connection.execute(
        text(
            "INSERT INTO agent_session_captures (id, installation_id, capture_id, "
            "session_id, content_hash, collection_method, event_count, "
            "captured_at, received_at, content_level) VALUES (:id, :inst, 'cap', "
            ":session, 'h', 'hook', 1, now(), now(), 'rich')"
        ),
        {"id": uuid.uuid4(), "inst": installation, "session": sessions[0]},
    )
    await connection.execute(
        text("UPDATE companion_installations SET last_status = CAST(:status AS json)"),
        {"status": json.dumps(LAST_STATUS_ROLLBACK[0][0])},
    )


async def _assert_previous_release_reads_it(connection, sessions) -> None:
    assert (
        await connection.scalar(
            text("SELECT content_level FROM companion_project_mappings")
        )
        == "full"
    )
    for index, (_, expected) in enumerate(CAPTURE_LEVELS_ROLLBACK):
        stored = await connection.scalar(
            text("SELECT capture_levels::text FROM agent_sessions WHERE id = :id"),
            {"id": sessions[index]},
        )
        assert (None if stored is None else json.loads(stored)) == expected
    assert (
        await connection.scalar(
            text("SELECT content_level FROM agent_session_captures")
        )
        == "full"
    )
    status = await connection.scalar(
        text("SELECT last_status::text FROM companion_installations")
    )
    assert json.loads(status) == LAST_STATUS_ROLLBACK[0][1]


async def _insert_previous_release_rows(connection, owner, workspace, installation):
    await connection.execute(
        text("INSERT INTO users (id, email, name) VALUES (:id, :email, 'Old')"),
        {"id": owner, "email": f"{owner}@example.test"},
    )
    await connection.execute(
        text(
            "INSERT INTO workspaces (id, name, slug, created_by) "
            "VALUES (:id, 'Old', :slug, :owner)"
        ),
        {"id": workspace, "slug": f"old-{workspace.hex}", "owner": owner},
    )
    await connection.execute(
        text(
            "INSERT INTO companion_installations (id, owner_id, name, platform, "
            "token_hash, token_prefix) VALUES (:id, :owner, 'Old', 'linux', "
            ":hash, 'bpc_old')"
        ),
        {"id": installation, "owner": owner, "hash": installation.hex * 2},
    )
    await connection.execute(
        text(
            "INSERT INTO companion_project_mappings (id, installation_id, "
            "workspace_id, root_path, origin, content_level) VALUES (:id, "
            ":inst, :ws, '/old', 'explicit', 'full')"
        ),
        {"id": uuid.uuid4(), "inst": installation, "ws": workspace},
    )


async def _scratch_database() -> str:
    """A fresh database on the same disposable server; it goes with it."""
    server = make_url(database_url())
    name = "rc02_migration_" + uuid.uuid4().hex[:12]
    admin = create_async_engine(server, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'CREATE DATABASE "{name}"'))
    await admin.dispose()
    return server.set(database=name).render_as_string(hide_password=False)


async def test_migration_119_round_trips_on_postgresql():
    """Upgrade over the previous release's rows, downgrade (rich falls back to
    full everywhere the previous release reads it), upgrade again."""
    scratch = await _scratch_database()
    engine = create_async_engine(scratch)
    owner, workspace, installation = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    sessions = [uuid.uuid4() for _ in CAPTURE_LEVELS_ROLLBACK]
    try:
        _alembic(scratch, "upgrade", "118")
        async with engine.begin() as connection:
            await _insert_previous_release_rows(
                connection, owner, workspace, installation
            )
        _alembic(scratch, "upgrade", "119")
        async with engine.begin() as connection:
            row = (
                await connection.execute(
                    text(
                        "SELECT content_level, rich_since FROM companion_project_mappings"
                    )
                )
            ).one()
            assert tuple(row) == ("full", None)
            assert (
                await connection.scalar(
                    text("SELECT content_bytes FROM companion_installations")
                )
                == 0
            )
            types = dict(
                (
                    await connection.execute(
                        text(
                            "SELECT column_name, data_type FROM "
                            "information_schema.columns "
                            "WHERE table_name = 'agent_session_contents'"
                        )
                    )
                ).all()
            )
            assert types["content_key"] == "character"
            assert types["source_order"] == "bigint"
            await _seed_rich(connection, owner, workspace, installation, sessions)
        _alembic(scratch, "downgrade", "118")
        async with engine.begin() as connection:
            await _assert_previous_release_reads_it(connection, sessions)
        _alembic(scratch, "upgrade", "head")
    finally:
        await engine.dispose()


async def test_forget_rich_readies_the_database_for_the_previous_release():
    """The rollback of code alone (schema stays at 119): the entrypoint
    rewrites what the previous release cannot read, keeping every table."""
    scratch = await _scratch_database()
    engine = create_async_engine(scratch)
    owner, workspace, installation = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    sessions = [uuid.uuid4() for _ in CAPTURE_LEVELS_ROLLBACK]
    try:
        _alembic(scratch, "upgrade", "119")
        async with engine.begin() as connection:
            await _insert_previous_release_rows(
                connection, owner, workspace, installation
            )
            await _seed_rich(connection, owner, workspace, installation, sessions)
            await connection.execute(
                text(
                    "INSERT INTO agent_session_content_deletions (id, "
                    "storage_backend, storage_prefix, requested_at, next_attempt_at) "
                    "VALUES (:id, 'local', 'session-content/v1/kept/', now(), now())"
                ),
                {"id": uuid.uuid4()},
            )
        backend = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            [sys.executable, "-m", "scripts.forget_rich", "--apply"],
            cwd=backend,
            env={**os.environ, "DATABASE_URL": scratch},
            capture_output=True,
            text=True,
            timeout=300,
        )
        assert result.returncode == 0, result.stderr[-4000:]
        async with engine.begin() as connection:
            await _assert_previous_release_reads_it(connection, sessions)
            # The previous image's `alembic upgrade head` must find a head it knows.
            assert (
                await connection.scalar(text("SELECT version_num FROM alembic_version"))
                == "118"
            )
            assert (
                await connection.scalar(
                    text("SELECT to_regclass('agent_session_contents')::text")
                )
                == "agent_session_contents"
            )
        # Rolling forward runs 119 again over the objects it kept.
        _alembic(scratch, "upgrade", "119")
        async with engine.begin() as connection:
            assert (
                await connection.scalar(text("SELECT version_num FROM alembic_version"))
                == "119"
            )
            assert (
                await connection.scalar(
                    text("SELECT content_level FROM agent_session_captures")
                )
                == "full"
            )
            assert await connection.scalar(
                text("SELECT count(*) FROM agent_sessions")
            ) == len(sessions)
            assert (
                await connection.scalar(
                    text("SELECT storage_prefix FROM agent_session_content_deletions")
                )
                == "session-content/v1/kept/"
            )
    finally:
        await engine.dispose()
