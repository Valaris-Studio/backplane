# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Rich session capture: the `rich` mapping level, capture generations,
content items with their bodies' metadata, and the queue of stored objects
to delete.

Additive and rolling-safe: every new column is nullable or has a server
default, so the previous release keeps inserting; rows written before claim
no content (zero bytes, no items) and no mapping becomes rich.

The previous release does not know the level `rich` and fails to read any
row that names it. Rolling code back below this migration therefore first
rewrites `rich` to `full`, the closest level it knows, in this order (the
downgrade does the same before dropping anything):
  1. companion_project_mappings.content_level, first, so nothing records
     `rich` again meanwhile;
  2. agent_sessions.capture_levels, keeping each level's last occurrence in
     order, since the last entry is read as the latest level;
  3. agent_session_captures.content_level;
  4. companion_installations.last_status, without its rich_capture member.

To roll back the code alone (the usual path), keeping the schema and every
stored body:
  1. Deploy the current image with RICH_CAPTURE_ENABLED off and min = max
     instances set in that same deploy, and wait until that revision serves
     all traffic. Every instance start runs `alembic upgrade head`, and this
     migration is idempotent: a new instance started later (scaling, a
     restart, any service update) would quietly apply 119 again.
  2. Run `python -m scripts.forget_rich --apply` from that image (in
     production a one-off Cloud Run job on it). In one transaction it makes
     the four rewrites and stamps the previous head, 118, so the previous
     image's startup migration finds a revision it knows. Nothing is dropped,
     and with the switch off nothing writes these values again.
  3. Check `SELECT version_num FROM alembic_version` reads 118.
  4. Deploy the previous image at once.
  5. Should it still fail with "Can't locate revision identified by '119'",
     an instance of the current image applied 119 again: repeat 2 to 4, all
     of which are safe to repeat.
To roll forward, deploy the new image: its upgrade runs 119 again, creating
only what is absent and keeping the data it finds. Downgrading this migration
is the full revert only: it also drops the content tables, orphaning every
stored body.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.exc import NoInspectionAvailable
from sqlalchemy.dialects import postgresql

revision = "119"
down_revision = "118"
branch_labels = None
depends_on = None

LEVELS = "('metadata', 'standard', 'full')"
_sessions = sa.table(
    "agent_sessions", sa.column("id"), sa.column("capture_levels", sa.JSON)
)
_installations = sa.table(
    "companion_installations", sa.column("id"), sa.column("last_status", sa.JSON)
)
LEVELS_WITH_RICH = "('metadata', 'standard', 'full', 'rich')"
_MAPPINGS = "companion_project_mappings"


def _set_levels(levels: str) -> None:
    inspector = _inspector()
    existing = (
        {check["name"] for check in inspector.get_check_constraints(_MAPPINGS)}
        if inspector
        else {"ck_companion_mapping_content_level"}
    )
    with op.batch_alter_table(_MAPPINGS) as batch:
        if "ck_companion_mapping_content_level" in existing:
            batch.drop_constraint("ck_companion_mapping_content_level", type_="check")
        batch.create_check_constraint(
            "ck_companion_mapping_content_level", f"content_level IN {levels}"
        )


# Rolling code back keeps this migration's objects and stamps 118 (see
# stamp_previous_release), so rolling forward runs it again over them: each
# object is created only when it is absent, and existing data stays.
def _inspector():
    """The live schema, or None when there is none to probe (`upgrade --sql`,
    a mock connection): the DDL is then emitted as for a schema at 118."""
    if op.get_context().as_sql:
        return None
    try:
        return sa.inspect(op.get_bind())
    except NoInspectionAvailable:
        return None


def _add_missing_columns(table: str, *columns: sa.Column) -> None:
    inspector = _inspector()
    present = (
        {column["name"] for column in inspector.get_columns(table)}
        if inspector
        else set()
    )
    missing = [column for column in columns if column.name not in present]
    if missing:
        with op.batch_alter_table(table) as batch:
            for column in missing:
                batch.add_column(column)


def _create_table_if_absent(name: str, *elements) -> None:
    inspector = _inspector()
    if not (inspector and inspector.has_table(name)):
        op.create_table(name, *elements)


def _create_index_if_absent(name: str, table: str, columns: list[str], **kw) -> None:
    inspector = _inspector()
    if not (
        inspector and name in {index["name"] for index in inspector.get_indexes(table)}
    ):
        op.create_index(name, table, columns, **kw)


