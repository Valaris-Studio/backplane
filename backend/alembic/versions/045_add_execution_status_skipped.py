# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add skipped to executionstatus enum

Terminal graceful-skip value for runner's runLLMStage: custom pipeline
stage with no cached prompt and no Go fallback. Before this migration
runner's PATCH with status="skipped" was rejected at the Pydantic layer
(422) — the status never persisted, and the frontend had no way to
surface "this stage needs a prompt" to the user.

Rolling-deploy safe: new enum value is purely additive. Old code
reading the enum never receives `skipped` in the absence of the new
writer, and the new enum value is accepted at write time on both old
and new code paths after this migration runs.

Downgrade is unsafe if any rows have status='skipped' — the migration
refuses in that case so an operator can backfill (e.g., update those
rows to 'completed') before downgrading.

Revision ID: 045
Revises: 044
Create Date: 2026-04-18
"""

import sqlalchemy as sa
from alembic import op

revision = "045"
down_revision = "044"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    dialect = bind.dialect.name
    if dialect == "postgresql":
        # ALTER TYPE ... ADD VALUE IF NOT EXISTS is idempotent and must run
        # outside a transaction. The connection is in "autocommit" here only
        # when alembic is configured with transaction_per_migration=False; in
        # practice this repo runs each migration in its own transaction, but
        # Postgres 12+ allows ADD VALUE inside a transaction as long as the
        # new value isn't used in the same transaction.
        op.execute("ALTER TYPE executionstatus ADD VALUE IF NOT EXISTS 'skipped'")
    # SQLite stores enums as VARCHAR — no schema change needed; new values
    # become valid as soon as the Python enum accepts them.


def downgrade():
    bind = op.get_bind()
    dialect = bind.dialect.name
    if dialect != "postgresql":
        return
    # Refuse the downgrade if any rows carry the new value — dropping it
    # would orphan those records. Operator must backfill first.
    result = bind.execute(
        sa.text("SELECT count(*) FROM agent_executions WHERE status = 'skipped'")
    ).scalar()
    if result:
        raise RuntimeError(
            f"Cannot downgrade: {result} agent_executions row(s) have "
            "status='skipped'. Backfill (e.g., UPDATE to 'completed') "
            "before downgrading."
        )
    # Postgres enum downgrade is a rewrite: create new type, swap, drop old.
    op.execute("ALTER TYPE executionstatus RENAME TO executionstatus_old")
    op.execute(
        "CREATE TYPE executionstatus AS ENUM "
        "('started','running','completed','failed','aborted')"
    )
    op.execute(
        "ALTER TABLE agent_executions "
        "ALTER COLUMN status TYPE executionstatus "
        "USING status::text::executionstatus"
    )
    op.execute("DROP TYPE executionstatus_old")
