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
     cleanly): hand each staged intent to `committed_events.queue_until_commit`.
     Promotion happens only on a clean generation; a generation that raised never
     reaches promotion, so its staged intents are dropped (cleared on the next
     generation / never promoted) => NO push.

  3. FLUSH (committed_events): a promoted push is owned by the transaction open
     at promotion, so it publishes only once the OUTER transaction commits, and
     is dropped if that transaction — or any caller SAVEPOINT enclosing it —
     rolls back. A plain session-wide buffer outlived such a rollback and pushed
     a phantom notification on the next unrelated commit.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.committed_events import queue_until_commit

NOTIFICATION_CREATED_EVENT = "notification.created"

_STAGING = "_notification_push_staging"


def _info(db: AsyncSession) -> dict:
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
    """Hop 2: a generation that finished cleanly queues its staged intents to
    publish after the outer commit of the transaction it ran in."""
    for workspace_id, payload in _info(db).pop(_STAGING, []):
        queue_until_commit(db, NOTIFICATION_CREATED_EVENT, payload, workspace_id)
