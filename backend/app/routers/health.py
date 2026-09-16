# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus_health
from app.database import get_db

router = APIRouter(prefix="/api", tags=["health"])
logger = logging.getLogger(__name__)


@router.get("/health")
async def health():
    # event_bus is an additive observability field (Fix 6): backend name plus
    # postgres LISTEN liveness. event_bus_health never raises -- a probe must not.
    return {"status": "ok", "event_bus": event_bus_health()}


@router.get("/ready")
async def ready(db: AsyncSession = Depends(get_db)):
    # Liveness (/api/health) vs readiness (/api/ready): both start scripts run
    # `alembic upgrade head` before binding the port, so "the process is
    # listening" already implies "migrations are done" -- a DB ping is enough
    # to prove readiness without a separate alembic-head check. /api/health
    # stays DB-free so it's reachable even mid-migration; this endpoint is the
    # one allowed to touch the DB.
    try:
        await db.execute(text("SELECT 1"))
        return {"status": "ready"}
    except Exception:
        logger.exception("Readiness probe failed: DB did not answer")
        # get_db's teardown commits after the generator resumes; without this
        # rollback that commit can itself raise on the now-broken session,
        # turning our clean 503 back into an unhandled exception.
        await db.rollback()
        return JSONResponse(status_code=503, content={"status": "unavailable"})
