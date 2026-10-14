# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timedelta, timezone

from app.core.time import as_utc
from app.schemas.agent_session import (
    RhythmBucket,
    RhythmLane,
    SessionRhythm,
    TimeSpan,
)
from app.services.agent_session import lifecycle_status
from app.services.session_calls import SessionCallService

# A silence this long reads as the person (or agent) being away.
IDLE_SPAN_AFTER = timedelta(minutes=5)
RHYTHM_KINDS = ("prompt", "tool", "file", "work", "error")


class SessionRhythmService(SessionCallService):
    """A session's shape over time, bucketed in the database: counts and
    times only, never content, whatever the capture level."""

    async def rhythm(
        self,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
        session_id: uuid.UUID,
        *,
        buckets: int,
    ) -> SessionRhythm:
        session = await self._owned(workspace_id, owner_id, session_id)
        now = datetime.now(timezone.utc)
        live = lifecycle_status(session, now) != "ended"
        start = as_utc(session.started_at)
        end = now if live else as_utc(session.last_event_at)
        span_seconds = max((end - start).total_seconds(), 0.0)
        bucket_count = buckets if span_seconds else 1
        bucket_seconds = span_seconds / bucket_count

        work_call_ids = set(await self._work_refs(session))
        counts = [{kind: 0 for kind in RHYTHM_KINDS} for _ in range(bucket_count)]
        for index, kind, entries in await self.calls.rhythm_counts(
            session.id,
            start=start,
            # A single-instant session still divides by something.
            bucket_ms=(bucket_seconds or 1.0) * 1000,
            work_call_ids=work_call_ids,
        ):
            # The session's last instant (and any clock skew) lands in the
            # nearest bucket instead of past either end.
            counts[min(max(index, 0), bucket_count - 1)][kind] += entries

        idle_spans = [
            TimeSpan(start=quiet_from, end=quiet_until)
            for quiet_from, quiet_until in await self.calls.silences(
                session.id, int(IDLE_SPAN_AFTER.total_seconds() * 1000)
            )
        ]
        last_event_at = as_utc(session.last_event_at)
        if live and now - last_event_at > IDLE_SPAN_AFTER:
            idle_spans.append(TimeSpan(start=last_event_at, end=now))

        children = await self._reads(
            await self.repo.owned_children(session.workspace_id, owner_id, session.id),
            now,
            with_work=False,
        )
        return SessionRhythm(
            start=start,
            end=end,
            live=live,
            bucket_seconds=bucket_seconds,
            buckets=[
                RhythmBucket(t=start + timedelta(seconds=bucket_seconds * index), **row)
                for index, row in enumerate(counts)
            ],
            idle_spans=idle_spans,
            children=[
                RhythmLane(
                    session_id=child.id,
                    harness=child.harness,
                    harness_display_name=child.harness_display_name,
                    title=child.title,
                    start=child.started_at,
                    end=child.last_event_at,
                    display_state=child.display_state,
                )
                for child in children
            ],
            capture_gaps=session.capture_gaps,
        )
