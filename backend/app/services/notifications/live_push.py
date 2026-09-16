# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Post-commit live-push for notifications (Phase 3, INV-1 transport-only).

THE ORDERING CONTRACT (tests/services/notifications/test_live_push_ordering.py):

Generation runs DEEP inside the triggering service's txn, scoped by a
`begin_nested()` SAVEPOINT. The InAppChannel must publish `notification.created`
ONLY after the row is durably committed and OUTSIDE that savepoint. Two failure
modes this guards: a phantom push for a savepoint-rolled-back row, and a
visibility race where a client refetches before the outer txn commits.

Mechanism — three hops keyed off the AsyncSession's `info` dict:

  1. STAGE (InAppChannel.deliver, inside the savepoint): append the contract-
     shaped push intent to `session.info[_STAGING]`. A plain Python list, NOT
     transactional, so a savepoint rollback does NOT remove staged entries on its
     own — which is exactly why staged entries are never published directly.

  2. PROMOTE (promote_staged, after generate_for_event's per-event work exits
     the savepoint cleanly): move `_STAGING` -> `_PENDING`. Promotion happens
     only on a clean generation; a savepoint that rolled back (an exception in
     the nested block) never reaches promotion, so its staged intents are
     dropped (cleared on the next generation / never promoted) => NO push.

  3. FLUSH (an `after_commit` SQLAlchemy listener on the sync Session): once the
     OUTER transaction commits, drain `_PENDING` and schedule each
     `event_bus.publish`. The listener is sync; `event_bus.publish` is async, so
     it bridges via `asyncio.ensure_future`. Verified: AsyncSession.commit()
     awaits via greenlet_spawn, yielding to the loop, so the scheduled publish
     runs within that await — observable immediately after `await session.commit()`.
"""

from __future__ import annotations

import asyncio
import logging
import uuid

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.event_bus import event_bus

logger = logging.getLogger(__name__)

NOTIFICATION_CREATED_EVENT = "notification.created"

_STAGING = "_notification_push_staging"
_PENDING = "pending_notification_pushes"

# A staged/pending push intent: the workspace to publish under + the payload.
PushIntent = tuple[uuid.UUID, dict]


def _info(db: AsyncSession) -> dict:
    # AsyncSession.info proxies the underlying sync Session.info — the same dict
    # the after_commit listener (which only sees the sync Session) reads.
    return db.info


def stage_push(db: AsyncSession, *, workspace_id: uuid.UUID, payload: dict) -> None:
    """Hop 1: record a push intent during deliver() (inside the savepoint). NOT
    published until the outer commit, and only if promoted (clean generation)."""
    _info(db).setdefault(_STAGING, []).append((workspace_id, payload))


def reset_staged(db: AsyncSession) -> None:
    """Clear any leftover staged intents so a fresh generation starts clean (a
    prior generation that errored before promotion leaves staging populated)."""
    _info(db)[_STAGING] = []


def promote_staged(db: AsyncSession) -> None:
    """Hop 2: a generation that exited its savepoint cleanly promotes its staged
    intents to the pending (will-publish-after-commit) buffer."""
    info = _info(db)
    staged = info.pop(_STAGING, [])
    if staged:
        info.setdefault(_PENDING, []).extend(staged)


@event.listens_for(Session, "after_commit")
def _flush_pending_pushes(session: Session) -> None:
    """Hop 3: after the OUTER transaction commits, publish each pending intent.

    Sync listener -> async publish bridge via asyncio.ensure_future. Guarded so
    a session with no running loop (rare; non-request contexts) degrades to a
    no-op rather than raising inside SQLAlchemy's commit path."""
    # after_commit ALSO fires on SAVEPOINT release in this SQLAlchemy version
    # (SessionTransaction.commit dispatches when `self.nested`), so the
    # activity generator's begin_nested() exit would flush mid-mutation —
    # exactly the visibility race this module exists to prevent (the rows are
    # not outer-committed yet). At nested-dispatch time the savepoint is still
    # the session's current nested transaction; the real outermost commit
    # dispatches with no nested transaction in play.
    if session.in_nested_transaction():
        return
    pending: list[PushIntent] = session.info.pop(_PENDING, [])
    if not pending:
        return
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        logger.warning("no event loop to flush %d notification push(es)", len(pending))
        return
    for workspace_id, payload in pending:
        loop.create_task(
            event_bus.publish(NOTIFICATION_CREATED_EVENT, payload, workspace_id)
        )
