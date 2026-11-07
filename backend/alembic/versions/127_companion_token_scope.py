# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Companion installations gain a device-token scope.

Additive and rolling-safe: one non-null column whose server default `full`
is exactly what every existing token can do today, so the previous release,
which never reads it, keeps behaving as before. Downgrading drops the column;
a `capture_only` installation then reverts to a full token, so downgrade only
after revoking those installations if that matters."""

import sqlalchemy as sa
from alembic import op

revision = "127"
down_revision = "126"
branch_labels = None
depends_on = None


def upgrade():
    # Batch mode so SQLite can add the CHECK; on Postgres it is plain ALTERs.
    with op.batch_alter_table("companion_installations") as batch:
        batch.add_column(
            sa.Column(
                "token_scope",
                sa.String(16),
                nullable=False,
                server_default="full",
            )
        )
        batch.create_check_constraint(
            "ck_companion_installation_token_scope",
            "token_scope IN ('full', 'capture_only')",
        )


def downgrade():
    with op.batch_alter_table("companion_installations") as batch:
        batch.drop_constraint("ck_companion_installation_token_scope", type_="check")
        batch.drop_column("token_scope")
