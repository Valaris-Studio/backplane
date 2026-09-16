# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Dialect-split guard for ExecutionRepository.list_by_card (perf follow-up to
the 2026-07-23 outage). `cards_affected` migrated JSON -> JSONB (+GIN) so the
per-card history query must use the `@>` containment operator on Postgres —
served by the GIN index — instead of the unindexable `CAST(... AS TEXT) LIKE`
full scan. SQLite (the test backend) has no JSONB/GIN, so it keeps the portable
text-cast prefilter behind a dialect branch.

These compile the REAL statement the repository builds (not a toy stand-in) and
assert the dialect-correct operator without needing a live Postgres.
"""

from __future__ import annotations

import uuid

from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects import sqlite as sqlite_dialect

from app.repositories.agents.execution import ExecutionRepository


def _compiled_sql(dialect_name: str) -> str:
    workspace_id = uuid.uuid4()
    card_id = uuid.uuid4()
    stmt = ExecutionRepository._list_by_card_stmt(
        workspace_id=workspace_id, card_id=card_id, dialect_name=dialect_name
    )
    dialect = (
        postgresql.dialect()
        if dialect_name == "postgresql"
        else sqlite_dialect.dialect()
    )
    return str(stmt.compile(dialect=dialect))


def test_postgres_uses_jsonb_containment_not_text_scan():
    sql = _compiled_sql("postgresql")
    assert "@>" in sql, (
        "Postgres list_by_card must use the JSONB `@>` containment operator "
        f"(GIN-served); compiled SQL was:\n{sql}"
    )
    assert " LIKE " not in sql.upper(), (
        "Postgres branch must NOT fall back to the CAST(... AS TEXT) LIKE full "
        f"scan; compiled SQL was:\n{sql}"
    )


def test_sqlite_keeps_portable_text_scan():
    sql = _compiled_sql("sqlite")
    assert "@>" not in sql, (
        "SQLite has no JSONB `@>` operator — it must keep the portable text-cast "
        f"prefilter; compiled SQL was:\n{sql}"
    )
    assert " LIKE " in sql.upper(), (
        "SQLite branch must keep the CAST(... AS TEXT) LIKE prefilter; compiled "
        f"SQL was:\n{sql}"
    )
