# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Guard: migration 096 and the config-template models must agree.

`test_migration_model_fk_parity` already diffs FOREIGN KEYs across every
migration. The constraints that carry this feature's rules are NOT foreign
keys — the `kind` CHECK, the (workspace_id, kind, slug) uniqueness, and
board_id as the bindings' primary key — and the test suite builds its schema
from `Base.metadata`, never from migrations. So a 096 that drifted from the
models would be invisible to all 39 model/repository tests while being exactly
what runs against prod PostgreSQL.

This renders 096 in alembic offline mode against the postgresql dialect and
asserts the DDL it emits carries each of those constraints.
"""

from __future__ import annotations

import contextlib
import io
import re
from pathlib import Path
from unittest.mock import patch

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy.engine.mock import MockConnection

import app.main  # noqa: F401  — registers every model on Base.metadata
from app.config import settings

BACKEND_DIR = Path(__file__).resolve().parents[1]

CONFIG_TEMPLATE_TABLES = (
    "config_templates",
    "config_template_versions",
    "board_loop_template_bindings",
)


@pytest.fixture(scope="module")
def migration_sql() -> str:
    """The DDL 096 alone emits, rendered for postgresql without a database.

    Only the 093 -> 096 step: rendering the whole chain trips migration 039,
    a data migration whose `exec_driver_sql` has no offline equivalent.
    """
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))

    buf = io.StringIO()
    with (
        patch.object(
            MockConnection,
            "exec_driver_sql",
            lambda self, *a, **k: None,
            create=True,
        ),
        patch.object(
            settings,
            "DATABASE_URL",
            "postgresql+asyncpg://parity:parity@localhost/parity",
        ),
        contextlib.redirect_stdout(buf),
    ):
        command.upgrade(cfg, "093:096", sql=True)
    return buf.getvalue()


def _create_table_body(sql: str, table: str) -> str:
    match = re.search(rf"CREATE TABLE {table} \((.*?)\n\);", sql, re.S | re.I)
    assert match, f"096 emits no CREATE TABLE for {table}"
    return match.group(1)


@pytest.mark.parametrize("table", CONFIG_TEMPLATE_TABLES)
def test_migration_creates_every_config_template_table(migration_sql: str, table: str):
    assert f"CREATE TABLE {table}" in migration_sql


def test_kind_check_constraint_reaches_postgres(migration_sql: str):
    """The Direction's whole point: `kind` is guarded by a CHECK, so adding
    'pipeline' costs no ALTER TYPE. SQLite enforces it in tests, but only this
    asserts the constraint is in the DDL prod actually applies."""
    body = _create_table_body(migration_sql, "config_templates")

    assert "CONSTRAINT ck_config_templates_kind CHECK" in body
    assert "kind IN ('loop', 'pipeline')" in body


def test_kind_is_a_varchar_not_a_native_enum(migration_sql: str):
    body = _create_table_body(migration_sql, "config_templates")

    assert re.search(r"\bkind VARCHAR\(16\) NOT NULL", body)
    # A native enum would need its type created first; that it never appears
    # is what keeps the rollback story simple.
    assert "CREATE TYPE" not in migration_sql


def test_slug_uniqueness_is_scoped_by_workspace_and_kind(migration_sql: str):
    body = _create_table_body(migration_sql, "config_templates")

    assert (
        "CONSTRAINT uq_config_templates_scope_slug UNIQUE (workspace_id, kind, slug)"
        in body
    )


def test_version_snapshots_are_unique_per_template(migration_sql: str):
    body = _create_table_body(migration_sql, "config_template_versions")

    assert (
        "CONSTRAINT uq_config_template_versions_template_version "
        "UNIQUE (template_id, version)" in body
    )


def test_binding_is_keyed_by_board_alone(migration_sql: str):
    """One row per board, enforced by the PK — a surrogate id with a unique
    index would let a rebind insert a second row and lose the first."""
    body = _create_table_body(migration_sql, "board_loop_template_bindings")

    assert "PRIMARY KEY (board_id)" in body
    assert not re.search(r"^\s*id UUID", body, re.M)


def test_the_migration_is_purely_additive(migration_sql: str):
    """Rolling deploys run old and new code against the new schema, so 096
    must not drop, rename or alter anything that already exists."""
    forbidden = re.findall(
        r"\b(DROP TABLE|DROP COLUMN|ALTER COLUMN|RENAME)\b", migration_sql, re.I
    )

    assert forbidden == []


def test_the_workspace_kind_index_exists(migration_sql: str):
    assert (
        "CREATE INDEX ix_config_templates_workspace_kind "
        "ON config_templates (workspace_id, kind)" in migration_sql
    )
