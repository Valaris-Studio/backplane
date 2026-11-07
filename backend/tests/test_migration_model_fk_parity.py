# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Compare a fresh, fully migrated PostgreSQL catalog with the model FKs.

The ordinary test schema uses create_all, so migration/model drift can otherwise
remain invisible. Online migrations may require catalog validation and cannot
be represented faithfully by rendering their DDL offline.
"""

from collections import Counter
import json
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
import pytest
from sqlalchemy import text

from app.models.base import Base

# Register the same complete model graph as the application.
import app.main  # noqa: F401
from tests.test_session_search_index_migration_postgres import migration_database  # noqa: F401

pytestmark = [pytest.mark.slow, pytest.mark.timeout(120)]
BACKEND_DIR = Path(__file__).resolve().parents[1]
MIN_EXPECTED_DB_FKS = 50
DELETE_ACTIONS = {
    "a": "NO ACTION",
    "r": "RESTRICT",
    "c": "CASCADE",
    "n": "SET NULL",
    "d": "SET DEFAULT",
}

CATALOG_FKS = text("""
    SELECT constraint_row.oid::bigint AS oid,
           constraint_row.conname::text AS name,
           child_namespace.nspname::text AS child_schema,
           child.relname::text AS child_table,
           ARRAY(
               SELECT attribute.attname::text
               FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
               JOIN pg_attribute attribute
                 ON attribute.attrelid = child.oid AND attribute.attnum = key.attnum
               ORDER BY key.position
           ) AS child_columns,
           parent_namespace.nspname::text AS parent_schema,
           parent.relname::text AS parent_table,
           ARRAY(
               SELECT attribute.attname::text
               FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key(attnum, position)
               JOIN pg_attribute attribute
                 ON attribute.attrelid = parent.oid AND attribute.attnum = key.attnum
               ORDER BY key.position
           ) AS parent_columns,
           constraint_row.confdeltype::text AS delete_action,
           constraint_row.convalidated AS validated
    FROM pg_constraint constraint_row
    JOIN pg_class child ON child.oid = constraint_row.conrelid
    JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = constraint_row.confrelid
    JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
    WHERE constraint_row.contype = 'f'
      AND child_namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY child_namespace.nspname, child.relname, constraint_row.conname
""")


def _model_fk_state(default_schema):
    constraints = []
    for table in Base.metadata.tables.values():
        for constraint in table.foreign_key_constraints:
            elements = list(constraint.elements)
            parent = elements[0].column.table
            constraints.append(
                (
                    table.schema or default_schema,
                    table.name,
                    tuple(element.parent.name for element in elements),
                    parent.schema or default_schema,
                    parent.name,
                    tuple(element.column.name for element in elements),
                    (constraint.ondelete or "NO ACTION").upper(),
                )
            )
    return Counter(constraints)


def _catalog_fk_state(rows):
    return Counter(
        (
            row["child_schema"],
            row["child_table"],
            tuple(row["child_columns"]),
            row["parent_schema"],
            row["parent_table"],
            tuple(row["parent_columns"]),
            DELETE_ACTIONS[row["delete_action"]],
        )
        for row in rows
    )


async def _read_catalog(connection, directory, label):
    rows = [dict(row) for row in (await connection.execute(CATALOG_FKS)).mappings()]
    (directory / f"fk-{label}.json").write_text(json.dumps(rows, indent=2) + "\n")
    assert all(row["validated"] for row in rows), "Unvalidated foreign keys remain"
    return rows


def _assert_parity(actual, expected):
    assert actual == expected, (
        f"Missing migration FKs: {expected - actual}\n"
        f"Unexpected migration FKs: {actual - expected}"
    )


async def test_migrations_and_models_agree_on_foreign_keys(migration_database):  # noqa: F811
    database = migration_database
    migration = await database.cli("upgrade", "head", role="full-graph-parity")
    await migration.finish()
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    heads = ScriptDirectory.from_config(config).get_heads()
    assert len(heads) == 1

    async with database.engine.connect() as connection:
        versions = list(
            (
                await connection.scalars(
                    text("SELECT version_num FROM alembic_version ORDER BY version_num")
                )
            ).all()
        )
        assert versions == sorted(heads)
        schema = await connection.scalar(text("SELECT current_schema()"))
        expected = _model_fk_state(schema)
        rows = await _read_catalog(connection, database.directory, "migrated")
        assert len(rows) >= MIN_EXPECTED_DB_FKS, "Too few FKs; parity would be vacuous"
        _assert_parity(_catalog_fk_state(rows), expected)
        await connection.rollback()

        target = (
            schema,
            "activities",
            ("board_id",),
            schema,
            "boards",
            ("id",),
            "SET NULL",
        )
        assert expected[target] == 1
        target_rows = [
            row for row in rows if _catalog_fk_state([row]) == Counter({target: 1})
        ]
        assert len(target_rows) == 1
        quote = connection.dialect.identifier_preparer.quote
        child = f'{quote(schema)}.{quote("activities")}'
        parent = f'{quote(schema)}.{quote("boards")}'
        constraint_name = quote(target_rows[0]["name"])

        for label, wrong_delete in (("missing", False), ("wrong-delete", True)):
            transaction = await connection.begin()
            try:
                await connection.execute(
                    text(f"ALTER TABLE {child} DROP CONSTRAINT {constraint_name}")
                )
                if wrong_delete:
                    await connection.execute(
                        text(
                            f"ALTER TABLE {child} ADD CONSTRAINT {constraint_name} "
                            f'FOREIGN KEY ("board_id") REFERENCES {parent} ("id") ON DELETE CASCADE'
                        )
                    )
                changed = _catalog_fk_state(
                    await _read_catalog(connection, database.directory, label)
                )
                assert expected - changed == Counter({target: 1})
                wrong = (*target[:-1], "CASCADE")
                assert changed - expected == (
                    Counter({wrong: 1}) if wrong_delete else Counter()
                )
                with pytest.raises(AssertionError, match="Missing migration FKs:"):
                    _assert_parity(changed, expected)
            finally:
                await transaction.rollback()
            restored = await _read_catalog(
                connection, database.directory, label + "-rolled-back"
            )
            _assert_parity(_catalog_fk_state(restored), expected)
            await connection.rollback()
