# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Run only against an explicitly provided disposable, migrated PostgreSQL DB."""

import base64
import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone
from time import perf_counter
from urllib.parse import parse_qsl, urlencode, urlsplit

import pytest
from sqlalchemy import delete, event, func, select, text, update

from app.models.agent_session import AgentSession, SessionWorkLink
from app.models.companion import CompanionInstallation
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember
from app.repositories.agent_session import AgentSessionRepository
from tests.session_rows import add_installation, add_session
from tests.test_owner_session_overview import (
    HOUR,
    MINUTE,
    OVERVIEW,
    SESSIONS,
    page,
    seed_volume,
    workspace_for,
)
from tests.test_session_content_postgres import pg as capture_postgres_fixture

pytestmark = [pytest.mark.slow, pytest.mark.usefixtures("content_storage")]
pg = capture_postgres_fixture


ANALYZED_TABLES = (
    "workspace_members",
    "workspaces",
    "agent_sessions",
    "session_work_links",
    "notes",
    "cards",
    "boards",
    "companion_installations",
    "companion_project_mappings",
)
LINKED_SESSIONS = SESSIONS + "?linked_only=true"


def source_hashes():
    paths = (
        "app/main.py",
        "app/repositories/agent_session.py",
        "app/services/owner_session.py",
        "app/routers/owner_session.py",
        "app/schemas/owner_session.py",
        "tests/test_owner_session_overview.py",
        "tests/test_owner_session_overview_postgres.py",
        "tests/test_session_content_postgres.py",
        "tests/session_rows.py",
    )
    return {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in paths}


def query_kind(statement):
    if "session_work_links" in statement:
        return (
            "session_page_with_links"
            if "agent_sessions" in statement
            else "link_enrichment"
        )
    if "GROUP BY agent_sessions.parent_session_id" in statement:
        return "child_counts"
    return "session_page" if "agent_sessions" in statement else "other_select"


async def counted_request(client, engine, request_path):
    statements = []

    def record(_connection, _cursor, statement, *_rest):
        if statement.lstrip().upper().startswith(("SELECT", "WITH")):
            statements.append(statement)

    destination = urlsplit(request_path)
    # The shared page helper passes params explicitly; HTTPX would otherwise
    # replace an embedded query string with its default empty params mapping.
    params = dict(parse_qsl(destination.query))
    event.listen(engine, "before_cursor_execute", record)
    try:
        result = await page(client, destination.path, **params)
    finally:
        event.remove(engine, "before_cursor_execute", record)
    return result, statements


