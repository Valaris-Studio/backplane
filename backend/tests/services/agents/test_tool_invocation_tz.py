# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from datetime import datetime, timedelta, timezone

from app.services.agents.tool_invocation import _as_naive_utc


# Regression: tool_invocations columns are TIMESTAMP WITHOUT TIME ZONE; the
# MCP tracker sends tz-aware UTC iso strings. Without normalization asyncpg
# rejects the write on Postgres and every POST .../tool-invocations 500s.


def test_as_naive_utc_passes_through_none():
    assert _as_naive_utc(None) is None


def test_as_naive_utc_passes_through_naive_datetime_unchanged():
    naive = datetime(2026, 4, 17, 12, 0, 0)
    result = _as_naive_utc(naive)
    assert result == naive
    assert result.tzinfo is None


def test_as_naive_utc_strips_tzinfo_from_utc():
    aware = datetime(2026, 4, 17, 12, 0, 0, tzinfo=timezone.utc)
    result = _as_naive_utc(aware)
    assert result.tzinfo is None
    assert result == datetime(2026, 4, 17, 12, 0, 0)


def test_as_naive_utc_converts_non_utc_to_utc_then_strips():
    # EST is UTC-5; 12:00 EST == 17:00 UTC.
    est = timezone(timedelta(hours=-5))
    aware = datetime(2026, 4, 17, 12, 0, 0, tzinfo=est)
    result = _as_naive_utc(aware)
    assert result.tzinfo is None
    assert result == datetime(2026, 4, 17, 17, 0, 0)
