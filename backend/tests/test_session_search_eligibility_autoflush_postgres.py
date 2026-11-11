# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Keep eligibility reads inside the caller's ORM flush/transaction contract."""

import json
import uuid
from contextlib import nullcontext

import pytest
from sqlalchemy import event, select, text

from app.models.session_search import SessionSearchChunk as Chunk
from app.models.session_search import SessionSearchSource as Source
from app.repositories.session_search import SearchScope, SessionSearchRepository
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_search import paused_object_indexing as pause_processor_fixture
from tests.test_session_search_latency_postgres import original_eligible_totals
from tests.test_session_search_postgres import pg_inline, receipt_path

pg = content_postgres_fixture
paused_object_indexing = pause_processor_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]
BODY = b"autoflush needle"


def pending_state(db):
    return {
        name: sorted(
            [{"model": type(row).__name__, "id": str(row.id)} for row in rows],
            key=lambda row: (row["model"], row["id"]),
        )
        for name, rows in (("dirty", db.dirty), ("new", db.new))
    }


@pytest.mark.timeout(60)
@pytest.mark.parametrize("isolation", ["READ COMMITTED", "SERIALIZABLE"])
@pytest.mark.parametrize("mutation", ["source_status", "added_chunk"])
@pytest.mark.parametrize("autoflush", [True, False], ids=["autoflush", "no_autoflush"])
async def test_eligibility_preserves_caller_autoflush(
    pg, tmp_path, isolation, mutation, autoflush
):
    case_name = f"{isolation.lower().replace(' ', '-')}-{mutation}-{autoflush}"
    output = receipt_path(tmp_path, f"eligibility-autoflush-{case_name}.json")
    assert not output.exists(), "Use a fresh directory; preserve earlier observations"
    expected = (
        (0, 0)
        if autoflush and mutation == "source_status"
        else (1, len(BODY) * (2 if autoflush and mutation == "added_chunk" else 1))
    )
    receipt = {
        "isolation": isolation,
        "mutation": mutation,
        "autoflush": autoflush,
        "expected": expected,
        "baseline": "Unchanged original_eligible_totals; same writer-maintained Source counters as candidate, both summary and chunk pending until read; fresh transaction per implementation, rolled back after observation",
        "observations": [],
    }

    def save():
        output.write_text(json.dumps(receipt, indent=2, default=str) + "\n")

    save()
    _, session_id, acknowledgements = await pg_inline(pg, [BODY], native="autoflush")
    content_id = uuid.UUID(acknowledgements[0]["content_id"])
    factory = pg["factory"]
    engine = factory.kw["bind"]
    for implementation in ("original", "candidate"):
        observation = {"implementation": implementation, "statements": []}
        receipt["observations"].append(observation)
        async with factory() as db:
            transaction = await db.begin()
            try:
                # Values come only from the fixed isolation parameter above.
                await db.execute(text(f"SET TRANSACTION ISOLATION LEVEL {isolation}"))
                await db.execute(text("SET LOCAL statement_timeout='8s'"))
                await db.execute(text("SET LOCAL lock_timeout='3s'"))
                source = await db.scalar(
                    select(Source).where(Source.content_id == content_id)
                )
                assert source is not None and source.status == "indexed"
                template = (
                    await db.execute(select(Chunk).where(Chunk.source_id == source.id))
                ).scalar_one()
                assert template.owned_bytes == len(BODY)
                if mutation == "source_status":
                    source.status = "pending"
                else:
                    values = {
                        column.name: getattr(template, column.name)
                        for column in Chunk.__table__.columns
                    }
                    values.update(id=uuid.uuid4(), ordinal=template.ordinal + 1)
                    db.add(Chunk(**values))
                    # A valid writer appends its chunk and summary atomically.
                    # Both remain pending here, so this still probes autoflush.
                    source.folded_bytes += values["owned_bytes"]
                    source.chunk_count += 1
                observation["before"] = pending_state(db)

                def capture(_connection, _cursor, sql, parameters, _context, _many):
                    observation["statements"].append(
                        {"sql": sql, "parameters": parameters}
                    )

                event.listen(engine.sync_engine, "before_cursor_execute", capture)
                try:
                    with nullcontext() if autoflush else db.no_autoflush:
                        repo = SessionSearchRepository(db)
                        scope = SearchScope(EXTRACTOR_VERSION)
                        observation["result"] = (
                            await original_eligible_totals(repo, session_id, scope)
                            if implementation == "original"
                            else await repo.eligible_totals(session_id, scope)
                        )
                except Exception as error:
                    original = getattr(error, "orig", error)
                    observation["error"] = {
                        "type": type(error).__name__,
                        "sqlstate": getattr(original, "sqlstate", None),
                        "message": str(error),
                    }
                finally:
                    event.remove(engine.sync_engine, "before_cursor_execute", capture)
                observation["after"] = pending_state(db)
                observation["transaction_active_after_call"] = (
                    db.in_transaction() and transaction.is_active
                )
                save()
            finally:
                await db.rollback()
                observation["transaction_active_after_rollback"] = db.in_transaction()
                save()
        dml = [
            statement["sql"].lstrip().split(None, 1)[0].upper()
            for statement in observation["statements"]
            if statement["sql"].lstrip().split(None, 1)[0].upper()
            in {"INSERT", "UPDATE", "DELETE"}
        ]
        metadata_selects = [
            statement
            for statement in observation["statements"]
            if statement["sql"].lstrip().upper().startswith("SELECT")
        ]
        expected_dml = (
            (["UPDATE"] if mutation == "source_status" else ["INSERT", "UPDATE"])
            if autoflush
            else []
        )
        contract = {
            "no_error": "error" not in observation,
            "fixed_totals": tuple(observation.get("result", ())) == expected,
            "normal_flush_sql": dml == expected_dml,
            "one_metadata_select": len(metadata_selects) == 1,
            "pending_state": observation["after"]
            == ({"dirty": [], "new": []} if autoflush else observation["before"]),
            "caller_owns_transaction": observation["transaction_active_after_call"],
            "rolled_back": not observation["transaction_active_after_rollback"],
        }
        observation["contract"] = contract
        if not all(contract.values()):
            receipt["classification"] = (
                "INCONCLUSIVE_ORIGINAL_CONTROL_FAILED"
                if implementation == "original"
                else "CANDIDATE_CHANGED_AUTOFLUSH_CONTRACT"
            )
        save()
        assert all(contract.values()), observation
    receipt["classification"] = "ORIGINAL_AND_CANDIDATE_PRESERVE_AUTOFLUSH"
    save()
