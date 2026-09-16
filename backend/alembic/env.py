# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio
import sys
from pathlib import Path
from logging.config import fileConfig

# Ensure the backend directory is on sys.path so 'app' is importable
# regardless of how alembic is invoked (Make, conda, IDE, etc.)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import settings
from app.models import Base  # noqa: F401 — registers all models

config = context.config
if config.config_file_name is not None:
    # disable_existing_loggers=False: fileConfig's default silently disables
    # every already-created logger. Any test that runs alembic in-process would
    # otherwise mute app.* loggers for the rest of the pytest session, breaking
    # caplog assertions in whatever file happens to run afterwards.
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def run_migrations_offline():
    context.configure(
        url=settings.DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection):
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online():
    connectable = create_async_engine(settings.DATABASE_URL)
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