@pytest.mark.parametrize(
    "root_count", [2000, 20_000], ids=["2000-roots", "20000-roots"]
)
async def test_postgres_global_queries_are_bounded_across_50_workspaces_2000_roots(
    pg, tmp_path, monkeypatch, root_count
):
    engine = pg["factory"].kw["bind"]
    extra_workspaces = []
    now = datetime.now(timezone.utc)
    inputs_before = source_hashes()

    def unexpected_body_read(*_args, **_kwargs):
        raise AssertionError("Owner metadata must not fetch captured bodies")

    monkeypatch.setattr("app.services.session_content.store_for", unexpected_body_read)
    monkeypatch.setattr(
        "app.services.storage.session_content.content_store", unexpected_body_read
    )
    try:
        async with pg["factory"].begin() as db:
            owner = await db.get(User, pg["owner_id"])
            original_workspace = await db.get(Workspace, pg["workspace_id"])
            active = await db.get(CompanionInstallation, pg["installation_id"])
            paused = await add_installation(db, owner, paused=True)
            await seed_volume(db, owner, [original_workspace], active, paused, now)
        # Enrollment alone is not liveness. Establish a real heartbeat before
        # asserting that this device contributes the active half of the fixture.
        heartbeat = await pg["client"].post(
            "/api/companion/status",
            headers=pg["headers"],
            json={
                "companion_version": "a02-fixture",
                "queue": {"pending": 0, "dropped_total": 0},
            },
        )
        assert heartbeat.status_code == 200, heartbeat.text
        control = await page(pg["client"], f"/api/workspaces/{pg['slug']}/sessions")
        assert len(control["items"]) == 40
        assert sum(row["display_state"] == "active" for row in control["items"]) == 20
        assert sum(row["display_state"] == "paused" for row in control["items"]) == 20
        small_counts = {}
        for path in (SESSIONS, OVERVIEW, LINKED_SESSIONS):
            _, statements = await counted_request(
                pg["client"], engine.sync_engine, path
            )
            small_counts[path] = len(statements)

        async with pg["factory"].begin() as db:
            for index in range(49):
                workspace = await workspace_for(
                    db, owner, f"{pg['slug']}-volume-{index}"
                )
                extra_workspaces.append(workspace.id)
            workspaces = [
                await db.get(Workspace, identity) for identity in extra_workspaces
            ]
            await seed_volume(db, owner, workspaces, active, paused, now - MINUTE)
            all_workspaces = [original_workspace, *workspaces]
            # Repeat the same seed seam without increasing workspace fan-out.
            # Native identities are fresh each batch; timestamps intentionally tie.
            for _ in range(root_count // 2000 - 1):
                await seed_volume(
                    db, owner, all_workspaces, active, paused, now - 2 * MINUTE
                )

        async with pg["factory"]() as db:
            fixture_counts = {
                "workspaces": await db.scalar(
                    select(func.count())
                    .select_from(WorkspaceMember)
                    .where(WorkspaceMember.user_id == owner.id)
                ),
                "root_sessions": await db.scalar(
                    select(func.count())
                    .select_from(AgentSession)
                    .where(
                        AgentSession.owner_id == owner.id,
                        AgentSession.parent_native_session_id.is_(None),
                    )
                ),
                "notes": await db.scalar(
                    select(func.count())
                    .select_from(Note)
                    .where(Note.created_by == owner.id)
                ),
                "work_links": await db.scalar(
                    select(func.count())
                    .select_from(SessionWorkLink)
                    .join(AgentSession, AgentSession.id == SessionWorkLink.session_id)
                    .where(AgentSession.owner_id == owner.id)
                ),
            }
        assert fixture_counts == {
            "workspaces": 50,
            "root_sessions": root_count,
            "notes": root_count // 20,
            "work_links": root_count * 2,
        }

        async with engine.begin() as connection:
            for table in ANALYZED_TABLES:
                await connection.execute(text(f"ANALYZE {table}"))
            database_version = await connection.scalar(text("SELECT version()"))
            statistics = (
                (
                    await connection.execute(
                        text(
                            "SELECT relname, reltuples, relpages FROM pg_class "
                            "WHERE relname::text = ANY(CAST(:tables AS text[])) "
                            "ORDER BY relname"
                        ),
                        {"tables": list(ANALYZED_TABLES)},
                    )
                )
                .mappings()
                .all()
            )

        queries = []

        def record_query(_connection, _cursor, statement, parameters, _context, _many):
            if statement.lstrip().upper().startswith(("SELECT", "WITH")):
                queries.append((statement, parameters))

        measurements = []
        page_ids = {}
        event.listen(engine.sync_engine, "before_cursor_execute", record_query)
        try:
            for path, maximum in (
                (SESSIONS, 12),
                (OVERVIEW, 24),
                (LINKED_SESSIONS, 12),
            ):
                request_path = path
                for page_number in range(1 if path == OVERVIEW else 2):
                    first_query = len(queries)
                    started = perf_counter()
                    result, statements = await counted_request(
                        pg["client"], engine.sync_engine, request_path
                    )
                    elapsed_ms = (perf_counter() - started) * 1000
                    assert len(statements) == small_counts[path] <= maximum
                    assert len(queries) - first_query == len(statements)
                    assert not any(
                        forbidden in query.lower()
                        for query in statements
                        for forbidden in (
                            "agent_session_contents",
                            "agent_session_events",
                            "notes.content",
                            "cards.description",
                        )
                    )
                    if path == OVERVIEW:
                        assert len(result["active"]) == len(result["recent"]) == 6
                        assert (
                            result["active_more"] is True
                            and result["recent_more"] is True
                        )
                        rows = result["active"] + result["recent"]
                        assert len({row["id"] for row in rows}) == 12
                        assert all(
                            row["display_state"] == "active" for row in result["active"]
                        )
                        assert all(
                            row["display_state"] != "active" for row in result["recent"]
                        )
                    else:
                        assert len(result["items"]) == 40 and result["next_cursor"]
                        rows = result["items"]
                        current_ids = {row["id"] for row in rows}
                        assert len(current_ids) == 40
                        assert current_ids.isdisjoint(page_ids.setdefault(path, set()))
                        page_ids[path].update(current_ids)
                        params = {"cursor": result["next_cursor"]}
                        if path == LINKED_SESSIONS:
                            params["linked_only"] = "true"
                        request_path = SESSIONS + "?" + urlencode(params)
                    assert all(
                        row["link_count"] == 2 and len(row["link_preview"]) == 2
                        for row in rows
                    )
                    assert all(row["parent_session_id"] is None for row in rows)
                    measurements.append(
                        {
                            "path": path,
                            "page": page_number + 1,
                            "select_count": len(statements),
                            "elapsed_ms": elapsed_ms,
                            "response_bytes": len(json.dumps(result).encode()),
                            "returned_rows": len(rows),
                            "query_indexes": list(range(first_query, len(queries))),
                        }
                    )
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", record_query)
        assert page_ids[SESSIONS] == page_ids[LINKED_SESSIONS]
        assert any(
            query_kind(statement) == "link_enrichment" for statement, _ in queries
        )
        assert any(
            query_kind(statement) == "session_page_with_links"
            for statement, _ in queries
        )

        plans = []
        async with engine.connect() as connection:
            for index, (statement, parameters) in enumerate(queries):
                result = await connection.exec_driver_sql(
                    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + statement, parameters
                )
                plans.append(
                    {
                        "query_index": index,
                        "kind": query_kind(statement),
                        "statement": statement,
                        "parameters": parameters,
                        "plan": result.scalar_one(),
                    }
                )
        assert plans and len(plans) == sum(
            item["select_count"] for item in measurements
        )
        inputs_after = source_hashes()
        assert (
            inputs_before == inputs_after
        ), "Measurement source changed during the run"
        receipt = tmp_path / "owner-session-overview-postgres.json"
        receipt.write_text(
            json.dumps(
                {
                    "database_version": database_version,
                    **fixture_counts,
                    "synthetic_owners": 1,
                    "seeded_card_links": 0,
                    "analyzed_tables": ANALYZED_TABLES,
                    "table_statistics": [dict(row) for row in statistics],
                    "source_hashes": inputs_after,
                    "small_select_counts": small_counts,
                    "measurements": measurements,
                    "plans": plans,
                },
                indent=2,
                default=str,
            )
        )
        print(f"PostgreSQL owner overview receipt: {receipt}")
    finally:
        async with pg["factory"].begin() as db:
            if extra_workspaces:
                await db.execute(
                    delete(Workspace).where(Workspace.id.in_(extra_workspaces))
                )


@pytest.mark.parametrize("recent_count", [1, 2], ids=["no-more", "more"])
async def test_postgres_overview_excludes_committed_active_and_lookahead_rows(
    pg, tmp_path, monkeypatch, recent_count
):
    inputs_before = source_hashes()
    now = datetime.now(timezone.utc)
    monkeypatch.setattr("app.services.owner_session.utcnow", lambda: now)
    async with pg["factory"].begin() as db:
        owner = await db.get(User, pg["owner_id"])
        workspace = await db.get(Workspace, pg["workspace_id"])
        active_device = await add_installation(db, owner, last_seen_at=now)
        paused_device = await add_installation(db, owner, paused=True)
        active = [
            await add_session(
                db, active_device, workspace, started=HOUR, last=index * MINUTE
            )
            for index in range(2)
        ]
        recent = [
            await add_session(
                db, paused_device, workspace, started=HOUR, last=(index + 3) * MINUTE
            )
            for index in range(recent_count)
        ]
    active_ids = {row.id for row in active}
    recent_ids = [str(row.id) for row in recent]
    control = await page(pg["client"], f"/api/workspaces/{pg['slug']}/sessions")
    assert {
        row["id"] for row in control["items"] if row["display_state"] == "active"
    } == {str(identity) for identity in active_ids}
    assert {
        row["id"] for row in control["items"] if row["display_state"] == "paused"
    } == set(recent_ids)

    original = AgentSessionRepository.list_owner_metadata
    reads = []
    commit_evidence = {}

    async def commit_end_after_active_read(self, *args, **kwargs):
        rows = await original(self, *args, **kwargs)
        reads.append(
            {"states": kwargs["states"], "ids": [str(row.session.id) for row in rows]}
        )
        if len(reads) == 1:
            assert kwargs["states"] == ["active"]
            assert {row.session.id for row in rows} == active_ids
            reader_pid = await self.db.scalar(text("SELECT pg_backend_pid()"))
            isolation = await self.db.scalar(text("SHOW transaction_isolation"))
            assert isolation == "read committed"
            # The request keeps its connection and transaction open while a
            # different connection commits the ingest-like state transition.
            async with pg["factory"].begin() as writer:
                writer_pid = await writer.scalar(text("SELECT pg_backend_pid()"))
                assert writer_pid != reader_pid
                writer_txid = await writer.scalar(text("SELECT txid_current()"))
                changed = await writer.execute(
                    update(AgentSession)
                    .where(AgentSession.id.in_(active_ids))
                    .values(ended_at=AgentSession.last_event_at, status="ended")
                )
                assert changed.rowcount == 2
            # Selecting columns avoids refreshing the first-read ORM objects.
            # This proves the request can see the other connection's COMMIT.
            committed = (
                await self.db.execute(
                    select(
                        AgentSession.id, AgentSession.ended_at, AgentSession.status
                    ).where(AgentSession.id.in_(active_ids))
                )
            ).all()
            assert {row.id for row in committed} == active_ids
            assert all(
                row.ended_at is not None and row.status == "ended" for row in committed
            )
            commit_evidence.update(
                reader_pid=reader_pid,
                writer_pid=writer_pid,
                writer_transaction_id=writer_txid,
                isolation=isolation,
                committed_ids=[str(row.id) for row in committed],
            )
        return rows

    monkeypatch.setattr(
        AgentSessionRepository, "list_owner_metadata", commit_end_after_active_read
    )
    overview = await page(pg["client"], OVERVIEW, active_limit=1, recent_limit=1)
    assert len(reads) == 2
    assert [row["id"] for row in overview["active"]] == [str(active[0].id)]
    assert [row["id"] for row in overview["recent"]] == recent_ids[:1]
    assert not {row["id"] for row in overview["active"]} & {
        row["id"] for row in overview["recent"]
    }
    # Check the actual repository result before any service-level truncation:
    # both the displayed active row and its lookahead must be excluded by SQL.
    assert reads[1]["ids"] == recent_ids
    assert overview["active_more"] is True
    assert overview["recent_more"] is (recent_count > 1)
    inputs_after = source_hashes()
    assert inputs_before == inputs_after, "Concurrency source changed during the run"
    receipt = tmp_path / "owner-session-overview-read-committed.json"
    receipt.write_text(
        json.dumps(
            {
                "source_hashes": inputs_after,
                "commit": commit_evidence,
                "repository_reads": reads,
                "overview": overview,
            },
            indent=2,
            default=str,
        )
    )
    print(f"PostgreSQL overview READ COMMITTED receipt: {receipt}")


@pytest.mark.parametrize(
    ("clock", "expected_status"),
    [
        ("9999-12-31T23:59:59.999999+00:00", 200),
        ("0001-01-01T00:00:00+00:00", 422),
        ("9999-12-31T23:59:59.999999-14:00", 422),
    ],
    ids=["valid-utc-maximum", "threshold-underflow", "utc-normalization-overflow"],
)
async def test_postgres_cursor_clock_uses_real_driver_encoding(
    pg, tmp_path, clock, expected_status
):
    inputs_before = source_hashes()
    async with pg["factory"].begin() as db:
        owner = await db.get(User, pg["owner_id"])
        workspace = await db.get(Workspace, pg["workspace_id"])
        device = await add_installation(db, owner)
        sessions = [
            await add_session(db, device, workspace, started=HOUR, last=index * MINUTE)
            for index in range(2)
        ]
    first = await page(pg["client"], limit=1)
    assert [row["id"] for row in first["items"]] == [str(sessions[0].id)]
    cursor = first["next_cursor"]
    assert cursor
    control = await page(pg["client"], limit=1, cursor=cursor)
    assert [row["id"] for row in control["items"]] == [str(sessions[1].id)]
    assert control["next_cursor"] is None

    fields = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    fields[2] = clock
    changed_cursor = (
        base64.urlsafe_b64encode(json.dumps(fields).encode()).decode().rstrip("=")
    )
    queries = []

    def record_query(_connection, _cursor, statement, parameters, _context, _many):
        if statement.lstrip().upper().startswith(("SELECT", "WITH")):
            queries.append((statement, parameters))

    engine = pg["factory"].kw["bind"].sync_engine
    event.listen(engine, "before_cursor_execute", record_query)
    try:
        response = await pg["client"].get(
            SESSIONS, params={"limit": 1, "cursor": changed_cursor}
        )
    finally:
        event.remove(engine, "before_cursor_execute", record_query)
    assert (response.status_code, response.headers.get("cache-control")) == (
        expected_status,
        "no-store",
    ), response.text
    if expected_status == 200:
        result = response.json()
        assert [row["id"] for row in result["items"]] == [str(sessions[1].id)]
        assert result["next_cursor"] is None
        assert result["items"][0]["display_state"] == "incomplete"
        assert any(
            isinstance(value, datetime) and value.year == 9999
            for _, parameters in queries
            for value in parameters
        ), "The accepted extreme clock must reach PostgreSQL's actual parameter codec"
    else:
        assert response.json()["detail"] == "Invalid cursor"
        assert clock not in response.text and changed_cursor not in response.text
        assert not any("agent_sessions" in statement for statement, _ in queries)
    inputs_after = source_hashes()
    assert inputs_before == inputs_after, "Cursor source changed during the run"
    receipt = tmp_path / "owner-session-cursor-clock-postgres.json"
    receipt.write_text(
        json.dumps(
            {
                "source_hashes": inputs_after,
                "clock": clock,
                "status": response.status_code,
                "cache_control": response.headers.get("cache-control"),
                "queries": [
                    {"statement": statement, "parameters": parameters}
                    for statement, parameters in queries
                ],
            },
            indent=2,
            default=str,
        )
    )
    print(f"PostgreSQL cursor clock receipt: {receipt}")
