# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""API keys a companion installation minted for the agents it launches.

Purely additive: one nullable column that only the new agent-key endpoints
write, so the previous release keeps running against this schema during a
rolling deploy.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "113"
down_revision = "112"
branch_labels = None
depends_on = None


def upgrade():
    # Batch mode so SQLite (tests, local dev) can add the foreign key.
    with op.batch_alter_table("api_keys") as batch:
        batch.add_column(sa.Column("installation_id", UUID(as_uuid=True), nullable=True))
        batch.create_foreign_key(
            "fk_api_keys_installation_id",
            "companion_installations",
            ["installation_id"],
            ["id"],
            ondelete="CASCADE",
        )


    # One live key per installation, whatever two concurrent rotations do.
    op.create_index(
        "ix_api_keys_installation_id",
        "api_keys",
        ["installation_id"],
        unique=True,
        postgresql_where=sa.text("installation_id IS NOT NULL"),
        sqlite_where=sa.text("installation_id IS NOT NULL"),
    )


def downgrade():
    op.drop_index("ix_api_keys_installation_id", table_name="api_keys")
    with op.batch_alter_table("api_keys") as batch:
        batch.drop_constraint("fk_api_keys_installation_id", type_="foreignkey")
        batch.drop_column("installation_id")
