# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""extend activityentitytype enum with 'agent'

Card 1ed41312. Agent lifecycle transitions (pause, resume, poll, deactivate,
restart, hard delete) previously left no durable trace — the WS bus was the
only observability surface and it is ephemeral. ActivityService now records
them, which needs an `agent` member on the `activityentitytype` enum.

ADDITIVE, and safe under Cloud Run rolling updates. `ALTER TYPE ... ADD VALUE`
is a metadata-only catalog change: it rewrites no table data and takes no
lock on `activities`. During a rolling update both code versions run against
the widened enum — the OLD code simply never emits the new value, and it reads
no rows carrying it because only the NEW code writes them. The reverse
direction (new code, old enum) never occurs: migrations run at container start,
before the new revision serves traffic.

Mirrors 066_extend_activity_action_dependency.py, which mirrors
008_extend_activity_enums.py — both ran in production without incident.
Non-transactional in Postgres but idempotent on re-run via IF NOT EXISTS.

Revision ID: 092
Revises: 091
Create Date: 2026-08-16
"""

from alembic import op

revision = "092"
down_revision = "091"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE activityentitytype ADD VALUE IF NOT EXISTS 'agent'")


def downgrade() -> None:
    # PostgreSQL cannot drop an enum value without rewriting every dependent
    # column, and rows already written with it would be orphaned. Leaving the
    # value in place is harmless — nothing emits it once the code is rolled
    # back. Same choice as 008 and 066.
    pass
