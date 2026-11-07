# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Actual verification-query plans over a synthetic 10,001-source corpus.

This measures two bounded repository reads, not a whole backfill epoch or the
deployed corpus. Query plans and timings are observations, not latency gates.
"""

import hashlib
import json
import uuid
from pathlib import Path
from time import perf_counter

import pytest
from sqlalchemy import func, insert, select, text, update
from sqlalchemy.engine import make_url

from app.config import settings
from app.models.agent_session import AgentSession, AgentSessionContent
from app.models.companion import CompanionInstallation
from app.models.session_search import SessionSearchChunk, SessionSearchSource
from app.repositories.session_search_backfill import SessionSearchBackfillRepository
from app.services.session_search_index import (
    SessionSearchIndexWriter,
    SessionSearchObjectProcessor,
)
from app.services.session_search_text import EXTRACTOR_VERSION
from app.services.storage.session_content import LocalContentStore
from tests.rich_capture import declaration
from tests.services.test_session_search_backfill import BodyIO
from tests.test_session_content_postgres import database_url, post_batch, session_record
from tests.test_session_search_backfill_plans_postgres import (
    assert_no_body_projection,
    capture_selects,
    explain_metadata,
)
from tests.test_session_search_backfill_postgres import (
    BODY,
    backfill_pg as backfill_pg_fixture,
    paused_object_indexing as paused_object_indexing_fixture,
    pg as capture_postgres_fixture,
)

pg = capture_postgres_fixture
backfill_pg = backfill_pg_fixture
paused_object_indexing = paused_object_indexing_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]
DATABASE_NAME = "session_search_backfill_b01h_20261019"
SETTLED_COUNT = 10_000
PAGE_SIZE = 200
BATCH_SIZE = 500
HIGH_ID = uuid.UUID(int=(1 << 128) - 1)
INLINE_TEXT = "Synthetic settled verification plan control"


@pytest.fixture(autouse=True)
def exact_disposable_database():
    # Autouse validates the explicit target before the imported PG fixture
    # connects. Missing opt-in skips normally, and fails the required PG leg.
    url = make_url(database_url())
    assert url.drivername == "postgresql+asyncpg"
    assert url.host == "127.0.0.1" and url.port == 55446
    assert url.database == DATABASE_NAME
    assert url.username, "Root must supply its disposable database role"
    return url


@pytest.fixture
async def verification_plan_case(
    backfill_pg,
    exact_disposable_database,
    monkeypatch,
    tmp_path,
    request,
):
    case = backfill_pg
    async with case.factory() as db:
        identity = (
            (
                await db.execute(
                    text(
                        "SELECT current_database() AS database_name, current_user AS role_name, "
                        "inet_server_port() AS server_port, version() AS server_version"
                    )
                )
            )
            .mappings()
            .one()
        )
        assert identity["database_name"] == DATABASE_NAME
        assert identity["role_name"] == exact_disposable_database.username
        assert identity["server_port"] == 55446
        # The global query must see only this known corpus. Never clean up
        # another test's leftovers merely to manufacture these preconditions.
        assert (
            await db.scalar(select(func.count()).select_from(AgentSessionContent)) == 0
        )
        assert (
            await db.scalar(select(func.count()).select_from(SessionSearchSource)) == 0
        )
    case.io = BodyIO(monkeypatch)
    case.evidence["verification_plan"] = {
        "test": request.node.name,
        "test_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "database_identity": dict(identity),
        "source_sha256": {
            name: hashlib.sha256(
                (Path(__file__).resolve().parents[1] / name).read_bytes()
            ).hexdigest()
            for name in (
                "app/repositories/session_search_backfill.py",
                "app/services/session_search_backfill.py",
                "app/services/session_search_index.py",
            )
        },
    }
    try:
        yield case
    finally:
        (tmp_path / "backfill-verification-plan-receipt.json").write_text(
            json.dumps(case.evidence, indent=2, default=str) + "\n"
        )


async def seed_verification_corpus(case):
    source = await case.source()
    async with case.factory.begin() as db:
        original = await db.get(AgentSessionContent, source["content_id"])
        object_values = {
            column.name: getattr(original, column.name)
            for column in AgentSessionContent.__table__.columns
        }
        await db.delete(original)
        await db.flush()
        db.add(
            AgentSessionContent(
                **{
                    **object_values,
                    "id": HIGH_ID,
                    "content_key": hashlib.sha256(HIGH_ID.bytes).hexdigest(),
                }
            )
        )
    LocalContentStore(settings.LOCAL_STORAGE_DIR).delete(object_values["storage_key"])
    missing = await SessionSearchObjectProcessor(case.factory).prepare_source(HIGH_ID)
    assert missing.outcome == "missing_object"
    async with case.factory.begin() as db:
        assert (
            await SessionSearchIndexWriter(db).index_prepared_source(missing)
            == "unavailable"
        )

    result = await post_batch(
        case.env,
        [
            session_record(
                case.env,
                "verification-plan-inline-" + uuid.uuid4().hex,
                [declaration(INLINE_TEXT.encode(), delivery="inline")],
            )
        ],
    )
    assert result["rejected"] == []
    [ack] = result["contents"]
    assert ack["outcome"] == "available"
    template_id = uuid.UUID(ack["content_id"])
    async with case.factory.begin() as db:
        template = await db.get(AgentSessionContent, template_id)
        assert template is not None and template.inline_text == INLINE_TEXT
        content_values = {
            column.name: getattr(template, column.name)
            for column in AgentSessionContent.__table__.columns
        }
        indexed = await db.scalar(
            select(SessionSearchSource).where(
                SessionSearchSource.content_id == template_id
            )
        )
        assert indexed is not None and indexed.status == "indexed"
        assert indexed.extractor_version == EXTRACTOR_VERSION
        assert indexed.source_digest == hashlib.sha256(INLINE_TEXT.encode()).hexdigest()
        source_values = {
            column.name: getattr(indexed, column.name)
            for column in SessionSearchSource.__table__.columns
        }
        chunks = list(
            await db.scalars(
                select(SessionSearchChunk)
                .where(SessionSearchChunk.source_id == indexed.id)
                .order_by(SessionSearchChunk.ordinal)
            )
        )
        assert indexed.chunk_count == len(chunks) == 1
        assert chunks[0].folded_text == INLINE_TEXT.casefold()
        chunk_values = {
            column.name: getattr(chunks[0], column.name)
            for column in SessionSearchChunk.__table__.columns
        }
        await db.delete(template)
        await db.flush()

        # Clone a real indexed inline record and its exact chunk, changing only
        # source identities/order. This is bulk synthetic plan data, not a claim
        # that ingestion or a backfill pass processed ten thousand objects.
        for first in range(1, SETTLED_COUNT + 1, BATCH_SIZE):
            contents, sources, indexed_chunks = [], [], []
            for ordinal in range(first, min(first + BATCH_SIZE, SETTLED_COUNT + 1)):
                content_id, source_id = uuid.UUID(int=ordinal), uuid.uuid4()
                contents.append(
                    {
                        **content_values,
                        "id": content_id,
                        "content_key": hashlib.sha256(content_id.bytes).hexdigest(),
                        "source_order": ordinal,
                    }
                )
                sources.append(
                    {
                        **source_values,
                        "id": source_id,
                        "content_id": content_id,
                    }
                )
                indexed_chunks.append(
                    {
                        **chunk_values,
                        "id": uuid.uuid4(),
                        "source_id": source_id,
                        "sort_order": ordinal,
                    }
                )
            await db.execute(insert(AgentSessionContent), contents)
            await db.execute(insert(SessionSearchSource), sources)
            await db.execute(insert(SessionSearchChunk), indexed_chunks)
        await db.execute(
            update(AgentSession)
            .where(AgentSession.id == template.session_id)
            .values(
                content_count=SETTLED_COUNT,
                content_bytes=SETTLED_COUNT * len(INLINE_TEXT.encode()),
            )
        )
        await db.execute(
            update(CompanionInstallation)
            .where(CompanionInstallation.id == case.env["installation_id"])
            .values(content_bytes=SETTLED_COUNT * len(INLINE_TEXT.encode()) + len(BODY))
        )

    case.evidence["verification_plan"]["fixture"] = {
        "owner_id": case.env["owner_id"],
        "workspace_id": case.env["workspace_id"],
        "object_session_id": source["session_id"],
        "inline_session_id": content_values["session_id"],
        "settled_content_uuid_range": [
            str(uuid.UUID(int=1)),
            str(uuid.UUID(int=SETTLED_COUNT)),
        ],
        "unavailable_content_id": HIGH_ID,
        "seeded_indexed_rows": SETTLED_COUNT,
        "seeded_matching_chunk_rows": SETTLED_COUNT,
        "real_writer_unavailable_rows": 1,
        "inline_bytes_per_row": len(INLINE_TEXT.encode()),
        "object_declared_bytes": len(BODY),
    }


async def test_postgres_verification_limits_content_keys_before_unavailable_join_filter(
    verification_plan_case,
):
    case = verification_plan_case
    evidence = case.evidence["verification_plan"]
    engine = case.factory.kw["bind"]
    await seed_verification_corpus(case)
    async with case.factory.begin() as db:
        assert (
            await db.scalar(select(func.count()).select_from(AgentSessionContent))
            == SETTLED_COUNT + 1
        )
        status_counts = dict(
            (
                await db.execute(
                    select(SessionSearchSource.status, func.count()).group_by(
                        SessionSearchSource.status
                    )
                )
            ).all()
        )
        assert status_counts == {"indexed": SETTLED_COUNT, "unavailable": 1}
        assert (
            await db.scalar(select(func.count()).select_from(SessionSearchChunk))
            == SETTLED_COUNT
        )
        for table in (
            "agent_sessions",
            "agent_session_contents",
            "session_search_sources",
            "workspace_members",
        ):
            await db.execute(text(f'ANALYZE "{table}"'))
    evidence["corpus"] = {
        "content_rows": SETTLED_COUNT + 1,
        "source_rows": SETTLED_COUNT + 1,
        "source_status_counts": status_counts,
        "chunk_rows": SETTLED_COUNT,
    }
    case.io.clear()
    captured, observations = [], []
    evidence["queries"], evidence["windows"] = captured, observations
    windows = (
        (None, [uuid.UUID(int=ordinal) for ordinal in range(1, PAGE_SIZE + 1)]),
        (
            uuid.UUID(int=SETTLED_COUNT - PAGE_SIZE + 1),
            [
                uuid.UUID(int=ordinal)
                for ordinal in range(SETTLED_COUNT - PAGE_SIZE + 2, SETTLED_COUNT + 1)
            ]
            + [HIGH_ID],
        ),
    )
    actual_windows = []
    for after, expected in windows:
        started_at = perf_counter()
        with capture_selects(engine) as queries:
            async with case.factory() as db:
                candidates = await SessionSearchBackfillRepository(
                    db
                ).content_candidates(
                    after=after,
                    upper=HIGH_ID,
                    limit=PAGE_SIZE,
                    recorded_unavailable_in=EXTRACTOR_VERSION,
                )
        elapsed_ms = (perf_counter() - started_at) * 1000
        captured.extend(queries)
        actual_windows.append(candidates)
        observations.append(
            {
                "after": after,
                "upper": HIGH_ID,
                "limit": PAGE_SIZE,
                "returned_keys": [row.id for row in candidates],
                "returned_count": len(candidates),
                "distinct_key_count": len({row.id for row in candidates}),
                "current_member_count": sum(row.member for row in candidates),
                "unavailable_join_matches": sum(
                    row.index_status == "unavailable" for row in candidates
                ),
                "elapsed_ms_observation_only": elapsed_ms,
            }
        )
        assert len(queries) == 1, "Measure the actual single repository SELECT"
        assert_no_body_projection(queries)
        assert len(candidates) == len({row.id for row in candidates}) == PAGE_SIZE
        assert [row.id for row in candidates] == expected
        assert all(row.member for row in candidates)
        assert case.io.stats == case.io.reads == []

    first, last = actual_windows
    assert all(
        row.inline and row.inline_bytes == len(INLINE_TEXT.encode()) for row in first
    )
    assert all(
        row.index_status is row.index_version is row.index_digest is None
        for row in first
    )
    assert all(row.index_status is None for row in last[:-1])
    assert last[-1].id == HIGH_ID and last[-1].index_status == "unavailable"
    assert last[-1].index_version == EXTRACTOR_VERSION
    assert last[-1].index_digest == hashlib.sha256(BODY).hexdigest()
    assert (
        last[-1].has_storage_key
        and not last[-1].inline
        and last[-1].inline_bytes is None
    )

    plans = await explain_metadata(engine, captured)
    evidence["plans"] = plans
    evidence["object_store_calls_during_measurement"] = {
        "stat": len(case.io.stats),
        "read": len(case.io.reads),
    }
    assert len(plans) == len(windows) == 2
    assert all(plan["plan"][0]["Plan"]["Actual Rows"] == PAGE_SIZE for plan in plans)
    assert case.io.stats == case.io.reads == []
