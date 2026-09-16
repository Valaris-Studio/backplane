# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from pydantic import BaseModel


class DailyMetric(BaseModel):
    date: str  # YYYY-MM-DD
    cards_completed: int
    cost_usd: float
    executions: int
    failures: int


class RoleCount(BaseModel):
    role: str  # pipeline stage role; "unknown" for role-less executions
    count: int


class ExecutionAnalytics(BaseModel):
    daily_metrics: list[DailyMetric]  # last N days
    total_executions: int
    total_completed: int
    total_failed: int
    total_cost_usd: float
    success_rate: float  # 0.0-1.0
    rework_rate: float  # fraction of executions requiring rework
    avg_duration_seconds: float
    avg_cost_per_card: float
    # Executions grouped by role over the full window — computed server-side so
    # the count reflects EVERY execution, not a paginated slice. Empty when there
    # are no executions.
    role_distribution: list[RoleCount] = []
