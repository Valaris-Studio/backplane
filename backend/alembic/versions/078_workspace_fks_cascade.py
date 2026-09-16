# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add ondelete CASCADE to the three workspace FKs that lacked it

activities, agent_executions and approval_requests referenced workspaces.id
with NOT NULL and no ondelete, so deleting a workspace with any history hit an
FK violation. The workspace is the tenant boundary — its rows have no meaning
once it is gone, and SET NULL is unavailable (NOT NULL columns).

Revision ID: 078
Revises: 077
Create Date: 2026-07-30
"""

from alembic import op

revision = "078"
down_revision = "077"
branch_labels = None
depends_on = None

TABLES = ("activities", "agent_executions", "approval_requests")


def upgrade() -> None:
    for table in TABLES:
        op.drop_constraint(f"{table}_workspace_id_fkey", table, type_="foreignkey")
        op.create_foreign_key(
            f"{table}_workspace_id_fkey",
            table,
            "workspaces",
            ["workspace_id"],
            ["id"],
            ondelete="CASCADE",
        )


def downgrade() -> None:
    for table in TABLES:
        op.drop_constraint(f"{table}_workspace_id_fkey", table, type_="foreignkey")
        op.create_foreign_key(
            f"{table}_workspace_id_fkey",
            table,
            "workspaces",
            ["workspace_id"],
            ["id"],
        )
