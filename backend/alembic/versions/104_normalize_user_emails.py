# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""normalize users.email to canonical form + case-insensitive unique index

Email identity became case-insensitive at the app layer: every entry point
(HTTP auth tiers, WS, OIDC, add_member, seed) now writes and queries the
canonical form (`normalize_email`: strip + lower). This migration brings existing
rows in line and adds a Postgres functional unique index as belt-and-braces —
the app-level canonicalization is the primary guarantee, the index makes a
case-duplicate row impossible even for out-of-band writes (psql, future code
that forgets to normalize).

Case-collision groups (two rows whose emails differ only by case) are distinct
identities holding memberships, cards, and activity across many FK'd tables.
Merging them is operator judgment — this migration REFUSES and lists the
collisions instead of guessing which row wins.

Rolling-deploy safety: the UPDATE rewrites only non-canonical rows (expected
zero-to-few; users is small), and old code reading a lowercased email keeps
working — lookups by the exact stored value still hit. The index is a pure
addition. In-transaction build is fine at this table size (same reasoning as
075's non-concurrent indexes).

SQLite (test backend) runs the collision check and the backfill (plain SQL,
both dialects); the functional unique index is Postgres-only.

Revision ID: 104
Revises: 103
Create Date: 2026-08-29
"""

from alembic import op
from sqlalchemy import text

revision = "104"
down_revision = "103"
branch_labels = None
depends_on = None

LOWER_UNIQUE_INDEX = "ix_users_email_lower"


def upgrade():
    bind = op.get_bind()

    collisions = bind.execute(
        text(
            "SELECT lower(trim(email)) AS canonical, count(*) AS n FROM users "
            "GROUP BY lower(trim(email)) HAVING count(*) > 1"
        )
    ).fetchall()
    if collisions:
        detail = ", ".join(f"{row.canonical} (x{row.n})" for row in collisions)
        raise RuntimeError(
            "users.email has case-collision groups that must be merged by an "
            f"operator before this migration can run: {detail}. Each group is "
            "two distinct user rows with memberships/cards/activity — decide "
            "which row survives, reassign the other's references, delete it, "
            "then re-run migrations. Never auto-merged: FK reassignment across "
            "the schema is operator judgment."
        )

    bind.execute(
        text(
            "UPDATE users SET email = lower(trim(email)) "
            "WHERE email <> lower(trim(email))"
        )
    )

    if bind.dialect.name == "postgresql":
        # First functional index in the repo; plain op.create_index can't
        # express the function calls, hence raw SQL. btrim == trim(both) in
        # Postgres — used here because SQL-standard TRIM syntax is awkward
        # inside an index expression (this step is PG-only anyway; the
        # both-dialect steps above use trim(), which SQLite also has).
        op.execute(
            f"CREATE UNIQUE INDEX {LOWER_UNIQUE_INDEX} ON users (lower(btrim(email)))"
        )


def downgrade():
    if op.get_bind().dialect.name == "postgresql":
        op.execute(f"DROP INDEX IF EXISTS {LOWER_UNIQUE_INDEX}")
    # The lowercase backfill is one-way: original casing is not recorded, and
    # canonical rows are valid under the old code anyway.
