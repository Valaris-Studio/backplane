# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add 'gitea' value to the gitprovider enum

Reconciles the backend GitProvider enum with the runner's `git.forge: gitea`
option (provider-abstraction program). Additive only — no existing value is
renamed or dropped, so it is rolling-deploy safe: old code never emits 'gitea',
new code can.

`ALTER TYPE ... ADD VALUE IF NOT EXISTS` is idempotent. Postgres 12+ allows it
inside a transaction as long as the new value is not USED in the same
transaction (it is not — only added), matching this repo's existing
enum-extension migrations (see 045). SQLite (the test DB) stores enums as plain
VARCHAR, so no DDL is needed there.

Downgrade is a documented no-op: Postgres has no `ALTER TYPE ... DROP VALUE`,
and the unused 'gitea' label is harmless.

Revision ID: 072
Revises: 071
Create Date: 2026-06-16
"""

from alembic import op

revision = "072"
down_revision = "071"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    op.execute("ALTER TYPE gitprovider ADD VALUE IF NOT EXISTS 'gitea'")


def downgrade():
    # Postgres cannot remove an enum value; leaving 'gitea' in place is safe.
    pass
