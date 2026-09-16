# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging

from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.event_bus import Event, EventBus
from app.services.webhooks.event_emitter import EventEmitter

logger = logging.getLogger(__name__)


class WebhookSubscriber:
    def __init__(self, bus: EventBus, session_factory: async_sessionmaker):
        self._bus = bus
        self._session_factory = session_factory
        self._unsubscribe = None

    def start(self):
        self._unsubscribe = self._bus.subscribe(
            callback=self._handle_event, event_pattern="*"
        )

    def stop(self):
        if self._unsubscribe:
            self._unsubscribe()
            self._unsubscribe = None

    async def _handle_event(self, event: Event):
        # Webhook delivery is origin-only: a remote event was already delivered
        # by the instance that published it. Without this guard every worker in
        # the fleet re-POSTs the same external webhook once per NOTIFY.
        if event.remote:
            return
        try:
            async with self._session_factory() as session:
                async with session.begin():
                    emitter = EventEmitter(session)
                    await emitter.emit(
                        workspace_id=event.workspace_id,
                        event=event.event_type,
                        payload=event.payload,
                    )
        except Exception:
            logger.exception(
                "WebhookSubscriber failed to deliver event %s", event.event_type
            )
