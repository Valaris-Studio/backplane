# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from fastapi import APIRouter, Depends, Query

from app.core.auth import get_current_user
from app.models.user import User
from app.services.product_documentation import ProductDocumentationService

router = APIRouter(prefix="/api/documentation", tags=["documentation"])


@router.get("")
async def list_documentation(
    locale: str = "en",
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    user: User = Depends(get_current_user),
):
    return ProductDocumentationService().list_sections(user, locale, offset, limit)


@router.get("/{slug}")
async def read_documentation(
    slug: str,
    locale: str = "en",
    version: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(12000, ge=1, le=30000),
    user: User = Depends(get_current_user),
):
    return ProductDocumentationService().read_section(
        user, slug, locale, version, offset, limit
    )
