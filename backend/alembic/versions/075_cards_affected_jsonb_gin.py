# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""cards_affected JSON -> JSONB + GIN index; (workspace_id, status) composite

Perf follow-up to the 2026-07-23 prod outage (board-view execution fan-out ->
DB connection exhaustion -> backend crash-loop). The hot fan-out was cured in the
incident fix, but two per-request queries on agent_executions still full-scan:

  1. ExecutionRepository.list_by_card (card-detail open) filtered via
     `cast(cards_affected AS text) LIKE '%<uuid>%'` — unindexable. Converting the
     column to JSONB lets it use `cards_affected @> '["<uuid>"]'` served by a GIN
     index.
  2. skipped_card_ids filters on (workspace_id, status) with only a workspace_id
     index — a composite index makes it a range scan instead of a filter.

Rolling-deploy safety (both old and new code run against this schema briefly):
  - The type change is in-place (no rename). asyncpg round-trips JSONB as the same
    Python list, so old code that reads/writes plain JSON keeps working, and old
    code's `cast(... AS text) LIKE` prefilter still compiles/executes against JSONB
    (Postgres casts JSONB -> text). New code's `@>` needs JSONB; hence type-first.
  - Indexes are pure additions.
  - NON-CONCURRENT operations: `ALTER COLUMN ... TYPE jsonb USING ...::jsonb`
    rewrites the table and takes an ACCESS EXCLUSIVE lock; the two CREATE INDEX
    take a SHARE lock blocking writes. Migrations run at container startup and
    agent_executions is small at current scale, so the lock window is brief and
    acceptable. If this table grows large, redo as CONCURRENTLY outside a
    transaction. (Kept simple, in-transaction, per the current table size.)

SQLite (test backend) has no JSONB or GIN. The generic-JSON column is already the
right type there and these Postgres-only ops are dialect-guarded to no-ops, so the
in-process test DB and any SQLite deploy are untouched.

Revision ID: 075
Revises: 074
Create Date: 2026-07-23
"""

from alembic import op

revision = "075"
down_revision = "074"
branch_labels = None
depends_on = None

GIN_INDEX = "ix_agent_executions_cards_affected_gin"
WS_STATUS_INDEX = "ix_agent_executions_workspace_status"


def upgrade():
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute(
        "ALTER TABLE agent_executions "
        "ALTER COLUMN cards_affected TYPE JSONB USING cards_affected::jsonb"
    )
    op.execute(
        f"CREATE INDEX {GIN_INDEX} " "ON agent_executions USING gin (cards_affected)"
    )
    op.create_index(WS_STATUS_INDEX, "agent_executions", ["workspace_id", "status"])


def downgrade():
    if op.get_bind().dialect.name != "postgresql":
        return
    op.drop_index(WS_STATUS_INDEX, table_name="agent_executions")
    op.execute(f"DROP INDEX {GIN_INDEX}")
    op.execute(
        "ALTER TABLE agent_executions "
        "ALTER COLUMN cards_affected TYPE JSON USING cards_affected::json"
    )
