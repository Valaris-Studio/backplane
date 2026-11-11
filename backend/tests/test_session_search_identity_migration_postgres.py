# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Native recovery contracts for the additive A+C session identity migration."""

import asyncio

import pytest
from sqlalchemy import text

from tests.test_session_search_index_migration_postgres import (
    _constraints,
    _eventually,
    _index_catalog,
    _records,
    migration_database,  # noqa: F401
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(150)]
PARENT_INDEXES = (
    ("uq_agent_session_contents_id_session", "agent_session_contents"),
    ("uq_session_search_sources_id_session", "session_search_sources"),
)
FOREIGN_KEYS = (
    (
        "fk_session_search_sources_content_session",
        "session_search_sources",
        "content_id",
        "agent_session_contents",
    ),
    (
        "fk_session_search_chunks_source_session",
        "session_search_chunks",
        "source_id",
        "session_search_sources",
    ),
)


@pytest.fixture
async def identity_database(migration_database):  # noqa: F811
    await (await migration_database.cli("upgrade", "128")).finish()
    return migration_database


async def identity_constraints(database):
    async with database.engine.connect() as connection:
        return {
            row["conname"]: dict(row)
            for row in (
                await connection.execute(
                    text("""
                        SELECT c.oid, c.conname, c.convalidated, c.conindid,
                               c.contype::text, c.confdeltype::text,
                               pg_get_constraintdef(c.oid) AS definition,
                               c.conrelid::regclass::text AS child,
                               c.confrelid::regclass::text AS parent
                        FROM pg_constraint c
                        WHERE c.conname IN (
                            'fk_session_search_sources_content_session',
                            'fk_session_search_chunks_source_session'
                        )
                        ORDER BY c.conname
                    """)
                )
            ).mappings()
        }


async def assert_identity_schema(database):
    indexes = {}
    for name, table in PARENT_INDEXES:
        row = await _index_catalog(database, name)
        assert row is not None, name
        assert row["table_name"] == table
        assert row["indisunique"]
        assert row["indisvalid"] and row["indisready"] and row["indislive"]
        assert tuple(row["keys"]) == ("id", "session_id")
        assert tuple(row["included"]) == ()
        assert row["predicate"] is None
        indexes[table] = row
    constraints = await identity_constraints(database)
    assert set(constraints) == {name for name, *_ in FOREIGN_KEYS}
    for name, child, column, parent in FOREIGN_KEYS:
        row = constraints[name]
        assert row["convalidated"]
        assert (row["contype"], row["confdeltype"]) == ("f", "c")
        assert (row["child"], row["parent"]) == (child, parent)
        assert row["conindid"] == indexes[parent]["oid"]
        assert row["definition"] == (
            f"FOREIGN KEY ({column}, session_id) REFERENCES {parent}(id, session_id) ON DELETE CASCADE"
        )
    return indexes, constraints


async def test_identity_migration_builds_concurrently_then_adds_and_validates(
    identity_database,
):
    database = identity_database
    before = await _constraints(database)
    command = await database.cli("upgrade", "129")
    await command.finish()
    await assert_identity_schema(database)
    statements = [record["sql"] for record in _records(command.trace)]
    creates = [sql for sql in statements if sql.startswith("CREATE UNIQUE INDEX")]
    assert len(creates) == 2
    assert all(sql.startswith("CREATE UNIQUE INDEX CONCURRENTLY ") for sql in creates)
    for name, child, column, parent in FOREIGN_KEYS:
        additions = [
            sql for sql in statements if "ADD CONSTRAINT" in sql and name in sql
        ]
        validations = [
            sql for sql in statements if "VALIDATE CONSTRAINT" in sql and name in sql
        ]
        assert len(additions) == len(validations) == 1
        assert additions[0].endswith("NOT VALID")
        assert statements.index(additions[0]) < statements.index(validations[0])
        assert max(statements.index(sql) for sql in creates) < statements.index(
            additions[0]
        )
    remaining = [
        row
        for row in await _constraints(database)
        if row[1] not in {x[0] for x in FOREIGN_KEYS}
    ]
    assert remaining == before
    await (await database.cli("downgrade", "128")).finish()
    assert await identity_constraints(database) == {}
    for name, _ in PARENT_INDEXES:
        assert await _index_catalog(database, name) is None
    assert await _constraints(database) == before


async def test_identity_migration_reuses_validated_schema_after_stamp_loss(
    identity_database,
):
    database = identity_database
    command = await database.cli("upgrade", "129", before_stamp=True)
    await command.finish(expected=91)
    assert await database.version() == "128"
    before = await assert_identity_schema(database)
    await (await database.cli("upgrade", "129")).finish()
    assert await assert_identity_schema(database) == before


