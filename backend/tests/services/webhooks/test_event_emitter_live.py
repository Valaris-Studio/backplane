# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tier-2 live smoke for webhook delivery — LOCAL-ONLY, MANUAL.

The credentialed counterpart to the keyless contract suite. It makes a *real*
network POST (default httpx transport — NO MockTransport) to a maintainer-
supplied receiver and asserts the real service accepts our signed payload. It
catches what a fake transport structurally cannot: TLS, real proxies/redirects,
and the receiver's own signature verification.

This is the in-repo precedent for the OSS two-tier pattern — a fresh keyless
clone must stay GREEN, so:
  - Gated on ``WEBHOOK_LIVE_TEST_URL``; absent → SKIP, never fail.
  - Tagged ``@pytest.mark.live`` so it deselects wholesale (``-m "not live"``).
  - Never wired into public CI. The URL/secret live in a maintainer's
    gitignored ``.env`` only.

Maintainer invocation (point the URL at a real receiver that 2xx-acks, e.g. a
webhook.site bin or a local listener):

    WEBHOOK_LIVE_TEST_URL=https://your-receiver.example/hook \
    WEBHOOK_LIVE_TEST_SECRET=shared-secret \
        python -m pytest tests/services/webhooks/test_event_emitter_live.py -m live -v

Delivery is exercised through EventEmitter so the live path is the same code
the contract suite drives — only the transport (real vs MockTransport) differs.
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.webhooks.webhook import WebhookEvent
from app.models.workspace import Workspace
from app.schemas.webhooks.webhook import WebhookCreate
from app.services.webhooks.event_emitter import EventEmitter
from app.services.webhooks.webhook import WebhookService

_LIVE_URL = os.getenv("WEBHOOK_LIVE_TEST_URL")
_LIVE_SECRET = os.getenv("WEBHOOK_LIVE_TEST_SECRET", "live-smoke-secret")


@pytest.mark.live
@pytest.mark.skipif(
    not _LIVE_URL,
    reason="WEBHOOK_LIVE_TEST_URL not set — Tier-2 live smoke is local-only/manual",
)
async def test_live_delivery_reaches_real_receiver(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """A real signed POST to a real receiver is accepted (delivered=True)."""
    service = WebhookService(db_session)
    await service.create(
        test_workspace.id,
        test_user.id,
        WebhookCreate(
            url=_LIVE_URL,
            events=[WebhookEvent.card_created],
            secret=_LIVE_SECRET,
        ),
    )

    emitter = EventEmitter(db_session)
    # transport omitted on purpose: real network, the whole point of Tier-2.
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"source": "valaris-webhook-live-smoke", "id": str(uuid.uuid4())},
    )

    assert results, "no active subscriber matched — check the seeded webhook"
    assert results[0]["delivered"] is True, (
        f"Live receiver at {_LIVE_URL} did not 2xx the signed webhook "
        f"(status={results[0].get('status_code')}, error={results[0].get('error')}). "
        "Confirm the receiver is reachable and acks with a 2xx."
    )
