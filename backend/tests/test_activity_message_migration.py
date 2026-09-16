# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Rolling-deploy contract for additive structured activity columns."""

import importlib.util
from pathlib import Path
from unittest.mock import Mock, call

import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "093_add_activity_message_fields.py"
)


def _load_migration():
    assert MIGRATION_PATH.exists(), "migration 093 must add the activity message fields"
    spec = importlib.util.spec_from_file_location(
        "migration_093_activity_messages", MIGRATION_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_activity_message_migration_is_nullable_additive_and_reversible():
    migration = _load_migration()
    migration.op = Mock()

    migration.upgrade()

    assert migration.revision == "093"
    assert migration.down_revision == "092"
    add_calls = migration.op.add_column.call_args_list
    assert [call.args[1].name for call in add_calls] == [
        "message_key",
        "message_params",
    ]
    message_key_column = add_calls[0].args[1]
    assert isinstance(message_key_column.type, sa.String)
    assert message_key_column.type.length == 255
    assert message_key_column.nullable is True
    assert message_key_column.server_default is None
    message_params_column = add_calls[1].args[1]
    assert isinstance(message_params_column.type, sa.JSON)
    assert message_params_column.nullable is True
    assert message_params_column.server_default is None
    assert [method_call[0] for method_call in migration.op.method_calls] == [
        "add_column",
        "add_column",
    ]

    migration.op.reset_mock()
    migration.downgrade()
    assert migration.op.drop_column.call_args_list == [
        call("activities", "message_params"),
        call("activities", "message_key"),
    ]
    assert [method_call[0] for method_call in migration.op.method_calls] == [
        "drop_column",
        "drop_column",
    ]


def test_activity_message_migration_contains_no_rename_backfill_or_destructive_upgrade():
    source = MIGRATION_PATH.read_text()
    upgrade_body = source.split("def upgrade():", 1)[1].split("def downgrade():", 1)[0]

    for forbidden in ("alter_column", "execute(", "drop_column", "rename"):
        assert forbidden not in upgrade_body
