# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A capped body read must follow the metadata window it is completing."""

import asyncio
import json

import pytest
from sqlalchemy import update

from app.models.session_search import SessionSearchChunk
from app.repositories.session_search import SessionSearchRepository
from tests.test_session_content_postgres import pg as capture_postgres_fixture
from tests.test_session_search import (
    paused_object_indexing as paused_object_indexing_fixture,
    search,
)
from tests.test_session_search_postgres import pg_inline

pg = capture_postgres_fixture
paused_object_indexing = paused_object_indexing_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]


async def test_matching_limit_keeps_frozen_metadata_order_after_reorder(
    pg, monkeypatch, tmp_path
):
    path, session_id, acknowledgements = await pg_inline(
        pg, [b"needle retained body"] * 64, native="matching-order-race"
    )
    baseline = await search(pg["client"], path, "needle", limit=20)
    expected_contents = [item["content_id"] for item in acknowledgements[:20]]
    assert [item["content_id"] for item in baseline["items"]] == expected_contents
    assert baseline["next_cursor"] is not None

    metadata_ready, release = asyncio.Event(), asyncio.Event()
    metadata_ids = []
    original = SessionSearchRepository.scan_window

    async def pause_after_metadata(repo, *args, **kwargs):
        window = await original(repo, *args, **kwargs)
        metadata_ids.extend(chunk.id for chunk in window)
        metadata_ready.set()
        await asyncio.wait_for(release.wait(), timeout=5)
        return window

    monkeypatch.setattr(SessionSearchRepository, "scan_window", pause_after_metadata)
    task = asyncio.create_task(search(pg["client"], path, "needle", limit=20))
    try:
        await asyncio.wait_for(metadata_ready.wait(), timeout=5)
        assert len(metadata_ids) == 64
        async with pg["factory"].begin() as db:
            # A committed reorder is deliberately not a body/digest change.
            # The existing request must still consume its captured metadata
            # prefix, not infer exhaustion from a differently ordered LIMIT.
            await db.execute(
                update(SessionSearchChunk)
                .where(SessionSearchChunk.session_id == session_id)
                .values(sort_order=-SessionSearchChunk.sort_order)
            )
        release.set()
        page = await asyncio.wait_for(task, timeout=5)
    finally:
        release.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    (tmp_path / "matching-order-race.json").write_text(
        json.dumps(
            {
                "metadata_ids": [str(value) for value in metadata_ids],
                "expected_contents": expected_contents,
                "actual_contents": [item["content_id"] for item in page["items"]],
                "expected_cursor": baseline["next_cursor"],
                "actual_cursor": page["next_cursor"],
            },
            indent=2,
        )
    )
    assert page["items"] == baseline["items"]
    assert page["next_cursor"] == baseline["next_cursor"]
    assert page["scanned_bytes"] == baseline["scanned_bytes"]
    assert page["complete"] == baseline["complete"]
