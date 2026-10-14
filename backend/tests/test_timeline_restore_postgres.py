# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Behavioral checks using explicitly disposable PostgreSQL databases."""

import os
import uuid
from pathlib import Path

import asyncpg
import pytest
import pytest_asyncio
from sqlalchemy.engine import make_url

HELPER = Path(__file__).resolve().parents[1] / "scripts" / "normalize_timeline_restore.sql"
pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


def helper_sql():
    assert HELPER.is_file(), "supported restore must ship normalize_timeline_restore.sql"
    return HELPER.read_text()


def test_restore_normalizer_is_shipped():
    helper_sql()


def connection_options(url):
    parsed = make_url(url)
    return {
        "host": parsed.query.get("host") or parsed.host,
        "port": int(parsed.query.get("port") or parsed.port or 5432),
        "user": parsed.username, "password": parsed.password, "database": parsed.database,
    }


@pytest_asyncio.fixture
async def restored_database():
    url = os.environ.get("TIMELINE_RESTORE_DATABASE_URL")
    if not url:
        pytest.skip("Requires disposable TIMELINE_RESTORE_DATABASE_URL on a second cluster")
    admin = await asyncpg.connect(**connection_options(url))
    name = "timeline_restore_" + uuid.uuid4().hex
    await admin.execute(f'CREATE DATABASE "{name}"')
    restored_url = make_url(url).set(database=name).render_as_string(hide_password=False)
    try:
        yield restored_url
    finally:
        # Only this fixture's uniquely created database is removed.
        await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        await admin.close()


async def test_restore_helper_preserves_older_dump_without_timeline_columns(restored_database):
    sql = helper_sql()
    connection = await asyncpg.connect(**connection_options(restored_database))
    try:
        await connection.execute("CREATE TABLE activities (id integer PRIMARY KEY, summary text NOT NULL)")
        await connection.execute("INSERT INTO activities VALUES (1, 'retained legacy evidence')")
        await connection.execute(sql)
        await connection.execute(sql)
        assert await connection.fetchval("SELECT summary FROM activities WHERE id=1") == "retained legacy evidence"
        assert await connection.fetchval("SELECT to_regclass('timeline_generations')") is None
    finally:
        await connection.close()


async def test_restore_helper_is_atomic_idempotent_and_preserves_future_default(restored_database):
    sql = helper_sql()
    connection = await asyncpg.connect(**connection_options(restored_database))
    try:
        await connection.execute("""
            CREATE TABLE activities (
                id integer PRIMARY KEY, summary text NOT NULL,
                recorded_transaction xid8 DEFAULT pg_current_xact_id()
            );
            CREATE TABLE timeline_generations (id integer PRIMARY KEY);
            CREATE TABLE timeline_checkpoints (
                id integer PRIMARY KEY, generation_id integer REFERENCES timeline_generations ON DELETE CASCADE
            );
            CREATE TABLE timeline_preparations (
                id integer PRIMARY KEY, generation_id integer REFERENCES timeline_generations ON DELETE CASCADE
            );
            INSERT INTO activities (id,summary) VALUES (1,'retained evidence');
            INSERT INTO timeline_generations VALUES (1);
            INSERT INTO timeline_checkpoints VALUES (1,1);
            INSERT INTO timeline_preparations VALUES (1,1);
            CREATE FUNCTION reject_generation_delete() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'synthetic normalization failure'; END $$;
            CREATE TRIGGER reject_normalization BEFORE DELETE ON timeline_generations
                FOR EACH ROW EXECUTE FUNCTION reject_generation_delete();
        """)
        original_marker = await connection.fetchval("SELECT recorded_transaction::text FROM activities WHERE id=1")
        with pytest.raises(asyncpg.PostgresError, match="synthetic normalization failure"):
            await connection.execute(sql)
        await connection.execute("ROLLBACK")
        assert await connection.fetchval("SELECT recorded_transaction::text FROM activities WHERE id=1") == original_marker
        assert await connection.fetchval("SELECT count(*) FROM timeline_generations") == 1
        await connection.execute("DROP TRIGGER reject_normalization ON timeline_generations")
        await connection.execute(sql)
        await connection.execute(sql)
        assert await connection.fetchval("SELECT summary FROM activities WHERE id=1") == "retained evidence"
        assert await connection.fetchval("SELECT recorded_transaction FROM activities WHERE id=1") is None
        for table in ("timeline_generations", "timeline_checkpoints", "timeline_preparations"):
            assert await connection.fetchval(f"SELECT count(*) FROM {table}") == 0
        marker = await connection.fetchval("INSERT INTO activities(id,summary) VALUES(2,'future evidence') RETURNING recorded_transaction::text")
        assert marker is not None
    finally:
        await connection.close()


