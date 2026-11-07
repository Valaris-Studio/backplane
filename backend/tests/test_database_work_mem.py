# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest
from sqlalchemy import event

from app import database
from app.config import Settings


@pytest.mark.parametrize("megabytes", [4, 64])
async def test_postgres_connection_receives_configured_work_memory(
    monkeypatch, megabytes
):
    monkeypatch.setattr(
        database, "settings", Settings(_env_file=None, DATABASE_WORK_MEM_MB=megabytes)
    )
    engine = database.build_engine("postgresql+asyncpg://u:p@localhost:5432/db")
    parameters = {}

    class ConnectionIntercepted(Exception):
        pass

    def intercept(_dialect, _record, _args, kwargs):
        parameters.update(kwargs)
        raise ConnectionIntercepted

    event.listen(engine.sync_engine, "do_connect", intercept)
    try:
        with pytest.raises(ConnectionIntercepted):
            await engine.connect()
        assert parameters.get("server_settings") == {"work_mem": f"{megabytes}MB"}
    finally:
        await engine.dispose()


@pytest.mark.parametrize("value", [0, -1, "not-memory"])
def test_invalid_work_memory_configuration_is_rejected(value):
    with pytest.raises(ValueError):
        Settings(_env_file=None, DATABASE_WORK_MEM_MB=value)


async def test_work_memory_setting_does_not_break_sqlite(monkeypatch):
    monkeypatch.setattr(
        database, "settings", Settings(_env_file=None, DATABASE_WORK_MEM_MB=64)
    )
    engine = database.build_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.connect() as connection:
            assert (await connection.exec_driver_sql("SELECT 1")).scalar_one() == 1
    finally:
        await engine.dispose()
