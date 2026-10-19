# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The ordinary SQLite capture fixtures must isolate post-commit sessions too.

This probe stops preparation before opening any database connection. Actual
committed processing is covered in test_session_search_lifecycle_review_postgres.
"""

import uuid

import pytest
from sqlalchemy import select

from app.models.agent_session import AgentSessionContent
from app.models.session_search import SessionSearchSource
from app.services.session_search_index import SessionSearchObjectProcessor
from tests.rich_capture import declaration, enroll_rich, ingest, rich_record, upload

pytestmark = [pytest.mark.slow, pytest.mark.usefixtures("content_storage")]


async def test_generic_capture_fixture_binds_the_postcommit_database_factory(
    client,
    device_client,
    db_session,
    db_engine,
    test_workspace,
    test_board,
    monkeypatch,
):
    attempted_sources, uses_test_database = [], []

    class PreparationProbeStopped(RuntimeError):
        pass

    async def stop_before_database_connect(processor, content_id, **_options):
        attempted_sources.append(content_id)
        uses_test_database.append(
            processor.session_factory.kw.get("bind") is db_engine
        )
        # Both the wrong ambient factory and a correctly bound one stop here.
        # Never depend on the ambient database being absent or unreachable.
        raise PreparationProbeStopped("database factory identity recorded")

    monkeypatch.setattr(
        SessionSearchObjectProcessor, "prepare_source", stop_before_database_connect
    )
    capture = await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )
    body = b"FACTORY_SCOPE_MARKER " * 1500
    result = await ingest(
        device_client,
        capture,
        [rich_record(capture["mapping_id"], [declaration(body)], events=[])],
    )
    assert result["rejected"] == [], result
    [ack] = result["contents"]
    assert ack["outcome"] == "upload_required"
    settled = await upload(device_client, capture, ack, body)
    assert settled["state"] == "available", settled
    content_id = uuid.UUID(ack["content_id"])
    content = await db_session.get(AgentSessionContent, content_id)
    assert content is not None and content.state == "available"
    assert await db_session.scalar(
        select(SessionSearchSource.status).where(
            SessionSearchSource.content_id == content_id
        )
    ) == "pending"
    assert attempted_sources == [content_id], "Real finalize must dispatch processing"
    assert uses_test_database == [True], (
        "The generic get_db override did not bind the post-commit factory to "
        "the same disposable test database; the probe prevented ambient access"
    )
