# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Owner A+C session identity contracts on a disposable, migrated PostgreSQL.

Run serially with SESSION_CAPTURE_TEST_DATABASE_URL and
RICH_CAPTURE_REQUIRE_LEGS=1. Identity rejection is enforced by PostgreSQL,
including writes that bypass the index writer. The precheck calibration uses
private, unconstrained temporary tables; production constraints remain enabled.
"""

import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import UniqueConstraint, delete, insert, select, text, update
from sqlalchemy.exc import IntegrityError

from app.models.agent_session import AgentSession, AgentSessionContent as Content
from app.models.agent_session import AgentSessionEvent as Event
from app.models.session_search import SessionSearchChunk as Chunk
from app.models.session_search import SessionSearchSource as Source
from app.services.session_search_index import SessionSearchIndexWriter
from tests.test_session_calls import prompt
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_search import paused_object_indexing as pause_processor_fixture
from tests.test_session_search import search
from tests.test_session_search_postgres import pg_inline

pg = content_postgres_fixture
paused_object_indexing = pause_processor_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.timeout(60),
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]
PRECHECK = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "session_search_session_identity_precheck.sql"
)
EXPECTED_COUNTS = {"chunk_source_violations", "source_content_violations"}
IDENTITY_FOREIGN_KEYS = (
    (Chunk, ("source_id", "session_id"), Source, ("id", "session_id")),
    (Source, ("content_id", "session_id"), Content, ("id", "session_id")),
)


@pytest.fixture
async def indexed_pair(pg):
    result = []
    for native in ("identity-left", "identity-right"):
        path, session_id, [ack] = await pg_inline(
            pg, [b"session identity content needle"], native=native
        )
        content_id = uuid.UUID(ack["content_id"])
        async with pg["factory"]() as db:
            source = dict(
                (
                    await db.execute(
                        select(Source.__table__).where(Source.content_id == content_id)
                    )
                )
                .mappings()
                .one()
            )
            chunk = dict(
                (
                    await db.execute(
                        select(Chunk.__table__).where(Chunk.source_id == source["id"])
                    )
                )
                .mappings()
                .one()
            )
        result.append(
            {
                "path": path,
                "session_id": session_id,
                "content_id": content_id,
                "source": source,
                "chunk": chunk,
            }
        )
    return result


async def test_migrated_and_model_composite_identity_foreign_keys_agree(pg):
    async with pg["factory"]() as db:
        for child, child_columns, parent, parent_columns in IDENTITY_FOREIGN_KEYS:
            constraints = (
                (
                    await db.execute(
                        text("""
                        SELECT c.conname, c.convalidated, c.confdeltype::text AS confdeltype,
                            ARRAY(
                                SELECT a.attname::text
                                FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, n)
                                JOIN pg_attribute a
                                  ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                                ORDER BY k.n
                            ) AS child_columns,
                            ARRAY(
                                SELECT a.attname::text
                                FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, n)
                                JOIN pg_attribute a
                                  ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                                ORDER BY k.n
                            ) AS parent_columns
                        FROM pg_constraint c
                        WHERE c.contype = 'f'
                          AND c.conrelid = to_regclass(:child)
                          AND c.confrelid = to_regclass(:parent)
                    """),
                        {"child": child.__tablename__, "parent": parent.__tablename__},
                    )
                )
                .mappings()
                .all()
            )
            matching = [
                constraint
                for constraint in constraints
                if tuple(constraint["child_columns"]) == child_columns
                and tuple(constraint["parent_columns"]) == parent_columns
            ]
            assert len(matching) == 1, (child.__tablename__, constraints)
            assert matching[0]["convalidated"], matching[0]
            assert matching[0]["confdeltype"] == "c", matching[0]

            model_constraints = [
                constraint
                for constraint in child.__table__.foreign_key_constraints
                if tuple(element.parent.name for element in constraint.elements)
                == child_columns
                and tuple(element.column.name for element in constraint.elements)
                == parent_columns
                and constraint.referred_table is parent.__table__
            ]
            assert len(model_constraints) == 1, child.__tablename__
            assert model_constraints[0].ondelete == "CASCADE"


async def test_migrated_and_model_identity_parent_keys_are_unique(pg):
    async with pg["factory"]() as db:
        for model in (Source, Content):
            keys = (
                (
                    await db.execute(
                        text("""
                        SELECT i.indisvalid, i.indisready,
                            ARRAY(
                                SELECT a.attname::text
                                FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, n)
                                JOIN pg_attribute a
                                  ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                                WHERE k.n <= i.indnkeyatts
                                ORDER BY k.n
                            ) AS columns
                        FROM pg_index i
                        WHERE i.indrelid = to_regclass(:table)
                          AND i.indisunique AND i.indpred IS NULL
                    """),
                        {"table": model.__tablename__},
                    )
                )
                .mappings()
                .all()
            )
            matching = [
                key for key in keys if tuple(key["columns"]) == ("id", "session_id")
            ]
            assert len(matching) == 1, (model.__tablename__, keys)
            assert matching[0]["indisvalid"] and matching[0]["indisready"]
            model_keys = {
                tuple(column.name for column in key.columns)
                for key in (*model.__table__.constraints, *model.__table__.indexes)
                if isinstance(key, UniqueConstraint) or getattr(key, "unique", False)
            }
            assert ("id", "session_id") in model_keys, model.__tablename__


@pytest.mark.parametrize(
    "mutation",
    [
        "insert_source",
        "source_session",
        "source_content",
        "content_session",
        "insert_chunk",
        "chunk_session",
        "chunk_source",
    ],
)
async def test_native_foreign_keys_reject_cross_session_identity(
    pg, indexed_pair, mutation
):
    left, right = indexed_pair
    async with pg["factory"].begin() as db:
        await db.execute(text("SET LOCAL statement_timeout='5s'"))
        if mutation in ("insert_source", "source_content"):
            # Remove only the competing unique content reference, so the
            # expected rejection must come from the composite foreign key.
            await db.execute(delete(Source).where(Source.id == right["source"]["id"]))
        if mutation == "source_session":
            await db.execute(
                delete(Chunk).where(Chunk.source_id == left["source"]["id"])
            )

        if mutation == "insert_source":
            statement = insert(Source).values(
                **{
                    **left["source"],
                    "id": uuid.uuid4(),
                    "content_id": right["content_id"],
                }
            )
        elif mutation == "source_session":
            statement = (
                update(Source)
                .where(Source.id == left["source"]["id"])
                .values(session_id=right["session_id"])
            )
        elif mutation == "source_content":
            statement = (
                update(Source)
                .where(Source.id == left["source"]["id"])
                .values(content_id=right["content_id"])
            )
        elif mutation == "content_session":
            statement = (
                update(Content)
                .where(Content.id == left["content_id"])
                .values(session_id=right["session_id"])
            )
        elif mutation == "insert_chunk":
            statement = insert(Chunk).values(
                **{
                    **left["chunk"],
                    "id": uuid.uuid4(),
                    "session_id": right["session_id"],
                }
            )
        elif mutation == "chunk_session":
            statement = (
                update(Chunk)
                .where(Chunk.id == left["chunk"]["id"])
                .values(session_id=right["session_id"])
            )
        else:
            statement = (
                update(Chunk)
                .where(Chunk.id == left["chunk"]["id"])
                .values(source_id=right["source"]["id"])
            )
        with pytest.raises(IntegrityError) as error:
            async with db.begin_nested():
                await db.execute(statement)
                await db.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
        assert error.value.orig.sqlstate == "23503", str(error.value)


@pytest.mark.parametrize("deleted_parent", ["content", "event", "source", "session"])
async def test_valid_writers_and_cascades_preserve_content_and_event_sources(
    pg, indexed_pair, deleted_parent
):
    left, right = indexed_pair
    event_id = uuid.uuid4()
    async with pg["factory"].begin() as db:
        now = datetime.now(timezone.utc)
        db.add(
            Event(
                id=event_id,
                session_id=left["session_id"],
                event_id=event_id.hex,
                capture_id=uuid.uuid4().hex,
                occurred_at=now,
                received_at=now,
                action="prompt.submitted",
                category="prompt",
                collection_method="hook",
                event=prompt(0, "session identity event needle"),
            )
        )
        await db.flush()
        writer = SessionSearchIndexWriter(db)
        assert await writer.index_source("event", event_id) == "indexed"
        assert await writer.index_source("event", event_id) == "unchanged"
        assert await writer.index_source("content", left["content_id"]) == "unchanged"
        event_source = await db.scalar(
            select(Source).where(Source.event_id == event_id)
        )
        assert event_source.content_id is None
        assert event_source.session_id == left["session_id"]
        event_source_id = event_source.id
        event_chunks = list(
            await db.scalars(select(Chunk).where(Chunk.source_id == event_source_id))
        )
        assert event_chunks
        assert {chunk.session_id for chunk in event_chunks} == {left["session_id"]}
        event_chunk_ids = {chunk.id for chunk in event_chunks}

    page = await search(pg["client"], left["path"], "needle")
    assert {hit["source_kind"] for hit in page["items"]} == {"content", "event"}
    parent, identity = {
        "content": (Content, left["content_id"]),
        "event": (Event, event_id),
        "source": (Source, left["source"]["id"]),
        "session": (AgentSession, left["session_id"]),
    }[deleted_parent]
    async with pg["factory"].begin() as db:
        await db.execute(delete(parent).where(parent.id == identity))

    content_index_survives = deleted_parent == "event"
    event_index_survives = deleted_parent not in {"event", "session"}
    async with pg["factory"]() as db:
        assert (
            await db.get(Source, left["source"]["id"]) is not None
        ) == content_index_survives
        assert (
            await db.get(Chunk, left["chunk"]["id"]) is not None
        ) == content_index_survives
        assert (
            await db.get(Source, event_source_id) is not None
        ) == event_index_survives
        remaining_event_chunks = set(
            await db.scalars(select(Chunk.id).where(Chunk.id.in_(event_chunk_ids)))
        )
        assert remaining_event_chunks == (
            event_chunk_ids if event_index_survives else set()
        )
        assert (await db.get(Content, left["content_id"]) is not None) == (
            deleted_parent not in {"content", "session"}
        )
        assert (await db.get(Event, event_id) is not None) == (
            deleted_parent not in {"event", "session"}
        )
        assert await db.get(Source, right["source"]["id"]) is not None
        assert await db.get(Chunk, right["chunk"]["id"]) is not None


def precheck_sql():
    assert (
        PRECHECK.is_file()
    ), "The production identity admission needs one reusable read-only query"
    return text(PRECHECK.read_text())


async def read_only_precheck(connection, statement):
    await connection.execute(text("SET TRANSACTION READ ONLY"))
    await connection.execute(text("SET LOCAL statement_timeout='5s'"))
    assert await connection.scalar(text("SHOW transaction_read_only")) == "on"
    assert (
        await connection.scalar(text("SELECT pg_current_xact_id_if_assigned()")) is None
    )
    rows = (await connection.execute(statement)).mappings().all()
    assert len(rows) == 1
    result = dict(rows[0])
    assert result.keys() == EXPECTED_COUNTS
    assert all(type(value) is int for value in result.values()), result
    assert (
        await connection.scalar(text("SELECT pg_current_xact_id_if_assigned()")) is None
    )
    return result


async def test_production_precheck_is_read_only_and_counts_only(pg, indexed_pair):
    statement = precheck_sql()
    engine = pg["factory"].kw["bind"]
    async with engine.connect() as connection:
        result = await read_only_precheck(connection, statement)
    assert result == {name: 0 for name in EXPECTED_COUNTS}


async def test_production_precheck_detects_each_violation_and_excludes_event_sources(
    pg,
):
    statement = precheck_sql()
    engine = pg["factory"].kw["bind"]
    session_a, session_b = uuid.uuid4(), uuid.uuid4()
    content_id, absent_content_id = uuid.uuid4(), uuid.uuid4()
    source_id, event_source_id, absent_source_id = (
        uuid.uuid4(),
        uuid.uuid4(),
        uuid.uuid4(),
    )
    tables = (
        "session_search_chunks",
        "session_search_sources",
        "agent_session_contents",
    )
    async with engine.connect() as connection:
        try:
            await connection.execute(
                text("""
                CREATE TEMP TABLE agent_session_contents (
                    id uuid NOT NULL, session_id uuid NOT NULL
                ) ON COMMIT PRESERVE ROWS
            """)
            )
            await connection.execute(
                text("""
                CREATE TEMP TABLE session_search_sources (
                    id uuid NOT NULL, session_id uuid NOT NULL, content_id uuid
                ) ON COMMIT PRESERVE ROWS
            """)
            )
            await connection.execute(
                text("""
                CREATE TEMP TABLE session_search_chunks (
                    id uuid NOT NULL, session_id uuid NOT NULL, source_id uuid NOT NULL
                ) ON COMMIT PRESERVE ROWS
            """)
            )
            await connection.execute(
                text(
                    "INSERT INTO pg_temp.agent_session_contents VALUES (:id, :session)"
                ),
                {"id": content_id, "session": session_a},
            )
            await connection.execute(
                text(
                    "INSERT INTO pg_temp.session_search_sources VALUES (:id, :session, :content)"
                ),
                [
                    {"id": source_id, "session": session_a, "content": content_id},
                    {"id": uuid.uuid4(), "session": session_b, "content": content_id},
                    {
                        "id": uuid.uuid4(),
                        "session": session_a,
                        "content": absent_content_id,
                    },
                    {"id": event_source_id, "session": session_b, "content": None},
                ],
            )
            await connection.execute(
                text(
                    "INSERT INTO pg_temp.session_search_chunks VALUES (:id, :session, :source)"
                ),
                [
                    {"id": uuid.uuid4(), "session": session_a, "source": source_id},
                    {"id": uuid.uuid4(), "session": session_b, "source": source_id},
                    {
                        "id": uuid.uuid4(),
                        "session": session_a,
                        "source": absent_source_id,
                    },
                    {
                        "id": uuid.uuid4(),
                        "session": session_b,
                        "source": event_source_id,
                    },
                ],
            )
            await connection.commit()
            await connection.execute(text("SET TRANSACTION READ ONLY"))
            await connection.execute(text("SET LOCAL search_path = pg_temp, public"))
            result = await read_only_precheck(connection, statement)
            assert result == {name: 2 for name in EXPECTED_COUNTS}
        finally:
            await connection.rollback()
            for table in tables:
                await connection.execute(text(f"DROP TABLE IF EXISTS pg_temp.{table}"))
            await connection.commit()
