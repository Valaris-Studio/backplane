# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import WorkspaceContext, get_workspace
from app.database import get_db
from app.services.improvement_triggers import ImprovementTriggerService

router = APIRouter(tags=["improvement"])


class TriggerRead(BaseModel):
    trigger_type: str
    severity: str
    description: str
    context: dict


class ImprovementStatusRead(BaseModel):
    triggers: list[TriggerRead]
    improvements_today: int
    can_run: bool


@router.get(
    "/api/workspaces/{slug}/improvement/status",
    response_model=ImprovementStatusRead,
)
async def get_improvement_status(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = ImprovementTriggerService(db)
    triggers = await service.detect_triggers(ctx.workspace.id)
    count = await service.count_improvement_prs_today(ctx.workspace.id)
    can_run = await service.can_run_improvement(ctx.workspace.id)

    return ImprovementStatusRead(
        triggers=[
            TriggerRead(
                trigger_type=t.trigger_type,
                severity=t.severity,
                description=t.description,
                context=t.context,
            )
            for t in triggers
        ],
        improvements_today=count,
        can_run=can_run,
    )
