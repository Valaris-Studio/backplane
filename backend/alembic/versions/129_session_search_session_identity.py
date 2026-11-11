# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Enforce the search writer's session identity with additive, resumable DDL."""

from contextlib import contextmanager
from typing import NamedTuple

from alembic import op
import sqlalchemy as sa

revision = "129"
down_revision = "128"
branch_labels = None
depends_on = None

# Tighter existing statement and lock limits still win.
DDL_STATEMENT_TIMEOUT_MS: int | None = 30000
DDL_LOCK_TIMEOUT_MS: int | None = 5000


class IndexSpec(NamedTuple):
    name: str
    table: str
    definition: str
    creation: str


def _spec(
    name: str, table: str, body: str, create_body: str | None = None
) -> IndexSpec:
    return IndexSpec(
        name,
        table,
        f"CREATE UNIQUE INDEX {name} ON public.{table} USING btree {body}",
        f"CREATE UNIQUE INDEX {name} ON public.{table} USING btree {create_body or body}",
    )


# Frozen schema definitions; no application model or prior-migration imports.
INDEXES = (
    _spec(
        "uq_agent_session_contents_id_session",
        "agent_session_contents",
        "(id, session_id)",
    ),
    _spec(
        "uq_session_search_sources_id_session",
        "session_search_sources",
        "(id, session_id)",
    ),
)


class ForeignKeySpec(NamedTuple):
    name: str
    table: str
    column: str
    parent: str


FOREIGN_KEYS = (
    ForeignKeySpec(
        "fk_session_search_sources_content_session",
        "session_search_sources",
        "content_id",
        "agent_session_contents",
    ),
    ForeignKeySpec(
        "fk_session_search_chunks_source_session",
        "session_search_chunks",
        "source_id",
        "session_search_sources",
    ),
)


CATALOG = sa.text("""
    SELECT relation.oid, relation.relkind::text AS relkind, relation.relowner,
           relation.relpersistence::text AS relpersistence, relation.relispartition,
           relation.reloptions, relation.reltablespace,
           parent.relname AS table_name, parent.relkind::text AS table_kind,
           parent.relispartition AS table_partition,
           parent.relowner AS table_owner, parent_namespace.nspname AS table_schema,
           method.amname, index.indisvalid, index.indisready, index.indislive,
           index.indisunique, index.indisprimary, index.indisexclusion,
           index.indisreplident, index.indisclustered,
           pg_get_indexdef(index.indexrelid) AS definition,
           EXISTS (SELECT 1 FROM pg_depend dependency
                   WHERE dependency.refclassid='pg_class'::regclass
                     AND dependency.refobjid=relation.oid) AS has_dependents,
           EXISTS (SELECT 1 FROM pg_depend dependency
                   WHERE dependency.classid='pg_class'::regclass
                     AND dependency.objid=relation.oid
                     AND dependency.deptype='e') AS extension_member,
           EXISTS (SELECT 1 FROM pg_constraint constraint_row
                   WHERE constraint_row.conindid=relation.oid
                     AND constraint_row.contype IN ('p', 'u', 'x')) AS constraint_owned
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    LEFT JOIN pg_index index ON index.indexrelid=relation.oid
    LEFT JOIN pg_class parent ON parent.oid=index.indrelid
    LEFT JOIN pg_namespace parent_namespace ON parent_namespace.oid=parent.relnamespace
    LEFT JOIN pg_am method ON method.oid=relation.relam
    WHERE namespace.nspname='public' AND relation.relname=:name
""")


def _catalog(spec: IndexSpec):
    return op.get_bind().execute(CATALOG, {"name": spec.name}).mappings().one_or_none()


def _validate_definition(spec: IndexSpec, row) -> None:
    # PostgreSQL 16's exact canonical definition binds keys, INCLUDE order,
    # predicate, opclasses, collations and ordering. Equivalent-but-different
    # definitions are held for review, not silently adopted or removed.
    expected = (
        row["relkind"] == "i"
        and row["table_schema"] == "public"
        and row["table_name"] == spec.table
        and row["table_kind"] == "r"
        and not row["table_partition"]
        and not row["relispartition"]
        and row["relpersistence"] == "p"
        and row["relowner"] == row["table_owner"]
        and row["amname"] == "btree"
        and row["definition"] == spec.definition
        and row["reloptions"] is None
        and row["indisunique"]
        and not row["indisprimary"]
        and not row["indisexclusion"]
        and not row["indisreplident"]
        and not row["indisclustered"]
        and not row["extension_member"]
        and not row["constraint_owned"]
    )
    if not expected:
        raise RuntimeError(
            f"Migration 129 refuses conflicting object public.{spec.name}; "
            "its definition, ownership or dependencies do not match"
        )
    _validate_index_dependents(spec, row)


