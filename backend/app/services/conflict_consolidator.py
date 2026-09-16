# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Conflict-consolidator card creator (PAR-3c).

Sits between the merge queue (which records the conflict) and the kanban
board (which surfaces the work). When `MergeQueueService.process_entry`
sees a `("conflict", ...)` outcome, it asks this module to create a
follow-up card carrying the conflict body so a human or specialised
runner can resolve the rebase manually.

The creator is intentionally a separate module — keeping the merge-queue
service free of card-creation concerns leaves both files small and the
seam easy to mock in tests.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import String, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import EventBus
from app.models.agents.merge_queue import MergeQueueEntry
from app.models.kanban.card import Card
from app.repositories.kanban.card import CardRepository
from app.repositories.workspace_config import WorkspaceConfigRepository

logger = logging.getLogger(__name__)


CONSOLIDATOR_CARD_CREATED = "merge_queue.conflict_consolidator_created"

_DEFAULT_CONSOLIDATOR_LABEL = "consolidate-merge-conflict"


class ConsolidatorCardCreator:
    """Idempotent factory for conflict-resolution consolidator cards.

    Constructed per-tick (cheap — just three repo handles). The merge-queue
    worker passes one in to `MergeQueueService(consolidator=...)`; routers
    that don't need consolidator behaviour (e.g. raw enqueue) skip wiring
    it and the queue silently no-ops the consolidator step.
    """

    def __init__(
        self,
        db: AsyncSession,
        *,
        card_service,  # app.services.kanban.card.CardService
        event_bus: EventBus | None = None,
    ) -> None:
        self.db = db
        self._card_service = card_service
        self._bus = event_bus
        self._card_repo = CardRepository(db)
        self._config_repo = WorkspaceConfigRepository(db)

    async def create_for_entry(
        self, entry: MergeQueueEntry, *, conflict_message: str
    ) -> Card | None:
        """Create (or return existing) consolidator card for a conflict entry.

        Returns:
            The created or pre-existing consolidator Card, or None when the
            workspace's `conflict_consolidator` config is unset/disabled
            (graceful degradation — the conflict is still recorded on the
            merge_queue_entries row, operators just have to triage manually).
        """
        config = await self._load_enabled_config(entry.workspace_id)
        if config is None:
            return None

        label = config.get("label") or _DEFAULT_CONSOLIDATOR_LABEL

        existing = await self._find_existing(
            parent_card_id=entry.card_id, label=label
        )
        if existing is not None:
            return existing

        original = await self._card_repo.get_by_id(entry.card_id)
        if original is None:
            # Original card vanished (cascade-delete?) — can't usefully
            # create a child. Surface as a skip rather than crash the worker.
            logger.warning(
                "consolidator skipped: parent card %s missing for entry %s",
                entry.card_id,
                entry.id,
            )
            return None

        board_id = uuid.UUID(config["board_id"])
        column_id = uuid.UUID(config["column_id"])

        consolidator = await self._card_repo.create(
            board_id=board_id,
            column_id=column_id,
            title=_consolidator_title(original.title),
            description=_consolidator_description(
                original=original,
                entry=entry,
                conflict_message=conflict_message,
            ),
            position=await self._next_position(column_id),
            created_by=original.created_by,
            labels=[label],
            parent_card_id=entry.card_id,
        )

        await self._publish_created(entry=entry, consolidator=consolidator)
        return consolidator

    async def _load_enabled_config(
        self, workspace_id: uuid.UUID
    ) -> dict | None:
        cfg = await self._config_repo.get_by_workspace(workspace_id)
        if cfg is None or cfg.conflict_consolidator is None:
            return None
        config = cfg.conflict_consolidator
        if not isinstance(config, dict) or not config.get("enabled"):
            return None
        if not config.get("board_id") or not config.get("column_id"):
            logger.warning(
                "consolidator config for workspace %s missing board_id/column_id",
                workspace_id,
            )
            return None
        return config

    async def _find_existing(
        self, *, parent_card_id: uuid.UUID, label: str
    ) -> Card | None:
        # JSON-array membership across SQLite + Postgres: cast labels to text
        # and look for the quoted needle. Mirrors CardRepository.search()'s
        # pattern; assumes labels never contain a literal `"`.
        stmt = (
            select(Card)
            .where(Card.parent_card_id == parent_card_id)
            .where(Card.labels.cast(String).like(f'%"{label}"%'))
            .order_by(Card.created_at.asc())
            .limit(1)
        )
        result = await self.db.execute(stmt)
        existing = result.scalar_one_or_none()
        if existing is None:
            return None
        return await self._card_repo.get_by_id(existing.id)

    async def _next_position(self, column_id: uuid.UUID) -> float:
        max_pos = await self._card_repo.get_max_position(column_id)
        return max_pos + 1024.0

    async def _publish_created(
        self, *, entry: MergeQueueEntry, consolidator: Card
    ) -> None:
        if self._bus is None:
            return
        try:
            await self._bus.publish(
                event_type=CONSOLIDATOR_CARD_CREATED,
                payload={
                    "entry_id": str(entry.id),
                    "original_card_id": str(entry.card_id),
                    "consolidator_card_id": str(consolidator.id),
                },
                workspace_id=entry.workspace_id,
            )
        except Exception:
            logger.exception(
                "failed to publish %s for entry %s",
                CONSOLIDATOR_CARD_CREATED,
                entry.id,
            )


def _consolidator_title(original_title: str) -> str:
    return f"Resolve merge conflict: {original_title}"


def _consolidator_description(
    *,
    original: Card,
    entry: MergeQueueEntry,
    conflict_message: str,
) -> str:
    return (
        "## Original card\n"
        f"- Title: {original.title}\n"
        f"- PR: {entry.pr_url}\n"
        f"- Branch: {entry.pr_branch}\n"
        f"- Integration branch: {entry.integration_branch}\n"
        "\n"
        "## Conflict\n"
        "```\n"
        f"{conflict_message}\n"
        "```\n"
    )
