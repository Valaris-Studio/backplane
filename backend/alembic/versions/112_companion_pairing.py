# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Browser-code (RFC 8628) companion pairing.

Purely additive: two new tables that only the new pairing endpoints read or
write, so the previous release keeps running against this schema during a
rolling deploy.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "112"
down_revision = "111"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "companion_pairings",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("device_code_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("user_code_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("requested_name", sa.String(200), nullable=True),
        sa.Column("platform", sa.String(32), nullable=False),
        sa.Column("arch", sa.String(32), nullable=False),
        sa.Column("companion_version", sa.String(64), nullable=False),
        sa.Column("state", sa.String(16), nullable=False, server_default="pending"),
        sa.Column(
            "approved_by",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "installation_id",
            UUID(as_uuid=True),
            sa.ForeignKey("companion_installations.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_polled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "state IN ('pending', 'approved', 'denied', 'consumed', 'expired')",
            name="ck_companion_pairing_state",
        ),
    )
    op.create_index(
        "ix_companion_pairings_approved_by", "companion_pairings", ["approved_by"]
    )
    op.create_table(
        "companion_pairing_lookup_failures",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_companion_pairing_failures_user_time",
        "companion_pairing_lookup_failures",
        ["user_id", "created_at"],
    )


def downgrade():
    op.drop_table("companion_pairing_lookup_failures")
    op.drop_table("companion_pairings")
