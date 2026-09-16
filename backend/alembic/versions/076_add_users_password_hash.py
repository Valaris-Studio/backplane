# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add password_hash to users

Local auth card 1 (docs/plans/local-auth.md, L1): the argon2id encoded hash
for users with a local credential. NULL = no local password — OIDC/IAP
provisioned users, and every user that exists today.

Additive and nullable per the rolling-deploy rule: old code briefly runs
against the new schema during deploys and must not need this column.

Revision ID: 076
Revises: 075
Create Date: 2026-07-28
"""

from alembic import op
import sqlalchemy as sa

revision = "076"
down_revision = "075"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("password_hash", sa.String(length=255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "password_hash")
