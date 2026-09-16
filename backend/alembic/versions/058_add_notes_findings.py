# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add notes.findings for severity-tiered reviewer rubric (SWE-AF #3)

Reviewer verdicts now carry a structured `findings` list — each finding has a
severity tier (BLOCKING / SHOULD_FIX / SUGGESTION). The done-gate derives
`approved` deterministically: tests_pass AND no BLOCKING findings. The closed
enum lives in app.models.notes.finding.FindingSeverity; the DB column is JSON
because findings are a list of small dicts and we don't need to query into
them by index — they're consumed as a unit by the verdict service.

Rolling-deploy safe: nullable, no server default. Pre-existing verdicts stay
NULL — old code (and the legacy decision-string path) keeps working. The
derivation helper treats NULL as "no structured findings, fall back to the
decision string". No backfill.

Revision ID: 058
Revises: 057
Create Date: 2026-05-13
"""

import sqlalchemy as sa
from alembic import op

revision = "058"
down_revision = "057"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "notes",
        sa.Column("findings", sa.JSON(), nullable=True),
    )


def downgrade():
    op.drop_column("notes", "findings")
