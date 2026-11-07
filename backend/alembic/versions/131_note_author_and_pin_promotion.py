# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add author and pin-promotion stamps to notes

Records who a note came from and who promoted it to a pinned directive, so
agents can read a board's pinned notes as human-controlled context and the UI
can attribute a note to the Agent that wrote it (SEC, card 6f33e60a).

- author_principal_kind: "user" | "installation" | "agent", stamped by the
  server from the request principal, never from the body.
- author_agent_id: the Agent row when the principal was an agent.
- pinned_by / pinned_at: the human promotion act; cleared on unpin.

Additive, nullable, ondelete=SET NULL — rolling-deploy safe (old code ignores
the columns) and reaping an agent or user never deletes the note. Pre-131
rows stay NULL and are treated exactly like freshly pinned notes.

Mirrors 074 (add source_execution_id to notes) — same table, same nullable-FK
+ index + SET NULL shape, same direct op.* + postgresql.UUID style.

Revision ID: 131
Revises: 130
Create Date: 2026-11-02
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "131"
down_revision = "130"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "notes", sa.Column("author_principal_kind", sa.String(16), nullable=True)
    )
    op.add_column(
        "notes",
        sa.Column("author_agent_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_index("ix_notes_author_agent_id", "notes", ["author_agent_id"])
    op.create_foreign_key(
        "fk_notes_author_agent_id",
        "notes",
        "agents",
        ["author_agent_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column(
        "notes", sa.Column("pinned_by", postgresql.UUID(as_uuid=True), nullable=True)
    )
    op.create_foreign_key(
        "fk_notes_pinned_by", "notes", "users", ["pinned_by"], ["id"], ondelete="SET NULL"
    )
    op.add_column(
        "notes", sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("notes", "pinned_at")
    op.drop_constraint("fk_notes_pinned_by", "notes", type_="foreignkey")
    op.drop_column("notes", "pinned_by")
    op.drop_constraint("fk_notes_author_agent_id", "notes", type_="foreignkey")
    op.drop_index("ix_notes_author_agent_id", "notes")
    op.drop_column("notes", "author_agent_id")
    op.drop_column("notes", "author_principal_kind")
