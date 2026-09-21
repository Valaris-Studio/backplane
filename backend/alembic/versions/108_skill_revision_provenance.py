# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Preserve immutable skill revision provenance and lifecycle audit history."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "108"
down_revision = "107"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("skill_versions", sa.Column("base_version", sa.Integer(), nullable=True))
    op.add_column("skill_versions", sa.Column("reason", sa.Text(), nullable=True))
    op.add_column("skill_versions", sa.Column("provenance", sa.JSON(), nullable=True))
    for name in ("source_board_id", "source_card_id", "source_execution_id", "delegation_id"):
        op.add_column("skill_versions", sa.Column(name, UUID(as_uuid=True), nullable=True))

    op.create_table(
        "skill_audit_events",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.func.gen_random_uuid()),
        sa.Column("skill_id", UUID(as_uuid=True), sa.ForeignKey("skills.id", ondelete="CASCADE"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=True),
        sa.Column("event_type", sa.String(64), nullable=False),
        sa.Column("actor", sa.JSON(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("details", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_skill_audit_events_history", "skill_audit_events", ["skill_id", "created_at", "id"])


def downgrade():
    op.drop_index("ix_skill_audit_events_history", table_name="skill_audit_events")
    op.drop_table("skill_audit_events")
    for name in ("delegation_id", "source_execution_id", "source_card_id", "source_board_id", "provenance", "reason", "base_version"):
        op.drop_column("skill_versions", name)
