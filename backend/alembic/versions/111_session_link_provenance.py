# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fuzzy session links for harnesses that send no native call id (Pi).

Purely additive: nullable columns, or NOT NULL with a server default that
states what every existing row already is (an exact match), so the previous
release keeps running against this schema during a rolling deploy.
"""

from alembic import op
import sqlalchemy as sa

revision = "111"
down_revision = "110"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "agent_session_events",
        sa.Column("tool_call_signature", sa.String(64), nullable=True),
    )
    op.create_index(
        "ix_agent_session_events_call_signature",
        "agent_session_events",
        ["tool_call_signature"],
        postgresql_where=sa.text("tool_call_signature IS NOT NULL"),
        sqlite_where=sa.text("tool_call_signature IS NOT NULL"),
    )
    op.add_column(
        "mcp_invocations",
        sa.Column("arguments_fingerprint", sa.String(64), nullable=True),
    )
    op.create_index(
        "ix_mcp_invocations_correlatable",
        "mcp_invocations",
        ["owner_id", "completed_at"],
        postgresql_where=sa.text("arguments_fingerprint IS NOT NULL"),
        sqlite_where=sa.text("arguments_fingerprint IS NOT NULL"),
    )
    with op.batch_alter_table("agent_session_invocations") as batch:
        batch.add_column(
            sa.Column(
                "provenance", sa.String(16), nullable=False, server_default="exact"
            )
        )
        batch.add_column(sa.Column("matched_call_id", sa.String(200), nullable=True))
        batch.create_check_constraint(
            "ck_agent_session_invocation_provenance",
            "provenance IN ('exact', 'correlated')",
        )
    op.add_column(
        "session_work_links",
        sa.Column("correlated_count", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade():
    op.drop_column("session_work_links", "correlated_count")
    with op.batch_alter_table("agent_session_invocations") as batch:
        batch.drop_constraint("ck_agent_session_invocation_provenance", type_="check")
        batch.drop_column("matched_call_id")
        batch.drop_column("provenance")
    op.drop_index("ix_mcp_invocations_correlatable", table_name="mcp_invocations")
    op.drop_column("mcp_invocations", "arguments_fingerprint")
    op.drop_index(
        "ix_agent_session_events_call_signature", table_name="agent_session_events"
    )
    op.drop_column("agent_session_events", "tool_call_signature")