def upgrade():
    _set_levels(LEVELS_WITH_RICH)
    _add_missing_columns(
        "companion_project_mappings",
        sa.Column("rich_since", sa.DateTime(timezone=True), nullable=True),
    )
    _add_missing_columns(
        "companion_installations",
        sa.Column("capture_capabilities", sa.JSON(), nullable=True),
        sa.Column("capture_capabilities_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("content_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("content_sweep_cursor", sa.String(1024), nullable=True),
        sa.Column("content_swept_at", sa.DateTime(timezone=True), nullable=True),
    )
    _add_missing_columns(
        "agent_sessions",
        sa.Column("content_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("content_count", sa.Integer(), nullable=False, server_default="0"),
    )

    _create_table_if_absent(
        "agent_session_capture_generations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "installation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("companion_installations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "mapping_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("companion_project_mappings.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("harness", sa.String(64), nullable=False),
        sa.Column("generation_key", sa.CHAR(32), nullable=False),
        sa.Column("policy_revision", sa.CHAR(64), nullable=False),
        sa.Column("admitted_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "installation_id",
            "generation_key",
            name="uq_agent_session_capture_generation",
        ),
    )
    _create_table_if_absent(
        "agent_session_contents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("agent_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "workspace_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "owner_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "installation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("companion_installations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "generation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("agent_session_capture_generations.id"),
            nullable=False,
        ),
        sa.Column("capture_id", sa.String(32), nullable=False),
        sa.Column("content_key", sa.CHAR(64), nullable=False),
        sa.Column("event_id", sa.String(64), nullable=True),
        sa.Column("call_key", sa.String(200), nullable=True),
        sa.Column("parent_call_key", sa.String(200), nullable=True),
        sa.Column("turn_id", sa.String(200), nullable=True),
        sa.Column("display_path", sa.String(1024), nullable=True),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("channel", sa.String(32), nullable=False),
        sa.Column("media_type", sa.String(127), nullable=False),
        sa.Column("source_kind", sa.String(32), nullable=False),
        sa.Column("native_ref", sa.String(200), nullable=True),
        sa.Column("source_order", sa.BigInteger(), nullable=False),
        sa.Column("body_from", sa.String(32), nullable=True),
        sa.Column("parser_version", sa.String(64), nullable=False),
        sa.Column("source_schema_version", sa.String(64), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("content_level", sa.String(16), nullable=False),
        sa.Column("policy_revision", sa.CHAR(64), nullable=False),
        sa.Column("filter_version", sa.String(64), nullable=False),
        sa.Column("redactions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("byte_count", sa.BigInteger(), nullable=True),
        sa.Column("original_byte_count", sa.BigInteger(), nullable=True),
        sa.Column("sha256", sa.CHAR(64), nullable=True),
        sa.Column("inline_text", sa.Text(), nullable=True),
        sa.Column("preview", sa.Text(), nullable=True),
        sa.Column("storage_backend", sa.String(16), nullable=True),
        sa.Column("storage_key", sa.String(1024), nullable=True),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("coverage", sa.String(32), nullable=False),
        sa.Column("coverage_reason", sa.String(32), nullable=True),
        sa.Column("declared_coverage", sa.String(32), nullable=False),
        sa.Column("declared_coverage_reason", sa.String(32), nullable=True),
        sa.Column("delivery", sa.String(16), nullable=False),
        sa.Column("chunk_count", sa.SmallInteger(), nullable=True),
        sa.Column(
            "received_chunks",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column(
            "finalize_failures", sa.SmallInteger(), nullable=False, server_default="0"
        ),
        sa.Column("upload_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint(
            "session_id", "content_key", name="uq_agent_session_content"
        ),
        sa.CheckConstraint(
            "state IN ('pending', 'available', 'recorded')",
            name="ck_agent_session_content_state",
        ),
    )
    _create_index_if_absent(
        "ix_agent_session_contents_timeline",
        "agent_session_contents",
        ["session_id", "occurred_at", "source_order", "id"],
    )
    _create_index_if_absent(
        "ix_agent_session_contents_call",
        "agent_session_contents",
        ["session_id", "call_key"],
        postgresql_where=sa.text("call_key IS NOT NULL"),
        sqlite_where=sa.text("call_key IS NOT NULL"),
    )
    _create_index_if_absent(
        "ix_agent_session_contents_pending_expiry",
        "agent_session_contents",
        ["upload_expires_at"],
        postgresql_where=sa.text("state = 'pending'"),
        sqlite_where=sa.text("state = 'pending'"),
    )
    _create_index_if_absent(
        "ix_agent_session_contents_receipt",
        "agent_session_contents",
        ["installation_id", "capture_id"],
    )
    _create_table_if_absent(
        "agent_session_content_deletions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("storage_backend", sa.String(16), nullable=False),
        sa.Column("storage_prefix", sa.String(1024), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_error", sa.String(1024), nullable=True),
    )
    _create_index_if_absent(
        "ix_agent_session_content_deletions_due",
        "agent_session_content_deletions",
        ["next_attempt_at"],
    )


def _without_rich(levels: list[str]) -> list[str]:
    """`rich` as `full`; of a repeated level only its last occurrence, in order."""
    levels = ["full" if level == "rich" else level for level in levels]
    last_seen = {level: position for position, level in enumerate(levels)}
    return sorted(last_seen, key=last_seen.get)


def _rewrite(connection, table, column, marker: str, rewrite) -> int:
    """Apply `rewrite` to each JSON value whose text names `marker`."""
    found = connection.execute(
        sa.select(table.c.id, table.c[column]).where(
            sa.cast(table.c[column], sa.Text).like(f'%"{marker}"%')
        )
    ).all()
    for row_id, value in found:
        connection.execute(
            sa.update(table)
            .where(table.c.id == row_id)
            .values({column: rewrite(value)})
        )
    return len(found)


def forget_rich(connection) -> dict[str, int]:
    """Rewrite what the previous release cannot read, in the order that keeps
    it from coming back; returns the rows changed per step. Also run on its
    own (scripts/forget_rich.py) to roll code back while keeping the schema."""
    return {
        "mappings": connection.execute(
            sa.text(
                "UPDATE companion_project_mappings SET content_level = 'full' "
                "WHERE content_level = 'rich'"
            )
        ).rowcount,
        "sessions": _rewrite(
            connection, _sessions, "capture_levels", "rich", _without_rich
        ),
        "captures": connection.execute(
            sa.text(
                "UPDATE agent_session_captures SET content_level = 'full' "
                "WHERE content_level = 'rich'"
            )
        ).rowcount,
        "heartbeats": _rewrite(
            connection,
            _installations,
            "last_status",
            "rich_capture",
            lambda status: {
                name: value for name, value in status.items() if name != "rich_capture"
            },
        ),
    }


def stamp_previous_release(connection) -> int:
    """Record the previous release's head, so its startup `alembic upgrade
    head` finds a revision it knows; 119's objects stay for a roll-forward.
    Only ever over 119 itself, and only in a database 119 built."""
    if not sa.inspect(connection).has_table("agent_session_contents"):
        return 0
    return connection.execute(
        sa.text(
            f"UPDATE alembic_version SET version_num = '{down_revision}' "
            f"WHERE version_num = '{revision}'"
        )
    ).rowcount


def downgrade():
    forget_rich(op.get_bind())
    op.drop_index(
        "ix_agent_session_content_deletions_due",
        table_name="agent_session_content_deletions",
    )
    op.drop_table("agent_session_content_deletions")
    for name in (
        "ix_agent_session_contents_receipt",
        "ix_agent_session_contents_pending_expiry",
        "ix_agent_session_contents_call",
        "ix_agent_session_contents_timeline",
    ):
        op.drop_index(name, table_name="agent_session_contents")
    op.drop_table("agent_session_contents")
    op.drop_table("agent_session_capture_generations")
    with op.batch_alter_table("agent_sessions") as batch:
        batch.drop_column("content_count")
        batch.drop_column("content_bytes")
    with op.batch_alter_table("companion_installations") as batch:
        batch.drop_column("content_swept_at")
        batch.drop_column("content_sweep_cursor")
        batch.drop_column("content_bytes")
        batch.drop_column("capture_capabilities_at")
        batch.drop_column("capture_capabilities")
    with op.batch_alter_table("companion_project_mappings") as batch:
        batch.drop_column("rich_since")
    _set_levels(LEVELS)
