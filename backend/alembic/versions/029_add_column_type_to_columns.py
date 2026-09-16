# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add column_type to columns table

Revision ID: 029
Revises: 028
Create Date: 2026-04-13

"""
from alembic import op
import sqlalchemy as sa

revision = "029"
down_revision = "028"
branch_labels = None
depends_on = None

# Semantic column types for agent work discovery.
# Agents search by column_type instead of matching column names.
COLUMN_TYPE_ENUM = sa.Enum(
    "backlog", "active", "review", "done", "blocked",
    name="columntype",
)

# Case-insensitive name patterns → column_type defaults
NAME_DEFAULTS = {
    "backlog": "backlog",
    "to do": "backlog",
    "todo": "backlog",
    "in progress": "active",
    "doing": "active",
    "active": "active",
    "review": "review",
    "code review": "review",
    "qa": "review",
    "done": "done",
    "completed": "done",
    "shipped": "done",
    "blocked": "blocked",
}


def upgrade() -> None:
    COLUMN_TYPE_ENUM.create(op.get_bind(), checkfirst=True)
    op.add_column(
        "columns",
        sa.Column("column_type", COLUMN_TYPE_ENUM, nullable=True),
    )
    # Assign defaults based on common column name patterns.
    # Use CAST for PostgreSQL enum compatibility.
    for name_pattern, col_type in NAME_DEFAULTS.items():
        op.execute(
            sa.text(
                "UPDATE columns SET column_type = CAST(:col_type AS columntype) "
                "WHERE lower(name) = :pattern AND column_type IS NULL"
            ).bindparams(col_type=col_type, pattern=name_pattern)
        )


def downgrade() -> None:
    op.drop_column("columns", "column_type")
    COLUMN_TYPE_ENUM.drop(op.get_bind(), checkfirst=True)
