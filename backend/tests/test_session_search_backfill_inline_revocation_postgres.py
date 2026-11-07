# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B01H inline authorization after a real PostgreSQL content-row lock wait.

The authorized control proves that the body observers and writer are exercised.
The revocation case changes only membership after PostgreSQL proves the wait.
"""

import asyncio
import hashlib
import json
import os
import uuid
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

import pytest
from sqlalchemy import delete, event, inspect, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.sql.elements import Cast, Label, TypeCoerce

from app.models.agent_session import AgentSessionContent
from app.models.session_search import SessionSearchSource
from app.models.workspace import WorkspaceMember
from tests.rich_capture import declaration
from tests.test_session_content_postgres import (
    pg as capture_postgres_fixture,
    post_batch,
    session_record,
)
from tests.test_session_search import exact_match, search
from tests.test_session_search_backfill_postgres import (
    BARRIER_SECONDS,
    actual_waiter,
    attempt_source,
    backfill_pg as backfill_pg_fixture,
    paused_object_indexing as paused_object_indexing_fixture,
)

pg = capture_postgres_fixture
backfill_pg = backfill_pg_fixture
paused_object_indexing = paused_object_indexing_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]
DATABASE_NAME = "session_search_backfill_b01h_20261019"
NEEDLE = "Straße_INLINE_CONTENT_LOCK"
INLINE_TEXT = "先🙂 " + NEEDLE + " authorized retained inline body"


@pytest.fixture(autouse=True)
def exact_disposable_database():
    # Autouse precedes the imported function-scoped PG fixture's connection.
    raw = os.environ.get("SESSION_CAPTURE_TEST_DATABASE_URL")
    assert raw, "Root must supply the explicit migrated disposable PostgreSQL URL"
    url = make_url(raw)
    assert url.drivername == "postgresql+asyncpg"
    assert url.host == "127.0.0.1" and url.port == 55446
    assert url.database == DATABASE_NAME
    assert url.username, "Use the root-owned database role"
    return url


@pytest.fixture
async def inline_backfill_pg(backfill_pg, exact_disposable_database, tmp_path, request):
    case = backfill_pg
    async with case.factory.begin() as db:
        identity = (await db.execute(text(
            "SELECT current_database() AS database_name, current_user AS role_name, "
            "inet_server_port() AS server_port, version() AS server_version"
        ))).mappings().one()
        assert identity["database_name"] == DATABASE_NAME
        assert identity["role_name"] == exact_disposable_database.username
        assert identity["server_port"] == 55446
    case.evidence["database_identity"] = dict(identity)
    case.evidence["review_test"] = request.node.name
    case.evidence["review_test_sha256"] = hashlib.sha256(
        Path(__file__).read_bytes()
    ).hexdigest()
    try:
        yield case
    finally:
        (tmp_path / "backfill-inline-revocation-receipt.json").write_text(
            json.dumps(case.evidence, indent=2, default=str) + "\n"
        )


async def historical_inline_source(case):
    result = await post_batch(case.env, [session_record(
        case.env, "backfill-inline-lock-" + uuid.uuid4().hex,
        [declaration(INLINE_TEXT.encode(), delivery="inline")],
    )])
    assert result["rejected"] == []
    [ack] = result["contents"]
    assert ack["outcome"] == "available"
    content_id = uuid.UUID(ack["content_id"])
    async with case.factory() as db:
        content = await db.get(AgentSessionContent, content_id)
        assert content is not None and content.state == "available"
        assert content.inline_text == INLINE_TEXT
        source = {
            "content_id": content_id,
            "content_ids": [content_id],
            "session_id": content.session_id,
            "path": f"/api/workspaces/{case.env['slug']}/sessions/{content.session_id}",
        }
    available = await case.env["client"].get(
        f"{source['path']}/contents/{content_id}/body"
    )
    assert available.status_code == 200
    assert available.json()["text"] == INLINE_TEXT
    positive = await search(case.env["client"], source["path"], NEEDLE.casefold())
    [hit] = positive["items"]
    assert hit["content_id"] == str(content_id)
    exact_match(hit, INLINE_TEXT, NEEDLE)
    assert positive["coverage"]["index_ready"] is True
    # Delete only the real derived index to model retained old-writer content.
    # The real content and existing generation remain, so a later increment
    # cannot be hidden by replacing the whole session or resetting generation.
    async with case.factory.begin() as db:
        removed = await db.execute(delete(SessionSearchSource).where(
            SessionSearchSource.content_id == content_id
        ))
        assert removed.rowcount == 1
    historical = await search(case.env["client"], source["path"], NEEDLE.casefold())
    assert historical["items"] == []
    assert historical["generation"] == positive["generation"]
    assert historical["coverage"]["pending_index"] == {
        "count": 1, "bytes": len(INLINE_TEXT.encode()),
    }
    case.evidence["observations"].append({
        "kind": "real_inline_index_then_derived_only_removal",
        "available_body_bytes": len(INLINE_TEXT.encode()),
        "indexed_hit_count": len(positive["items"]),
        "historical_hit_count": len(historical["items"]),
        "before_generation": positive["generation"],
        "retained_generation": historical["generation"],
    })
    return source


def raw_inline_column(expression):
    while isinstance(expression, (Label, Cast, TypeCoerce)):
        expression = (
            expression.element if isinstance(expression, Label) else expression.clause
        )
    return AgentSessionContent.__table__.c.inline_text in expression.proxy_set


@contextmanager
def observe_inline_materialization(case, source, state):
    observed = {"completed_body_selects": [], "loaded_bodies": []}
    case.evidence["inline_materialization"] = observed
    engine = case.factory.kw["bind"].sync_engine

    def completed_select(_connection, _cursor, _sql, _parameters, context, _many):
        statement = getattr(context.compiled, "statement", None)
        if statement is None or not getattr(statement, "is_select", False):
            return
        if any(raw_inline_column(column) for column in statement.selected_columns):
            observed["completed_body_selects"].append(dict(state))

    def loaded(content, _context):
        if (
            content.id == source["content_id"]
            and "inline_text" not in inspect(content).unloaded
        ):
            # Observe loaded state without reading or recording the body value.
            observed["loaded_bodies"].append(dict(state))

    event.listen(engine, "after_cursor_execute", completed_select)
    event.listen(AgentSessionContent, "load", loaded, restore_load_context=True)
    try:
        yield observed
    finally:
        event.remove(engine, "after_cursor_execute", completed_select)
        event.remove(AgentSessionContent, "load", loaded)


@asynccontextmanager
async def content_blocker(case, source):
    async with case.factory() as db:
        transaction = await db.begin()
        try:
            pid = await db.scalar(text("SELECT pg_backend_pid()"))
            locked = await db.scalar(select(AgentSessionContent.id).where(
                AgentSessionContent.id == source["content_id"]
            ).with_for_update())
            assert locked == source["content_id"]
            yield pid
        finally:
            if transaction.is_active:
                await transaction.rollback()


async def revoke_membership(case):
    async with case.factory.begin() as db:
        pid = await db.scalar(text("SELECT pg_backend_pid()"))
        removed = await db.execute(delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == case.env["workspace_id"],
            WorkspaceMember.user_id == case.env["owner_id"],
        ))
        assert removed.rowcount == 1
    # Return only after this independent transaction has committed.
    return pid


@pytest.mark.parametrize(
    "revoke", [False, True], ids=["authorized-control", "revoked-while-waiting"]
)
async def test_postgres_inline_content_lock_rechecks_membership_before_body_read(
    inline_backfill_pg, revoke,
):
    case = inline_backfill_pg
    source = await historical_inline_source(case)
    started = await case.start()
    before = await case.snapshot(started, source)
    assert before["sources"] == [] and before["chunks"] == 0
    assert before["generation"] is not None and before["generation"] > 0
    state = {"after_lock_barrier": False, "membership_revoked": False}
    worker = barrier = None
    with observe_inline_materialization(case, source, state) as bodies:
        try:
            async with content_blocker(case, source) as blocker_pid:
                worker = asyncio.create_task(attempt_source(case, started, source_limit=1))
                barrier = asyncio.create_task(actual_waiter(case, blocker_pid))
                await asyncio.wait({worker, barrier}, return_when=asyncio.FIRST_COMPLETED)
                if worker.done():
                    worker.result()
                    pytest.fail("Worker completed before the actual content-row lock barrier")
                waiter = await barrier
                assert not worker.done()
                assert bodies["completed_body_selects"] == bodies["loaded_bodies"] == []
                if revoke:
                    revoker_pid = await asyncio.wait_for(
                        revoke_membership(case), BARRIER_SECONDS
                    )
                    assert revoker_pid not in {blocker_pid, waiter["pid"]}
                    still_waiting = await actual_waiter(case, blocker_pid)
                    assert still_waiting["pid"] == waiter["pid"]
                    async with case.factory() as db:
                        assert await db.get(WorkspaceMember, (
                            case.env["workspace_id"], case.env["owner_id"],
                        )) is None
                    state["membership_revoked"] = True
                    case.evidence["observations"].append({
                        "kind": "membership_commit_before_content_unlock",
                        "worker_pid": waiter["pid"], "blocker_pid": blocker_pid,
                        "revoker_pid": revoker_pid,
                    })
                state["after_lock_barrier"] = True
            result = await asyncio.wait_for(asyncio.shield(worker), BARRIER_SECONDS)
        finally:
            for task in (worker, barrier):
                if task is not None and not task.done():
                    task.cancel()
            await asyncio.gather(
                *(task for task in (worker, barrier) if task is not None),
                return_exceptions=True,
            )
    after = await case.snapshot(started, source)
    case.evidence["settlement"] = {
        "revoked": revoke,
        "before": before,
        "after": after,
        "pass": result,
    }
    assert result["exit_code"] in {0, 10}
    assert result["pass"]["sources_attempted"] == 1
    assert after["claims"] == []
    assert result["pass"]["stat_calls"] == result["pass"]["read_calls"] == 0
    if revoke:
        assert bodies["completed_body_selects"] == [], "Inline body was selected after known revocation"
        assert bodies["loaded_bodies"] == [], "Inline body reached an ORM instance after known revocation"
        assert after["sources"] == [] and after["chunks"] == 0
        assert after["generation"] == before["generation"]
        assert result["progress"]["outcomes"]["owner_not_member"] == 1
        assert result["progress"]["outcomes"]["indexed"] == 0
        assert result["pass"]["reserved_bytes"] == 0
        denied_search = await case.env["client"].post(
            f"{source['path']}/search", json={"q": NEEDLE.casefold()}
        )
        denied_body = await case.env["client"].get(
            f"{source['path']}/contents/{source['content_id']}/body"
        )
        assert denied_search.status_code == denied_body.status_code == 403
        assert NEEDLE not in denied_search.text + denied_body.text
    else:
        assert bodies["completed_body_selects"] and bodies["loaded_bodies"]
        assert all(row == state for rows in bodies.values() for row in rows)
        assert len(after["sources"]) == 1 and after["sources"][0][2] == "indexed"
        assert after["chunks"] > 0 and after["generation"] > before["generation"]
        assert result["progress"]["outcomes"]["indexed"] == 1
        assert result["progress"]["outcomes"]["owner_not_member"] == 0
        page = await search(case.env["client"], source["path"], NEEDLE.casefold())
        [hit] = page["items"]
        assert hit["content_id"] == str(source["content_id"])
        exact_match(hit, INLINE_TEXT, NEEDLE)
