# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pydantic schemas for the WS3 setup contract.

These mirror `app.services.setup_contract` dataclasses and give the API a typed,
self-documenting response shape for the contract (and a validated request shape
when an operator hand-authors one inside a config or bundle). The runtime
authority remains the service dataclasses + the drift validator; these schemas
are the wire contract.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ColumnSpecSchema(BaseModel):
    column_type: str
    position: int
    name: str


class LabelGateSchema(BaseModel):
    name: str
    applies_in_role: str | None = None
    removes_in_role: str | None = None
    gated_by_roles: list[str] = Field(default_factory=list)
    description: str = ""


class RoleOrchestrationSchema(BaseModel):
    role: str
    pick_strategy: list[str] = Field(default_factory=list)
    emits: list[str] = Field(default_factory=list)
    terminal_actions: list[str] = Field(default_factory=list)


class SetupContractSchema(BaseModel):
    version: int = 1
    columns: list[ColumnSpecSchema] = Field(default_factory=list)
    labels: list[LabelGateSchema] = Field(default_factory=list)
    role_orchestration: list[RoleOrchestrationSchema] = Field(default_factory=list)
    prose_overview: str = ""

    model_config = {"from_attributes": True}
