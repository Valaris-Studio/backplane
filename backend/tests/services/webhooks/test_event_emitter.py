# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import uuid

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.webhooks.webhook import Webhook, WebhookEvent
from app.models.workspace import Workspace
from app.repositories.webhooks.webhook import WebhookRepository
from app.schemas.webhooks.webhook import WebhookCreate
from app.services.webhooks.event_emitter import EventEmitter, compute_hmac_signature
from app.services.webhooks.webhook import WebhookService


async def test_compute_hmac_signature():
    payload = '{"event": "card.created", "data": {}}'
    secret = "my-secret"
    sig = compute_hmac_signature(payload, secret)
    assert isinstance(sig, str)
    assert len(sig) == 64  # SHA-256 hex digest


async def test_hmac_signature_deterministic():
    payload = '{"event": "card.created"}'
    secret = "secret"
    sig1 = compute_hmac_signature(payload, secret)
    sig2 = compute_hmac_signature(payload, secret)
    assert sig1 == sig2


async def test_hmac_signature_differs_with_different_secret():
    payload = '{"event": "card.created"}'
    sig1 = compute_hmac_signature(payload, "secret1")
    sig2 = compute_hmac_signature(payload, "secret2")
    assert sig1 != sig2


def test_webhook_events_are_all_published_on_internal_bus():
    # WebhookSubscriber bridges the internal event bus to external webhooks by
    # subscribing to `*` and fanning out. A WebhookEvent enum value that is
    # never published on the internal bus is a phantom subscription — users
    # who subscribe to it receive nothing, ever. This test keeps the public
    # WebhookEvent enum in sync with the internal publisher surface.
    from app.core import events as bus_events

    published = {
        value
        for name, value in vars(bus_events).items()
        if name.isupper() and isinstance(value, str)
    }
    declared = {e.value for e in WebhookEvent}
    phantoms = declared - published
    assert not phantoms, (
        f"WebhookEvent declares values with no internal-bus publisher: {sorted(phantoms)}. "
        "Either wire a publisher in app/core/events.py + the emitting service, or drop the enum entry."
    )


async def test_emit_event_to_subscribed_webhook(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    webhook_service = WebhookService(db_session)
    await webhook_service.create(
        test_workspace.id,
        test_user.id,
        WebhookCreate(
            url="https://example.com/hook",
            events=[WebhookEvent.card_created],
            secret="my-secret",
        ),
    )

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": str(uuid.uuid4()), "title": "New Card"},
    )

    assert len(results) == 1
    assert results[0]["event"] == "card.created"
    assert results[0]["url"] == "https://example.com/hook"
    assert "signature" in results[0]
    assert "body" in results[0]

    # Verify signature is valid HMAC of the body
    body = results[0]["body"]
    expected_sig = compute_hmac_signature(body, "my-secret")
    assert results[0]["signature"] == expected_sig


async def test_emit_event_skips_unsubscribed_webhook(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    webhook_service = WebhookService(db_session)
    await webhook_service.create(
        test_workspace.id,
        test_user.id,
        WebhookCreate(
            url="https://example.com/hook",
            events=[WebhookEvent.card_moved],  # subscribed to moved, not created
            secret="secret",
        ),
    )

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": str(uuid.uuid4())},
    )

    assert len(results) == 0


async def test_emit_event_skips_inactive_webhook(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    webhook_service = WebhookService(db_session)
    from app.schemas.webhooks.webhook import WebhookUpdate

    webhook = await webhook_service.create(
        test_workspace.id,
        test_user.id,
        WebhookCreate(
            url="https://example.com/hook",
            events=[WebhookEvent.card_created],
            secret="secret",
        ),
    )
    await webhook_service.update(
        webhook.id, test_workspace.id, WebhookUpdate(is_active=False)
    )

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": str(uuid.uuid4())},
    )

    assert len(results) == 0


@pytest.mark.slow
async def test_emit_event_multiple_webhooks(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    webhook_service = WebhookService(db_session)
    for i in range(3):
        await webhook_service.create(
            test_workspace.id,
            test_user.id,
            WebhookCreate(
                url=f"https://example.com/hook{i}",
                events=[WebhookEvent.card_created],
                secret=f"secret-{i}",
            ),
        )

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": str(uuid.uuid4())},
    )

    assert len(results) == 3
    urls = {r["url"] for r in results}
    assert urls == {
        "https://example.com/hook0",
        "https://example.com/hook1",
        "https://example.com/hook2",
    }

    # Each has a unique signature due to different secrets
    signatures = {r["signature"] for r in results}
    assert len(signatures) == 3


