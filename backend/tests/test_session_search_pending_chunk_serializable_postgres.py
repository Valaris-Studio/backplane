# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Requalify the SSI schedule with session-consistent pending source chunks.

The owner A+C invariant supersedes the former cross-session fixture. Preserve
the original-query-first outcome classification; prior native receipts do not
establish the baseline outcome for this new graph.
"""

import json
import uuid

import pytest
from sqlalchemy import func, select, text

from app.models.agent_session import AgentSessionContent as Content
from app.models.session_search import SessionSearchChunk as Chunk
from app.models.session_search import SessionSearchSource as Source
from tests.test_session_search_metadata_serializable_postgres import (
    assert_owned_fresh_relation_history,
    assert_preserved_schedule,
    error_receipt,
    metadata_schedule,
    paused_object_indexing as pause_processor_fixture,
    pg as owned_serializable_database,
    record_database_environment,
    serializable_fixture,
)
from tests.test_session_search_postgres import receipt_path

pg = owned_serializable_database
paused_object_indexing = pause_processor_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]


async def pending_chunk_fixture(pg):
    fixture = await serializable_fixture(pg)
    async with pg["factory"].begin() as db:
        pending_template = await db.get(Source, fixture["unrelated"]["source_id"])
        assert pending_template is not None and pending_template.status == "pending"
        template = await db.scalar(
            select(Chunk)
            .join(Source, Source.id == Chunk.source_id)
            .where(
                Chunk.session_id == fixture["session_id"],
                Source.content_id.is_not(None),
            )
            .order_by(Chunk.ordinal)
            .limit(1)
        )
        assert template is not None
        template_source = await db.get(Source, template.source_id)
        template_content = await db.get(Content, template_source.content_id)
        assert template_content is not None
        content_values = {
            column.name: getattr(template_content, column.name)
            for column in Content.__table__.columns
        }
        content_values.update(id=uuid.uuid4(), content_key=uuid.uuid4().hex * 2)
        content = Content(**content_values)
        db.add(content)
        await db.flush()
        source_values = {
            column.name: getattr(pending_template, column.name)
            for column in Source.__table__.columns
        }
        source_values.update(
            id=uuid.uuid4(),
            session_id=content.session_id,
            content_id=content.id,
            source_digest=content.sha256,
            byte_count=content.byte_count,
        )
        pending = Source(**source_values)
        db.add(pending)
        await db.flush()
        assert pending.session_id == content.session_id == fixture["session_id"]
        assert pending.status == "pending"
        assert pending.folded_bytes == pending.chunk_count == 0
        assert (
            await db.scalar(
                select(func.count())
                .select_from(Chunk)
                .where(Chunk.source_id == pending.id)
            )
            == 0
        )
        values = {
            column.name: getattr(template, column.name)
            for column in Chunk.__table__.columns
        }
        values.update(
            id=uuid.uuid4(), source_id=pending.id, ordinal=template.ordinal + 1
        )
        # Pending excludes this real chunk even though all session identities
        # agree; its cached counters do not make it indexed.
        db.add(Chunk(**values))
        await db.flush()
        counts = (
            await db.execute(
                select(func.count(), func.count(func.distinct(Chunk.source_id))).where(
                    Chunk.session_id == fixture["session_id"]
                )
            )
        ).one()
        assert tuple(counts) == (fixture["chunk_count"] + 1, 3), counts
        fixture["foreign_pending_control"] = fixture["unrelated"]
        fixture["unrelated"] = {
            "id": content.id,
            "state": content.state,
            "coverage": content.coverage,
            "source_id": pending.id,
            "reason": pending.reason,
        }
        fixture["added_pending_chunk"] = {
            "id": values["id"],
            "template_id": template.id,
            "chunk_session_id": values["session_id"],
            "source_id": pending.id,
            "source_session_id": pending.session_id,
            "source_status": pending.status,
            "source_digest": pending.source_digest,
            "source_chunk_count_unchanged": pending.chunk_count,
            "content_id": content.id,
            "content_session_id": content.session_id,
            "ordinal": values["ordinal"],
            "owned_bytes": values["owned_bytes"],
            "target_chunk_count": counts[0],
        }
        for table in (
            "agent_session_contents",
            "session_search_sources",
            "session_search_chunks",
        ):
            await db.execute(text(f"ANALYZE {table}"))
    fixture["write_unrelated_content"] = False
    return fixture


@pytest.mark.timeout(120)
async def test_pending_chunk_fixture_owns_relations_without_inherited_history(pg):
    await assert_owned_fresh_relation_history(pg)


@pytest.mark.timeout(150)
async def test_pending_chunk_eligibility_preserves_baseline_serializable_commits(
    pg, tmp_path
):
    output = receipt_path(tmp_path, "metadata-pending-chunk-serializable-outcomes.json")
    assert (
        not output.exists()
    ), "Use a fresh measurement directory; preserve earlier outcomes"
    receipt = {
        "schedule": "T1 eligibility; T2 marker read; T1 marker write; T2 pending Source.reason write; T1 commit; T2 commit",
        "scope": "Default SearchScope; one actual scoped Chunk references a pending Source and Content in the same target session; expected eligible totals remain unchanged",
        "baseline": "Unchanged original_eligible_totals and metadata_schedule on the same current schema/index set; classify the first invariant-fixture baseline afresh and require its commit before candidate runs; historical cross-session receipts do not qualify this fixture",
        "causal_question": "Does Source-ID lookup followed by status rejection add a predicate on the pending writer that the original indexed-status range does not acquire?",
        "fixture": None,
        "plans": "Participant pg_locks and writer ctid are actual evidence; observer EXPLAIN without ANALYZE is only a replan",
        "controls": "Exactly one added target Content, pending Source and Chunk; consistent session identity and digest, pending counters remain zero; same reason-only writer targets this new Source; no planner-setting or participant-schedule changes, retries or fixture tuning",
        "schedules": [],
    }

    def save():
        output.write_text(json.dumps(receipt, indent=2, default=str) + "\n")

    save()
    try:
        fixture = await pending_chunk_fixture(pg)
    except Exception as error:
        receipt["classification"] = "INCONCLUSIVE_FIXTURE_ERROR"
        receipt["fixture_error"] = error_receipt(error)
        save()
        raise
    receipt["fixture"] = fixture
    await record_database_environment(pg, receipt)
    save()
    for implementation in ("original", "candidate"):
        observation = await metadata_schedule(
            pg, fixture, implementation, receipt, save
        )
        assert_preserved_schedule(observation, fixture, receipt, save, "eligibility")
    receipt["classification"] = "BASELINE_AND_CANDIDATE_COMMITTED"
    save()
