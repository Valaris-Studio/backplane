# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add metadata covers with bounded concurrent builds and exact recovery."""

from contextlib import contextmanager
from typing import NamedTuple

from alembic import op
import sqlalchemy as sa

revision = "128"
down_revision = "127"
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
        f"CREATE INDEX {name} ON public.{table} USING btree {body}",
        f"CREATE INDEX {name} ON public.{table} USING btree {create_body or body}",
    )


# Freeze definitions independently of mutable application models.
INDEXES = (
    _spec(
        "ix_session_search_chunks_metadata",
        "session_search_chunks",
        "(session_id, source_id) INCLUDE (owned_bytes, channel)",
    ),
    _spec(
        "ix_session_search_sources_content_metadata",
        "session_search_sources",
        "(session_id, content_id) WHERE ((content_id IS NOT NULL) "
        "AND ((status)::text <> 'pending'::text))",
        create_body="(session_id, content_id) "
        "WHERE content_id IS NOT NULL AND status<>'pending'",
    ),
    _spec(
        "ix_agent_session_contents_search_metadata",
        "agent_session_contents",
        "(session_id, id, sha256) INCLUDE (state, coverage, media_type, "
        "byte_count, original_byte_count, channel)",
    ),
    _spec(
        "ix_agent_session_contents_search_session",
        "agent_session_contents",
        "(session_id, id)",
    ),
    _spec(
        "ix_session_search_sources_event_metadata",
        "session_search_sources",
        "(session_id, id) INCLUDE (status, extractor_version, event_id, call_anchor) "
        "WHERE (event_id IS NOT NULL)",
    ),
    _spec(
        "ix_session_search_sources_indexed_metadata",
        "session_search_sources",
        "(status, extractor_version, content_id) INCLUDE (source_digest, id)",
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
                     AND dependency.deptype='e') AS extension_member
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
        and not row["indisunique"]
        and not row["indisprimary"]
        and not row["indisexclusion"]
        and not row["indisreplident"]
        and not row["indisclustered"]
        and not row["has_dependents"]
        and not row["extension_member"]
    )
    if not expected:
        raise RuntimeError(
            f"Migration 128 refuses conflicting object public.{spec.name}; "
            "its definition, ownership or dependencies do not match"
        )


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
        raise RuntimeError("Migration 128 cannot resolve its bound index tablespace")
    return oid, name


def _verify_placement(spec, row, placement):
    if _placement(row) != placement:
        raise RuntimeError(
            f"Migration 128 observed tablespace drift for public.{spec.name}"
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
            f"Migration 128 observed tablespace identity drift for public.{spec.name}"
        )
    quoted = op.get_bind().dialect.identifier_preparer.quote_identifier(name)
    head, separator, predicate = spec.creation.partition(" WHERE ")
    statement = head + " TABLESPACE " + quoted + separator + predicate
    op.execute(statement.replace("CREATE INDEX ", "CREATE INDEX CONCURRENTLY ", 1))


def _validate_recoverable_state(spec: IndexSpec, row) -> None:
    if _usable(row):
        return
    # Exact live invalid states are recoverable. An interrupted drop may also
    # be live/invalid; non-live and contradictory valid states remain held.
    if row["indisvalid"] or not row["indislive"]:
        raise RuntimeError(
            f"Migration 128 refuses unqualified partial state for public.{spec.name}"
        )


def _drop_exact(spec: IndexSpec, expected_oid: int) -> None:
    row = _catalog(spec)
    if row is None or row["oid"] != expected_oid:
        raise RuntimeError(
            f"Migration 128 observed identity drift for public.{spec.name}"
        )
    _validate_definition(spec, row)
    _validate_recoverable_state(spec, row)
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
            f"Migration 128 found an active builder for public.{spec.name}"
        )
    # Fixed migration identifiers only. No CASCADE and no blocking fallback.
    op.execute(f'DROP INDEX CONCURRENTLY public."{spec.name}"')
    if _catalog(spec) is not None:
        raise RuntimeError(f"Migration 128 did not remove public.{spec.name}")


def _postgresql_online() -> bool:
    context = op.get_context()
    if context.dialect.name != "postgresql":
        return False
    if context.as_sql:
        raise RuntimeError(
            "Migration 128 requires online PostgreSQL catalog validation"
        )
    return True


@contextmanager
def _ddl_window():
    limits = {
        "statement_timeout": DDL_STATEMENT_TIMEOUT_MS,
        "lock_timeout": DDL_LOCK_TIMEOUT_MS,
    }
    if any(value is None or value <= 0 for value in limits.values()):
        raise RuntimeError("Migration 128 requires positive DDL deadlines")
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
                "Migration 128 could not inspect its DDL timeout settings"
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


def _preflight():
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
                raise RuntimeError(f"Migration 128 did not create public.{spec.name}")
            _validate_definition(spec, built)
            _verify_placement(spec, built, placement)
            if not _usable(built):
                raise RuntimeError(f"Migration 128 did not validate public.{spec.name}")
    # Alembic advances its version only after this method succeeds.


def downgrade():
    if not _postgresql_online():
        return
    with _ddl_window():
        _preflight()
        for spec in reversed(INDEXES):
            row = _catalog(spec)
            if row is not None:
                _drop_exact(spec, row["oid"])
    # Absence is accepted after interrupted downgrade; foreign objects are not.
