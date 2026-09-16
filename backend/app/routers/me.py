# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import forbid_agent_callers, get_current_user
from app.database import get_db
from app.models.user import User
from app.schemas.api_key import ApiKeyCreate, ApiKeyCreated, ApiKeyRead
from app.schemas.user import UserRead
from app.services.api_key import ApiKeyService

router = APIRouter(prefix="/api/me", tags=["me"])


@router.get("", response_model=UserRead)
async def get_me(user: User = Depends(get_current_user)):
    return user


@router.get("/api-keys", response_model=list[ApiKeyRead])
async def list_api_keys(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    service = ApiKeyService(db)
    return await service.list_keys(user.id)


@router.post(
    "/api-keys",
    response_model=ApiKeyCreated,
    status_code=201,
    dependencies=[Depends(forbid_agent_callers)],
)
async def create_api_key(
    data: ApiKeyCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    service = ApiKeyService(db)
    api_key, raw_key = await service.create_key(user.id, data.name)
    # model_validate rather than field-by-field so ApiKeyRead can grow columns
    # without this route silently dropping them.
    return ApiKeyCreated.model_validate(
        {**ApiKeyRead.model_validate(api_key).model_dump(), "raw_key": raw_key}
    )


@router.delete(
    "/api-keys/{key_id}",
    status_code=204,
    dependencies=[Depends(forbid_agent_callers)],
)
async def delete_api_key(
    key_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    service = ApiKeyService(db)
    await service.delete_key(key_id, user.id)
