# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Upload preview safety on an explicitly disposable PostgreSQL, run serially."""

import uuid
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.core.session_content_keys import body_key
from app.database import get_db
from app.main import create_app
from app.models.agent_session import AgentSessionContent
from app.models.session_search import (
    SessionSearchChunk,
    SessionSearchSource,
    SessionSearchState,
)
from app.services.session_search_index import (
    SessionSearchIndexWriter,
    SessionSearchObjectProcessor,
)
from app.services.storage.session_content import content_store, stored
from tests.rich_capture import declaration, sha256
from tests.test_session_content_postgres import (
    finalize,
    installation_bytes,
    pg as capture_postgres_fixture,
    post_batch,
    put_body,
    session_record,
)
from tests.test_session_search import (
    exact_match,
    paused_object_indexing as paused_object_indexing_fixture,
    search,
)
from tests.test_session_search_backfill_postgres import (
    attempt_source,
    backfill_pg as backfill_postgres_fixture,
)

pg = capture_postgres_fixture
paused_object_indexing = paused_object_indexing_fixture
backfill_pg = backfill_postgres_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]


async def declare_upload(pg, body):
    result = await post_batch(
        pg,
        [
            session_record(
                pg,
                "finalize-nul-" + uuid.uuid4().hex,
                [
                    declaration(body, delivery="upload", original_byte_count=len(body)),
                ],
            )
        ],
    )
    assert result["rejected"] == []
    [ack] = result["contents"]
    assert ack["outcome"] == "upload_required"
    return uuid.UUID(ack["content_id"])


async def index_snapshot(pg, content_id):
    async with pg["factory"].begin() as db:
        content = await db.get(AgentSessionContent, content_id)
        sources = (
            await db.execute(
                select(
                    SessionSearchSource.id,
                    SessionSearchSource.status,
                    SessionSearchSource.source_digest,
                    SessionSearchSource.chunk_count,
                ).where(SessionSearchSource.content_id == content_id)
            )
        ).all()
        chunks = (
            await db.scalars(
                select(SessionSearchChunk.id)
                .join(
                    SessionSearchSource,
                    SessionSearchSource.id == SessionSearchChunk.source_id,
                )
                .where(SessionSearchSource.content_id == content_id)
                .order_by(SessionSearchChunk.id)
            )
        ).all()
        generation = await db.scalar(
            select(SessionSearchState.generation).where(
                SessionSearchState.session_id == content.session_id
            )
        )
        return sources, chunks, generation


@pytest.mark.parametrize(
    ("body", "expected_preview", "truncated"),
    [
        pytest.param(
            "ordinary café 🙂".encode(), "ordinary café 🙂", False, id="ordinary-utf8"
        ),
        pytest.param(b"\x00AFTER_NUL", "", True, id="nul-at-zero"),
        pytest.param(
            "前🙂 before\x00Straße_AFTER_NUL".encode(),
            "前🙂 before",
            True,
            id="nul-inside-preview",
        ),
        pytest.param(
            b"a" * 2048 + b"x\x00AFTER_NUL", "a" * 2048, True, id="nul-beyond-preview"
        ),
        pytest.param(
            ("a" * 2047 + "🙂 ending").encode(),
            "a" * 2047,
            True,
            id="multibyte-preview-boundary",
        ),
    ],
)
async def test_finalize_preserves_uploaded_bytes_and_safe_preview(
    pg,
    paused_object_indexing,
    body,
    expected_preview,
    truncated,
):
    content_id = await declare_upload(pg, body)
    await put_body(pg, content_id, body)

    response = await finalize(pg, content_id, body)
    assert response.status_code == 200, response.text
    assert response.json()["state"] == "available"

    # A separate transaction observes the committed row, not request-local state.
    async with pg["factory"].begin() as db:
        content = await db.get(AgentSessionContent, content_id)
        assert content.state == "available"
        assert content.preview == expected_preview
        assert content.inline_text is None
        assert content.sha256 == sha256(body)
        assert content.byte_count == content.original_byte_count == len(body)
        assert content.coverage == "captured"
        assert content.owner_id == pg["owner_id"]
        assert content.workspace_id == pg["workspace_id"]
        assert content.installation_id == pg["installation_id"]
        assert content.available_at is not None
        available_at = content.available_at
        key = content.storage_key
        path = f"/api/workspaces/{pg['slug']}/sessions/{content.session_id}"
    assert await stored(content_store().read, key) == body
    assert await installation_bytes(pg) == len(body)

    listed = await pg["client"].get(f"{path}/contents")
    assert listed.status_code == 200, listed.text
    [item] = listed.json()["items"]
    assert item["preview"] == {"text": expected_preview, "truncated": truncated}
    assert item["sha256"] == sha256(body)
    assert item["original_byte_count"] == len(body)
    read = await pg["client"].get(f"{path}/contents/{content_id}/body")
    assert read.status_code == 200, read.text
    assert read.json()["text"].encode() == body
    assert read.json()["total_bytes"] == len(body)
    assert read.json()["next_offset"] is None

    before_retry = await index_snapshot(pg, content_id)
    [source] = before_retry[0]
    assert tuple(source[1:]) == ("pending", sha256(body), 0)
    assert before_retry[1] == []
    assert paused_object_indexing == [str(content_id)]
    retry = await finalize(pg, content_id, body)
    assert retry.status_code == 200, retry.text
    assert retry.json() == response.json()
    assert await index_snapshot(pg, content_id) == before_retry
    assert paused_object_indexing == [str(content_id)]
    async with pg["factory"].begin() as db:
        content = await db.get(AgentSessionContent, content_id)
        assert content.available_at == available_at
        assert content.preview == expected_preview
        assert content.sha256 == sha256(body)
        assert content.byte_count == content.original_byte_count == len(body)
    assert await stored(content_store().read, key) == body
    assert await installation_bytes(pg) == len(body)


