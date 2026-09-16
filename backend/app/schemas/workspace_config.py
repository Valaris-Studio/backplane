# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.completion import CompletionPolicyV1


class CostCircuitBreakerConfig(BaseModel):
    """Workspace-level cost circuit breaker settings.

    `action` decides what happens when the rolling-window spend exceeds
    `threshold_usd_per_15min`:
      - "alert"      : emit cost.threshold_crossed only.
      - "pause"      : also short-circuit /next-assignment with 423 Locked.
      - "kill_runner": pause + emit a runner-shutdown event (NOT YET WIRED;
        treated as "pause" until the kill-runner handler lands).
    """

    enabled: bool = False
    threshold_usd_per_15min: float = Field(default=20.0, gt=0.0)
    action: Literal["alert", "pause", "kill_runner"] = "pause"


class WorkspaceConfigRead(BaseModel):
    max_rework_attempts: int
    card_cooldown_hours: float
    commit_message_template: str
    pr_description_template: str
    model_pricing: dict | None
    pipeline_config: dict | None
    cost_circuit_breaker: CostCircuitBreakerConfig | None = None
    role_labels: dict | None = None
    # PAR-3a: per-workspace conflict-consolidator settings; consumed by PAR-3c.
    # Shape is intentionally permissive — validated at use-time, not here.
    conflict_consolidator: dict | None = None
    completion_policy: CompletionPolicyV1 | None = None
    enforce_done_merge_gate: bool = True
    version: int
    # Non-blocking context-source ↔ prompt wiring findings (severity="warning").
    # Populated on read and after a config save so the UI can surface inert /
    # silently-empty context sources without blocking the write.
    context_source_warnings: list[dict] = Field(default_factory=list)

    model_config = {"from_attributes": True}


class WorkspaceConfigUpdate(BaseModel):
    max_rework_attempts: int | None = None
    card_cooldown_hours: float | None = None
    commit_message_template: str | None = None
    pr_description_template: str | None = None
    model_pricing: dict | None = None
    pipeline_config: dict | None = None
    cost_circuit_breaker: CostCircuitBreakerConfig | None = None
    role_labels: dict | None = None
    conflict_consolidator: dict | None = None
    completion_policy: CompletionPolicyV1 | None = None
    enforce_done_merge_gate: bool | None = None
    expected_version: int | None = None
