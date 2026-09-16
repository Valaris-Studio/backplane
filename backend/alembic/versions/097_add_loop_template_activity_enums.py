# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""extend activity enums with loop_template entity + published/unarchived actions

Card 1ebeb37f (p2-05). Loop-template authoring — create, publish, archive,
restore — left no durable trace; the WS bus was the only surface and it is
ephemeral (the lesson card 1ed41312 recorded when it added `agent`). Recording
those needs a `loop_template` member on `activityentitytype`, plus `published`
and `unarchived` on `activityaction` — publish is the operator intent a flat
`updated` would erase, since a draft moves many times but only a publish
changes what boards can bind.

ADDITIVE, and safe under Cloud Run rolling updates. `ALTER TYPE ... ADD VALUE`
is a metadata-only catalog change: it rewrites no table data and takes no lock
on `activities`. During a rolling update both code versions run against the
widened enums — the OLD code never emits the new values, and it reads no rows
carrying them because only the NEW code writes them. The reverse direction
(new code, old enum) never occurs: migrations run at container start, before
the new revision serves traffic.

Mirrors 092_add_agent_activity_entity_type.py, which mirrors
066_extend_activity_action_dependency.py and 008_extend_activity_enums.py —
all three ran in production without incident. Non-transactional in Postgres
but idempotent on re-run via IF NOT EXISTS.

No dialect guard: like every activity-enum migration before it, this file is
Postgres-only by construction and the SQLite test suite builds its schema from
`Base.metadata.create_all`, never from alembic.

Revision ID: 097
Revises: 096
Create Date: 2026-08-17
"""

from alembic import op

revision = "097"
down_revision = "096"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE activityentitytype ADD VALUE IF NOT EXISTS 'loop_template'")
    op.execute("ALTER TYPE activityaction ADD VALUE IF NOT EXISTS 'published'")
    op.execute("ALTER TYPE activityaction ADD VALUE IF NOT EXISTS 'unarchived'")


def downgrade() -> None:
    # PostgreSQL cannot drop an enum value without rewriting every dependent
    # column, and rows already written with it would be orphaned. Leaving the
    # values in place is harmless — nothing emits them once the code is rolled
    # back. Same choice as 008, 066 and 092.
    pass