def _usable(row) -> bool:
    return bool(row["indisvalid"] and row["indisready"] and row["indislive"])


def _placement(row):
    connection = op.get_bind()
    database_default = connection.execute(
        sa.text(
            "SELECT dattablespace FROM pg_database WHERE datname=current_database()"
        )
    ).scalar_one()
    if row is None:
        ambient = connection.execute(
            sa.text(
                "SELECT oid FROM pg_tablespace "
                "WHERE spcname=current_setting('default_tablespace')"
            )
        ).scalar_one_or_none()
        oid = ambient or database_default
    else:
        oid = row["reltablespace"] or database_default
    name = connection.execute(
        sa.text("SELECT spcname FROM pg_tablespace WHERE oid=:oid"), {"oid": oid}
    ).scalar_one_or_none()
    if name is None:
        raise RuntimeError("Migration 129 cannot resolve its bound index tablespace")
    return oid, name


def _verify_placement(spec, row, placement):
    if _placement(row) != placement:
        raise RuntimeError(
            f"Migration 129 observed tablespace drift for public.{spec.name}"
        )


def _create_in_placement(spec, placement):
    oid, name = placement
    current = (
        op.get_bind()
        .execute(
            sa.text("SELECT spcname FROM pg_tablespace WHERE oid=:oid"), {"oid": oid}
        )
        .scalar_one_or_none()
    )
    if current != name:
        raise RuntimeError(
            f"Migration 129 observed tablespace identity drift for public.{spec.name}"
        )
    quoted = op.get_bind().dialect.identifier_preparer.quote_identifier(name)
    head, separator, predicate = spec.creation.partition(" WHERE ")
    statement = head + " TABLESPACE " + quoted + separator + predicate
    op.execute(
        statement.replace(
            "CREATE UNIQUE INDEX ", "CREATE UNIQUE INDEX CONCURRENTLY ", 1
        )
    )


def _validate_recoverable_state(spec: IndexSpec, row) -> None:
    if _usable(row):
        return
    # Exact live invalid states are recoverable. An interrupted drop may also
    # be live/invalid; non-live and contradictory valid states remain held.
    if row["indisvalid"] or not row["indislive"]:
        raise RuntimeError(
            f"Migration 129 refuses unqualified partial state for public.{spec.name}"
        )


def _drop_exact(spec: IndexSpec, expected_oid: int) -> None:
    row = _catalog(spec)
    if row is None or row["oid"] != expected_oid:
        raise RuntimeError(
            f"Migration 129 observed identity drift for public.{spec.name}"
        )
    _validate_definition(spec, row)
    _validate_recoverable_state(spec, row)
    if row["has_dependents"]:
        raise RuntimeError(
            f"Migration 129 refuses to drop dependent index public.{spec.name}"
        )
    active = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_progress_create_index "
                "WHERE index_relid=:oid)"
            ),
            {"oid": expected_oid},
        )
        .scalar_one()
    )
    if active:
        raise RuntimeError(
            f"Migration 129 found an active builder for public.{spec.name}"
        )
    # Fixed migration identifiers only. No CASCADE and no blocking fallback.
    op.execute(f'DROP INDEX CONCURRENTLY public."{spec.name}"')
    if _catalog(spec) is not None:
        raise RuntimeError(f"Migration 129 did not remove public.{spec.name}")


def _postgresql_online() -> bool:
    context = op.get_context()
    if context.dialect.name != "postgresql":
        return False
    if context.as_sql:
        raise RuntimeError(
            "Migration 129 requires online PostgreSQL catalog validation"
        )
    return True


