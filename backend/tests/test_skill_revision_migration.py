# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
from pathlib import Path
from unittest.mock import Mock

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "alembic/versions/108_skill_revision_provenance.py"
)


def _migration():
    assert MIGRATION_PATH.exists(), "Additive skill revision migration is required"
    spec = importlib.util.spec_from_file_location("skill_revision_migration", MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_skill_revision_migration_is_additive_without_fabricated_backfill():
    migration = _migration()
    migration.op = Mock()
    migration.upgrade()
    assert migration.revision == "108"
    assert migration.down_revision == "107"
    columns = [call.args[1] for call in migration.op.add_column.call_args_list]
    assert [column.name for column in columns] == [
        "base_version", "reason", "provenance", "source_board_id", "source_card_id",
        "source_execution_id", "delegation_id",
    ]
    assert all(column.nullable and column.server_default is None for column in columns)
    assert all(call.args[0] == "skill_versions" for call in migration.op.add_column.call_args_list)
    assert migration.op.create_table.call_args.args[0] == "skill_audit_events"
    assert {call[0] for call in migration.op.method_calls} <= {
        "add_column", "create_table", "create_index",
    }


def test_skill_revision_migration_retains_legacy_rows_and_old_insert_contract():
    migration = _migration()
    engine = sa.create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE skills (id CHAR(32) PRIMARY KEY)")
        connection.exec_driver_sql("CREATE TABLE skill_versions (version INTEGER PRIMARY KEY)")
        connection.exec_driver_sql("INSERT INTO skill_versions (version) VALUES (1)")
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        connection.exec_driver_sql("INSERT INTO skill_versions (version) VALUES (2)")
        rows = connection.exec_driver_sql(
            "SELECT version, base_version, reason, provenance FROM skill_versions ORDER BY version"
        ).all()
        assert rows == [(1, None, None, None), (2, None, None, None)]
        assert "skill_audit_events" in sa.inspect(connection).get_table_names()
        migration.downgrade()
        assert "skill_audit_events" not in sa.inspect(connection).get_table_names()
        assert [row[0] for row in connection.exec_driver_sql("SELECT version FROM skill_versions")] == [1, 2]
    engine.dispose()
