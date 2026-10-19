# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B01 review regressions across committed PostgreSQL changes and real reads.

Run serially against the existing disposable migrated capture database. The
integration owner runs this file; authoring it is not PostgreSQL qualification.
"""

import asyncio
import uuid
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import delete, func, select, text, update

from app import database
from app.models.agent_session import AgentSessionContent
from app.models.session_search import (
    SessionSearchChunk,
    SessionSearchSource,
    SessionSearchState,
)
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.services import session_search as search_module
from app.services.session_search_index import (
    SessionSearchIndexWriter,
    SessionSearchObjectProcessor,
)
from app.services.storage.session_content import LocalContentStore, store_for
from tests.rich_capture import declaration, rich_record, upload
from tests.test_agent_sessions import outcome
from tests.test_session_calls import call_started
from tests.test_session_content_postgres import (
    pg as capture_postgres_fixture,
    post_batch,
)
from tests.test_session_search import SNIPPET_BYTES, exact_match, search

pytestmark = [pytest.mark.slow, pytest.mark.usefixtures("content_storage")]
pg = capture_postgres_fixture
READ_BARRIER_SECONDS = 5
MARKER = "LIFECYCLE_PRIVATE_MARKER"
BODY = MARKER.encode() + b"." * 20_000
OTHER_BODY = b"b"


@pytest.fixture
async def isolated_pg(pg, monkeypatch):
    # Request overrides alone do not bind background sessions. This fixture
    # supplies a real committed factory; it never replaces the processor.
    monkeypatch.setattr(database, "async_session", pg["factory"])
    return pg


async def indexed_object(env, body=BODY, *, call_id=None):
    native_session = "review-" + uuid.uuid4().hex
    events = []
    if call_id is not None:
        started = call_started(call_id, 1, tool="get_note", arguments={"scope": "work"})
        started["timestamp"] = "2026-10-08T14:04:18Z"
        started["session"]["id"] = native_session
        started["mcp"] = {"server": "backplane", "tool": "get_note"}
        events.append(started)
    result = await post_batch(
        env,
        [
            rich_record(
                env["mapping_id"],
                [
                    declaration(body, delivery="upload", order=1, call_id=call_id),
                    declaration(OTHER_BODY, order=2),
                ],
                events=events,
                native_session_id=native_session,
            )
        ],
    )
    assert result["rejected"] == [], result
    uploaded, inline = result["contents"]
    assert uploaded["outcome"] == "upload_required"
    assert inline["outcome"] == "available"
    settled = await upload(env["client"], env, uploaded, body)
    assert settled["state"] == "available", settled
    content_id = uuid.UUID(uploaded["content_id"])
    async with env["factory"].begin() as db:
        content = await db.get(AgentSessionContent, content_id)
        session_id, backend, key = (
            content.session_id,
            content.storage_backend,
            content.storage_key,
        )
        status = await db.scalar(
            select(SessionSearchSource.status).where(
                SessionSearchSource.content_id == content_id
            )
        )
        assert status == "indexed", (
            "Actual post-commit processing must populate the index"
        )
    path = f"/api/workspaces/{env['slug']}/sessions/{session_id}"
    body_read = await env["client"].get(f"{path}/contents/{content_id}/body")
    assert body_read.status_code == 200, body_read.text
    assert body_read.json()["text"].encode() == body
    return {
        "path": path,
        "content_id": content_id,
        "inline_id": uuid.UUID(inline["content_id"]),
        "session_id": session_id,
        "backend": backend,
        "key": key,
    }


@asynccontextmanager
async def held_search(env, source, monkeypatch, *, query=MARKER, **options):
    """Return actual stored bytes only after the independent mutation commits."""
    entered, released = asyncio.Event(), asyncio.Event()
    original_stored = search_module.stored

    async def hold_ranged_result(operation, *args):
        result = await original_stored(operation, *args)
        if operation.__name__ == "read" and args[0] == source["key"]:
            assert 0 < args[2] <= SNIPPET_BYTES
            entered.set()
            await released.wait()
        return result

    with monkeypatch.context() as patch:
        patch.setattr(search_module, "stored", hold_ranged_result)
        request = asyncio.create_task(
            env["client"].post(
                f"{source['path']}/search", json={"q": query, **options}
            )
        )
        arrival = asyncio.create_task(entered.wait())
        try:
            await asyncio.wait(
                {request, arrival},
                timeout=READ_BARRIER_SECONDS,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not entered.is_set():
                if request.done():
                    response = request.result()
                    pytest.fail(
                        f"No held object read: HTTP {response.status_code}: {response.text}"
                    )
                pytest.fail("Search did not reach its actual bounded storage read")
            yield request
        finally:
            released.set()
            arrival.cancel()
            await asyncio.gather(arrival, return_exceptions=True)
            if not request.done():
                await asyncio.wait_for(request, READ_BARRIER_SECONDS)


def assert_private_response(response):
    assert response.headers["cache-control"] == "private, no-store"
    assert response.request.url.query == b""


async def source_index_state(factory, source):
    async with factory.begin() as db:
        generation = await db.scalar(
            select(SessionSearchState.generation).where(
                SessionSearchState.session_id == source["session_id"]
            )
        )
        status = await db.scalar(
            select(SessionSearchSource.status).where(
                SessionSearchSource.content_id == source["content_id"]
            )
        )
        chunks = await db.scalar(
            select(func.count())
            .select_from(SessionSearchChunk)
            .join(SessionSearchSource)
            .where(SessionSearchSource.content_id == source["content_id"])
        )
        pid = await db.scalar(text("SELECT pg_backend_pid()"))
        return generation, status, chunks, pid


async def test_committed_finalize_runs_actual_processor_in_disposable_database(
    isolated_pg,
):
    source = await indexed_object(isolated_pg)
    page = await search(isolated_pg["client"], source["path"], MARKER)
    [hit] = page["items"]
    exact_match(hit, BODY.decode(), MARKER)
    assert page["coverage"]["indexed"] == {
        "count": 2,
        "bytes": len(BODY) + len(OTHER_BODY),
    }
    assert page["coverage"]["pending_index"] == {"count": 0, "bytes": 0}
    assert page["coverage"]["index_ready"] is True


@pytest.mark.parametrize("change", ["unchanged", "retract", "delete"])
async def test_current_coverage_survives_source_change_during_object_read(
    isolated_pg, monkeypatch, change
):
    source = await indexed_object(isolated_pg)
    before = await search(isolated_pg["client"], source["path"], MARKER)
    assert len(before["items"]) == 1
    exact_match(before["items"][0], BODY.decode(), MARKER)
    assert before["coverage"]["indexed"]["count"] == 2

    async with held_search(isolated_pg, source, monkeypatch) as request:
        if change != "unchanged":
            async with isolated_pg["factory"].begin() as concurrent:
                if change == "delete":
                    await concurrent.execute(
                        delete(AgentSessionContent).where(
                            AgentSessionContent.id == source["content_id"]
                        )
                    )
                else:
                    await concurrent.execute(
                        update(AgentSessionContent)
                        .where(AgentSessionContent.id == source["content_id"])
                        .values(
                            state="recorded",
                            coverage="source_unavailable",
                            coverage_reason="source_replaced",
                            storage_key=None,
                            storage_backend=None,
                        )
                    )
    response = request.result()
    assert response.status_code == 200, response.text
    assert_private_response(response)
    page = response.json()
    if change == "unchanged":
        exact_match(page["items"][0], BODY.decode(), MARKER)
    else:
        assert MARKER not in response.text
        assert all(hit["snippet"] is None for hit in page["items"])
    expected_indexed = {
        "count": 2 if change == "unchanged" else 1,
        "bytes": len(OTHER_BODY) + (len(BODY) if change == "unchanged" else 0),
    }
    assert page["coverage"]["indexed"] == expected_indexed
    assert page["coverage"]["eligible"] == expected_indexed
    assert page["coverage"]["unavailable"] == {
        "count": 1 if change == "retract" else 0,
        "bytes": len(BODY) if change == "retract" else 0,
    }
    for bucket in page["coverage"].values():
        if isinstance(bucket, dict) and "bytes" in bucket:
            assert bucket["count"] >= 0
            assert bucket["bytes"] is None or bucket["bytes"] >= 0
    other = await search(isolated_pg["client"], source["path"], "b")
    assert {hit["source_id"] for hit in other["items"]} == {str(source["inline_id"])}


@pytest.mark.parametrize("settlement", ["commit", "rollback"])
async def test_chunk_removal_generation_is_atomic_and_retry_is_idempotent(
    isolated_pg, settlement
):
    source = await indexed_object(isolated_pg)
    before = await source_index_state(isolated_pg["factory"], source)
    assert before[0] > 0 and before[1] == "indexed" and before[2] > 0
    store_for(source["backend"]).delete(source["key"])
    prepared = await SessionSearchObjectProcessor(isolated_pg["factory"]).prepare_source(
        source["content_id"]
    )
    assert prepared.outcome == "missing_object"
    async with isolated_pg["factory"]() as writer_db:
        transaction = await writer_db.begin()
        writer_pid = await writer_db.scalar(text("SELECT pg_backend_pid()"))
        await SessionSearchIndexWriter(writer_db).index_prepared_source(prepared)
        assert writer_db.in_transaction(), "Source writer must not commit its caller"
        during = await source_index_state(isolated_pg["factory"], source)
        assert during[3] != writer_pid
        assert during[:3] == before[:3]
        if settlement == "commit":
            await transaction.commit()
        else:
            await transaction.rollback()
    after = await source_index_state(isolated_pg["factory"], source)
    if settlement == "rollback":
        assert after[:3] == before[:3]
        return
    assert after[1:3] == ("unavailable", 0)
    async with isolated_pg["factory"].begin() as retry_db:
        await SessionSearchIndexWriter(retry_db).index_prepared_source(prepared)
    repeated = await source_index_state(isolated_pg["factory"], source)
    assert repeated[:3] == after[:3], "The same unavailable outcome is a no-op"
    assert after[0] > before[0], "Committed chunk removal must advance generation"


async def test_multiple_hits_stat_each_object_once_with_bounded_reads(
    isolated_pg, monkeypatch
):
    needle = "MULTI_HIT_MARKER"
    body = ((needle + " ") * 5).encode() + b"." * 20_000
    source = await indexed_object(isolated_pg, body)
    stats, ranges = [], []
    original_stat, original_read = LocalContentStore.stat, LocalContentStore.read

    def record_stat(store, key):
        stats.append(key)
        return original_stat(store, key)

    def record_range(store, key, offset=0, length=None):
        assert length is not None and 0 < length <= SNIPPET_BYTES
        ranges.append((key, offset, length))
        return original_read(store, key, offset, length)

    monkeypatch.setattr(LocalContentStore, "stat", record_stat)
    monkeypatch.setattr(LocalContentStore, "read", record_range)
    page = await search(isolated_pg["client"], source["path"], needle)
    assert len(page["items"]) == 5
    for index, hit in enumerate(page["items"]):
        exact_match(hit, body.decode(), needle, start=index * (len(needle) + 1))
    assert len(ranges) == 5
    assert {key for key, _, _ in ranges} == {source["key"]}
    assert stats == [source["key"]], "A source's five hits share one stat operation"


@asynccontextmanager
async def linked_note(env, source, call_id):
    target_id = uuid.uuid4()
    target_slug = "search-work-" + target_id.hex
    async with env["factory"].begin() as db:
        db.add(
            Workspace(
                id=target_id,
                name="Synthetic linked-work target",
                slug=target_slug,
                created_by=env["owner_id"],
            )
        )
        await db.flush()
        db.add(
            WorkspaceMember(
                workspace_id=target_id,
                user_id=env["owner_id"],
                role=WorkspaceRole.owner,
            )
        )
    try:
        base = f"/api/workspaces/{target_slug}/notes"
        created = await env["client"].post(
            base, json={"title": "Current linked target", "content": "Target evidence"}
        )
        assert created.status_code == 201, created.text
        note_path = f"{base}/{created.json()['id']}"
        invocation_id = uuid.uuid4()
        read = await env["client"].get(
            note_path, headers={"X-Backplane-Invocation-ID": str(invocation_id)}
        )
        assert read.status_code == 200, read.text
        recorded = await env["client"].post(
            "/api/me/mcp-invocations",
            json=outcome(
                invocation_id,
                tool_name="get_note",
                workspace_slug=target_slug,
                native_call_id=call_id,
                started_at="2026-10-08T14:04:18Z",
                completed_at="2026-10-08T14:04:19Z",
            ),
        )
        assert recorded.status_code == 200, recorded.text
        calls = await env["client"].get(
            f"{source['path']}/calls", params={"filter": "work"}
        )
        assert calls.status_code == 200, calls.text
        assert {item["call_id"] for item in calls.json()["items"]} == {call_id}
        yield target_id, note_path
    finally:
        async with env["factory"].begin() as db:
            await db.execute(delete(Workspace).where(Workspace.id == target_id))


@pytest.mark.parametrize("change", ["delete_note", "revoke_work_membership"])
async def test_work_only_rechecks_current_eligibility_after_object_read(
    isolated_pg, monkeypatch, change
):
    call_id = "toolu_work_" + uuid.uuid4().hex
    source = await indexed_object(isolated_pg, call_id=call_id)
    async with linked_note(isolated_pg, source, call_id) as (target_id, note_path):
        control = await search(
            isolated_pg["client"], source["path"], MARKER, work_only=True
        )
        assert len(control["items"]) == 1
        exact_match(control["items"][0], BODY.decode(), MARKER)
        async with held_search(
            isolated_pg, source, monkeypatch, work_only=True
        ) as request:
            if change == "delete_note":
                deleted = await isolated_pg["client"].delete(note_path)
                assert deleted.status_code == 204, deleted.text
            else:
                async with isolated_pg["factory"].begin() as db:
                    await db.execute(
                        delete(WorkspaceMember).where(
                            WorkspaceMember.workspace_id == target_id,
                            WorkspaceMember.user_id == isolated_pg["owner_id"],
                        )
                    )
        response = request.result()
        assert_private_response(response)
        # A restart response or a freshly empty result both respect the final
        # live filter. The still-owned body itself has not become unavailable.
        assert response.status_code in (200, 409), response.text
        if response.status_code == 409:
            assert response.json()["error_code"] == "session_search_stale"
        else:
            assert response.json()["items"] == []
        assert MARKER not in response.text
        refreshed = await search(
            isolated_pg["client"], source["path"], MARKER, work_only=True
        )
        assert refreshed["items"] == []
        unfiltered = await search(isolated_pg["client"], source["path"], MARKER)
        exact_match(unfiltered["items"][0], BODY.decode(), MARKER)


async def test_owner_membership_loss_during_read_denies_private_response(
    isolated_pg, monkeypatch
):
    source = await indexed_object(isolated_pg)
    control = await search(isolated_pg["client"], source["path"], MARKER)
    exact_match(control["items"][0], BODY.decode(), MARKER)
    async with held_search(isolated_pg, source, monkeypatch) as request:
        async with isolated_pg["factory"].begin() as db:
            await db.execute(
                delete(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == isolated_pg["workspace_id"],
                    WorkspaceMember.user_id == isolated_pg["owner_id"],
                )
            )
    response = request.result()
    assert response.status_code == 403, response.text
    assert_private_response(response)
    assert MARKER not in response.text
    assert "items" not in response.json()
    assert "coverage" not in response.json()