@contextmanager
def _ddl_window():
    limits = {
        "statement_timeout": DDL_STATEMENT_TIMEOUT_MS,
        "lock_timeout": DDL_LOCK_TIMEOUT_MS,
    }
    if any(value is None or value <= 0 for value in limits.values()):
        raise RuntimeError("Migration 129 requires positive DDL deadlines")
    with op.get_context().autocommit_block():
        connection = op.get_bind()
        prior = dict(
            connection.execute(
                sa.text(
                    "SELECT name,setting::bigint FROM pg_settings "
                    "WHERE name IN ('statement_timeout','lock_timeout')"
                )
            ).all()
        )
        if set(prior) != set(limits):
            raise RuntimeError(
                "Migration 129 could not inspect its DDL timeout settings"
            )
        try:
            for name, maximum in limits.items():
                effective = min(prior[name] or maximum, maximum)
                connection.execute(
                    sa.text("SELECT set_config(:name,:value,false)"),
                    {"name": name, "value": str(effective)},
                ).scalar_one()
            yield
        finally:
            # A lost physical session must not be reconnected during cleanup.
            if not connection.closed and not connection.invalidated:
                for name, value in prior.items():
                    connection.execute(
                        sa.text("SELECT set_config(:name,:value,false)"),
                        {"name": name, "value": str(value)},
                    ).scalar_one()


FOREIGN_KEY_CATALOG = sa.text("""
    SELECT c.oid, c.contype::text, c.convalidated, c.conindid,
           c.confmatchtype::text, c.confupdtype::text, c.confdeltype::text,
           c.condeferrable, c.condeferred, c.conislocal, c.coninhcount, c.conparentid,
           child.relkind::text AS child_kind, child.relpersistence::text AS child_persistence,
           child.relispartition AS child_partition,
           parent_namespace.nspname AS parent_schema, parent.relname AS parent_table,
           parent.relkind::text AS parent_kind, parent.relpersistence::text AS parent_persistence,
           parent.relispartition AS parent_partition,
           ARRAY(SELECT a.attname::text
                 FROM unnest(c.conkey) WITH ORDINALITY k(attnum, n)
                 JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
                 ORDER BY k.n) AS child_columns,
           ARRAY(SELECT a.attname::text
                 FROM unnest(c.confkey) WITH ORDINALITY k(attnum, n)
                 JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum
                 ORDER BY k.n) AS parent_columns
    FROM pg_constraint c
    JOIN pg_class child ON child.oid=c.conrelid
    JOIN pg_namespace child_namespace ON child_namespace.oid=child.relnamespace
    LEFT JOIN pg_class parent ON parent.oid=c.confrelid
    LEFT JOIN pg_namespace parent_namespace ON parent_namespace.oid=parent.relnamespace
    WHERE child_namespace.nspname='public' AND child.relname=:table AND c.conname=:name
""")


def _foreign_key_catalog(spec):
    return (
        op.get_bind()
        .execute(FOREIGN_KEY_CATALOG, {"table": spec.table, "name": spec.name})
        .mappings()
        .one_or_none()
    )


def _validate_foreign_key(spec, row):
    index = _catalog(next(index for index in INDEXES if index.table == spec.parent))
    expected = (
        row["contype"] == "f"
        and tuple(row["child_columns"]) == (spec.column, "session_id")
        and row["parent_schema"] == "public"
        and row["parent_table"] == spec.parent
        and tuple(row["parent_columns"]) == ("id", "session_id")
        and row["child_kind"] == row["parent_kind"] == "r"
        and row["child_persistence"] == row["parent_persistence"] == "p"
        and not row["child_partition"]
        and not row["parent_partition"]
        and row["confmatchtype"] == "s"
        and row["confupdtype"] == "a"
        and row["confdeltype"] == "c"
        and not row["condeferrable"]
        and not row["condeferred"]
        and row["conislocal"]
        and row["coninhcount"] == 0
        and row["conparentid"] == 0
        and index is not None
        and row["conindid"] == index["oid"]
    )
    if not expected:
        raise RuntimeError(
            f"Migration 129 refuses conflicting constraint public.{spec.table}.{spec.name}"
        )


