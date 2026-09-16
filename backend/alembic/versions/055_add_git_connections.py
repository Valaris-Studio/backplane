# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add git_connections + git_repos.connection_id

Sprint 1 of the provider-agnostic git integrations layer (the new
app/integrations/git/ module tree). Coexists with the legacy single-token
GITHUB_TOKEN path in app/services/github_client.py — `git_repos.connection_id`
is nullable and NULL means "use the legacy path".

Both changes are rolling-deploy safe: adding a table + adding a nullable FK
column with no default. No data migration; existing repos stay on the legacy
path until an operator connects an OAuth account and points the repo at it.

Revision ID: 055
Revises: 054
Create Date: 2026-04-26
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSON, UUID

revision = "055"
down_revision = "054"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "git_connections",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "workspace_id",
            UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("account_login", sa.String(length=255), nullable=False),
        sa.Column("account_type", sa.String(length=32), nullable=False),
        sa.Column("encrypted_access_token", sa.LargeBinary, nullable=False),
        sa.Column("encrypted_refresh_token", sa.LargeBinary, nullable=True),
        sa.Column(
            "scopes",
            JSON,
            nullable=False,
            server_default="[]",
        ),
        sa.Column("expires_at", sa.DateTime, nullable=True),
        sa.Column("base_url", sa.String(length=512), nullable=True),
        sa.Column(
            "connected_by",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "workspace_id",
            "provider",
            "account_login",
            name="uq_git_connections_workspace_provider_login",
        ),
        sa.CheckConstraint(
            "provider IN ('github','gitlab','bitbucket','other')",
            name="ck_git_connections_provider",
        ),
        sa.CheckConstraint(
            "account_type IN ('user','organization')",
            name="ck_git_connections_account_type",
        ),
    )
    op.create_index(
        "ix_git_connections_workspace_provider",
        "git_connections",
        ["workspace_id", "provider"],
    )

    op.add_column(
        "git_repos",
        sa.Column(
            "connection_id",
            UUID(as_uuid=True),
            sa.ForeignKey("git_connections.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_git_repos_connection_id", "git_repos", ["connection_id"]
    )


def downgrade():
    op.drop_index("ix_git_repos_connection_id", table_name="git_repos")
    op.drop_column("git_repos", "connection_id")

    op.drop_index(
        "ix_git_connections_workspace_provider",
        table_name="git_connections",
    )
    op.drop_table("git_connections")
