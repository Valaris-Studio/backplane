# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect

from app.models.base import Base
import app.models  # noqa: F401  (registers every table on Base.metadata)

VERSIONS = Path(__file__).parents[1] / "alembic/versions"
SESSION_CAPTURE = VERSIONS / "109_companion_session_capture.py"
SESSION_COST = VERSIONS / "110_agent_session_usage.py"
# Columns 110 adds to a table 109 created.
ADDED_SESSION_COLUMNS = {
    "reasoning_tokens",
    "cost_reported_usd",
    "cost_estimated_usd",
    "unpriced_usage_count",
    "cost_source",
    "auth_kind",
    "provider",
    "service_tier",
}
# Added to agent_sessions by migrations after 110, which this test stops short of.
LATER_SESSION_COLUMNS = {
    "capture_levels",
    "activity_event_count",
    "content_bytes",
    "content_count",
}


def _load(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _columns(inspector, table):
    return {
        column["name"]: column["nullable"] for column in inspector.get_columns(table)
    }


def _model_columns(table):
    return {
        column.name: column.nullable
        for column in Base.metadata.tables[table].columns
        if not (table == "agent_sessions" and column.name in LATER_SESSION_COLUMNS)
    }


def _at_109(connection):
    for table in ["users", "workspaces", "boards", "agents"]:
        connection.exec_driver_sql(f"CREATE TABLE {table} (id CHAR(32) PRIMARY KEY)")
    connection.exec_driver_sql(
        "CREATE TABLE activities (id CHAR(32) PRIMARY KEY, actor_id CHAR(32), workspace_id CHAR(32))"
    )
    capture = _load(SESSION_CAPTURE)
    capture.op = Operations(MigrationContext.configure(connection))
    capture.upgrade()


def _insert_session(connection, session_id, cost):
    connection.exec_driver_sql(
        "INSERT INTO agent_sessions (id, workspace_id, owner_id, installation_id, harness, "
        "native_session_id, started_at, last_event_at, cost_usd) VALUES "
        "(?, 'w', 'o', 'i', 'pi_cli', ?, '2026-09-25', '2026-09-25', ?)",
        (session_id, session_id, cost),
    )


@pytest.mark.parametrize("downgrade", [False, True])
def test_usage_migration_is_additive_matches_models_and_reverses(tmp_path, downgrade):
    migration = _load(SESSION_COST)
    assert (migration.revision, migration.down_revision) == ("110", "109")
    engine = create_engine("sqlite:///" + str(tmp_path / "usage.db"))
    with engine.begin() as connection:
        _at_109(connection)
        _insert_session(connection, "reported", 0.75)
        _insert_session(connection, "unknown", None)
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        inspector = inspect(connection)
        for table in ("agent_sessions", "agent_session_usage"):
            assert _columns(inspector, table) == _model_columns(table), table
        added = {
            name: nullable
            for name, nullable in _columns(inspector, "agent_sessions").items()
            if name in ADDED_SESSION_COLUMNS
        }
        # Old code keeps writing sessions during a rolling deploy: every new
        # column is nullable or has a server default.
        defaults = {
            column["name"]: column["default"]
            for column in inspector.get_columns("agent_sessions")
        }
        assert all(
            nullable or defaults[name] is not None for name, nullable in added.items()
        )
        uniques = {
            constraint["name"]: constraint["column_names"]
            for constraint in inspector.get_unique_constraints("agent_session_usage")
        }
        assert uniques["uq_agent_session_usage_event"] == ["session_id", "event_id"]
        # Every cost stored before 110 was agent-reported.
        rows = dict(
            connection.exec_driver_sql(
                "SELECT native_session_id, cost_reported_usd FROM agent_sessions"
            ).fetchall()
        )
        assert (
            float(rows["reported"]) == pytest.approx(0.75) and rows["unknown"] is None
        )
        # Rollups are recomputed from usage rows, so each pre-110 cost gets
        # one reported-only row carrying it.
        legacy = connection.exec_driver_sql(
            "SELECT s.native_session_id, u.event_id, u.cost_reported_usd, "
            "u.cost_source, u.pricing_status, u.input_uncached_tokens "
            "FROM agent_session_usage u JOIN agent_sessions s ON s.id = u.session_id"
        ).fetchall()
        assert [tuple(row[:2]) for row in legacy] == [("reported", "pre-110")]
        assert float(legacy[0][2]) == pytest.approx(0.75)
        assert tuple(legacy[0][3:]) == ("reported", "no_tokens", 0)
        sources = dict(
            connection.exec_driver_sql(
                "SELECT native_session_id, cost_source FROM agent_sessions"
            ).fetchall()
        )
        assert sources == {"reported": "reported", "unknown": None}
        if downgrade:
            migration.downgrade()
            inspector = inspect(connection)
            assert "agent_session_usage" not in inspector.get_table_names()
            assert not ADDED_SESSION_COLUMNS & set(
                _columns(inspector, "agent_sessions")
            )
    engine.dispose()
