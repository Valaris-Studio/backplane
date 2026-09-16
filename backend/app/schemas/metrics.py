# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from pydantic import BaseModel


class AgentMetric(BaseModel):
    agent_id: str
    name: str
    agent_type: str
    is_active: bool = True
    # Pause primitive state (card 49f8bb82). Projected here so the runners list
    # can render Paused and offer Resume without a per-row detail fetch.
    is_paused: bool = False
    total_executions: int
    completed_executions: int
    failed_executions: int
    avg_duration_seconds: float | None
    total_tokens_used: int
    total_cost_usd: float = 0.0
    last_seen_at: str | None = None
    # Derived by MetricsService — alive | stale | offline | unknown. An agent
    # with an in-flight execution is promoted to at least `alive` so a runner
    # mid-stage (heartbeat only fires at stage boundaries → ages past the 90s
    # threshold during a long LLM stage) never reads `stale` while it's working.
    liveness: str = "unknown"
    # Authoritative "is this runner actively working right now" signal: true iff
    # the agent has a started/running execution with no completed_at in this
    # workspace. Backend-owned so every consumer agrees without re-deriving the
    # in-flight union from a second query (the source of the transient
    # "0 working / Stale" the board showed while a runner was mid-card).
    working: bool = False
    health_status: str | None = None
    health_version: str | None = None
    health_uptime_seconds: int | None = None
    health_cards_processed: int | None = None
    health_cards_failed: int | None = None
    health_current_card_id: str | None = None
    health_current_board_id: str | None = None
    health_last_error: str | None = None
    health_last_error_at: str | None = None
    health_config_errors: list | None = None


class AgentMetricsRead(BaseModel):
    agents: list[AgentMetric]


class VelocityRead(BaseModel):
    cards_completed_7d: int
    cards_completed_30d: int
    cards_completed_90d: int


class QualityRead(BaseModel):
    reversion_rate: float | None = None
    agent_efficiency_score: float | None = None


class AgentCostMetric(BaseModel):
    name: str
    agent_type: str
    tokens_used_7d: int
    tokens_used_30d: int
    executions_7d: int
    executions_30d: int


class CostRead(BaseModel):
    agents: list[AgentCostMetric]


class CardCostMetric(BaseModel):
    card_id: str
    total_cost_usd: float
    total_tokens: int
    execution_count: int


class CardCostRead(BaseModel):
    cards: list[CardCostMetric]
