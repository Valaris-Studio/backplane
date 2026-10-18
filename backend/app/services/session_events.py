# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Owner-only, id-only invalidations for captured sessions and devices.

Services return these as intents; routers publish them from a background task,
which runs only after the request's transaction committed and its response was
sent, so a rolled-back write never announces anything. Work-link changes are
made inside transactions and savepoints their caller owns, so their intents
are queued with that transaction instead (`queue_after_commit`).
"""

import logging
import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.committed_events import queue_until_commit

logger = logging.getLogger(__name__)

AGENT_SESSION_UPDATED = "agent_session.updated"
COMPANION_INSTALLATION_UPDATED = "companion_installation.updated"
LINKS_CHANGED = "links"


@dataclass(frozen=True)
class Invalidation:
    event_type: str
    workspace_id: uuid.UUID
    payload: tuple[tuple[str, str], ...]


def session_updated(session, reason: str) -> Invalidation:
    return Invalidation(
        AGENT_SESSION_UPDATED,
        session.workspace_id,
        (
            ("owner_id", str(session.owner_id)),
            ("session_id", str(session.id)),
            ("workspace_id", str(session.workspace_id)),
            ("reason", reason),
        ),
    )


def owner_links_changed(owner_id: uuid.UUID, workspace_id: uuid.UUID) -> Invalidation:
    # For another workspace whose cards and notes list the owner's sessions:
    # it learns only that the owner's links changed, never which session or
    # which source workspace.
    return Invalidation(
        AGENT_SESSION_UPDATED,
        workspace_id,
        (
            ("owner_id", str(owner_id)),
            ("workspace_id", str(workspace_id)),
            ("reason", LINKS_CHANGED),
        ),
    )


def queue_after_commit(db: AsyncSession, invalidations: Iterable[Invalidation]) -> None:
    """Publish once the outer transaction commits, each at most once per
    transaction however many matches and retractions produced it."""
    for invalidation in invalidations:
        queue_until_commit(
            db,
            invalidation.event_type,
            dict(invalidation.payload),
            invalidation.workspace_id,
            coalesce_key=invalidation,
        )


def installation_updated(
    installation, workspace_ids: list[uuid.UUID], reason: str
) -> list[Invalidation]:
    # Published into each of the owner's workspaces, so every member's socket
    # on those workspaces receives it; clients act only when `owner_id` is
    # theirs. It carries ids only, never names or content.
    payload = (
        ("owner_id", str(installation.owner_id)),
        ("installation_id", str(installation.id)),
        ("reason", reason),
    )
    return [
        Invalidation(COMPANION_INSTALLATION_UPDATED, workspace_id, payload)
        for workspace_id in workspace_ids
    ]


async def publish_invalidations(invalidations: list[Invalidation]) -> None:
    from app.core.event_bus import event_bus

    for invalidation in dict.fromkeys(invalidations):
        try:
            await event_bus.publish(
                event_type=invalidation.event_type,
                payload=dict(invalidation.payload),
                workspace_id=invalidation.workspace_id,
            )
        except Exception:
            logger.exception("session invalidation not published")
