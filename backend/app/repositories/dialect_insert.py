# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession


def conflict_aware_insert(db: AsyncSession, model):
    """INSERT that supports ON CONFLICT on both production and test databases."""
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        return postgres_insert(model)
    if dialect == "sqlite":
        return sqlite_insert(model)
    raise RuntimeError(f"ON CONFLICT inserts are not supported on {dialect}")