async def run_pg_tool(tool, url, *args):
    import asyncio
    import shutil

    executable = shutil.which(tool)
    assert executable, f"{tool} must be on PATH for the actual dump/restore seam"
    options = connection_options(url)
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    env.update({"PGDATABASE": options["database"], "PGPORT": str(options["port"])})
    for key, field in (("PGHOST", "host"), ("PGUSER", "user"), ("PGPASSWORD", "password")):
        if options[field] is not None:
            env[key] = str(options[field])
    process = await asyncio.create_subprocess_exec(
        executable, *args, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    _, stderr = await asyncio.wait_for(process.communicate(), timeout=20)
    assert process.returncode == 0, stderr.decode()


# Reuse the source API fixture; its rows are owned and cleaned by that fixture.
from tests.test_timeline_generations_postgres import postgres_history  # noqa: E402,F401


async def test_cross_cluster_restore_normalizes_visibility_before_new_generation(
    postgres_history, restored_database, monkeypatch, tmp_path  # noqa: F811
):
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app import database
    from app.core.auth import get_current_user
    from app.database import get_db
    from app.main import create_app
    from app.models.user import User
    from tests.test_timeline_generations_postgres import insert_old_writer

    sql = helper_sql()
    source = postgres_history
    source_url = os.environ["TIMELINE_TEST_DATABASE_URL"]
    source_options = connection_options(source_url)
    target_options = connection_options(restored_database)
    assert (source_options["host"], source_options["port"]) != (target_options["host"], target_options["port"]), "test requires two distinct clusters"
    async with source["factory"].begin() as db:
        recorded = await insert_old_writer(db, source["values"], "survives a logical restore")
    response = await source["client"].post(
        f"{source['base']}/generations", json={"request_id": str(uuid.uuid4())}
    )
    assert response.status_code == 201, response.text
    old_generation = response.json()
    dump = tmp_path / "timeline.dump"
    await run_pg_tool("pg_dump", source_url, "--format=custom", "--no-owner", "--file", str(dump))
    await run_pg_tool("pg_restore", restored_database, "--no-owner", "--exit-on-error", "--dbname", target_options["database"], str(dump))
    connection = await asyncpg.connect(**target_options)
    try:
        assert await connection.fetchval("SELECT recorded_transaction::text FROM activities WHERE id=$1", recorded.id) is not None
        await connection.execute(sql)
        await connection.execute(sql)
        assert await connection.fetchval("SELECT summary FROM activities WHERE id=$1", recorded.id) == "survives a logical restore"
        assert await connection.fetchval("SELECT recorded_transaction FROM activities WHERE id=$1", recorded.id) is None
        assert await connection.fetchval("SELECT count(*) FROM timeline_generations") == 0
    finally:
        await connection.close()
    engine = create_async_engine(restored_database, hide_parameters=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(database, "async_session", factory)
    async with factory() as db:
        restored_user = await db.get(User, source["values"]["actor"])
    app = create_app()

    async def owner():
        return restored_user

    async def request_db():
        async with factory() as db:
            yield db
            await db.commit()

    app.dependency_overrides[get_current_user] = owner
    app.dependency_overrides[get_db] = request_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://restore") as client:
            missing = await client.get(f"{source['base']}/generations/{old_generation['id']}")
            assert missing.status_code in (404, 410)
            response = await client.post(f"{source['base']}/generations", json={"request_id": str(uuid.uuid4())})
            assert response.status_code == 201, response.text
            generation = response.json()
            assert generation["event_count"] == "1"
            window = await client.get(f"{source['base']}/generations/{generation['id']}/window")
            assert window.status_code == 200, window.text
            assert [event["id"] for event in window.json()["events"]] == [str(recorded.id)]
            async with factory.begin() as db:
                future = await insert_old_writer(db, source["values"], "recorded after restore")
                assert await db.scalar(text("SELECT recorded_transaction::text FROM activities WHERE id=:id"), {"id": future.id}) is not None
            response = await client.post(f"{source['base']}/generations", json={"request_id": str(uuid.uuid4())})
            assert response.status_code == 201, response.text
            assert response.json()["event_count"] == "2"
    finally:
        await engine.dispose()
