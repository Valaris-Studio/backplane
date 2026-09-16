# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add source_execution_id to notes

Links a machine-generated note (review verdict, system note) to the execution
that produced it, so the UI can render the note as a link to its source
execution — the house "link anything we mention" rule.

Additive, nullable, ondelete=SET NULL — rolling-deploy safe and reaping an
execution never deletes the verdict it wrote. Human notes and pre-rollout rows
stay NULL. (Plumbing only: the column is accepted/persisted now; the Go runner
populating it on note creation is a follow-up.)

Mirrors 030 (add_card_id_to_notes) — same table, same nullable-FK + index +
SET NULL shape, same direct op.* + postgresql.UUID style.

Revision ID: 074
Revises: 073
Create Date: 2026-06-20
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "074"
down_revision = "073"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "notes",
        sa.Column("source_execution_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_index(
        "ix_notes_source_execution_id", "notes", ["source_execution_id"]
    )
    op.create_foreign_key(
        "fk_notes_source_execution_id",
        "notes",
        "agent_executions",
        ["source_execution_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_notes_source_execution_id", "notes", type_="foreignkey")
    op.drop_index("ix_notes_source_execution_id", "notes")
    op.drop_column("notes", "source_execution_id")
