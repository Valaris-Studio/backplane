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
from sqlalchemy import text
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

# A separate two-integer advisory-lock namespace: ASCII "BPLN", "MIGR".
MIGRATION_LOCK = {"namespace": 0x42504C4E, "operation": 0x4D494752}
MIGRATION_LOCK_TIMEOUT_MS = 15_000
MIGRATION_LOCK_RETRY_SECONDS = 0.25


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
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        transaction_per_migration=connection.dialect.name == "postgresql",
    )
    with context.begin_transaction():
        context.run_migrations()


async def acquire_migration_lock(connection):
    started = asyncio.get_running_loop().time()
    try:
        async with asyncio.timeout_at(
            started + MIGRATION_LOCK_TIMEOUT_MS / 1000
        ) as deadline:
            # Honor tighter limits without changing any database timeout.
            timeout_ms = (
                await connection.execute(
                    text(
                        "SELECT LEAST(COALESCE(NULLIF(setting::bigint, 0), "
                        ":maximum), :maximum) "
                        "FROM pg_settings WHERE name='lock_timeout'"
                    ),
                    {"maximum": MIGRATION_LOCK_TIMEOUT_MS},
                )
            ).scalar_one()
            deadline.reschedule(started + timeout_ms / 1000)
            await connection.rollback()
            while True:
                acquired = (
                    await connection.execute(
                        text("SELECT pg_try_advisory_lock(:namespace, :operation)"),
                        MIGRATION_LOCK,
                    )
                ).scalar_one()
                if acquired:
                    # Clear SQLAlchemy's implicit transaction before Alembic
                    # configure; the session lock survives all later commits.
                    await connection.commit()
                    return
                # A waiting transaction's snapshot can deadlock with the
                # holder's CREATE INDEX CONCURRENTLY. Wait only while idle.
                await connection.rollback()
                await asyncio.sleep(MIGRATION_LOCK_RETRY_SECONDS)
    except TimeoutError as error:
        raise TimeoutError(
            "Timed out acquiring database migration session lock"
        ) from error


async def run_migrations_online():
    connectable = create_async_engine(
        settings.DATABASE_URL,
        connect_args=settings.database_connect_args(settings.DATABASE_URL),
    )
    try:
        async with connectable.connect() as connection:
            postgresql = connection.dialect.name == "postgresql"
            lock_acquired = False
            try:
                if postgresql:
                    await acquire_migration_lock(connection)
                    lock_acquired = True
                await connection.run_sync(do_run_migrations)
            finally:
                # Never reconnect to unlock a different session after loss.
                if postgresql and not connection.closed and not connection.invalidated:
                    await connection.rollback()
                    if lock_acquired and not connection.invalidated:
                        released = (
                            await connection.execute(
                                text(
                                    "SELECT pg_advisory_unlock(:namespace, :operation)"
                                ),
                                MIGRATION_LOCK,
                            )
                        ).scalar_one()
                        await connection.commit()
                        if not released:
                            raise RuntimeError(
                                "Database migration session lock was lost"
                            )
    finally:
        await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
