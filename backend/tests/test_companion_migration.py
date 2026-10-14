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
MIGRATION = VERSIONS / "109_companion_session_capture.py"
# Later additive migrations to the same tables; the models describe them all.
LATER_MIGRATIONS = [
    VERSIONS / "110_agent_session_usage.py",
    VERSIONS / "111_session_link_provenance.py",
    VERSIONS / "112_companion_pairing.py",
    VERSIONS / "114_session_capture_levels.py",
    VERSIONS / "115_session_activity_count.py",
    VERSIONS / "117_session_tombstone_history_cutoff.py",
    VERSIONS / "119_session_contents.py",
]
NEW_TABLES = {
    "companion_installations",
    "companion_project_mappings",
    "mcp_invocations",
    "mcp_consultations",
    "agent_sessions",
    "agent_session_captures",
    "agent_session_events",
    "agent_session_invocations",
    "agent_session_tombstones",
    "session_work_links",
    # 110
    "agent_session_usage",
    # 112
    "companion_pairings",
    "companion_pairing_lookup_failures",
    # 119
    "agent_session_capture_generations",
    "agent_session_contents",
    "agent_session_content_deletions",
}
PARENTS = {"users", "workspaces", "boards", "agents", "activities"}


def _load_migration(path=MIGRATION):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def _columns(inspector, table):
    return {
        column["name"]: column["nullable"] for column in inspector.get_columns(table)
    }


@pytest.mark.parametrize("downgrade", [False, True])
def test_single_additive_migration_matches_models_and_reverses(tmp_path, downgrade):
    migration = _load_migration()
    assert (migration.revision, migration.down_revision) == ("109", "108")
    engine = create_engine("sqlite:///" + str(tmp_path / "migration.db"))
    with engine.begin() as connection:
        for table in ["users", "workspaces", "boards", "agents"]:
            connection.exec_driver_sql(
                f"CREATE TABLE {table} (id CHAR(32) PRIMARY KEY)"
            )
        connection.exec_driver_sql(
            "CREATE TABLE activities (id CHAR(32) PRIMARY KEY, actor_id CHAR(32), "
            "workspace_id CHAR(32))"
        )
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        later = [_load_migration(path) for path in LATER_MIGRATIONS]
        for step in later:
            step.op = migration.op
            step.upgrade()
        inspector = inspect(connection)
        assert set(inspector.get_table_names()) == PARENTS | NEW_TABLES
        for table in NEW_TABLES:
            assert _columns(inspector, table) == {
                column.name: column.nullable
                for column in Base.metadata.tables[table].columns
            }, table
        assert {"mcp_invocation_id", "principal_key"} <= set(
            _columns(inspector, "activities")
        )
        assert all(
            nullable
            for name, nullable in _columns(inspector, "activities").items()
            if name in {"mcp_invocation_id", "principal_key"}
        )
        uniques = {
            constraint["name"]: constraint["column_names"]
            for constraint in inspector.get_unique_constraints("agent_sessions")
        }
        assert uniques["uq_agent_session_identity"] == [
            "workspace_id",
            "owner_id",
            "installation_id",
            "harness",
            "native_session_id",
        ]
        mapping_indexes = {
            index["name"]: (index["column_names"], index["unique"])
            for index in inspector.get_indexes("companion_project_mappings")
        }
        # Auto-matched repositories carry no local path, so they are unique
        # per repository instead of per root.
        assert mapping_indexes["uq_companion_mapping_auto_repo"] == (
            ["installation_id", "repo_url_normalized"],
            1,
        )
        # Correlation only ever looks up rows that carry a signature or a
        # fingerprint, so its indexes cover only those.
        partial = dict(
            connection.exec_driver_sql(
                "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN "
                "('ix_agent_session_events_call_signature', "
                "'ix_mcp_invocations_correlatable')"
            ).all()
        )
        assert (
            "WHERE tool_call_signature IS NOT NULL"
            in partial["ix_agent_session_events_call_signature"]
        )
        assert (
            "WHERE arguments_fingerprint IS NOT NULL"
            in partial["ix_mcp_invocations_correlatable"]
        )
        if downgrade:
            for step in reversed(later):
                step.downgrade()
            migration.downgrade()
            inspector = inspect(connection)
            assert set(inspector.get_table_names()) == PARENTS
            assert set(_columns(inspector, "activities")) == {
                "id",
                "actor_id",
                "workspace_id",
            }
    engine.dispose()


def test_only_auto_matched_mappings_may_omit_the_root(tmp_path):
    migration = _load_migration()
    engine = create_engine("sqlite:///" + str(tmp_path / "mappings.db"))
    with engine.begin() as connection:
        for table in ["users", "workspaces", "boards", "agents"]:
            connection.exec_driver_sql(
                f"CREATE TABLE {table} (id CHAR(32) PRIMARY KEY)"
            )
        connection.exec_driver_sql(
            "CREATE TABLE activities (id CHAR(32) PRIMARY KEY, actor_id CHAR(32), "
            "workspace_id CHAR(32))"
        )
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
    insert = (
        "INSERT INTO companion_project_mappings (id, installation_id, workspace_id, "
        "root_path, repo_url_normalized, origin) VALUES (?, 'i', 'w', ?, ?, ?)"
    )
    with engine.begin() as connection:
        connection.exec_driver_sql(insert, ("a", None, "github.com/o/r", "auto_repo"))
        connection.exec_driver_sql(insert, ("b", "/work/project", None, "explicit"))
    for row in [
        ("c", None, "github.com/o/other", "explicit"),
        ("d", None, None, "auto_repo"),
        ("e", None, "github.com/o/r", "auto_repo"),
    ]:
        with pytest.raises(Exception), engine.begin() as connection:
            connection.exec_driver_sql(insert, row)
    engine.dispose()
