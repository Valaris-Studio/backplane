# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Companion installations, private agent sessions, MCP invocations and work links.

Purely additive: new tables plus two nullable Activity columns, so the previous
release keeps running against this schema during a rolling deploy.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "109"
down_revision = "108"
branch_labels = None
depends_on = None

EventJSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def uuid_pk():
    return sa.Column(
        "id",
        postgresql.UUID(as_uuid=True),
        primary_key=True,
        server_default=sa.func.gen_random_uuid(),
    )


def ref(name, table, *, nullable=False, ondelete="CASCADE", primary_key=False):
    return sa.Column(
        name,
        postgresql.UUID(as_uuid=True),
        sa.ForeignKey(table + ".id", ondelete=ondelete),
        nullable=nullable,
        primary_key=primary_key,
    )


def timestamp(name, *, nullable=False, now=False):
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        nullable=nullable,
        server_default=sa.func.now() if now else None,
    )


def counter(name, type_=sa.Integer()):
    return sa.Column(name, type_, nullable=False, server_default="0")


def upgrade():
    op.create_table(
        "companion_installations",
        uuid_pk(),
        ref("owner_id", "users"),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("platform", sa.String(64), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("token_prefix", sa.String(12), nullable=False),
        sa.Column("paused", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "auto_match_repos", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        sa.Column(
            "enabled_agents", sa.JSON(), nullable=False, server_default=sa.text("'[]'")
        ),
        sa.Column(
            "exclude_globs", sa.JSON(), nullable=False, server_default=sa.text("'[]'")
        ),
        timestamp("created_at", now=True),
        timestamp("last_seen_at", nullable=True),
        timestamp("revoked_at", nullable=True),
        sa.Column("retention_days", sa.Integer(), nullable=True),
        sa.Column("last_status", sa.JSON(), nullable=True),
        timestamp("last_status_at", nullable=True),
    )
    op.create_index(
        "ix_companion_installations_owner_id", "companion_installations", ["owner_id"]
    )

    op.create_table(
        "companion_project_mappings",
        uuid_pk(),
        ref("installation_id", "companion_installations"),
        ref("workspace_id", "workspaces"),
        ref("board_id", "boards", nullable=True, ondelete="SET NULL"),
        # Null for auto-matched repositories: the device keeps its local
        # root, and no home-directory path reaches the server.
        sa.Column("root_path", sa.String(1024), nullable=True),
        sa.Column("repo_url_normalized", sa.String(512), nullable=True),
        sa.Column("origin", sa.String(16), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "content_level", sa.String(16), nullable=False, server_default="standard"
        ),
        timestamp("created_at", now=True),
        timestamp("updated_at", now=True),
        sa.UniqueConstraint(
            "installation_id", "root_path", name="uq_companion_mapping_root"
        ),
        sa.CheckConstraint(
            "origin IN ('explicit', 'auto_repo')", name="ck_companion_mapping_origin"
        ),
        sa.CheckConstraint(
            "content_level IN ('metadata', 'standard', 'full')",
            name="ck_companion_mapping_content_level",
        ),
        sa.CheckConstraint(
            "(origin = 'auto_repo' AND repo_url_normalized IS NOT NULL) "
            "OR (origin = 'explicit' AND root_path IS NOT NULL)",
            name="ck_companion_mapping_located",
        ),
    )
    op.create_index(
        "uq_companion_mapping_auto_repo",
        "companion_project_mappings",
        ["installation_id", "repo_url_normalized"],
        unique=True,
        postgresql_where=sa.text("origin = 'auto_repo'"),
        sqlite_where=sa.text("origin = 'auto_repo'"),
    )
    for column in ("installation_id", "workspace_id", "board_id"):
        op.create_index(
            "ix_companion_project_mappings_" + column,
            "companion_project_mappings",
            [column],
        )

    op.create_table(
        "mcp_invocations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        ref("owner_id", "users"),
        ref("agent_id", "agents", nullable=True),
        ref("workspace_id", "workspaces", nullable=True),
        sa.Column("workspace_slug", sa.String(200), nullable=True),
        sa.Column("scope_status", sa.String(16), nullable=False),
        sa.Column("tool_name", sa.String(200), nullable=False),
        sa.Column("arguments_summary", sa.String(200), nullable=True),
        sa.Column("result_summary", sa.String(500), nullable=True),
        sa.Column("error_message", sa.String(500), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        timestamp("started_at"),
        timestamp("completed_at"),
        sa.Column("duration_seconds", sa.Float(), nullable=False),
        sa.Column("harness", sa.String(64), nullable=True),
        sa.Column("native_call_id", sa.String(200), nullable=True),
        sa.Column("client_name", sa.String(200), nullable=True),
        sa.Column("client_version", sa.String(64), nullable=True),
        sa.Column("server_instance_id", sa.String(200), nullable=True),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        timestamp("created_at"),
        sa.CheckConstraint(
            "status IN ('completed', 'failed', 'aborted')",
            name="ck_mcp_invocation_status",
        ),
    )
    op.create_index(
        "ix_mcp_invocations_owner", "mcp_invocations", ["owner_id", "created_at", "id"]
    )
    op.create_index(
        "ix_mcp_invocations_native_call",
        "mcp_invocations",
        ["owner_id", "native_call_id"],
    )

    op.create_table(
        "mcp_consultations",
        sa.Column("invocation_id", postgresql.UUID(as_uuid=True), primary_key=True),
        ref("actor_id", "users", primary_key=True),
        sa.Column("principal_key", sa.String(36), primary_key=True),
        ref("workspace_id", "workspaces", primary_key=True),
        sa.Column("entity_type", sa.String(16), primary_key=True),
        sa.Column("entity_id", postgresql.UUID(as_uuid=True), primary_key=True),
    )

    # The outcome arrives after the mutation it describes, so no FK. NULL
    # principal_key means an older writer: unknown, never an inferred human.
    op.add_column(
        "activities",
        sa.Column("mcp_invocation_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "activities", sa.Column("principal_key", sa.String(36), nullable=True)
    )
    op.create_index(
        "ix_activities_mcp_invocation",
        "activities",
        ["mcp_invocation_id", "actor_id", "workspace_id"],
    )

    op.create_table(
        "agent_sessions",
        uuid_pk(),
        ref("workspace_id", "workspaces"),
        ref("owner_id", "users"),
        ref("installation_id", "companion_installations"),
        sa.Column("harness", sa.String(64), nullable=False),
        sa.Column("native_session_id", sa.String(200), nullable=False),
        sa.Column("parent_native_session_id", sa.String(200), nullable=True),
        ref("parent_session_id", "agent_sessions", nullable=True, ondelete="SET NULL"),
        ref(
            "mapping_id",
            "companion_project_mappings",
            nullable=True,
            ondelete="SET NULL",
        ),
        ref("board_id", "boards", nullable=True, ondelete="SET NULL"),
        timestamp("started_at"),
        timestamp("last_event_at"),
        timestamp("ended_at", nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("cwd", sa.String(1024), nullable=True),
        sa.Column("repository", sa.String(1024), nullable=True),
        sa.Column("branch", sa.String(255), nullable=True),
        sa.Column("model", sa.String(200), nullable=True),
        sa.Column("harness_version", sa.String(64), nullable=True),
        counter("input_tokens", sa.BigInteger()),
        counter("output_tokens", sa.BigInteger()),
        counter("cache_read_tokens", sa.BigInteger()),
        counter("cache_creation_tokens", sa.BigInteger()),
        sa.Column("cost_usd", sa.Numeric(18, 6), nullable=True),
        counter("event_count"),
        counter("prompt_count"),
        counter("tool_call_count"),
        counter("error_count"),
        counter("capture_gaps"),
        sa.Column("title", sa.String(200), nullable=True),
        timestamp("created_at", now=True),
        timestamp("updated_at", now=True),
        sa.UniqueConstraint(
            "workspace_id",
            "owner_id",
            "installation_id",
            "harness",
            "native_session_id",
            name="uq_agent_session_identity",
        ),
        sa.CheckConstraint(
            "status IN ('active', 'ended')", name="ck_agent_session_status"
        ),
    )
    op.create_index(
        "ix_agent_sessions_owner_recent",
        "agent_sessions",
        ["owner_id", "workspace_id", "last_event_at", "id"],
    )
    for column in ("parent_session_id", "mapping_id"):
        op.create_index("ix_agent_sessions_" + column, "agent_sessions", [column])
    op.create_index(
        "ix_agent_sessions_board_recent",
        "agent_sessions",
        ["board_id", "last_event_at"],
    )
    op.create_index(
        "ix_agent_sessions_last_event_at", "agent_sessions", ["last_event_at"]
    )

    op.create_table(
        "agent_session_tombstones",
        uuid_pk(),
        sa.Column("session_id", postgresql.UUID(as_uuid=True), nullable=False),
        ref("installation_id", "companion_installations"),
        ref("workspace_id", "workspaces"),
        ref("owner_id", "users"),
        sa.Column("harness", sa.String(64), nullable=False),
        sa.Column("native_session_id", sa.String(200), nullable=False),
        sa.Column("reason", sa.String(16), nullable=False),
        timestamp("deleted_at"),
        sa.UniqueConstraint(
            "workspace_id",
            "owner_id",
            "installation_id",
            "harness",
            "native_session_id",
            name="uq_agent_session_tombstone_identity",
        ),
        sa.CheckConstraint(
            "reason IN ('owner', 'retention')",
            name="ck_agent_session_tombstone_reason",
        ),
    )
    for column in ("session_id", "deleted_at"):
        op.create_index(
            "ix_agent_session_tombstones_" + column,
            "agent_session_tombstones",
            [column],
        )

    op.create_table(
        "agent_session_captures",
        uuid_pk(),
        ref("installation_id", "companion_installations"),
        sa.Column("capture_id", sa.String(32), nullable=False),
        ref("session_id", "agent_sessions"),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("collection_method", sa.String(16), nullable=False),
        sa.Column("beacon_commit", sa.String(64), nullable=True),
        sa.Column("beacon_schema_version", sa.String(16), nullable=True),
        sa.Column("event_count", sa.Integer(), nullable=False),
        timestamp("captured_at"),
        timestamp("received_at"),
        sa.UniqueConstraint(
            "installation_id", "capture_id", name="uq_agent_session_capture"
        ),
    )
    op.create_index(
        "ix_agent_session_captures_session_id", "agent_session_captures", ["session_id"]
    )

    op.create_table(
        "agent_session_events",
        uuid_pk(),
        ref("session_id", "agent_sessions"),
        sa.Column("event_id", sa.String(64), nullable=False),
        sa.Column("capture_id", sa.String(32), nullable=False),
        timestamp("occurred_at"),
        timestamp("received_at"),
        sa.Column("action", sa.String(200), nullable=False),
        sa.Column("kind", sa.String(64), nullable=True),
        sa.Column("category", sa.String(64), nullable=True),
        sa.Column("fidelity", sa.String(16), nullable=True),
        sa.Column("collection_method", sa.String(16), nullable=False),
        sa.Column("tool_name", sa.String(200), nullable=True),
        sa.Column("native_tool_call_id", sa.String(200), nullable=True),
        sa.Column("mcp_server", sa.String(200), nullable=True),
        sa.Column("mcp_tool", sa.String(200), nullable=True),
        sa.Column("outcome", sa.String(16), nullable=True),
        sa.Column("event", EventJSON, nullable=False),
        sa.UniqueConstraint("session_id", "event_id", name="uq_agent_session_event"),
    )
    op.create_index(
        "ix_agent_session_events_timeline",
        "agent_session_events",
        ["session_id", "occurred_at", "id"],
    )
    op.create_index(
        "ix_agent_session_events_native_call",
        "agent_session_events",
        ["native_tool_call_id"],
    )

    op.create_table(
        "agent_session_invocations",
        ref("session_id", "agent_sessions", primary_key=True),
        ref("invocation_id", "mcp_invocations", primary_key=True),
        timestamp("matched_at"),
    )
    op.create_index(
        "ix_agent_session_invocations_invocation_id",
        "agent_session_invocations",
        ["invocation_id"],
    )

    op.create_table(
        "session_work_links",
        uuid_pk(),
        ref("session_id", "agent_sessions"),
        ref("workspace_id", "workspaces"),
        sa.Column("entity_type", sa.String(16), nullable=False),
        sa.Column("entity_id", postgresql.UUID(as_uuid=True), nullable=False),
        ref("board_id", "boards", nullable=True, ondelete="SET NULL"),
        sa.Column("relation", sa.String(16), nullable=False),
        timestamp("first_seen_at"),
        timestamp("last_seen_at"),
        sa.Column("invocation_count", sa.Integer(), nullable=False),
        sa.UniqueConstraint(
            "session_id",
            "entity_type",
            "entity_id",
            "relation",
            name="uq_session_work_link",
        ),
        sa.CheckConstraint(
            "entity_type IN ('card', 'note')", name="ck_session_work_link_entity"
        ),
        sa.CheckConstraint(
            "relation IN ('changed', 'consulted')",
            name="ck_session_work_link_relation",
        ),
    )
    for column in ("workspace_id", "board_id"):
        op.create_index(
            "ix_session_work_links_" + column, "session_work_links", [column]
        )
    op.create_index(
        "ix_session_work_links_entity",
        "session_work_links",
        ["entity_type", "entity_id"],
    )


def downgrade():
    op.drop_table("session_work_links")
    op.drop_table("agent_session_invocations")
    op.drop_table("agent_session_events")
    op.drop_table("agent_session_captures")
    op.drop_table("agent_session_tombstones")
    op.drop_table("agent_sessions")
    op.drop_index("ix_activities_mcp_invocation", table_name="activities")
    op.drop_column("activities", "principal_key")
    op.drop_column("activities", "mcp_invocation_id")
    op.drop_table("mcp_consultations")
    op.drop_table("mcp_invocations")
    op.drop_table("companion_project_mappings")
    op.drop_table("companion_installations")
