# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import WorkspaceContext, get_workspace
from app.database import get_db
from app.schemas.alerts.alert_threshold import (
    AlertThresholdCreate,
    AlertThresholdRead,
    AlertThresholdUpdate,
)
from app.services.alerts.alert_threshold import AlertThresholdService

router = APIRouter(
    prefix="/api/workspaces/{slug}/alerts", tags=["alerts"]
)


@router.post("/thresholds", response_model=AlertThresholdRead, status_code=201)
async def create_threshold(
    data: AlertThresholdCreate,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = AlertThresholdService(db)
    return await service.create(ctx.workspace.id, ctx.user.id, data)


@router.get("/thresholds", response_model=list[AlertThresholdRead])
async def list_thresholds(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
    board_id: uuid.UUID | None = Query(None),
):
    service = AlertThresholdService(db)
    return await service.list_thresholds(ctx.workspace.id, board_id)


@router.get("/thresholds/{threshold_id}", response_model=AlertThresholdRead)
async def get_threshold(
    threshold_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = AlertThresholdService(db)
    return await service.get(threshold_id, ctx.workspace.id)


@router.patch("/thresholds/{threshold_id}", response_model=AlertThresholdRead)
async def update_threshold(
    threshold_id: uuid.UUID,
    data: AlertThresholdUpdate,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = AlertThresholdService(db)
    return await service.update(threshold_id, ctx.workspace.id, data)


@router.delete("/thresholds/{threshold_id}", status_code=204)
async def delete_threshold(
    threshold_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = AlertThresholdService(db)
    await service.delete(threshold_id, ctx.workspace.id)


@router.post("/thresholds/{threshold_id}/evaluate")
async def evaluate_threshold(
    threshold_id: uuid.UUID,
    metrics: dict,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = AlertThresholdService(db)
    threshold = await service.get(threshold_id, ctx.workspace.id)
    results = await service.evaluate_for_board(threshold.board_id, metrics)
    return results


@router.post("/evaluate-cost")
async def evaluate_cost_thresholds(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = AlertThresholdService(db)
    return await service.evaluate_cost_thresholds(ctx.workspace.id)
