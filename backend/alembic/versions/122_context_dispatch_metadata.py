# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Context-dispatch v1 floor on bindings and dispatch evidence on receipts.

Additive and rolling-safe: nullable columns with no default and no backfill.
The 121 release never selects them, and NULL keeps every existing binding
legacy and every existing receipt free of dispatch claims."""

import sqlalchemy as sa
from alembic import op

revision = "122"
down_revision = "121"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "execution_context_bindings",
        sa.Column("context_dispatch_version", sa.Integer(), nullable=True),
    )
    op.add_column(
        "execution_context_bindings",
        sa.Column("context_dispatch_mode", sa.String(16), nullable=True),
    )
    op.add_column(
        "execution_context_bindings",
        sa.Column("context_dispatch_policy_revision", sa.CHAR(64), nullable=True),
    )
    op.add_column(
        "execution_context_receipts", sa.Column("dispatch", sa.JSON(), nullable=True)
    )
    op.add_column(
        "execution_context_receipts",
        sa.Column("dispatch_summary", sa.JSON(), nullable=True),
    )


def downgrade():
    op.drop_column("execution_context_receipts", "dispatch_summary")
    op.drop_column("execution_context_receipts", "dispatch")
    op.drop_column("execution_context_bindings", "context_dispatch_policy_revision")
    op.drop_column("execution_context_bindings", "context_dispatch_mode")
    op.drop_column("execution_context_bindings", "context_dispatch_version")
