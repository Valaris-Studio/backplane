# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import WorkspaceContext, get_workspace
from app.database import get_db
from app.schemas.agents.analytics import ExecutionAnalytics
from app.schemas.metrics import AgentMetricsRead, CardCostRead, CostRead, QualityRead, VelocityRead
from app.services.metrics import MetricsService

router = APIRouter(prefix="/api/workspaces/{slug}/metrics", tags=["metrics"])


@router.get("/agents", response_model=AgentMetricsRead)
async def get_agent_metrics(
    include_inactive: bool = Query(False),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = MetricsService(db)
    return await service.get_agent_metrics(
        ctx.workspace.id, include_inactive=include_inactive,
    )


@router.get("/velocity", response_model=VelocityRead)
async def get_velocity(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = MetricsService(db)
    return await service.get_velocity(ctx.workspace.id)


@router.get("/quality", response_model=QualityRead)
async def get_quality(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = MetricsService(db)
    return await service.get_quality(ctx.workspace.id)


@router.get("/cost", response_model=CostRead)
async def get_cost(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = MetricsService(db)
    return await service.get_cost(ctx.workspace.id)


@router.get("/card-costs", response_model=CardCostRead)
async def get_card_costs(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = MetricsService(db)
    return await service.get_card_costs(ctx.workspace.id)


@router.get("/execution-analytics", response_model=ExecutionAnalytics)
async def get_execution_analytics(
    agent_id: uuid.UUID | None = Query(None),
    days: int = Query(30, ge=1, le=365),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = MetricsService(db)
    return await service.get_execution_analytics(
        ctx.workspace.id, days=days, agent_id=agent_id,
    )
