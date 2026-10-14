# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import and_, case, func, literal, or_, select
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.sql import Select, operators, visitors
from sqlalchemy.sql.elements import (
    BinaryExpression,
    BindParameter,
    BooleanClauseList,
    ColumnClause,
    Grouping,
)

from app.models.agent_session import AgentSessionEvent
from app.repositories.session_calls import SessionCallRepository

SESSION_ID = uuid.UUID("d61fbba6-20c8-4c43-ad85-faaae8f8610e")
OTHER_SESSION_ID = uuid.UUID("1a6984f6-b765-48de-b10b-982be7028505")
START = datetime(2026, 10, 14, tzinfo=UTC)
EVENT = AgentSessionEvent.__table__


def _direct_columns(expression):
    pending = [expression]
    while pending:
        node = pending.pop()
        # A nested SELECT has its own input boundary and is checked separately.
        if isinstance(node, Select):
            continue
        if isinstance(node, ColumnClause):
            yield node
        else:
            pending.extend(node.get_children())


def _payload_columns(expressions):
    return [
        column
        for expression in expressions
        for column in _direct_columns(expression)
        if column.shares_lineage(EVENT.c.event)
    ]


def _scopes_payload(criterion, payload, session_id):
    if isinstance(criterion, Grouping):
        return _scopes_payload(criterion.element, payload, session_id)
    if (
        isinstance(criterion, BooleanClauseList)
        and criterion.operator is operators.and_
    ):
        return any(
            _scopes_payload(part, payload, session_id) for part in criterion.clauses
        )
    if (
        not isinstance(criterion, BinaryExpression)
        or criterion.operator is not operators.eq
    ):
        return False
    for column, value in (
        (criterion.left, criterion.right),
        (criterion.right, criterion.left),
    ):
        if (
            isinstance(column, ColumnClause)
            and column.table is payload.table
            and column.shares_lineage(EVENT.c.session_id)
            and isinstance(value, BindParameter)
            and value.value == session_id
        ):
            return True
    return False


def _assert_scalar_group_inputs(statement, session_id):
    seen = set()
    grouped = 0
    for query in visitors.iterate(statement):
        if not isinstance(query, Select) or id(query) in seen:
            continue
        seen.add(id(query))
        outputs = (
            *query.selected_columns,
            *query._having_criteria,
            *query._group_by_clauses,
            *query._order_by_clauses,
        )
        if query._group_by_clauses:
            grouped += 1
            assert not _payload_columns(
                outputs
            ), "raw event JSON enters a grouped input"
        for payload in _payload_columns((*outputs, *query._where_criteria)):
            assert any(
                _scopes_payload(criterion, payload, session_id)
                for criterion in query._where_criteria
            ), "payload lookup is not explicitly scoped to the requested session"
    assert grouped, "the query did not exercise a grouped input"


async def _repository_statement(method, dialect_name, *, failed_only=True):
    db = SimpleNamespace(
        execute=AsyncMock(return_value=[]),
        get_bind=lambda: SimpleNamespace(dialect=SimpleNamespace(name=dialect_name)),
    )
    repository = SessionCallRepository(db)
    if method == "groups_before":
        await repository.groups_before(
            SESSION_ID,
            before=(START, "c:cursor"),
            anchors=None,
            failed_only=failed_only,
            limit=25,
        )
    elif method == "turn_totals":
        await repository.turn_totals(SESSION_ID, {0: None, 1: START}, None)
    else:
        await repository.rhythm_counts(
            SESSION_ID,
            start=START,
            bucket_ms=1000,
            work_call_ids={"work-call"},
        )
    db.execute.assert_awaited_once()
    statement = db.execute.await_args.args[0]
    dialect = postgresql.dialect() if dialect_name == "postgresql" else sqlite.dialect()
    statement.compile(dialect=dialect)
    return statement


@pytest.mark.parametrize("dialect_name", ["postgresql", "sqlite"])
@pytest.mark.parametrize("method", ["groups_before", "turn_totals", "rhythm_counts"])
async def test_grouped_outcome_queries_keep_payload_out_of_aggregate_inputs(
    method, dialect_name
):
    statement = await _repository_statement(method, dialect_name)
    _assert_scalar_group_inputs(statement, SESSION_ID)


@pytest.mark.parametrize("dialect_name", ["postgresql", "sqlite"])
async def test_unfiltered_page_grouping_already_has_scalar_inputs(dialect_name):
    statement = await _repository_statement(
        "groups_before", dialect_name, failed_only=False
    )
    _assert_scalar_group_inputs(statement, SESSION_ID)


def _grouped_failure(predicate):
    return (
        select(EVENT.c.native_tool_call_id, func.max(case((predicate, 1), else_=0)))
        .where(EVENT.c.session_id == SESSION_ID)
        .group_by(EVENT.c.native_tool_call_id)
    )


def test_boundary_accepts_indexed_only_aggregate():
    _assert_scalar_group_inputs(
        _grouped_failure(EVENT.c.outcome == "failed"), SESSION_ID
    )


@pytest.mark.parametrize(
    "scope", ["requested", "reversed", "missing", "other", "or", "wrong_alias"]
)
def test_boundary_checks_nested_payload_lookup_scope(scope):
    legacy = EVENT.alias()
    lookup = select(legacy.c.id).where(
        legacy.c.event["success"].as_boolean().is_(False)
    )
    if scope == "requested":
        lookup = lookup.where(
            and_(legacy.c.outcome.is_(None), legacy.c.session_id == SESSION_ID)
        )
    elif scope == "reversed":
        lookup = lookup.where(literal(SESSION_ID) == legacy.c.session_id)
    elif scope == "other":
        lookup = lookup.where(legacy.c.session_id == OTHER_SESSION_ID)
    elif scope == "or":
        lookup = lookup.where(
            or_(legacy.c.session_id == SESSION_ID, legacy.c.outcome.is_(None))
        )
    elif scope == "wrong_alias":
        lookup = lookup.where(EVENT.alias().c.session_id == SESSION_ID)
    statement = _grouped_failure(EVENT.c.id.in_(lookup))
    if scope in {"requested", "reversed"}:
        _assert_scalar_group_inputs(statement, SESSION_ID)
    else:
        with pytest.raises(AssertionError, match="not explicitly scoped"):
            _assert_scalar_group_inputs(statement, SESSION_ID)


@pytest.mark.parametrize("nested", [False, True])
def test_boundary_rejects_payload_inside_direct_or_nested_group(nested):
    statement = _grouped_failure(EVENT.c.event["success"].as_boolean().is_(False))
    if nested:
        statement = select(statement.subquery())
    with pytest.raises(AssertionError, match="raw event JSON"):
        _assert_scalar_group_inputs(statement, SESSION_ID)