async def test_finalize_failure_before_commit_never_publishes_success_or_index_work(
    pg,
    paused_object_indexing,
):
    body = b"before\x00AFTER_NUL_COMMIT_CONTROL"
    content_id = await declare_upload(pg, body)
    await put_body(pg, content_id, body)
    reached_commit = []
    app = create_app()

    async def fail_commit():
        async with pg["factory"]() as db:
            try:
                yield db
                reached_commit.append(True)
                raise RuntimeError("synthetic finalize commit failure")
            finally:
                await db.rollback()

    app.dependency_overrides[get_db] = fail_commit
    async with AsyncClient(
        transport=ASGITransport(app, raise_app_exceptions=False),
        base_url="http://test",
    ) as client:
        response = await client.post(
            f"/api/companion/contents/{content_id}/finalize",
            headers=pg["headers"],
            json={"byte_count": len(body), "sha256": sha256(body)},
        )
    assert response.status_code == 500
    assert reached_commit == [True]
    assert paused_object_indexing == []
    async with pg["factory"].begin() as db:
        content = await db.get(AgentSessionContent, content_id)
        assert content.state == "pending"
        assert content.preview is None
        assert content.sha256 == sha256(body)
        assert content.byte_count == len(body)
        assert (
            await db.scalar(
                select(SessionSearchSource.id).where(
                    SessionSearchSource.content_id == content_id
                )
            )
            is None
        )


async def test_backfill_of_available_nul_object_preserves_exact_anchors_and_chunks(
    backfill_pg,
):
    case = backfill_pg
    pg = case.env
    marker = "Straße_AFTER_NUL_BACKFILL"
    body = ("前🙂 before\x00" + marker + " ending").encode()
    content_id = await declare_upload(pg, body)

    # Model a retained object from an older writer independently of finalize.
    # This is the backfill control, not evidence that upload settlement works.
    async with pg["factory"].begin() as db:
        content = await db.get(AgentSessionContent, content_id)
        key = body_key(content)
        await stored(content_store().put, key, body)
        content.state = "available"
        content.coverage = content.declared_coverage
        content.coverage_reason = content.declared_coverage_reason
        content.preview = "前🙂 before"
        content.storage_backend = content_store().backend
        content.storage_key = key
        content.available_at = datetime.now(timezone.utc)
        path = f"/api/workspaces/{pg['slug']}/sessions/{content.session_id}"

    read = await pg["client"].get(f"{path}/contents/{content_id}/body")
    assert read.status_code == 200, read.text
    assert read.json()["text"].encode() == body
    before = await search(pg["client"], path, marker.casefold())
    assert before["items"] == []
    assert before["coverage"]["pending_index"] == {"count": 1, "bytes": len(body)}

    started = await case.start()
    result = await attempt_source(case, started, source_limit=1)
    assert result["exit_code"] in {0, 10}, result
    assert result["pass"]["sources_attempted"] == 1
    assert result["progress"]["outcomes"]["indexed"] == 1
    page = await search(pg["client"], path, marker.casefold())
    [item] = page["items"]
    assert item["content_id"] == str(content_id)
    exact_match(item, body.decode(), marker)
    assert item["byte_start"] == len("前🙂 before\x00".encode())
    indexed = await index_snapshot(pg, content_id)
    [source] = indexed[0]
    assert tuple(source[1:]) == ("indexed", sha256(body), 1)
    assert len(indexed[1]) == 1

    prepared = await SessionSearchObjectProcessor(pg["factory"]).prepare_source(
        content_id
    )
    assert prepared.outcome == "ready"
    async with pg["factory"].begin() as db:
        assert (
            await SessionSearchIndexWriter(db).index_prepared_source(prepared)
            == "unchanged"
        )
    retry = await finalize(pg, content_id, body)
    assert retry.status_code == 200, retry.text
    assert await index_snapshot(pg, content_id) == indexed
    assert await stored(content_store().read, key) == body
