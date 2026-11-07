# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Migration tests must release only their own scratch databases after failure."""

import inspect
import re
from contextlib import asynccontextmanager

import pytest
from sqlalchemy.engine import make_url

from tests import test_context_receipts_postgres as context_tests
from tests import test_session_content_postgres as content_tests


class MigrationFailure(Exception):
    pass


class Result:
    def __init__(self, rows):
        self.rows = rows

    def mappings(self):
        return self

    def one(self):
        assert len(self.rows) == 1
        return self.rows[0]

    def one_or_none(self):
        assert len(self.rows) <= 1
        return self.rows[0] if self.rows else None

    def scalar_one(self):
        return next(iter(self.one().values()))


class RecordingServer:
    def __init__(self):
        self.databases = {}
        self.events = []
        self.clients = 0

    def engine(self, url, **_):
        server = self
        database = make_url(url).database

        class Engine:
            @asynccontextmanager
            async def connect(self):
                yield self

            async def execute(self, statement, parameters=None):
                sql = str(statement)
                if sql.startswith("CREATE DATABASE"):
                    name = re.search(r'"([^"]+)"', sql).group(1)
                    server.events.append(("create", name))
                    assert name not in server.databases
                    server.databases[name] = {"oid": 9001, "owner": "fixture"}
                    return Result([])
                if sql.startswith("DROP DATABASE"):
                    assert "FORCE" not in sql
                    name = re.search(r'"([^"]+)"', sql).group(1)
                    server.events.append(("drop", name))
                    del server.databases[name]
                    return Result([])
                if "AS role" in sql:
                    return Result([{"role": "fixture", "database": "anchor",
                                    "database_oid": 9, "address": "127.0.0.1",
                                    "port": 55446, "version_num": "160015"}])
                if "pg_stat_activity" in sql:
                    return Result([{"clients": server.clients}])
                if "pg_database" in sql:
                    row = server.databases.get(parameters["name"])
                    return Result([row] if row else [])
                raise AssertionError(sql)

            async def dispose(self):
                server.events.append(("dispose", database))

        return Engine()


CASES = [
    (context_tests, "test_migration_121_round_trips_on_postgresql"),
    (content_tests, "test_migration_119_round_trips_on_postgresql"),
    (content_tests, "test_forget_rich_readies_the_database_for_the_previous_release"),
]


@pytest.mark.parametrize("module,name", CASES, ids=["context121", "content119", "forget-rich"])
async def test_failed_migration_drops_its_scratch_after_disposing_connections(
    monkeypatch, tmp_path, module, name
):
    server = RecordingServer()
    for target in (context_tests, content_tests):
        monkeypatch.setattr(target, "create_async_engine", server.engine)
        monkeypatch.setattr(target, "database_url", lambda: "postgresql+asyncpg://fixture@127.0.0.1:55446/anchor")

    def fail_migration(*_):
        raise MigrationFailure("injected after scratch creation")

    monkeypatch.setattr(module, "_alembic", fail_migration)
    function = getattr(module, name)
    arguments = {"tmp_path": tmp_path} if "tmp_path" in inspect.signature(function).parameters else {}
    with pytest.raises(MigrationFailure, match="injected after scratch creation"):
        await function(**arguments)
    assert not server.databases, "Migration failure leaked its scratch database"
    created = next(value for event, value in server.events if event == "create")
    assert server.events.index(("dispose", created)) < server.events.index(("drop", created))


@pytest.mark.parametrize("tamper", ["oid", "owner", "clients"])
async def test_cleanup_preserves_changed_identity_or_active_clients(monkeypatch, tmp_path, tamper):
    server = RecordingServer()
    monkeypatch.setattr(content_tests, "create_async_engine", server.engine)
    monkeypatch.setattr(content_tests, "database_url", lambda: "postgresql+asyncpg://fixture@127.0.0.1:55446/anchor")

    def fail_migration(*_):
        row = next(iter(server.databases.values()))
        if tamper == "clients":
            server.clients = 1
        else:
            row[tamper] = 9002 if tamper == "oid" else "someone_else"
        raise MigrationFailure("injected after ownership changed")

    monkeypatch.setattr(content_tests, "_alembic", fail_migration)
    function = content_tests.test_migration_119_round_trips_on_postgresql
    arguments = {"tmp_path": tmp_path} if "tmp_path" in inspect.signature(function).parameters else {}
    with pytest.raises(RuntimeError, match="identity|clients"):
        await function(**arguments)
    assert len(server.databases) == 1
    assert not any(event == "drop" for event, _ in server.events)
