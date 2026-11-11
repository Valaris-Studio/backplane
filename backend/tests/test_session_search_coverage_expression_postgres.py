# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Historical coverage-expression causal control on native PostgreSQL.

The expanded VOLATILE counter measures expression work, not the uninstrumented
executor or latency. The retired helper and expanded expression retain their
original causal control, not evidence about the active product query. Only this
private 32-row control bypasses the retired query's large-branch dispatch.
"""

import hashlib
import inspect
import json
import uuid
from pathlib import Path

import pytest
from sqlalchemy import Boolean, case, delete, func, select, text, true, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.sql import operators, visitors
from sqlalchemy.sql.elements import BinaryExpression

from app.models.agent_session import AgentSessionContent as Content
from app.models.session_search import SessionSearchSource as Source
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.rejected_session_search_metadata import (
    coverage_totals_query,
    historical_coverage_oracle_query,
)
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_search import paused_object_indexing as pause_processor_fixture
from tests.test_session_search_postgres import pg_inline, receipt_path

pg = content_postgres_fixture
paused_object_indexing = pause_processor_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]
STATUSES = ("indexed", "unavailable", "not_text")
ROWS = 32
BODY = b"coverage expression needle"
FUNCTION_DDL = """
CREATE FUNCTION pg_temp.uxc_coverage_digest_equal(
    left_digest bpchar, right_digest bpchar, content uuid
) RETURNS boolean LANGUAGE plpgsql VOLATILE STRICT AS $function$
DECLARE result boolean;
BEGIN
    result := left_digest = right_digest;
    INSERT INTO pg_temp.uxc_coverage_digest_calls VALUES (content, result);
    RETURN result;
