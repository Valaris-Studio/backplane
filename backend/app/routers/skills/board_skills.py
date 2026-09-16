# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Board skill bindings — which skills a board's agents get, at which version.

Bind/unbind is board configuration (like binding a board's loop), so it is
admin-gated WITHOUT the agent ban that guards skill authoring: a binding
selects among already-authored, already-published content. Backplane only
answers "which skills, which version" — it never executes, renders, or
interprets them.
"""

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import (
    WorkspaceContext,
    get_workspace,
    get_workspace_admin,
    resolve_board_id,
)
from app.database import get_db
from app.schemas.skills.skill import BoardSkillBindingPut, BoardSkillBindingRead
from app.services.skills.skill_service import SkillService

router = APIRouter(
    prefix="/api/workspaces/{slug}/boards/{board_id}/skills", tags=["skills"]
)


@router.get("")
async def list_board_skills(
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The board's EFFECTIVE set: enabled bindings resolved to pinned_version
    when set, else the skill's latest published version; a skill resolving to
    nothing is excluded."""
    service = SkillService(db)
    items = await service.get_board_effective_skills(board_id)
    return {"skills": [item.model_dump(mode="json") for item in items]}


# Declared BEFORE /{skill_slug}: FastAPI matches in declaration order, so a
# literal segment registered after the parameterized one is unreachable.
@router.get("/bindings")
async def list_board_skill_bindings(
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """EVERY binding row — enabled or not, resolving or not.

    The effective set above answers "what would a runner materialize"; this
    answers "what did an operator configure", which is what a settings UI has
    to render so a disabled or draft-only binding stays visible and removable.
    """
    service = SkillService(db)
    rows = await service.list_board_bindings(board_id)
    return {"bindings": [row.model_dump(mode="json") for row in rows]}


@router.put("/{skill_slug}", response_model=BoardSkillBindingRead)
async def set_board_skill(
    skill_slug: str,
    data: BoardSkillBindingPut,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
) -> BoardSkillBindingRead:
    """Upsert the binding. `pinned_version` is TRI-STATE: omitted leaves any
    existing pin unchanged, an explicit null unpins back to tracking the
    latest published version, and a number pins to it."""
    service = SkillService(db)
    return BoardSkillBindingRead.model_validate(
        await service.set_binding(
            ctx.workspace.id, board_id, skill_slug, data, ctx.user.id
        )
    )


@router.delete("/{skill_slug}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_board_skill(
    skill_slug: str,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Idempotent: removing a binding that does not exist is still a 204."""
    service = SkillService(db)
    await service.remove_binding(ctx.workspace.id, board_id, skill_slug, ctx.user.id)