def _validate_index_dependents(spec, row):
    if not row["has_dependents"]:
        return
    dependencies = (
        op.get_bind()
        .execute(
            sa.text("""
        SELECT classid='pg_constraint'::regclass AS is_constraint, objid, objsubid, deptype::text
        FROM pg_depend WHERE refclassid='pg_class'::regclass AND refobjid=:oid
    """),
            {"oid": row["oid"]},
        )
        .mappings()
        .all()
    )
    for dependency in dependencies:
        owned = None
        if (
            dependency["is_constraint"]
            and dependency["objsubid"] == 0
            and dependency["deptype"] == "n"
        ):
            for foreign_key in FOREIGN_KEYS:
                if foreign_key.parent != spec.table:
                    continue
                constraint = _foreign_key_catalog(foreign_key)
                if constraint is not None and constraint["oid"] == dependency["objid"]:
                    _validate_foreign_key(foreign_key, constraint)
                    owned = constraint
                    break
        if owned is None:
            raise RuntimeError(
                f"Migration 129 refuses foreign dependencies on public.{spec.name}"
            )


def _ensure_foreign_key(spec):
    row = _foreign_key_catalog(spec)
    if row is None:
        op.execute(
            f'ALTER TABLE public."{spec.table}" ADD CONSTRAINT "{spec.name}" '
            f'FOREIGN KEY ("{spec.column}", "session_id") '
            f'REFERENCES public."{spec.parent}" ("id", "session_id") ON DELETE CASCADE NOT VALID'
        )
        row = _foreign_key_catalog(spec)
    if row is None:
        raise RuntimeError(f"Migration 129 did not create constraint {spec.name}")
    _validate_foreign_key(spec, row)
    oid = row["oid"]
    if not row["convalidated"]:
        op.execute(
            f'ALTER TABLE public."{spec.table}" VALIDATE CONSTRAINT "{spec.name}"'
        )
    validated = _foreign_key_catalog(spec)
    if validated is None or validated["oid"] != oid:
        raise RuntimeError(
            f"Migration 129 observed constraint identity drift for {spec.name}"
        )
    _validate_foreign_key(spec, validated)
    if not validated["convalidated"]:
        raise RuntimeError(f"Migration 129 did not validate constraint {spec.name}")


def _drop_foreign_key(spec):
    row = _foreign_key_catalog(spec)
    if row is None:
        return
    _validate_foreign_key(spec, row)
    op.execute(f'ALTER TABLE public."{spec.table}" DROP CONSTRAINT "{spec.name}"')
    if _foreign_key_catalog(spec) is not None:
        raise RuntimeError(f"Migration 129 did not remove constraint {spec.name}")


def _preflight():
    for spec in FOREIGN_KEYS:
        row = _foreign_key_catalog(spec)
        if row is not None:
            _validate_foreign_key(spec, row)
    existing = {}
    for spec in INDEXES:
        row = _catalog(spec)
        if row is not None:
            _validate_definition(spec, row)
            _validate_recoverable_state(spec, row)
        existing[spec.name] = row
    return existing


def upgrade():
    if not _postgresql_online():
        return
    # The qualified env.py owns one session advisory lock before version
    # discovery and across this autocommit window. Uncoordinated DDL is excluded.
    with _ddl_window():
        existing = _preflight()  # Reject any known collision before any build.
        placements = {spec.name: _placement(existing[spec.name]) for spec in INDEXES}
        for spec in INDEXES:
            row = _catalog(spec)
            placement = placements[spec.name]
            if row is not None:
                _validate_definition(spec, row)
                _validate_recoverable_state(spec, row)
                _verify_placement(spec, row, placement)
                if _usable(row):
                    continue
                _drop_exact(spec, row["oid"])
            _create_in_placement(spec, placement)
            built = _catalog(spec)
            if built is None:
                raise RuntimeError(f"Migration 129 did not create public.{spec.name}")
            _validate_definition(spec, built)
            _verify_placement(spec, built, placement)
            if not _usable(built):
                raise RuntimeError(f"Migration 129 did not validate public.{spec.name}")
        for spec in FOREIGN_KEYS:
            _ensure_foreign_key(spec)
    # Alembic advances its version only after this method succeeds.


def downgrade():
    if not _postgresql_online():
        return
    with _ddl_window():
        _preflight()
        for spec in reversed(FOREIGN_KEYS):
            _drop_foreign_key(spec)
        for spec in reversed(INDEXES):
            row = _catalog(spec)
            if row is not None:
                _drop_exact(spec, row["oid"])
    # Absence is accepted after interrupted downgrade; foreign objects are not.
