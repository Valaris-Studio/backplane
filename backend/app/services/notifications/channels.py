# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Protocol

from app.services.notifications.live_push import stage_push


class EffectivePrefs(Protocol):
    """The Phase-2 resolved-prefs object a channel reads. The precedence
    (muted -> category_overrides[cat][channel] -> category default by
    relevance_scope) is resolved BEFORE the channel sees it; the channel only
    asks "is MY key on for this category"."""

    def channel_enabled(self, category: str, channel_key: str) -> bool: ...


class NotificationChannel(ABC):
    """Pluggable transport. v1 ships only in_app; email/telegram drop in later
    as plugins with zero change to generation. See
    docs/notification-system-contract.md §"Channel / transport abstraction"."""

    key: str

    @abstractmethod
    async def deliver(self, notification: Any, recipient: Any, db: Any) -> None: ...

    def is_enabled_for(self, effective_prefs: EffectivePrefs, category: str) -> bool:
        # Reads category_overrides[cat][self.key] via the resolved prefs — never
        # another channel's key, never an invented default.
        return effective_prefs.channel_enabled(category, self.key)


class InAppChannel(NotificationChannel):
    key = "in_app"

    async def deliver(self, notification: Any, recipient: Any, db: Any) -> None:
        # INV-1: the durable row is ALREADY written by the generator. deliver()
        # must NOT publish synchronously — it runs DEEP inside the triggering
        # txn's begin_nested savepoint, so a synchronous push would (a) race the
        # outer commit's visibility and (b) become a phantom badge increment if
        # that savepoint later rolls back. Instead we STAGE the contract-shaped
        # push intent on the session; the generator promotes it past the
        # savepoint and an after_commit listener flushes it to the bus only once
        # the outer transaction has durably committed (see live_push.py).
        stage_push(
            db,
            workspace_id=notification.workspace_id,
            payload={
                "notification_id": str(notification.id),
                "recipient_user_id": str(notification.recipient_user_id),
                "category": notification.category,
                "workspace_id": str(notification.workspace_id),
                "unread_delta": 1,
                # The resolved deep-link travels on the push so a consumer that
                # acts on the event alone (an OS-notification toast) can navigate
                # to the entity without first fetching the row. None for rows with
                # no navigable target.
                "link": notification.link,
            },
        )


CHANNEL_REGISTRY: dict[str, NotificationChannel] = {"in_app": InAppChannel()}
