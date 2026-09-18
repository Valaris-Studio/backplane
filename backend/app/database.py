# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import settings


def build_engine(url: str) -> AsyncEngine:
    """Create the async engine, bounding the connection pool for PostgreSQL.

    An untuned pool (5 + 10 overflow) with gunicorn --workers 2 per instance and
    Cloud Run maxScale 2 could demand 2 x 2 x 15 = 60 connections and exhaust the
    server, 500-storming the app and starving the startup `alembic upgrade head`
    of a slot (the 2026-07-23 outage). Bounding to 3 + 2 caps the pools at
    2 x 2 x 5 = 20. Under EVENT_BUS_BACKEND=postgres each worker also holds 2
    dedicated asyncpg connections OUTSIDE this pool (LISTEN + NOTIFY, see
    core/event_bus.py) = 8 more at full scale, plus alembic-at-boot and Cloud
    SQL's reserved slots: ~33-35 worst case against db-g1-small's ~50 cap. Any
    change to workers/maxScale/pool sizes must redo this math.

    These kwargs are invalid for sqlite+aiosqlite (StaticPool, used by tests and
    local dev), so they're applied only for postgresql URLs.
    """
    kwargs = {"echo": settings.is_development}
    if url.startswith("postgresql"):
        kwargs.update(
            pool_size=3,
            max_overflow=2,
            pool_timeout=30,
            pool_pre_ping=True,
        )
    return create_async_engine(url, **kwargs)


engine = build_engine(settings.DATABASE_URL)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    # Injection sites use scope="function" so commit failures cannot follow
    # a success response or race the client's next request.
    async with async_session() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
