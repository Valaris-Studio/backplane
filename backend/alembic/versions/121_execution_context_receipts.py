# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Execution context bindings and append-only invocation context receipts.

Additive and rolling-safe: two new tables that the previous release never
reads. A binding's reservation_id is deliberately not a foreign key, so the
scheduler's hold sweep can never cascade into bound work."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "121"
down_revision = "120"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "execution_context_bindings",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "execution_id",
            UUID(as_uuid=True),
            sa.ForeignKey("agent_executions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("reservation_id", UUID(as_uuid=True), nullable=False),
        sa.Column("agent_id", UUID(as_uuid=True), nullable=False),
        sa.Column("workspace_id", UUID(as_uuid=True), nullable=False),
        sa.Column("board_id", UUID(as_uuid=True), nullable=False),
        sa.Column("card_id", UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.String(64), nullable=False),
        sa.Column("start_request_sha256", sa.CHAR(64), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint(
            "execution_id", name="uq_execution_context_bindings_execution"
        ),
        sa.UniqueConstraint(
            "reservation_id", name="uq_execution_context_bindings_reservation"
        ),
    )
    op.create_table(
        "execution_context_receipts",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "execution_id",
            UUID(as_uuid=True),
            sa.ForeignKey("agent_executions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("client_request_id", sa.String(255), nullable=False),
        sa.Column("context_revision", sa.CHAR(64), nullable=False),
        sa.Column("context_manifest", sa.JSON(), nullable=False),
        sa.Column("input_prompt", sa.Text(), nullable=False),
        sa.Column("system_prompt", sa.Text(), nullable=False),
        sa.Column("prompt_sha256", sa.CHAR(64), nullable=False),
        sa.Column("prompt_bytes", sa.Integer(), nullable=False),
        sa.Column("system_prompt_sha256", sa.CHAR(64), nullable=False),
        sa.Column("system_prompt_bytes", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(255), nullable=False),
        sa.Column("model", sa.String(255), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("use_verification", sa.String(32), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint(
            "execution_id",
            "client_request_id",
            name="uq_execution_context_receipts_request",
        ),
        sa.UniqueConstraint(
            "execution_id", "ordinal", name="uq_execution_context_receipts_ordinal"
        ),
    )


def downgrade():
    op.drop_table("execution_context_receipts")
    op.drop_table("execution_context_bindings")
