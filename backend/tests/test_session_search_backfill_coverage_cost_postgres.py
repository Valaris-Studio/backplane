# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fresh backfill coverage must not compare every content with every source."""

import json
import uuid
from contextlib import contextmanager

import pytest
from sqlalchemy import delete, event, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from app.models.agent_session import AgentSessionContent
from app.models.session_search import SessionSearchChunk, SessionSearchSource
from app.models.session_search_backfill import SessionSearchBackfillRun
from app.models.workspace import WorkspaceMember, WorkspaceRole
from app.repositories.session_search_backfill import SessionSearchBackfillRepository
from app.schemas.session_content import MAX_TEXT_BODY_BYTES
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.rich_capture import declaration
from tests.test_session_calls import prompt
from tests.services.test_session_search_backfill import driver, receipt, run_id
from tests.test_session_content_postgres import (
    pg as capture_postgres_fixture,
    _alembic,
    database_url,
    post_batch,
    session_record,
)

pg = capture_postgres_fixture
pytestmark = [pytest.mark.slow, pytest.mark.usefixtures("content_storage")]
BODY = b"retained coverage needle " + b"x" * 1000


@pytest.fixture
async def reenrolled_owner_pg(monkeypatch):
    """Re-enrollment after empty-table analysis, before new column statistics."""
    server = make_url(database_url())
    name = "uxc_coverage_cold_" + uuid.uuid4().hex[:12]
    admin = create_async_engine(server, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(
            text(
                f'CREATE DATABASE "{name}" TEMPLATE template0 '
                "ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'"
            )
        )
    scratch = server.set(database=name).render_as_string(hide_password=False)
    fixture = None
    try:
        _alembic(scratch, "upgrade", "head")
        monkeypatch.setenv("SESSION_CAPTURE_TEST_DATABASE_URL", scratch)
        prior = capture_postgres_fixture.__wrapped__()
        await prior.__anext__()
        await prior.aclose()
        empty = create_async_engine(scratch)
        try:
            async with empty.begin() as connection:
                await connection.execute(text("ANALYZE workspace_members"))
                empty_statistics = dict(
                    (
                        await connection.execute(
                            text(
                                "SELECT reltuples,relpages FROM pg_class "
                                "WHERE oid='workspace_members'::regclass"
                            )
                        )
                    )
                    .mappings()
                    .one()
                )
        finally:
            await empty.dispose()
        fixture = capture_postgres_fixture.__wrapped__()
        env = await fixture.__anext__()
        async with env["factory"]() as db:
            assert (
                await db.scalar(
                    text(
                        "SELECT count(*) FROM pg_stats WHERE tablename='workspace_members'"
                    )
                )
                == 0
            )
        assert empty_statistics["reltuples"] == 0
        assert empty_statistics["relpages"] > 0
        env["membership_statistics"] = empty_statistics
        yield env
    finally:
        if fixture is not None:
            await fixture.aclose()
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE "{name}"'))
        await admin.dispose()


async def clone_retained_sources(env, *, contents, indexed):
    """Expand one real ingestion's metadata and index, keeping exact text rows."""
    response = await post_batch(
        env, [session_record(env, "coverage-cost", [declaration(BODY)])]
    )
    assert response["rejected"] == []
    content_id = uuid.UUID(response["contents"][0]["content_id"])
    prefix = uuid.uuid4().hex
    async with env["factory"].begin() as db:
        source_id = await db.scalar(
            select(SessionSearchSource.id).where(
                SessionSearchSource.content_id == content_id
            )
        )
        assert source_id is not None
        templates = [
            (
                AgentSessionContent,
                content_id,
                contents,
                {
                    "id": "md5(:prefix || 'content' || g::text)::uuid",
                    "content_key": "md5(:prefix || g::text) || md5(g::text || :prefix)",
                    "source_order": "g",
                },
            ),
            (
                SessionSearchSource,
                source_id,
                indexed,
                {
                    "id": "md5(:prefix || 'source' || g::text)::uuid",
                    "content_id": "md5(:prefix || 'content' || g::text)::uuid",
                },
            ),
        ]
        for model, identity, count, overrides in templates:
            columns = [column.name for column in model.__table__.columns]
            projection = ",".join(
                overrides.get(name, f't."{name}"') for name in columns
            )
            names = ",".join(f'"{name}"' for name in columns)
            await db.execute(
                text(
                    f"INSERT INTO {model.__tablename__} ({names}) "
                    f"SELECT {projection} FROM {model.__tablename__} t "
                    "CROSS JOIN generate_series(1, :count) g WHERE t.id = :identity"
                ),
                {"prefix": prefix, "count": count, "identity": identity},
            )
        columns = [column.name for column in SessionSearchChunk.__table__.columns]
        overrides = {
            "id": "md5(:prefix || 'chunk' || g::text || t.ordinal::text)::uuid",
            "source_id": "md5(:prefix || 'source' || g::text)::uuid",
            "sort_order": "g",
        }
        projection = ",".join(overrides.get(name, f't."{name}"') for name in columns)
        names = ",".join(f'"{name}"' for name in columns)
        await db.execute(
            text(
                f"INSERT INTO session_search_chunks ({names}) SELECT {projection} "
                "FROM session_search_chunks t CROSS JOIN generate_series(1, :count) g "
                "WHERE t.source_id = :identity"
            ),
            {"prefix": prefix, "count": indexed, "identity": source_id},
        )
        # Match normal source metadata statistics. Membership remains live
        # even when its statistics predate recent enrollment or revocation.
        for table in (
            "agent_session_contents",
            "agent_session_events",
            "agent_sessions",
            "session_search_sources",
        ):
            await db.execute(text(f"ANALYZE {table}"))
    return content_id


@contextmanager
def observed_coverage_statement(env):
    statements = []

    def observe(_connection, _cursor, sql, parameters, _context, _many):
        if sql.startswith("SELECT 'content' AS part"):
            statements.append((sql, parameters))

    engine = env["factory"].kw["bind"].sync_engine
    event.listen(engine, "before_cursor_execute", observe)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", observe)


def nodes(plan):
    yield plan
    for child in plan.get("Plans", []):
        yield from nodes(child)


async def statement_plan(env, statement):
    sql, parameters = statement
    async with env["factory"].begin() as db:
        await db.execute(text("SET LOCAL statement_timeout = '10s'"))
        connection = await db.connection()
        raw = await connection.get_raw_connection()
        result = await raw.driver_connection.fetchval(
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, *parameters
        )
    return result[0]


async def test_scope_coverage_avoids_cross_product_after_owner_reenrollment(
    reenrolled_owner_pg, tmp_path
):
    pg = reenrolled_owner_pg
    count, settled = 100_000, 1_700
    await clone_retained_sources(pg, contents=count, indexed=settled)
    service = driver(pg["factory"])
    started = receipt(await service.start_run())
    identity = run_id(started)
    try:
        with observed_coverage_statement(pg) as statements:
            current = receipt(await service.status(identity))
        assert len(statements) == 1
        coverage = current["coverage"]
        assert coverage["indexed"] == {
            "count": settled + 1,
            "bytes": (settled + 1) * len(BODY),
        }
        assert coverage["pending_index"] == {
            "count": count - settled,
            "bytes": (count - settled) * len(BODY),
        }
        assert coverage["eligible_count"] == count + 1
        assert coverage["owner_not_member_count"] == 0
        assert coverage["index_ready"] is False
        plan = await statement_plan(pg, statements[0])
        rejected = sum(
            node.get("Rows Removed by Join Filter", 0) * node.get("Actual Loops", 1)
            for node in nodes(plan["Plan"])
        )
        (tmp_path / "coverage-cost.json").write_text(
            json.dumps(
                {
                    "receipt": current,
                    "plan": plan,
                    "join_rejections": rejected,
                    "membership_statistics": pg["membership_statistics"],
                },
                indent=2,
            )
        )
        assert rejected <= 10 * (count + 1), rejected
    finally:
        async with pg["factory"].begin() as db:
            await db.execute(
                delete(SessionSearchBackfillRun).where(
                    SessionSearchBackfillRun.id == identity
                )
            )


async def test_scope_coverage_keeps_live_freshness_unknown_sizes_and_membership(pg):
    bodies = [BODY + str(index).encode() for index in range(10)]
    response = await post_batch(
        pg,
        [
            session_record(
                pg, "coverage-freshness", [declaration(body) for body in bodies]
            )
        ],
    )
    assert response["rejected"] == []
    identities = [uuid.UUID(item["content_id"]) for item in response["contents"]]
    service = driver(pg["factory"])
    started = receipt(await service.start_run())
    identity = run_id(started)
    try:
        before = receipt(await service.status(identity))["coverage"]
        assert before["indexed"] == {"count": 10, "bytes": sum(map(len, bodies))}
        async with pg["factory"].begin() as db:
            for index, changes in (
                (1, {"extractor_version": "older-extractor"}),
                (2, {"source_digest": "0" * 64}),
                (4, {"status": "pending"}),
                (5, {"status": "unavailable"}),
                (6, {"status": "not_text"}),
            ):
                await db.execute(
                    update(SessionSearchSource)
                    .where(SessionSearchSource.content_id == identities[index])
                    .values(**changes)
                )
            await db.execute(
                delete(SessionSearchSource).where(
                    SessionSearchSource.content_id == identities[3]
                )
            )
            await db.execute(
                update(AgentSessionContent)
                .where(AgentSessionContent.id.in_([identities[7], identities[8]]))
                .values(byte_count=None, original_byte_count=None)
            )
            await db.execute(
                update(AgentSessionContent)
                .where(AgentSessionContent.id == identities[7])
                .values(sha256=None)
            )
            await db.execute(
                update(AgentSessionContent)
                .where(AgentSessionContent.id == identities[9])
                .values(
                    state="recorded", coverage="withheld_by_policy", inline_text=None
                )
            )
        with observed_coverage_statement(pg) as statements:
            changed = receipt(await service.status(identity))["coverage"]
        assert len(statements) == 1
        assert changed["observed_from"] >= before["observed_at"]
        assert changed["indexed"] == {"count": 2, "bytes": None}
        assert changed["pending_index"] == {"count": 5, "bytes": None}
        assert changed["unavailable"] == {"count": 1, "bytes": len(bodies[5])}
        assert changed["nontext"] == {"count": 1, "bytes": len(bodies[6])}
        assert changed["withheld"] == {"count": 1, "bytes": len(bodies[9])}
        assert changed["eligible"] == {"count": 7, "bytes": None}
        assert changed["index_ready"] is False
        async with pg["factory"].begin() as db:
            await db.execute(
                delete(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == pg["workspace_id"],
                    WorkspaceMember.user_id == pg["owner_id"],
                )
            )
        revoked = receipt(await service.status(identity))["coverage"]
        assert revoked["observed_from"] >= changed["observed_at"]
        assert revoked["eligible"] == {"count": 0, "bytes": 0}
        assert revoked["owner_not_member_count"] == 10
        async with pg["factory"].begin() as db:
            db.add(
                WorkspaceMember(
                    workspace_id=pg["workspace_id"],
                    user_id=pg["owner_id"],
                    role=WorkspaceRole.owner,
                )
            )
        restored = receipt(await service.status(identity))["coverage"]
        assert restored["eligible"] == changed["eligible"]
        assert restored["owner_not_member_count"] == 0
    finally:
        async with pg["factory"].begin() as db:
            await db.execute(
                delete(SessionSearchBackfillRun).where(
                    SessionSearchBackfillRun.id == identity
                )
            )


async def test_scope_coverage_preserves_content_identity_and_all_other_parts(pg):
    other_fixture = capture_postgres_fixture.__wrapped__()
    other = await other_fixture.__anext__()
    try:
        primary_record = session_record(pg, "coverage-parent", [declaration(BODY)])
        primary_record["events"] = [prompt(1, "retained coverage prompt")]
        child_record = session_record(
            pg, "coverage-child", [], parent_native_session_id="coverage-parent"
        )
        child_record["events"] = [prompt(2, "retained child prompt")]
        child_record.pop("capture_generation")
        primary = await post_batch(pg, [primary_record, child_record])
        foreign_record = session_record(other, "coverage-foreign", [declaration(BODY)])
        foreign_record["events"] = [prompt(1, "excluded coverage prompt")]
        foreign = await post_batch(other, [foreign_record])
        assert primary["rejected"] == foreign["rejected"] == []
        primary_content = uuid.UUID(primary["contents"][0]["content_id"])
        foreign_content = uuid.UUID(foreign["contents"][0]["content_id"])
        async with pg["factory"].begin() as db:
            foreign_session = await db.scalar(
                select(AgentSessionContent.session_id).where(
                    AgentSessionContent.id == foreign_content
                )
            )
            # The identity invariant rejects a Source moved to a foreign session.
            with pytest.raises(IntegrityError):
                async with db.begin_nested():
                    await db.execute(
                        update(SessionSearchSource)
                        .where(SessionSearchSource.content_id == primary_content)
                        .values(session_id=foreign_session)
                    )
            await db.execute(
                update(AgentSessionContent)
                .where(AgentSessionContent.id == primary_content)
                .values(byte_count=None, original_byte_count=None)
            )
            await db.execute(
                delete(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == other["workspace_id"],
                    WorkspaceMember.user_id == other["owner_id"],
                )
            )
            db.add(
                WorkspaceMember(
                    workspace_id=pg["workspace_id"],
                    user_id=other["owner_id"],
                    role=WorkspaceRole.member,
                )
            )
        async with pg["factory"]() as db:
            with observed_coverage_statement(pg) as statements:
                aggregate = await SessionSearchBackfillRepository(db).scope_aggregate(
                    extractor_version=EXTRACTOR_VERSION,
                    backend="local",
                    max_body_bytes=MAX_TEXT_BODY_BYTES,
                )
        assert len(statements) == 1
        assert len(aggregate.contents) == 1
        assert aggregate.contents[0].index_status == "indexed"
        assert aggregate.contents[0].count == 1
        assert aggregate.contents[0].stored_known == 0
        assert aggregate.events_stored == aggregate.events_indexed == 2
        assert aggregate.events_indexed_bytes > 0
        assert aggregate.owner_not_member == 2
        assert aggregate.child_sessions == 1
        assert aggregate.unresolved_metadata == 1
    finally:
        await other_fixture.aclose()
