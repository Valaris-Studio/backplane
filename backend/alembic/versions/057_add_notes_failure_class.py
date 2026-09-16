# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add notes.failure_class for reviewer routing (SWE-AF #5)

Reviewer verdicts now carry a coarse failure classification so a downstream
advisor role can route by failure type and we can collect training signal on
what fails and why. The five values (ENVIRONMENT, LOGIC, DEPENDENCY, APPROACH,
TRANSIENT) live in app.models.notes.failure_class.ReviewFailureClass; the DB
column is a plain nullable string so the closed-set membership is enforced at
the schema boundary, not by a Postgres enum type (operator-extensible without
a schema change, same shape as notes.kind).

Rolling-deploy safe: nullable, no server default. Pre-existing verdicts stay
NULL, which means "this verdict pre-dates the field" — readable and meaningful
to both old and new code. No backfill.

Revision ID: 057
Revises: 056
Create Date: 2026-05-13
"""

import sqlalchemy as sa
from alembic import op

revision = "057"
down_revision = "056"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "notes",
        sa.Column("failure_class", sa.String(length=32), nullable=True),
    )


def downgrade():
    op.drop_column("notes", "failure_class")
