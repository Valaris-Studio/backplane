# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Exercise startup's real Alembic environment before any database connection."""

import sys
from pathlib import Path

import pytest
from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import event
from sqlalchemy.engine import Engine

from app import config as app_config


@pytest.mark.parametrize(
    "megabytes", [None, 4, 64], ids=["server_default", "4MB", "64MB"]
)
def test_alembic_connection_receives_environment_work_memory(monkeypatch, megabytes):
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+asyncpg://migration:unused@127.0.0.1:1/work_mem_test",
    )
    if megabytes is None:
        monkeypatch.delenv("DATABASE_WORK_MEM_MB", raising=False)
    else:
        monkeypatch.setenv("DATABASE_WORK_MEM_MB", str(megabytes))
    configured = app_config.Settings(_env_file=None)
    # Preserve references held by the application and any shared engine helper.
    monkeypatch.setattr(app_config.settings, "DATABASE_URL", configured.DATABASE_URL)
    monkeypatch.setattr(
        app_config.settings, "DATABASE_WORK_MEM_MB", configured.DATABASE_WORK_MEM_MB
    )
    monkeypatch.setattr(sys, "path", sys.path.copy())
    parameters = []

    class ConnectionIntercepted(Exception):
        pass

    def intercept(_dialect, _record, _args, kwargs):
        parameters.append(kwargs.copy())
        raise ConnectionIntercepted

    alembic_config = Config()
    alembic_config.set_main_option(
        "script_location", str(Path(__file__).resolve().parents[1] / "alembic")
    )
    script = ScriptDirectory.from_config(alembic_config)
    event.listen(Engine, "do_connect", intercept)
    try:
        with pytest.raises(ConnectionIntercepted):
            with EnvironmentContext(alembic_config, script):
                script.run_env()
    finally:
        event.remove(Engine, "do_connect", intercept)
    assert len(parameters) == 1
    assert parameters[0]["database"] == "work_mem_test"
    assert parameters[0].get("server_settings", {}) == (
        {} if megabytes is None else {"work_mem": f"{megabytes}MB"}
    )
