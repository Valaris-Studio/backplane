# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from app.database import build_engine


async def test_build_engine_bounds_postgres_pool():
    # Cloud SQL db-f1-micro caps at ~25 connections; with 2 gunicorn workers
    # per instance and Cloud Run maxScale 2, the pool must stay small enough
    # that 2 x 2 x (pool_size + max_overflow) < 25. Engine creation is lazy so
    # no live server is needed to assert the configured bounds.
    engine = build_engine("postgresql+asyncpg://u:p@localhost:5432/db")
    try:
        assert engine.pool.size() == 3
        assert engine.pool._max_overflow == 2
    finally:
        await engine.dispose()


async def test_build_engine_sqlite_builds_without_pool_kwargs():
    # pool_size / max_overflow are invalid for the StaticPool aiosqlite uses;
    # the factory must skip them for non-postgres URLs (tests + local dev).
    engine = build_engine("sqlite+aiosqlite:///:memory:")
    try:
        assert engine is not None
    finally:
        await engine.dispose()