@pytest.mark.slow
async def test_emit_event_body_contains_event_and_payload(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    webhook_service = WebhookService(db_session)
    await webhook_service.create(
        test_workspace.id,
        test_user.id,
        WebhookCreate(
            url="https://example.com/hook",
            events=[WebhookEvent.card_created],
            secret="secret",
        ),
    )

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": "abc-123", "title": "My Card"},
    )

    body = json.loads(results[0]["body"])
    assert body["event"] == "card.created"
    assert body["payload"]["card_id"] == "abc-123"
    assert body["payload"]["title"] == "My Card"
    assert "timestamp" in body


# ---------- HTTP delivery (real-transport, DB side-effects) ----------
#
# These drive delivery through a real httpx.AsyncClient via an injected
# MockTransport (the same seam as test_event_emitter_contract.py) rather than
# patching httpx.AsyncClient away. The wire-level signature contract lives in
# the contract suite; the cases here additionally assert the DB side-effects of
# delivery (record_delivery success/failure, auto-deactivation) that the
# contract suite intentionally leaves out.


async def _create_webhook(
    db: AsyncSession, workspace: Workspace, user: User, url: str = "https://example.com/hook"
) -> Webhook:
    service = WebhookService(db)
    return await service.create(
        workspace.id,
        user.id,
        WebhookCreate(url=url, events=[WebhookEvent.card_created], secret="test-secret"),
    )


def _status_transport(status: int) -> httpx.MockTransport:
    return httpx.MockTransport(lambda request: httpx.Response(status))


async def test_deliver_records_success(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    webhook = await _create_webhook(db_session, test_workspace, test_user)

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": "abc"},
        transport=_status_transport(200),
    )

    assert results[0]["delivered"] is True
    assert results[0]["status_code"] == 200

    await db_session.refresh(webhook)
    assert webhook.last_delivered_at is not None
    assert webhook.failure_count == 0


async def test_deliver_records_failure_on_http_error(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    webhook = await _create_webhook(db_session, test_workspace, test_user)

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": "abc"},
        transport=_status_transport(500),
    )

    assert results[0]["delivered"] is False
    assert results[0]["status_code"] == 500

    await db_session.refresh(webhook)
    assert webhook.failure_count == 1
    assert webhook.last_delivered_at is None


async def test_deliver_records_failure_on_timeout(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    webhook = await _create_webhook(db_session, test_workspace, test_user)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("timed out", request=request)

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": "abc"},
        transport=httpx.MockTransport(handler),
    )

    assert results[0]["delivered"] is False
    assert results[0]["status_code"] is None
    assert "timed out" in results[0]["error"]

    await db_session.refresh(webhook)
    assert webhook.failure_count == 1


async def test_deliver_deactivates_after_max_failures(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    webhook = await _create_webhook(db_session, test_workspace, test_user)
    # Simulate 9 prior failures (one more will hit the threshold of 10)
    repo = WebhookRepository(db_session)
    for _ in range(9):
        await repo.record_delivery(webhook.id, success=False)
    await db_session.refresh(webhook)
    assert webhook.failure_count == 9
    assert webhook.is_active is True

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": "abc"},
        transport=_status_transport(503),
    )

    assert results[0]["delivered"] is False

    await db_session.refresh(webhook)
    assert webhook.failure_count == 10
    assert webhook.is_active is False


async def test_deliver_multiple_webhooks_independent(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """One webhook failing doesn't prevent others from delivering."""
    service = WebhookService(db_session)
    wh_ok = await service.create(
        test_workspace.id, test_user.id,
        WebhookCreate(url="https://ok.com/hook", events=[WebhookEvent.card_created], secret="s1"),
    )
    wh_fail = await service.create(
        test_workspace.id, test_user.id,
        WebhookCreate(url="https://fail.com/hook", events=[WebhookEvent.card_created], secret="s2"),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if "fail.com" in str(request.url):
            return httpx.Response(500)
        return httpx.Response(200)

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": "abc"},
        transport=httpx.MockTransport(handler),
    )

    assert len(results) == 2
    result_by_url = {r["url"]: r for r in results}
    assert result_by_url["https://ok.com/hook"]["delivered"] is True
    assert result_by_url["https://fail.com/hook"]["delivered"] is False

    await db_session.refresh(wh_ok)
    await db_session.refresh(wh_fail)
    assert wh_ok.failure_count == 0
    assert wh_fail.failure_count == 1
