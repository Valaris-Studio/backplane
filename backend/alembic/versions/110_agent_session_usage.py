# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Per-model usage rows and cost provenance for agent sessions.

Purely additive: one new table, and new agent_sessions columns that are each
nullable or server-defaulted, so the previous release keeps running against
this schema during a rolling deploy. Every cost stored before this revision
was agent-reported, so it is copied into cost_reported_usd and into one
tokenless 'pre-110' usage row per session; cost_usd keeps its value and from
here on means the effective cost (reported, else estimated).
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "110"
down_revision = "109"
branch_labels = None
depends_on = None


def counter(name):
    return sa.Column(name, sa.BigInteger(), nullable=False, server_default="0")


def upgrade():
    op.add_column("agent_sessions", counter("reasoning_tokens"))
    op.add_column(
        "agent_sessions",
        sa.Column("cost_reported_usd", sa.Numeric(18, 6), nullable=True),
    )
    op.add_column(
        "agent_sessions",
        sa.Column("cost_estimated_usd", sa.Numeric(18, 6), nullable=True),
    )
    op.add_column(
        "agent_sessions",
        sa.Column(
            "unpriced_usage_count", sa.Integer(), nullable=False, server_default="0"
        ),
    )
    op.add_column(
        "agent_sessions", sa.Column("cost_source", sa.String(16), nullable=True)
    )
    op.add_column(
        "agent_sessions", sa.Column("auth_kind", sa.String(16), nullable=True)
    )
    op.add_column("agent_sessions", sa.Column("provider", sa.String(64), nullable=True))
    op.add_column(
        "agent_sessions", sa.Column("service_tier", sa.String(32), nullable=True)
    )
    op.execute("UPDATE agent_sessions SET cost_reported_usd = cost_usd")
    op.execute(
        "UPDATE agent_sessions SET cost_source = 'reported' WHERE cost_usd IS NOT NULL"
    )

    op.create_table(
        "agent_session_usage",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.func.gen_random_uuid(),
        ),
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("agent_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("event_id", sa.String(64), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("provider", sa.String(64), nullable=True),
        sa.Column("model", sa.String(200), nullable=True),
        sa.Column("service_tier", sa.String(32), nullable=True),
        sa.Column("speed", sa.String(16), nullable=True),
        sa.Column("auth_kind", sa.String(16), nullable=False, server_default="unknown"),
        counter("input_uncached_tokens"),
        counter("cache_read_tokens"),
        counter("cache_write_5m_tokens"),
        counter("cache_write_1h_tokens"),
        counter("output_tokens"),
        counter("reasoning_tokens"),
        sa.Column("context_tokens", sa.BigInteger(), nullable=True),
        sa.Column("cost_reported_usd", sa.Numeric(18, 9), nullable=True),
        sa.Column("cost_estimated_usd", sa.Numeric(18, 9), nullable=True),
        sa.Column("cost_source", sa.String(16), nullable=False),
        sa.Column("pricing_status", sa.String(16), nullable=False),
        sa.Column("pricing_model", sa.String(200), nullable=True),
        sa.Column("price_table_version", sa.String(64), nullable=True),
        sa.UniqueConstraint(
            "session_id", "event_id", name="uq_agent_session_usage_event"
        ),
        sa.CheckConstraint(
            "auth_kind IN ('subscription', 'api', 'enterprise', 'unknown')",
            name="ck_agent_session_usage_auth_kind",
        ),
        sa.CheckConstraint(
            "cost_source IN ('reported', 'estimated', 'none')",
            name="ck_agent_session_usage_cost_source",
        ),
        sa.CheckConstraint(
            "pricing_status IN ('priced', 'unknown_model', 'no_model', 'no_tokens')",
            name="ck_agent_session_usage_pricing_status",
        ),
    )
    op.create_index(
        "ix_agent_session_usage_price_version",
        "agent_session_usage",
        ["price_table_version"],
    )
    # Session costs are rollups of usage rows from here on, so each cost
    # stored before this revision (all agent-reported) gets one tokenless
    # row carrying it; otherwise the next event would recompute it away.
    new_id = (
        "gen_random_uuid()"
        if op.get_bind().dialect.name == "postgresql"
        else "lower(hex(randomblob(16)))"
    )
    op.execute(
        "INSERT INTO agent_session_usage (id, session_id, event_id, occurred_at, "
        "auth_kind, cost_reported_usd, cost_source, pricing_status) "
        f"SELECT {new_id}, id, 'pre-110', last_event_at, 'unknown', cost_usd, "
        "'reported', 'no_tokens' FROM agent_sessions WHERE cost_usd IS NOT NULL"
    )


def downgrade():
    op.drop_table("agent_session_usage")
    for column in (
        "service_tier",
        "provider",
        "auth_kind",
        "unpriced_usage_count",
        "cost_source",
        "cost_estimated_usd",
        "cost_reported_usd",
        "reasoning_tokens",
    ):
        op.drop_column("agent_sessions", column)
