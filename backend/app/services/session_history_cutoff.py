# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timedelta

from app.core.time import as_utc
from app.models.agent_session import AgentSession, AgentSessionTombstone
from app.repositories.agent_session import SESSION_IDENTITY, AgentSessionRepository

# Harness clocks drift; a day of slack still rejects nonsense timestamps that
# would pin a session to the top of every list. It also bounds how far ahead
# of the server any accepted record's clock can be.
MAX_CLOCK_SKEW = timedelta(days=1)
# How far the measured clock lead may fall short of the real one: it is
# measured through upload latency, which hides that much of it.
CLOCK_LEAD_MARGIN = timedelta(minutes=2)
CLOCK_LEAD_SAMPLE = 50


def _bounded_lead(lead: timedelta) -> timedelta:
    return min(max(lead, timedelta(0)), MAX_CLOCK_SKEW)


def _clock_lead(capture_times: list[tuple[datetime, datetime]]) -> timedelta:
    """How far the device's clock runs ahead of the server's, at least: a
    record cannot reach the server before the device captured it."""
    return max(
        (as_utc(captured) - as_utc(received) for captured, received in capture_times),
        default=timedelta(0),
    )


def _identity(session: AgentSession) -> tuple:
    return tuple(getattr(session, key) for key in SESSION_IDENTITY)


async def history_cutoffs(
    repo: AgentSessionRepository,
    sessions: list[AgentSession],
    deleted_at: datetime,
) -> dict[uuid.UUID, datetime]:
    """Each doomed session's history cutoff, by session id, on its device's
    clock. Must run before the sessions' receipts cascade away with them.

    The cutoff reaches past the deletion by the device's clock lead, measured
    both now and on the doomed sessions' own receipts (a clock corrected since
    stamped them on its old reading), and past everything those sessions
    observed. It never falls behind an earlier tombstone of the identity."""
    facts = await repo.receipt_clock_facts([session.id for session in sessions])
    by_installation: dict[uuid.UUID, datetime] = {}
    for installation_id in {session.installation_id for session in sessions}:
        latest_captured, doomed_lead_seconds = facts.get(installation_id, (None, None))
        lead = _clock_lead(
            await repo.recent_capture_times(installation_id, CLOCK_LEAD_SAMPLE)
        )
        if doomed_lead_seconds is not None:
            # float(): a driver may hand a NUMERIC over as Decimal.
            lead = max(lead, timedelta(seconds=float(doomed_lead_seconds)))
        observed = [
            as_utc(session.last_event_at)
            for session in sessions
            if session.installation_id == installation_id
        ]
        if latest_captured is not None:
            observed.append(as_utc(latest_captured))
        by_installation[installation_id] = (
            max(deleted_at + _bounded_lead(lead), *observed) + CLOCK_LEAD_MARGIN
        )
    earlier = await repo.tombstones_of(sessions)
    cutoffs = {}
    for session in sessions:
        cutoff = by_installation[session.installation_id]
        if earlier and (previous := earlier.get(_identity(session))) is not None:
            cutoff = max(cutoff, effective_history_cutoff(previous))
        cutoffs[session.id] = cutoff
    return cutoffs


def deleted_history_of(
    tombstones: list[AgentSessionTombstone],
) -> tuple[datetime, str] | None:
    """The cutoff and reason that hold for a native session of one device in
    every workspace: the latest effective cutoff among its tombstones, so
    remapping a folder to another workspace never lets deleted history back
    in there."""
    if not tombstones:
        return None
    latest = max(tombstones, key=effective_history_cutoff)
    return effective_history_cutoff(latest), latest.reason


def effective_history_cutoff(tombstone: AgentSessionTombstone) -> datetime:
    """A tombstone without a cutoff predates them, and one whose cutoff was
    computed for another deletion was re-deleted by the previous release
    mid-deploy: neither measured the device's clock for its deleted_at, so
    both reach as far as any clock ingest accepts could be ahead."""
    deleted_at = as_utc(tombstone.deleted_at)
    if (
        tombstone.history_cutoff is None
        or tombstone.history_cutoff_deleted_at is None
        or as_utc(tombstone.history_cutoff_deleted_at) != deleted_at
    ):
        return deleted_at + MAX_CLOCK_SKEW
    return as_utc(tombstone.history_cutoff)
