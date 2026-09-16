# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Factory selection via EVENT_BUS_BACKEND (plan §4.2).

Every existing consumer imports the module-level `event_bus`; the factory must
keep `memory` the zero-config default so unset/`memory` behaviour is unchanged,
return a PostgresEventBus for `postgres`, and fail loudly for the not-yet-built
`redis` tier rather than silently degrading.
"""

import pytest

from app.core.event_bus import EventBus, PostgresEventBus, _make_event_bus


def test_default_is_memory(monkeypatch):
    monkeypatch.delenv("EVENT_BUS_BACKEND", raising=False)
    bus = _make_event_bus()
    assert type(bus) is EventBus


def test_explicit_memory(monkeypatch):
    monkeypatch.setenv("EVENT_BUS_BACKEND", "memory")
    bus = _make_event_bus()
    assert type(bus) is EventBus


@pytest.mark.parametrize("value", ["postgres", "POSTGRES", " Postgres "])
def test_postgres_backend(monkeypatch, value):
    monkeypatch.setenv("EVENT_BUS_BACKEND", value)
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@localhost:5432/db")
    bus = _make_event_bus()
    assert isinstance(bus, PostgresEventBus)


def test_redis_backend_not_implemented(monkeypatch):
    monkeypatch.setenv("EVENT_BUS_BACKEND", "redis")
    with pytest.raises(NotImplementedError):
        _make_event_bus()


def test_unknown_backend_falls_back_to_memory(monkeypatch):
    # An unrecognised value must not crash the app on import; default to memory.
    monkeypatch.setenv("EVENT_BUS_BACKEND", "rabbitmq")
    bus = _make_event_bus()
    assert type(bus) is EventBus


def test_asyncpg_transport_strips_sqlalchemy_dialect():
    from app.core.event_bus import AsyncpgNotifyTransport

    t = AsyncpgNotifyTransport("postgresql+asyncpg://u:p@host:5432/db")
    assert t._dsn == "postgresql://u:p@host:5432/db"
