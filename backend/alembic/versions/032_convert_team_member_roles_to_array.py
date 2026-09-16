# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""convert team member role to roles array

Revision ID: 032
Revises: 031
Create Date: 2026-04-15

"""

from alembic import op
import sqlalchemy as sa

revision = "032"
down_revision = "031"
branch_labels = None
depends_on = None


def upgrade():
    # Add roles JSON column (nullable during migration)
    op.add_column(
        "agent_team_members",
        sa.Column("roles", sa.JSON(), nullable=True),
    )

    # Migrate existing role values into roles array
    op.execute(
        """
        UPDATE agent_team_members
        SET roles = json_build_array(role)
        WHERE role IS NOT NULL
        """
    )

    # Set default for any null rows
    op.execute(
        """
        UPDATE agent_team_members
        SET roles = '[]'::json
        WHERE roles IS NULL
        """
    )

    # Make roles non-nullable
    op.alter_column("agent_team_members", "roles", nullable=False)

    # Drop old role column
    op.drop_column("agent_team_members", "role")


def downgrade():
    # Add role column back
    op.add_column(
        "agent_team_members",
        sa.Column("role", sa.String(20), nullable=True),
    )

    # Extract first role from array
    op.execute(
        """
        UPDATE agent_team_members
        SET role = roles->>0
        WHERE roles IS NOT NULL AND json_array_length(roles) > 0
        """
    )

    # Default for empty arrays
    op.execute(
        """
        UPDATE agent_team_members
        SET role = 'custom'
        WHERE role IS NULL
        """
    )

    op.alter_column("agent_team_members", "role", nullable=False)

    # Drop roles column
    op.drop_column("agent_team_members", "roles")
