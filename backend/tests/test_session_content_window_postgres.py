# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import copy
import json
import os
import uuid
from datetime import timedelta
from pathlib import Path
from time import perf_counter

import pytest
from sqlalchemy import delete, event, insert, text

from app.models.agent_session import AgentSessionContent
from tests.rich_capture import declaration
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_content_postgres import post_batch, session_record
from tests.test_session_content_window import START, SeededContents, ids, window

pytestmark = [pytest.mark.slow, pytest.mark.usefixtures("content_storage")]
pg = content_postgres_fixture


async def seed_pg_contents(pg, count, native_session):
    result = await post_batch(
        pg,
        [
            session_record(
                pg, native_session, [declaration(b"synthetic PostgreSQL preview")]
            )
        ],
    )
    content_id = uuid.UUID(result["contents"][0]["content_id"])
    async with pg["factory"].begin() as db:
        original = await db.get(AgentSessionContent, content_id)
        template = {
            column.name: copy.deepcopy(getattr(original, column.name))
            for column in AgentSessionContent.__table__.columns
        }
        session_id = original.session_id
        await db.execute(
            delete(AgentSessionContent).where(AgentSessionContent.id == content_id)
        )
        namespace = uuid.uuid4().int & ~((1 << 32) - 1)
        rows = [
            {
                **copy.deepcopy(template),
                "id": uuid.UUID(int=namespace + index + 1),
                "content_key": f"{index:064x}",
                "source_order": 10_000 + index // 3,
                "occurred_at": START + timedelta(seconds=index // 30),
            }
            for index in range(count)
        ]
        # Bound asyncpg's parameters per statement while preserving the real
        # indexed row shape. This tests reads, not the ingest throughput.
        for start in range(0, count, 300):
            await db.execute(insert(AgentSessionContent), rows[start : start + 300])
    return SeededContents(
        f"/api/workspaces/{pg['slug']}/sessions/{session_id}/contents",
        session_id,
        rows,
        template,
        {},
    )


def plan_nodes(node):
    yield node
    for child in node.get("Plans", []):
        yield from plan_nodes(child)


@pytest.mark.parametrize("count", [10_001, 100_001])
async def test_postgres_window_seeks_remain_bounded_and_emit_real_query_plans(
    pg, count, tmp_path
):
    seeded = await seed_pg_contents(pg, count, "window-query-plan")
    unrelated = await seed_pg_contents(pg, 10_001, "window-unrelated")
    engine = pg["factory"].kw["bind"]
    async with engine.begin() as connection:
        await connection.execute(text("ANALYZE agent_session_contents"))
        database_version = await connection.scalar(text("SELECT version()"))
    statements = []

    def record_statement(_connection, _cursor, statement, parameters, _context, _many):
        if (
            statement.lstrip().upper().startswith("SELECT")
            and "agent_session_contents" in statement
        ):
            statements.append((statement, parameters))

    event.listen(engine.sync_engine, "before_cursor_execute", record_statement)
    reads = []
    try:
        for mode in ("latest", "beginning"):
            before = len(statements)
            result = await window(pg["client"], seeded, mode=mode)
            expected = seeded.rows[-100:] if mode == "latest" else seeded.rows[:100]
            assert ids(result["items"]) == ids(expected)
            reads.append((mode, statements[before:]))
        before = len(statements)
        middle = count // 2
        anchored = await window(
            pg["client"],
            seeded,
            mode="anchor",
            anchor_id=str(seeded.rows[middle]["id"]),
        )
        assert ids(anchored["items"]) == ids(seeded.rows[middle - 49 : middle + 51])
        reads.append(("anchor", statements[before:]))
        for mode, cursor_name in (
            ("earlier", "earlier_cursor"),
            ("later", "later_cursor"),
            ("refresh", "window_cursor"),
        ):
            before = len(statements)
            result = await window(
                pg["client"], seeded, mode=mode, cursor=anchored[cursor_name]
            )
            assert len(result["items"]) == 100
            reads.append((mode, statements[before:]))
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record_statement)

    receipts = []
    async with engine.connect() as connection:
        for mode, queries in reads:
            assert queries, f"{mode} did not read durable content"
            for statement, parameters in queries:
                result = await connection.exec_driver_sql(
                    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + statement,
                    parameters,
                )
                explanation = result.scalar_one()
                if isinstance(explanation, str):
                    explanation = json.loads(explanation)
                receipts.append(
                    {
                        "mode": mode,
                        "sql": statement,
                        "parameters": list(parameters),
                        "explain": explanation,
                    }
                )
    report = {
        "database": database_version,
        "source_commit": os.environ.get("QUALIFIED_SOURCE_COMMIT"),
        "target_rows": count,
        "unrelated_rows": len(unrelated.rows),
        "reads": receipts,
    }
    directory = Path(os.environ.get("SESSION_CONTENT_WINDOW_PLAN_DIR", str(tmp_path)))
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"window-plans-{count}.json").write_text(
        json.dumps(report, indent=2, default=str) + "\n"
    )

    # Neighbor availability is part of every window read too. EXISTS can let
    # PostgreSQL scan half the session even when the ordered row seek is bounded.
    for receipt in receipts:
        nodes = list(plan_nodes(receipt["explain"][0]["Plan"]))
        assert not any(
            node["Node Type"] in {"Seq Scan", "Sort", "Incremental Sort"}
            for node in nodes
        ), receipt
    ordered_receipts = [receipt for receipt in receipts if "ORDER BY" in receipt["sql"]]
    assert ordered_receipts
    for receipt in ordered_receipts:
        nodes = list(plan_nodes(receipt["explain"][0]["Plan"]))
        timeline = [
            node
            for node in nodes
            if node.get("Index Name") == "ix_agent_session_contents_timeline"
        ]
        assert timeline, receipt
        assert all(node["Actual Rows"] <= 101 for node in timeline), receipt
        assert all(
            node.get("Rows Removed by Filter", 0) == 0 for node in timeline
        ), receipt


