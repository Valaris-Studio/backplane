# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""extend approvalcategory enum with 'skill_publication'

Skills Registry W2 (card cdcf94b7). Agents cannot author skills directly —
their path is a proposal that lands as a pending ApprovalRequest, and that
request needs its own category: skill content steers future agent behavior,
so `skill_publication` carries a base risk score above the auto-approve
threshold and always waits for a human decision.

ADDITIVE, and safe under Cloud Run rolling updates. `ALTER TYPE ... ADD VALUE`
is a metadata-only catalog change: it rewrites no table data and takes no lock
on `approval_requests`. During a rolling update both code versions run against
the widened enum — the OLD code never emits the new value, and it reads no
rows carrying it because only the NEW code writes them. The reverse direction
(new code, old enum) never occurs: migrations run at container start, before
the new revision serves traffic. Non-transactional in Postgres but idempotent
on re-run via IF NOT EXISTS.

No dialect guard: like every enum migration before it (092, 097, 100), this
file is Postgres-only by construction — the SQLite test suite builds its
schema from `Base.metadata.create_all`, never from alembic.

Revision ID: 101
Revises: 100
Create Date: 2026-08-24
"""

from alembic import op

revision = "101"
down_revision = "100"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE approvalcategory ADD VALUE IF NOT EXISTS 'skill_publication'")


def downgrade() -> None:
    # PostgreSQL cannot drop an enum value without rewriting every dependent
    # column, and rows already written with it would be orphaned. Leaving the
    # value in place is harmless — nothing emits it once the code is rolled
    # back. Same choice as 092, 097 and 100.
    pass
