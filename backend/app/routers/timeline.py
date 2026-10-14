# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.database import get_db
from app.models.user import User
from app.schemas.timeline import (
    GenerationCreate,
    GenerationRead,
    OverviewRead,
    WindowReady,
    PreparationRead,
    LiveHeadRead,
    SearchRead,
)
from app.services.timeline import TimelineService, generation_read, utc

router = APIRouter(
    prefix="/api/workspaces/{slug}/boards/{board_id}/timeline/generations",
    tags=["timeline"],
)


@router.post("", response_model=GenerationRead, status_code=201)
async def establish_generation(
    slug: str,
    board_id: str,
    data: GenerationCreate,
    response: Response,
    user: User = Depends(get_current_user),
):
    result, created = await TimelineService.establish(
        slug, board_id, user.id, data.request_id
    )
    response.status_code = 201 if created else 200
    return result


@router.get("/{generation_id}", response_model=GenerationRead)
async def read_generation(
    slug: str,
    board_id: str,
    generation_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    generation = await TimelineService(db).get(slug, board_id, user.id, generation_id)
    return generation_read(generation)


@router.get("/{generation_id}/overview", response_model=OverviewRead)
async def read_overview(
    slug: str,
    board_id: str,
    generation_id: uuid.UUID,
    buckets: int = Query(default=128, ge=1, le=256),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = TimelineService(db)
    generation = await service.get(slug, board_id, user.id, generation_id)
    return await service.overview(generation, buckets)


@router.get("/{generation_id}/window", response_model=WindowReady | PreparationRead)
async def read_window(
    slug: str,
    board_id: str,
    generation_id: uuid.UUID,
    response: Response,
    limit: int = Query(default=200, ge=1, le=500),
    at_seq: str | None = Query(default=None, max_length=19),
    at_time: datetime | None = None,
    cursor: str | None = Query(default=None, max_length=2048),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = TimelineService(db)
    generation = await service.get(slug, board_id, user.id, generation_id, lock=True)
    result = await service.window(
        generation,
        user.id,
        limit=limit,
        at_seq=at_seq,
        at_time=utc(at_time) if at_time else None,
        cursor=cursor,
    )
    response.status_code = 202 if result["status"] == "preparing" else 200
    return result


@router.post(
    "/{generation_id}/preparations/{preparation_id}/retry",
    response_model=PreparationRead,
)
async def retry_preparation(
    slug: str,
    board_id: str,
    generation_id: uuid.UUID,
    preparation_id: uuid.UUID,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = TimelineService(db)
    generation = await service.get(slug, board_id, user.id, generation_id, lock=True)
    result = await service.retry(generation, preparation_id)
    response.status_code = 202 if result["status"] == "preparing" else 200
    return result


@router.get("/{generation_id}/live-head", response_model=LiveHeadRead)
async def read_live_head(
    slug: str,
    board_id: str,
    generation_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = TimelineService(db)
    generation = await service.get(slug, board_id, user.id, generation_id)
    return await service.live_head(generation)


@router.get("/{generation_id}/search", response_model=SearchRead)
async def search_generation(
    slug: str,
    board_id: str,
    generation_id: uuid.UUID,
    q: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=2048),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = TimelineService(db)
    generation = await service.get(slug, board_id, user.id, generation_id)
    return await service.search(generation, q, limit, cursor)
