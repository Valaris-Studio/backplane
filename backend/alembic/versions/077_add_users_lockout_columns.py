# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add brute-force lockout columns to users

Local auth card 7 (docs/plans/local-auth.md, L7): per-account lockout state.
The in-process rate limiter is per-instance (counters evaporate on restart and
multiply across replicas), so the account lockout — the authoritative layer —
persists here.

Rolling-deploy safe: server_default lets old code insert without the column;
locked_until is nullable (NULL = not locked).

Revision ID: 077
Revises: 076
Create Date: 2026-07-29
"""

from alembic import op
import sqlalchemy as sa

revision = "077"
down_revision = "076"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "failed_login_attempts",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "users",
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "locked_until")
    op.drop_column("users", "failed_login_attempts")