async def test_postgres_microsecond_and_uuid_ties_traverse_without_gaps_or_overlap(pg):
    seeded = await seed_pg_contents(pg, 301, "window-tied-order")
    for direction, initial, cursor_name in (
        ("later", "beginning", "later_cursor"),
        ("earlier", "latest", "earlier_cursor"),
    ):
        result = await window(pg["client"], seeded, mode=initial)
        visited = ids(result["items"])
        pages = 1
        while result[cursor_name]:
            assert pages < 5
            result = await window(
                pg["client"], seeded, mode=direction, cursor=result[cursor_name]
            )
            current = ids(result["items"])
            assert not set(current).intersection(visited)
            visited = current + visited if direction == "earlier" else visited + current
            pages += 1
        assert pages == 4
        assert visited == ids(seeded.rows)


async def test_postgres_selected_metadata_at_limit_records_plan_and_response_size(pg, tmp_path):
    seeded = await seed_pg_contents(pg, 100_001, "selected-metadata-plan")
    unrelated = await seed_pg_contents(pg, 10_001, "metadata-unrelated")
    selected = seeded.rows[::97][:1024]
    requested = [str(row["id"]) for row in reversed(selected)]
    engine = pg["factory"].kw["bind"]
    statements = []

    def record_statement(_connection, _cursor, statement, parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT") and "agent_session_contents" in statement:
            statements.append((statement, parameters))

    async with engine.begin() as connection:
        await connection.execute(text("ANALYZE agent_session_contents"))
        database_version = await connection.scalar(text("SELECT version()"))
    event.listen(engine.sync_engine, "before_cursor_execute", record_statement)
    started = perf_counter()
    try:
        response = await pg["client"].post(
            f"{seeded.path}/metadata", json={"content_ids": requested}
        )
        elapsed_ms = (perf_counter() - started) * 1000
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record_statement)
    assert response.status_code == 200, response.text
    result = response.json()
    assert ids(result["items"]) == ids(selected)
    assert result["unavailable_ids"] == []
    assert all(item["preview"] is None for item in result["items"])
    assert "synthetic PostgreSQL preview" not in response.text
    assert len(statements) == 1
    statement, parameters = statements[0]
    assert "agent_session_contents.preview" not in statement
    assert "agent_session_contents.inline_text" not in statement
    async with engine.connect() as connection:
        explanation = (
            await connection.exec_driver_sql(
                "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + statement, parameters
            )
        ).scalar_one()
    if isinstance(explanation, str):
        explanation = json.loads(explanation)
    # This bounded ID lookup may sort its selected rows. The no-sort assertion
    # belongs to window seeks, not this separate selection query.
    nodes = list(plan_nodes(explanation[0]["Plan"]))
    assert all(node["Actual Rows"] <= 1024 for node in nodes)
    directory = Path(os.environ.get("SESSION_CONTENT_WINDOW_PLAN_DIR", str(tmp_path)))
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "selected-metadata-1024.json").write_text(json.dumps({
        "database": database_version,
        "source_commit": os.environ.get("QUALIFIED_SOURCE_COMMIT"),
        "target_rows": len(seeded.rows), "unrelated_rows": len(unrelated.rows),
        "selected_ids": len(requested), "response_bytes": len(response.content),
        "synthetic_asgi_http_ms": elapsed_ms,
        "sql": statement, "parameters": list(parameters), "explain": explanation,
    }, indent=2, default=str) + "\n")


async def test_postgres_refresh_uses_durable_original_bounds_and_reports_late_overflow(
    pg,
):
    seeded = await seed_pg_contents(pg, 101, "window-refresh")
    original = await window(pg["client"], seeded, mode="beginning")
    async with pg["factory"].begin() as db:
        await db.execute(
            delete(AgentSessionContent).where(
                AgentSessionContent.id == seeded.rows[0]["id"]
            )
        )
    refreshed = await window(
        pg["client"], seeded, mode="refresh", cursor=original["window_cursor"]
    )
    assert ids(refreshed["items"]) == ids(seeded.rows[1:100])
    assert refreshed["later_cursor"]
    async with pg["factory"].begin() as db:
        await db.execute(insert(AgentSessionContent), [seeded.rows[0]])
        await db.execute(
            insert(AgentSessionContent),
            [
                {
                    **copy.deepcopy(seeded.template),
                    "id": uuid.uuid4(),
                    "content_key": uuid.uuid4().hex * 2,
                    "occurred_at": START + timedelta(microseconds=1),
                    "source_order": 10_000,
                }
            ],
        )
    overflow = await pg["client"].get(
        f"{seeded.path}/window",
        params={"mode": "refresh", "cursor": refreshed["window_cursor"]},
    )
    assert overflow.status_code == 409, overflow.text
    assert overflow.json()["error_code"] == "content_window_changed"
