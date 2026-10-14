# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""PR #391 re-review: on Postgres, EXTRACT(EPOCH FROM interval) is NUMERIC,
which asyncpg returns as Decimal; the clock lead must survive that."""

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

from app.services.session_history_cutoff import history_cutoffs


class _PostgresShapedRepo:
    def __init__(self, installation_id):
        self.installation_id = installation_id

    async def receipt_clock_facts(self, session_ids):
        return {self.installation_id: (None, Decimal("3600.000000"))}

    async def recent_capture_times(self, installation_id, limit):
        return []

    async def tombstones_of(self, sessions):
        return {}


async def test_a_numeric_clock_lead_from_postgres_still_yields_a_cutoff():
    installation_id = uuid.uuid4()
    deleted_at = datetime.now(timezone.utc)
    session = SimpleNamespace(
        id=uuid.uuid4(),
        installation_id=installation_id,
        last_event_at=deleted_at - timedelta(minutes=5),
    )

    cutoffs = await history_cutoffs(
        _PostgresShapedRepo(installation_id), [session], deleted_at
    )

    assert cutoffs[session.id] >= deleted_at + timedelta(hours=1)
