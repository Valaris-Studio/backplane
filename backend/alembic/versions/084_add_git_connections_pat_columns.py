# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add git_connections auth_kind + health columns, widen provider check

Workspace-scoped forge credentials: a connection can now be minted by an
operator pasting a PAT (auth_kind='pat') rather than only by the OAuth dance,
and each connection carries the outcome of its last probe against the forge.

The provider CHECK predates the `gitea` member of GitProvider, so a gitea
connection was rejected at the database even though the enum accepted it.
Postgres can't extend a CHECK in place — drop and recreate.

Additive columns only (server_default on the NOT NULL one), so old code running
mid-rolling-deploy neither sees nor needs them.

Revision ID: 084
Revises: 083
Create Date: 2026-08-09
"""

import sqlalchemy as sa
from alembic import op

revision = "084"
down_revision = "083"
branch_labels = None
depends_on = None

_PROVIDERS_BEFORE = "('github','gitlab','bitbucket','other')"
_PROVIDERS_AFTER = "('github','gitlab','bitbucket','gitea','other')"


def upgrade():
    op.add_column(
        "git_connections",
        sa.Column(
            "auth_kind",
            sa.String(length=16),
            nullable=False,
            server_default="oauth",
        ),
    )
    op.add_column(
        "git_connections",
        sa.Column("last_verified_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "git_connections",
        sa.Column("last_error", sa.String(length=1024), nullable=True),
    )
    op.drop_constraint(
        "ck_git_connections_provider", "git_connections", type_="check"
    )
    op.create_check_constraint(
        "ck_git_connections_provider",
        "git_connections",
        f"provider IN {_PROVIDERS_AFTER}",
    )


def downgrade():
    op.drop_constraint(
        "ck_git_connections_provider", "git_connections", type_="check"
    )
    op.create_check_constraint(
        "ck_git_connections_provider",
        "git_connections",
        f"provider IN {_PROVIDERS_BEFORE}",
    )
    op.drop_column("git_connections", "last_error")
    op.drop_column("git_connections", "last_verified_at")
    op.drop_column("git_connections", "auth_kind")
