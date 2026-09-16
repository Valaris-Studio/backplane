# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add notes.kind for verdict immutability

Notes now carry a `kind` (user_note, review_verdict, system, …). The reviewer
writes review_verdict notes that the orchestrator's Done-gate checks before
shipping. The service layer enforces append-only semantics for kinds in
IMMUTABLE_KINDS (currently {review_verdict}); without an immutable verdict
of record, a reviewer's request_changes can be silently deleted and a card
shipped to Done on red CI.

Rolling-deploy safe: NOT NULL with server_default="user_note" so existing
rows backfill automatically and the older code (which never reads kind)
keeps working against the new schema during the rollout window.

Revision ID: 049
Revises: 048
Create Date: 2026-04-25
"""

import sqlalchemy as sa
from alembic import op

revision = "049"
down_revision = "048"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "notes",
        sa.Column(
            "kind",
            sa.String(length=32),
            nullable=False,
            server_default="user_note",
        ),
    )


def downgrade():
    op.drop_column("notes", "kind")
