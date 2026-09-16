# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add cards.parent_card_id + workspace_configs.conflict_consolidator + widen merge_queue state

PAR-3a (schema only). Three additive, rolling-deploy-safe changes:

1. cards.parent_card_id (nullable self-FK) — lets PAR-3c link a conflict-
   resolution consolidator card back to the original card whose merge
   failed. ON DELETE SET NULL so deleting an original card does not
   cascade-kill the consolidator history.
2. workspace_configs.conflict_consolidator (nullable JSON) — per-workspace
   knob that PAR-3c reads when deciding whether to spawn a consolidator
   card and where to put it. Expected shape (NOT enforced at the DB layer;
   PAR-3c validates at use-time):
       {"enabled": bool, "board_id": uuid, "column_id": uuid, "label": str}
3. Widen merge_queue_entries.state CHECK constraint to include
   'blocked_pending_consolidation' so PAR-3b can park entries while a
   human/agent works on the consolidator card.

Revision ID: 054
Revises: 053
Create Date: 2026-04-26
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSON, UUID

revision = "054"
down_revision = "053"
branch_labels = None
depends_on = None


_NEW_STATES = "'queued','merging','merged','conflict','failed','blocked_pending_consolidation'"
_OLD_STATES = "'queued','merging','merged','conflict','failed'"


def upgrade():
    op.add_column(
        "cards",
        sa.Column(
            "parent_card_id",
            UUID(as_uuid=True),
            sa.ForeignKey("cards.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_cards_parent_card_id", "cards", ["parent_card_id"]
    )

    op.add_column(
        "workspace_configs",
        sa.Column("conflict_consolidator", JSON, nullable=True),
    )

    # Widen the state allow-list. PostgreSQL has no ALTER CHECK CONSTRAINT,
    # so we drop and recreate. SQLite-backed test DBs build their schema
    # from the model's __table_args__ (where the new state is also listed),
    # so this migration step is Postgres-only territory in practice.
    if op.get_context().dialect.name == "postgresql":
        op.drop_constraint(
            "ck_merge_queue_entries_state",
            "merge_queue_entries",
            type_="check",
        )
        op.create_check_constraint(
            "ck_merge_queue_entries_state",
            "merge_queue_entries",
            f"state IN ({_NEW_STATES})",
        )


def downgrade():
    if op.get_context().dialect.name == "postgresql":
        op.drop_constraint(
            "ck_merge_queue_entries_state",
            "merge_queue_entries",
            type_="check",
        )
        op.create_check_constraint(
            "ck_merge_queue_entries_state",
            "merge_queue_entries",
            f"state IN ({_OLD_STATES})",
        )

    op.drop_column("workspace_configs", "conflict_consolidator")

    op.drop_index("ix_cards_parent_card_id", table_name="cards")
    op.drop_column("cards", "parent_card_id")