END
$function$
"""


def expression_statements(session_id, unverified):
    public = coverage_totals_query(session_id, EXTRACTOR_VERSION, unverified)
    assert len(public.selects) == 2
    large = public.selects[1]
    assert len(large._where_criteria) == 1
    decision = large._where_criteria[0]
    large = visitors.replacement_traverse(
        large, {}, lambda node: true() if node is decision else None
    )
    outer = large.get_final_froms()[0].element
    grouped = outer.get_final_froms()[0].element
    classified = grouped.get_final_froms()[0]
    assert not grouped._where_criteria and not grouped._distinct
    assert grouped._limit_clause is None and grouped._offset_clause is None
    expanded_fields = set()

    def expand(node):
        if getattr(node, "table", None) is classified:
            expanded_fields.add(node.key)
            return classified.element.selected_columns[node.key].element
        return None

    # Expand before instrumentation: a VOLATILE expression in the classified
    # subquery could itself inhibit pull-up and manufacture an apparent fix.
    expanded = (
        select(
            *(
                visitors.replacement_traverse(column, {}, expand)
                for column in grouped.selected_columns
            )
        )
        .select_from(*classified.element.get_final_froms())
        .where(*classified.element._where_criteria)
        .group_by(
            *(
                visitors.replacement_traverse(key, {}, expand)
                for key in grouped._group_by_clauses
            )
        )
    )
    assert expanded_fields == set(classified.c.keys())
    assert all(
        getattr(node, "table", None) is not classified
        for node in visitors.iterate(expanded)
    )
    replacements = []

    def instrument(node):
        if (
            isinstance(node, BinaryExpression)
            and node.operator is operators.eq
            and node.left.shares_lineage(Source.__table__.c.source_digest)
            and node.right.shares_lineage(Content.__table__.c.sha256)
        ):
            replacements.append(str(node))
            return func.pg_temp.uxc_coverage_digest_equal(
                node.left, node.right, Content.id, type_=Boolean()
            )
        return None

    measured = visitors.replacement_traverse(expanded, {}, instrument)
    assert replacements
    assert all(
        getattr(node, "name", None) != "uxc_coverage_digest_equal"
        for relation in measured.get_final_froms()
        for node in visitors.iterate(relation)
    )
    return (
        public,
        large,
        expanded,
        measured,
        {
            "expanded_fields": sorted(expanded_fields),
            "replaced_expressions": replacements,
            "projection_expanded_before_instrumentation": True,
        },
    )


def public_rows(rows):
    result = []
    for row in rows:
        flags = row[4:7]
        assert sum(bool(flag) for flag in flags) <= 1
        status = next(
            (name for name, flag in zip(STATUSES, flags, strict=True) if flag), None
        )
        result.append((row[0], row[1], bool(row[2]), status, bool(row[3]), *row[7:]))
    return sorted(result, key=repr)


async def test_large_coverage_compares_digest_once_per_terminal_source_expression(
    pg, tmp_path
):
    _, session_id, acknowledgements = await pg_inline(
        pg, [BODY] * ROWS, native="coverage-expression"
    )
    _, foreign_session, foreign_ack = await pg_inline(
        pg, [BODY], native="coverage-expression-foreign"
    )
    content_ids = [uuid.UUID(ack["content_id"]) for ack in acknowledgements]
    unverified = {
        content_ids[0],
        content_ids[1],
        uuid.UUID(foreign_ack[0]["content_id"]),
        uuid.uuid4(),
    }
    digest = hashlib.sha256(BODY).hexdigest()
    source_path = Path(inspect.getfile(coverage_totals_query))
    output = receipt_path(tmp_path, "coverage-expression-work.json")
    receipt = {
        "interpretation": "Historical retired helper and terminal-filtered oracle with VOLATILE counter: diagnostic expression work, not active-product, uninstrumented work or latency proof",
        "source_path": str(source_path),
        "source_sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
        "test_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "joined_rows": ROWS,
        "comparison_bound": ROWS,
    }

    def save():
        output.write_text(json.dumps(receipt, indent=2, default=str) + "\n")

    async with pg["factory"]() as db:
        transaction = await db.begin()
        try:
            await db.execute(text("SET LOCAL statement_timeout='8s'"))
            await db.execute(
                update(Source)
                .where(Source.content_id.in_(content_ids))
                .values(
                    status=case(
                        {
                            identity: STATUSES[number % 3]
                            for number, identity in enumerate(content_ids)
                        },
                        value=Source.content_id,
                    ),
                    source_digest=case(
                        {
                            identity: digest if number % 2 == 0 else "f" * 64
                            for number, identity in enumerate(content_ids)
                        },
                        value=Source.content_id,
                    ),
                )
            )
            # Owner A declares the writer's session identity as schema. Keep
            # the foreign-identity probe as a rejection, then measure expression
            # work on the unchanged legal graph in the outer transaction.
            with pytest.raises(IntegrityError):
                async with db.begin_nested():
                    await db.execute(
                        update(Source)
                        .where(Source.content_id.in_(content_ids[:2]))
                        .values(session_id=foreign_session)
                    )
            await db.execute(
                text(
                    "CREATE TEMP TABLE uxc_coverage_digest_calls (content_id uuid NOT NULL, comparison boolean NOT NULL) ON COMMIT DROP"
                )
            )
            await db.execute(text(FUNCTION_DDL))
            receipt["counter_definition"] = dict(
                (
                    await db.execute(
                        text(
                            "SELECT p.provolatile::text AS provolatile,p.proisstrict,pg_get_functiondef(p.oid) AS definition "
                            "FROM pg_proc p WHERE p.oid='pg_temp.uxc_coverage_digest_equal(bpchar,bpchar,uuid)'::regprocedure"
                        )
                    )
                )
                .mappings()
                .one()
            )
            assert receipt["counter_definition"]["provolatile"] == "v"
            assert receipt["counter_definition"]["proisstrict"]
            calibration = (
                await db.execute(
                    text(
                        "SELECT pg_temp.uxc_coverage_digest_equal('a'::bpchar,'a'::bpchar,:identity), "
                        "pg_temp.uxc_coverage_digest_equal('a'::bpchar,'b'::bpchar,:identity)"
                    ),
                    {"identity": content_ids[0]},
                )
            ).one()
            assert tuple(calibration) == (True, False)
            assert (
                await db.scalar(
                    text("SELECT count(*) FROM pg_temp.uxc_coverage_digest_calls")
                )
                == 2
            )
            await db.execute(text("DELETE FROM pg_temp.uxc_coverage_digest_calls"))

            public, large, expanded, measured, binding = expression_statements(
                session_id, unverified
            )
            receipt["binding"] = binding
            receipt["sql"] = {
                name: str(
                    statement.compile(
                        dialect=db.get_bind().dialect,
                        compile_kwargs={"literal_binds": True},
                    )
                )
                for name, statement in (
                    ("public", public),
                    ("large", large),
                    ("expanded", expanded),
                    ("instrumented", measured),
                )
            }
            pid = await db.scalar(text("SELECT pg_backend_pid()"))
            results = {}
            for name, statement in (
                ("large", large),
                ("expanded", expanded),
                ("instrumented", measured),
            ):
                results[name] = sorted(
                    (tuple(row) for row in await db.execute(statement)), key=repr
                )
                receipt[name] = results[name]
                save()
            oracle = historical_coverage_oracle_query(
                session_id, EXTRACTOR_VERSION, unverified
            )
            receipt["oracle"] = sorted(
                (tuple(row) for row in await db.execute(oracle)), key=repr
            )
            receipt["per_content"] = [
                dict(row)
                for row in (
                    await db.execute(
                        text(
                            "SELECT content_id,count(*) AS calls,bool_and(comparison) AS all_equal "
                            "FROM pg_temp.uxc_coverage_digest_calls GROUP BY content_id ORDER BY content_id"
                        )
                    )
                ).mappings()
            ]
            receipt["comparison_calls"] = sum(
                row["calls"] for row in receipt["per_content"]
            )
            receipt["pid_before"] = pid
            receipt["pid_after"] = await db.scalar(text("SELECT pg_backend_pid()"))
            save()
            assert (
                results["large"]
                == receipt["oracle"]
                == public_rows(results["expanded"])
            )
            assert results["expanded"] == results["instrumented"]
            assert {row["content_id"] for row in receipt["per_content"]} == set(
                content_ids
            )
            assert receipt["pid_after"] == pid

            # These controls exercise NULL collapse, declared session identity,
            # non-indexed classifications and unknown byte counts on the same
            # actual large branch; no instrumented function is involved.
            await db.execute(
                update(Content).where(Content.id == content_ids[0]).values(sha256=None)
            )
            await db.execute(delete(Source).where(Source.content_id == content_ids[1]))
            await db.execute(
                update(Source)
                .where(Source.content_id == content_ids[2])
                .values(extractor_version="previous")
            )
            await db.execute(
                update(Source)
                .where(Source.content_id == content_ids[3])
                .values(status="pending")
            )
            await db.execute(
                update(Content)
                .where(Content.id == content_ids[4])
                .values(state="pending", byte_count=None, original_byte_count=17)
            )
            await db.execute(
                update(Content)
                .where(Content.id == content_ids[5])
                .values(
                    state="recorded",
                    coverage="withheld_by_policy",
                    byte_count=7,
                    original_byte_count=None,
                )
            )
            with pytest.raises(IntegrityError):
                async with db.begin_nested():
                    await db.execute(
                        update(Content)
                        .where(Content.id == content_ids[8])
                        .values(session_id=foreign_session)
                    )
            # Moving an unindexed Content remains legal; clear its dependent
            # Source/chunks before this ownership change, under A.
            await db.execute(delete(Source).where(Source.content_id == content_ids[8]))
            await db.execute(
                update(Content)
                .where(Content.id == content_ids[8])
                .values(session_id=foreign_session)
            )
            receipt["edge_actual"] = sorted(
                (tuple(row) for row in await db.execute(large)), key=repr
            )
            receipt["edge_oracle"] = sorted(
                (tuple(row) for row in await db.execute(oracle)), key=repr
            )
            save()
            assert receipt["edge_actual"] == receipt["edge_oracle"]
            assert sum(row[5] for row in receipt["edge_actual"]) == ROWS - 1
            assert receipt["comparison_calls"] <= ROWS, receipt["per_content"]
            assert all(row["calls"] == 1 for row in receipt["per_content"])
        except BaseException as error:
            receipt["error_type"] = type(error).__name__
            raise
        finally:
            if transaction.is_active:
                await transaction.rollback()
            restored = (
                await db.execute(
                    text(
                        "SELECT to_regclass('pg_temp.uxc_coverage_digest_calls') IS NULL, "
                        "to_regprocedure('pg_temp.uxc_coverage_digest_equal(bpchar,bpchar,uuid)') IS NULL"
                    )
                )
            ).one()
            receipt["counter_rolled_back"] = tuple(restored)
            save()
            assert tuple(restored) == (True, True)
