# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Defer event-bus publication until the caller's OUTER transaction commits.

Each deferred event is owned by the innermost transaction boundary (SAVEPOINT
or root) open when it was queued:

- SAVEPOINT release hands its events to the enclosing boundary; it is not final.
- SAVEPOINT rollback drops only the events it owns (and any nested beneath it).
- Root commit dispatches the remaining events, in queue order, once.
- Root rollback, a failed commit, or closing the session drops everything, so
  nothing leaks into a later transaction on a reused session.

The bus stays best-effort: a crash between commit and dispatch loses the event.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, SessionTransaction

from app.core.event_bus import event_bus

logger = logging.getLogger(__name__)

_DEFERRED = "events_deferred_until_commit"

# Strong references: the loop only weakly holds tasks, so an unreferenced
# dispatch task can be garbage-collected before it runs.
_dispatch_tasks: set[asyncio.Task] = set()
# Each commit's dispatch waits for the previous one in the same workspace, so a
# subscriber that suspends on an earlier commit's event cannot be overtaken by a
# later commit. Subscribers filter by workspace or ignore note events, so only
# per-workspace order is observable; other workspaces never queue behind it.
_latest_dispatch: dict[uuid.UUID, asyncio.Task] = {}
# Above normal WS/NOTIFY fan-out latency, below one webhook phase timeout (5s):
# a stalled subscriber then reorders its own workspace rather than backlogging it.
_ORDERED_DISPATCH_WAIT_SECONDS = 2.0


@dataclass
class _DeferredEvent:
    owner: SessionTransaction
    event_type: str
    payload: dict
    workspace_id: uuid.UUID


def _boundary(session: Session) -> SessionTransaction | None:
    return session.get_nested_transaction() or session.get_transaction()


def _enclosing_boundary(transaction: SessionTransaction) -> SessionTransaction | None:
    parent = transaction.parent
    while parent is not None and not parent.nested and parent.parent is not None:
        parent = parent.parent
    return parent


def _is_within(owner: SessionTransaction, ended: SessionTransaction) -> bool:
    transaction: SessionTransaction | None = owner
    while transaction is not None:
        if transaction is ended:
            return True
        transaction = transaction.parent
    return False


async def _publish_in_order(
    events: list[_DeferredEvent], previous_dispatch: asyncio.Task | None
) -> None:
    if previous_dispatch is not None:
        _, still_running = await asyncio.wait(
            [previous_dispatch], timeout=_ORDERED_DISPATCH_WAIT_SECONDS
        )
        if still_running:
            logger.warning(
                "publishing %d committed event(s) before the previous dispatch "
                "finished; delivery order is not guaranteed",
                len(events),
            )
    for deferred in events:
        try:
            await event_bus.publish(
                event_type=deferred.event_type,
                payload=deferred.payload,
                workspace_id=deferred.workspace_id,
            )
        except Exception:
            logger.exception("Failed to publish event %s", deferred.event_type)


def queue_until_commit(
    db: AsyncSession, event_type: str, payload: dict, workspace_id: uuid.UUID
) -> None:
    session = db.sync_session
    owner = _boundary(session)
    if owner is None:
        raise RuntimeError(f"{event_type} must be queued inside a transaction")
    session.info.setdefault(_DEFERRED, []).append(
        _DeferredEvent(owner, event_type, payload, workspace_id)
    )


@event.listens_for(Session, "after_commit")
def _promote_or_dispatch(session: Session) -> None:
    deferred: list[_DeferredEvent] | None = session.info.get(_DEFERRED)
    if not deferred:
        return
    # Dispatched before close(), so the committing transaction is still the
    # session's innermost boundary: the SAVEPOINT on release, else the root.
    committed = _boundary(session)
    if committed is not None and committed.nested:
        enclosing = _enclosing_boundary(committed)
        for pending in deferred:
            if pending.owner is committed:
                pending.owner = enclosing
        return

    session.info.pop(_DEFERRED)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.warning("no event loop to publish %d committed event(s)", len(deferred))
        return
    by_workspace: dict[uuid.UUID, list[_DeferredEvent]] = {}
    for pending in deferred:
        by_workspace.setdefault(pending.workspace_id, []).append(pending)
    for workspace_id, events in by_workspace.items():
        _dispatch_after_previous(loop, workspace_id, events)


def _dispatch_after_previous(
    loop: asyncio.AbstractEventLoop,
    workspace_id: uuid.UUID,
    events: list[_DeferredEvent],
) -> None:
    previous_dispatch = _latest_dispatch.get(workspace_id)
    if previous_dispatch is not None and previous_dispatch.get_loop() is not loop:
        previous_dispatch = None
    task = loop.create_task(_publish_in_order(events, previous_dispatch))
    _latest_dispatch[workspace_id] = task
    _dispatch_tasks.add(task)

    def _forget(finished: asyncio.Task) -> None:
        _dispatch_tasks.discard(finished)
        if _latest_dispatch.get(workspace_id) is finished:
            del _latest_dispatch[workspace_id]

    task.add_done_callback(_forget)


@event.listens_for(Session, "after_soft_rollback")
def _drop_rolled_back(
    session: Session, previous_transaction: SessionTransaction
) -> None:
    deferred: list[_DeferredEvent] | None = session.info.get(_DEFERRED)
    if not deferred:
        return
    deferred[:] = [
        pending
        for pending in deferred
        if not _is_within(pending.owner, previous_transaction)
    ]


@event.listens_for(Session, "after_transaction_end")
def _drop_uncommitted(session: Session, transaction: SessionTransaction) -> None:
    if transaction.parent is None:
        session.info.pop(_DEFERRED, None)
