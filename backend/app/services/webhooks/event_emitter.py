# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import hmac
import json
import logging
import uuid
from datetime import datetime, timezone

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.webhooks.webhook import WebhookRepository

logger = logging.getLogger(__name__)

DELIVERY_TIMEOUT_SECONDS = 5
MAX_CONSECUTIVE_FAILURES = 10


def compute_hmac_signature(payload: str, secret: str) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


class EventEmitter:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = WebhookRepository(db)

    async def emit(
        self,
        workspace_id: uuid.UUID,
        event: str,
        payload: dict,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> list[dict]:
        """
        Emit an event to all active webhooks subscribed to it.
        Delivers via HTTP POST with HMAC signature, records success/failure,
        and auto-deactivates webhooks after MAX_CONSECUTIVE_FAILURES.

        The ``transport`` seam lets contract tests inject an
        ``httpx.MockTransport`` so the real signed request is built and
        asserted without network access (mirrors GitHubAdapter's
        ``async_transport``). Production callers omit it and get the default.
        """
        webhooks = await self.repo.list_active_for_event(workspace_id, event)
        results = []

        async with httpx.AsyncClient(
            timeout=DELIVERY_TIMEOUT_SECONDS, transport=transport
        ) as client:
            for webhook in webhooks:
                result = await self._deliver(client, webhook, event, payload)
                results.append(result)

        return results

    async def _deliver(
        self,
        client: httpx.AsyncClient,
        webhook,
        event: str,
        payload: dict,
    ) -> dict:
        body = json.dumps({
            "event": event,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "payload": payload,
        }, default=str)

        signature = compute_hmac_signature(body, webhook.secret)
        headers = {
            "Content-Type": "application/json",
            "X-Webhook-Event": event,
            "X-Webhook-Signature-256": f"sha256={signature}",
        }

        result = {
            "webhook_id": webhook.id,
            "url": webhook.url,
            "event": event,
            "signature": signature,
            "body": body,
        }

        try:
            response = await client.post(webhook.url, content=body, headers=headers)
            delivered = response.status_code < 400
            result["delivered"] = delivered
            result["status_code"] = response.status_code
            await self.repo.record_delivery(webhook.id, success=delivered)
        except httpx.TimeoutException as exc:
            result["delivered"] = False
            result["status_code"] = None
            result["error"] = str(exc)
            await self.repo.record_delivery(webhook.id, success=False)
        except httpx.HTTPError as exc:
            result["delivered"] = False
            result["status_code"] = None
            result["error"] = str(exc)
            await self.repo.record_delivery(webhook.id, success=False)

        if not result["delivered"]:
            await self._maybe_deactivate(webhook.id)
            logger.warning(
                "Webhook delivery failed: %s → %s (event=%s)",
                webhook.id, webhook.url, event,
            )
        else:
            logger.info(
                "Webhook delivered: %s → %s (event=%s)",
                webhook.id, webhook.url, event,
            )

        return result

    async def _maybe_deactivate(self, webhook_id: uuid.UUID) -> None:
        webhook = await self.repo.get_by_id(webhook_id)
        if webhook and webhook.failure_count >= MAX_CONSECUTIVE_FAILURES:
            await self.repo.update(webhook, is_active=False)
            logger.warning(
                "Webhook %s auto-deactivated after %d consecutive failures",
                webhook_id, webhook.failure_count,
            )
