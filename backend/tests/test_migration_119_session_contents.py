# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Migration 119 is additive and rolling-safe: old rows keep their values
and claim no content, the previous release's inserts still succeed, the
new tables match the models, and it reverses."""

import json

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect

import app.models  # noqa: F401  (registers every table on Base.metadata)
from app.models.base import Base
from tests.test_session_cost_migration import VERSIONS, _at_109, _columns, _load

BEFORE_119 = [
    "110_agent_session_usage.py",
    "111_session_link_provenance.py",
    "112_companion_pairing.py",
    "113_api_key_installation.py",
    "114_session_capture_levels.py",
    "115_session_activity_count.py",
    "116_session_started_sort_index.py",
    "117_session_tombstone_history_cutoff.py",
    "118_timeline_generations.py",
]
NEW_TABLES = {
    "agent_session_capture_generations",
    "agent_session_contents",
    "agent_session_content_deletions",
}


def _at_118(connection):
    _at_109(connection)
    connection.exec_driver_sql("CREATE TABLE api_keys (id CHAR(32) PRIMARY KEY)")
    operations = Operations(MigrationContext.configure(connection))
    for name in BEFORE_119:
        step = _load(VERSIONS / name)
        step.op = operations
        step.upgrade()
    return operations


def _old_rows(connection):
    connection.exec_driver_sql(
        "INSERT INTO companion_installations (id, owner_id, name, platform, "
        "token_hash, token_prefix) VALUES ('i', 'o', 'Laptop', 'linux', 'h', 'bpc_')"
    )
    connection.exec_driver_sql(
        "INSERT INTO companion_project_mappings (id, installation_id, workspace_id, "
        "root_path, origin, content_level) VALUES ('m', 'i', 'w', '/p', 'explicit', "
        "'full')"
    )
    connection.exec_driver_sql(
        "INSERT INTO agent_sessions (id, workspace_id, owner_id, installation_id, "
        "harness, native_session_id, started_at, last_event_at) VALUES "
        "('s', 'w', 'o', 'i', 'claude_code', 'n', '2026-10-01', '2026-10-01')"
    )


def test_migration_119_follows_118():
    migration = _load(VERSIONS / "119_session_contents.py")
    assert (migration.revision, migration.down_revision) == ("119", "118")


@pytest.mark.parametrize("downgrade", [False, True])
def test_old_rows_keep_their_values_and_claim_no_content(tmp_path, downgrade):
    migration = _load(VERSIONS / "119_session_contents.py")
    engine = create_engine("sqlite:///" + str(tmp_path / "contents.db"))
    with engine.begin() as connection:
        migration.op = _at_118(connection)
        _old_rows(connection)
        migration.upgrade()
        inspector = inspect(connection)
        for table in NEW_TABLES:
            assert _columns(inspector, table) == {
                column.name: column.nullable
                for column in Base.metadata.tables[table].columns
            }, table
        row = connection.exec_driver_sql(
            "SELECT content_level, rich_since FROM companion_project_mappings"
        ).one()
        assert tuple(row) == ("full", None)
        assert connection.exec_driver_sql(
            "SELECT content_bytes, content_count FROM agent_sessions"
        ).one() == (0, 0)
        assert connection.exec_driver_sql(
            "SELECT content_bytes, capture_capabilities FROM companion_installations"
        ).one() == (0, None)
        # The previous release's insert, naming none of the new columns.
        connection.exec_driver_sql(
            "INSERT INTO companion_project_mappings (id, installation_id, workspace_id,"
            " root_path, origin) VALUES ('m2', 'i', 'w', '/q', 'explicit')"
        )
        assert (
            connection.exec_driver_sql(
                "SELECT content_level FROM companion_project_mappings WHERE id = 'm2'"
            ).scalar()
            == "standard"
        )
        connection.exec_driver_sql(
            "UPDATE companion_project_mappings SET content_level = 'rich' WHERE id = 'm'"
        )
        with pytest.raises(Exception):
            with connection.begin_nested():
                connection.exec_driver_sql(
                    "UPDATE companion_project_mappings SET content_level = 'raw' "
                    "WHERE id = 'm'"
                )
        if downgrade:
            migration.downgrade()
            inspector = inspect(connection)
            assert NEW_TABLES.isdisjoint(inspector.get_table_names())
            assert "rich_since" not in _columns(inspector, "companion_project_mappings")
            assert "content_bytes" not in _columns(inspector, "agent_sessions")
            # The rollback runbook's UPDATE: a rich mapping falls back to full.
            assert (
                connection.exec_driver_sql(
                    "SELECT content_level FROM companion_project_mappings WHERE id = 'm'"
                ).scalar()
                == "full"
            )
    engine.dispose()


def test_content_indexes_serve_the_timeline_calls_sweeps_and_receipts(tmp_path):
    migration = _load(VERSIONS / "119_session_contents.py")
    engine = create_engine("sqlite:///" + str(tmp_path / "indexes.db"))
    with engine.begin() as connection:
        migration.op = _at_118(connection)
        migration.upgrade()
        inspector = inspect(connection)
        indexes = {
            tuple(index["column_names"]): index
            for index in inspector.get_indexes("agent_session_contents")
        }
        assert ("session_id", "occurred_at", "source_order", "id") in indexes
        assert ("session_id", "call_key") in indexes
        assert ("upload_expires_at",) in indexes
        assert ("installation_id", "capture_id") in indexes
        uniques = {
            tuple(constraint["column_names"])
            for constraint in inspector.get_unique_constraints("agent_session_contents")
        }
        assert ("session_id", "content_key") in uniques
        generation_uniques = {
            tuple(constraint["column_names"])
            for constraint in inspector.get_unique_constraints(
                "agent_session_capture_generations"
            )
        }
        assert ("installation_id", "generation_key") in generation_uniques
        partial = dict(
            connection.exec_driver_sql(
                "SELECT name, sql FROM sqlite_master WHERE type = 'index' "
                "AND tbl_name = 'agent_session_contents'"
            ).all()
        )
        assert any("WHERE state = 'pending'" in (sql or "") for sql in partial.values())
        assert any(
            "WHERE call_key IS NOT NULL" in (sql or "") for sql in partial.values()
        )
    engine.dispose()


def test_content_foreign_keys_cascade_with_their_session_and_device(tmp_path):
    """A generation cannot be deleted under its contents (NO ACTION, checked
    at the end of a statement, so one cascading delete still clears both)."""
    migration = _load(VERSIONS / "119_session_contents.py")
    engine = create_engine("sqlite:///" + str(tmp_path / "keys.db"))
    with engine.begin() as connection:
        migration.op = _at_118(connection)
        migration.upgrade()
        inspector = inspect(connection)

        def on_delete(table):
            return {
                tuple(key["constrained_columns"]): key["options"].get("ondelete")
                for key in inspector.get_foreign_keys(table)
            }

        contents = on_delete("agent_session_contents")
        assert contents[("session_id",)] == "CASCADE"
        assert contents[("generation_id",)] in (None, "NO ACTION")
        generations = on_delete("agent_session_capture_generations")
        assert generations[("installation_id",)] == "CASCADE"
        assert generations[("mapping_id",)] == "SET NULL"
    engine.dispose()


# capture_levels as the candidate wrote them -> after downgrade. The previous
# release reads the last entry as the latest level and knows no `rich`: it
# becomes `full`, and of repeated levels the last occurrence stays, in order.
CAPTURE_LEVELS_ROLLBACK = [
    (["full", "rich", "full"], ["full"]),
    (["rich", "standard"], ["full", "standard"]),
    (["full", "standard", "rich"], ["standard", "full"]),
    (["metadata", "standard"], ["metadata", "standard"]),
    (None, None),
]

# A heartbeat as the candidate stored it -> after downgrade. The previous
# release validates it with `extra="forbid"`, so no rich_capture member stays.
PREVIOUS_RELEASE_STATUS_FIELDS = {
    "companion_version",
    "beacon_commit",
    "agents",
    "queue",
}
LAST_STATUS_ROLLBACK = [
    (
        {
            "companion_version": "0.9.1",
            "beacon_commit": None,
            "agents": [],
            "queue": {"pending": 0, "dropped_total": 0, "oldest_pending_at": None},
            "rich_capture": {
                "sources": [],
                "spool": {"pending_bodies": 0, "pending_bytes": 0, "failed_total": 0},
            },
        },
        {
            "companion_version": "0.9.1",
            "beacon_commit": None,
            "agents": [],
            "queue": {"pending": 0, "dropped_total": 0, "oldest_pending_at": None},
        },
    ),
    (
        {
            "companion_version": "0.8.0",
            "agents": [],
            "queue": {"pending": 1, "dropped_total": 0},
            "rich_capture": None,
        },
        {
            "companion_version": "0.8.0",
            "agents": [],
            "queue": {"pending": 1, "dropped_total": 0},
        },
    ),
]


def test_downgrade_leaves_no_rich_level_the_previous_release_cannot_read(tmp_path):
    """Captured sessions and receipts recorded `rich` too; the previous
    release 500s on any of it, so the downgrade rewrites all three."""
    migration = _load(VERSIONS / "119_session_contents.py")
    engine = create_engine("sqlite:///" + str(tmp_path / "rollback.db"))
    with engine.begin() as connection:
        migration.op = _at_118(connection)
        _old_rows(connection)
        migration.upgrade()
        connection.exec_driver_sql(
            "UPDATE companion_project_mappings SET content_level = 'rich'"
        )
        for index, (levels, _) in enumerate(CAPTURE_LEVELS_ROLLBACK):
            connection.exec_driver_sql(
                "INSERT INTO agent_sessions (id, workspace_id, owner_id, "
                "installation_id, harness, native_session_id, started_at, "
                "last_event_at, capture_levels) VALUES (?, 'w', 'o', 'i', "
                "'claude_code', ?, '2026-10-09', '2026-10-09', ?)",
                (
                    f"r{index}",
                    f"rich-{index}",
                    None if levels is None else json.dumps(levels),
                ),
            )
        connection.exec_driver_sql(
            "INSERT INTO agent_session_captures (id, installation_id, capture_id, "
            "session_id, content_hash, collection_method, event_count, captured_at, "
            "received_at, content_level) VALUES ('c', 'i', 'cap', 'r0', 'h', 'hook', "
            "1, '2026-10-09', '2026-10-09', 'rich')"
        )

        for index, (status, _) in enumerate(LAST_STATUS_ROLLBACK):
            if index:
                connection.exec_driver_sql(
                    "INSERT INTO companion_installations (id, owner_id, name, "
                    "platform, token_hash, token_prefix) VALUES (?, 'o', 'Desk', "
                    "'linux', ?, 'bpc_')",
                    (f"i{index}", f"h{index}"),
                )
            connection.exec_driver_sql(
                "UPDATE companion_installations SET last_status = ? WHERE id = ?",
                (json.dumps(status), "i" if index == 0 else f"i{index}"),
            )

        migration.downgrade()
        for index, (_, expected) in enumerate(LAST_STATUS_ROLLBACK):
            stored = json.loads(
                connection.exec_driver_sql(
                    "SELECT last_status FROM companion_installations WHERE id = ?",
                    ("i" if index == 0 else f"i{index}",),
                ).scalar()
            )
            assert stored == expected
            assert set(stored) <= PREVIOUS_RELEASE_STATUS_FIELDS
        assert (
            connection.exec_driver_sql(
                "SELECT content_level FROM companion_project_mappings WHERE id = 'm'"
            ).scalar()
            == "full"
        )
        for index, (_, expected) in enumerate(CAPTURE_LEVELS_ROLLBACK):
            stored = connection.exec_driver_sql(
                "SELECT capture_levels FROM agent_sessions WHERE id = ?", (f"r{index}",)
            ).scalar()
            assert (None if stored is None else json.loads(stored)) == expected
        assert (
            connection.exec_driver_sql(
                "SELECT content_level FROM agent_session_captures"
            ).scalar()
            == "full"
        )
    engine.dispose()


def test_upgrading_over_kept_119_objects_keeps_their_data(tmp_path):
    """A rollback of code alone keeps 119's tables and columns and stamps the
    previous head; rolling forward runs 119 again over them."""
    migration = _load(VERSIONS / "119_session_contents.py")
    engine = create_engine("sqlite:///" + str(tmp_path / "forward.db"))
    with engine.begin() as connection:
        migration.op = _at_118(connection)
        _old_rows(connection)
        migration.upgrade()
        connection.exec_driver_sql(
            "UPDATE companion_installations SET content_bytes = 4096"
        )
        connection.exec_driver_sql(
            "INSERT INTO agent_session_content_deletions (id, storage_backend, "
            "storage_prefix, requested_at, next_attempt_at) VALUES ('d', 'local', "
            "'session-content/v1/w/', '2026-10-09', '2026-10-09')"
        )

        migration.upgrade()
        assert (
            connection.exec_driver_sql(
                "SELECT content_bytes FROM companion_installations"
            ).scalar()
            == 4096
        )
        assert (
            connection.exec_driver_sql(
                "SELECT storage_prefix FROM agent_session_content_deletions"
            ).scalar()
            == "session-content/v1/w/"
        )
        connection.exec_driver_sql(
            "UPDATE companion_project_mappings SET content_level = 'rich'"
        )
    engine.dispose()


def test_the_previous_release_head_is_stamped_only_over_119(tmp_path):
    migration = _load(VERSIONS / "119_session_contents.py")
    engine = create_engine("sqlite:///" + str(tmp_path / "stamp.db"))
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY)"
        )
        connection.exec_driver_sql("INSERT INTO alembic_version VALUES ('119')")
        # 119 recorded but its tables absent: not a database 119 built.
        migration.stamp_previous_release(connection)
        assert (
            connection.exec_driver_sql(
                "SELECT version_num FROM alembic_version"
            ).scalar()
            == "119"
        )
        connection.exec_driver_sql("CREATE TABLE agent_session_contents (id CHAR(32))")
        migration.stamp_previous_release(connection)
        assert (
            connection.exec_driver_sql(
                "SELECT version_num FROM alembic_version"
            ).scalar()
            == "118"
        )
        connection.exec_driver_sql("UPDATE alembic_version SET version_num = '120'")
        migration.stamp_previous_release(connection)
        assert (
            connection.exec_driver_sql(
                "SELECT version_num FROM alembic_version"
            ).scalar()
            == "120"
        )
    engine.dispose()


def test_offline_sql_for_119_is_the_plain_ddl():
    """`alembic upgrade --sql` has no database to probe: 119 then emits its
    DDL unconditionally, as for an empty schema."""
    import os
    import subprocess
    import sys

    backend = VERSIONS.parents[1]
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "118:119", "--sql"],
        cwd=backend,
        env={
            **os.environ,
            "DATABASE_URL": "postgresql+asyncpg://offline:offline@127.0.0.1:1/offline",
        },
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    assert "CREATE TABLE agent_session_contents" in result.stdout
    assert "ADD COLUMN rich_since" in result.stdout