async def test_identity_migration_resumes_exact_not_valid_constraint(identity_database):
    database = identity_database
    async with database.engine.begin() as connection:
        for name, table in PARENT_INDEXES:
            await connection.execute(
                text(f"CREATE UNIQUE INDEX {name} ON public.{table} (id, session_id)")
            )
        name, child, column, parent = FOREIGN_KEYS[0]
        await connection.execute(
            text(
                f"ALTER TABLE public.{child} ADD CONSTRAINT {name} FOREIGN KEY ({column}, session_id) "
                f"REFERENCES public.{parent} (id, session_id) ON DELETE CASCADE NOT VALID"
            )
        )
    before = await identity_constraints(database)
    assert not before[name]["convalidated"]
    await (await database.cli("upgrade", "129")).finish()
    _, after = await assert_identity_schema(database)
    assert before[name]["oid"] == after[name]["oid"]


@pytest.mark.parametrize("collision", ["table", "different_index", "constraint_index"])
async def test_identity_migration_preserves_index_collision_without_partial_builds(
    identity_database, collision
):
    database = identity_database
    name, table = PARENT_INDEXES[1]
    async with database.engine.begin() as connection:
        if collision == "table":
            await connection.execute(text(f"CREATE TABLE public.{name} (kept integer)"))
        elif collision == "different_index":
            await connection.execute(
                text(f"CREATE UNIQUE INDEX {name} ON public.{table} (session_id, id)")
            )
        else:
            await connection.execute(
                text(
                    f"ALTER TABLE public.{table} ADD CONSTRAINT {name} UNIQUE (id, session_id)"
                )
            )
    before = await _index_catalog(database, name)
    constraints = await _constraints(database)
    command = await database.cli("upgrade", "129")
    async with asyncio.timeout(120):
        assert await command.process.wait() != 0
    assert await database.version() == "128"
    assert await _index_catalog(database, name) == before
    assert await _index_catalog(database, PARENT_INDEXES[0][0]) is None
    assert await _constraints(database) == constraints


@pytest.mark.parametrize("action", ["NO ACTION", "CASCADE"])
async def test_identity_migration_preserves_conflicting_fk_before_any_build(
    identity_database, action
):
    database = identity_database
    name, child, column, parent = FOREIGN_KEYS[0]
    async with database.engine.begin() as connection:
        await connection.execute(
            text(
                f"ALTER TABLE public.{child} ADD CONSTRAINT {name} FOREIGN KEY ({column}) "
                f"REFERENCES public.{parent} (id) ON DELETE {action} NOT VALID"
            )
        )
    before = await identity_constraints(database)
    command = await database.cli("upgrade", "129")
    async with asyncio.timeout(120):
        assert await command.process.wait() != 0
    assert await database.version() == "128"
    assert await identity_constraints(database) == before
    for index_name, _ in PARENT_INDEXES:
        assert await _index_catalog(database, index_name) is None


async def test_identity_migration_repairs_cancelled_unique_index_build(
    identity_database,
):
    database = identity_database
    async with database.engine.connect() as writer:
        transaction = await writer.begin()
        for _, table in PARENT_INDEXES:
            await writer.execute(
                text(f"LOCK TABLE public.{table} IN ROW EXCLUSIVE MODE")
            )
        command = await database.cli("upgrade", "129")

        async def waiting_builder():
            owned_pids = {record["pid"] for record in _records(command.trace)}
            async with database.engine.connect() as observer:
                rows = (
                    await observer.execute(
                        text("""
                    SELECT p.pid, c.relname FROM pg_stat_progress_create_index p
                    JOIN pg_class c ON c.oid=p.index_relid
                    WHERE p.datname=current_database()
                      AND p.phase='waiting for writers before build'
                """)
                    )
                ).all()
            return next(
                (
                    row
                    for row in rows
                    if row.pid in owned_pids
                    and row.relname in {x[0] for x in PARENT_INDEXES}
                ),
                None,
            )

        try:
            pending = await _eventually(
                waiting_builder, "identity unique-index build waiting on writer"
            )
            async with database.engine.connect() as observer:
                assert await observer.scalar(
                    text("SELECT pg_cancel_backend(:pid)"), {"pid": pending.pid}
                )
            async with asyncio.timeout(30):
                assert await command.process.wait() != 0
        finally:
            await transaction.rollback()
    invalid = await _index_catalog(database, pending.relname)
    assert invalid is not None and not invalid["indisvalid"]
    assert await database.version() == "128"
    await (await database.cli("upgrade", "129")).finish()
    await assert_identity_schema(database)


async def test_identity_migration_resumes_interrupted_downgrade(identity_database):
    database = identity_database
    await (await database.cli("upgrade", "129")).finish()
    command = await database.cli("downgrade", "128", before_stamp=True)
    await command.finish(expected=91)
    assert await database.version() == "129"
    assert await identity_constraints(database) == {}
    for name, _ in PARENT_INDEXES:
        assert await _index_catalog(database, name) is None
    await (await database.cli("downgrade", "128")).finish()
    assert await database.version() == "128"
