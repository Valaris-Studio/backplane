# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""platform expansion - activities, notes, resources, definitions, channels, git repos

Revision ID: 002
Revises: 001
Create Date: 2026-03-10
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None

# Pre-create enum references (create_type=False — we create them explicitly below)
activityaction_enum = postgresql.ENUM(
    "created", "updated", "deleted", "moved", "uploaded", "archived",
    name="activityaction", create_type=False,
)
activityentitytype_enum = postgresql.ENUM(
    "board", "column", "card", "note", "resource", "definition", "channel", "git_repo",
    name="activityentitytype", create_type=False,
)
resourcetype_enum = postgresql.ENUM("file", "folder", name="resourcetype", create_type=False)
channeltype_enum = postgresql.ENUM(
    "email", "slack", "whatsapp", "phone", "website", "other",
    name="channeltype", create_type=False,
)
gitprovider_enum = postgresql.ENUM(
    "github", "gitlab", "bitbucket", "other",
    name="gitprovider", create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()

    # Create enum types explicitly (checkfirst=True — CREATE TYPE is not transactional in PG)
    activityaction_enum.create(bind, checkfirst=True)
    activityentitytype_enum.create(bind, checkfirst=True)
    resourcetype_enum.create(bind, checkfirst=True)
    channeltype_enum.create(bind, checkfirst=True)
    gitprovider_enum.create(bind, checkfirst=True)

    # Activities (append-only event log)
    op.create_table(
        "activities",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("board_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("actor_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("entity_type", activityentitytype_enum, nullable=False),
        sa.Column("entity_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("action", activityaction_enum, nullable=False),
        sa.Column("summary", sa.String(500), nullable=False, server_default=""),
        sa.Column("changes", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.ForeignKeyConstraint(["board_id"], ["boards.id"]),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_activities_workspace_id", "activities", ["workspace_id"])
    op.create_index("ix_activities_workspace_created", "activities", ["workspace_id", "created_at"])
    op.create_index("ix_activities_board_created", "activities", ["board_id", "created_at"])
    op.create_index("ix_activities_entity", "activities", ["entity_type", "entity_id"])

    # Notes
    op.create_table(
        "notes",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("board_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        sa.Column("pinned", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["board_id"], ["boards.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_notes_workspace_id", "notes", ["workspace_id"])
    op.create_index("ix_notes_board_id", "notes", ["board_id"])

    # Resources
    op.create_table(
        "resources",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("board_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("parent_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("resource_type", resourcetype_enum, nullable=False),
        sa.Column("name", sa.String(500), nullable=False),
        sa.Column("gcs_path", sa.String(1024), nullable=True),
        sa.Column("mime_type", sa.String(255), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("uploaded_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["board_id"], ["boards.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["parent_id"], ["resources.id"]),
        sa.ForeignKeyConstraint(["uploaded_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_resources_workspace_id", "resources", ["workspace_id"])
    op.create_index("ix_resources_board_id", "resources", ["board_id"])

    # Definitions (1:1 with board)
    op.create_table(
        "definitions",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("board_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False, server_default=""),
        sa.Column("deadline", sa.DateTime(), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("updated_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["board_id"], ["boards.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("board_id", name="uq_definitions_board_id"),
    )

    # Channels
    op.create_table(
        "channels",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("channel_type", channeltype_enum, nullable=False),
        sa.Column("contact_value", sa.String(500), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_channels_workspace_id", "channels", ["workspace_id"])

    # Git Repos
    op.create_table(
        "git_repos",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("board_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("url", sa.String(1024), nullable=False),
        sa.Column("provider", gitprovider_enum, nullable=False),
        sa.Column("default_branch", sa.String(255), nullable=False, server_default="main"),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("added_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["board_id"], ["boards.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["added_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_git_repos_board_id", "git_repos", ["board_id"])


def downgrade() -> None:
    op.drop_table("git_repos")
    op.drop_table("channels")
    op.drop_table("definitions")
    op.drop_table("resources")
    op.drop_table("notes")
    op.drop_table("activities")
    op.execute("DROP TYPE IF EXISTS gitprovider")
    op.execute("DROP TYPE IF EXISTS channeltype")
    op.execute("DROP TYPE IF EXISTS resourcetype")
    op.execute("DROP TYPE IF EXISTS activityentitytype")
    op.execute("DROP TYPE IF EXISTS activityaction")
