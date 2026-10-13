# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from fastapi import HTTPException

from app.config import settings


async def require_companion_enabled() -> None:
    """Router dependency for every companion surface. List it FIRST: router
    dependencies run in order, and a 401/403/422 from a later one would confirm
    the route exists."""
    if not settings.COMPANION_ENABLED:
        raise HTTPException(status_code=404, detail="Not Found")
