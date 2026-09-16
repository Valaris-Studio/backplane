# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Seal every artifact-fixture database path, including WebSocket imports."""

from contextlib import contextmanager

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


@contextmanager
def sealed_database(monkeypatch, engine):
    from app import database
    from app.config import settings
    from app.routers import events
    from app.services import api_key

    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(settings, "DATABASE_URL", str(engine.url))
    monkeypatch.setattr(database, "engine", engine)
    for module in (database, events, api_key):
        monkeypatch.setattr(module, "async_session", factory)

    def reject_foreign_connect(dialect, record, args, kwargs):
        if dialect is not engine.sync_engine.dialect:
            raise AssertionError(
                "artifact fixture refused a foreign database connection"
            )

    def reject_foreign_statement(
        connection, cursor, statement, parameters, context, many
    ):
        if connection.engine is not engine.sync_engine:
            raise AssertionError(
                "artifact fixture refused a foreign database statement"
            )

    event.listen(Engine, "do_connect", reject_foreign_connect)
    event.listen(Engine, "before_cursor_execute", reject_foreign_statement)
    try:
        yield factory
    finally:
        event.remove(Engine, "before_cursor_execute", reject_foreign_statement)
        event.remove(Engine, "do_connect", reject_foreign_connect)
