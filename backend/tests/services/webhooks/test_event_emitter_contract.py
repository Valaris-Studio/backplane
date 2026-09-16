# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tier-1 contract tests for webhook delivery — keyless, CI-safe.

These close the mock-blindness in the legacy delivery tests. Those patched
``httpx.AsyncClient`` wholesale and asserted on the *kwargs we handed a fake*
(``mock_client.post.call_args``), so they never proved the signed request was
actually built or that ``X-Webhook-Signature-256`` reached the wire.

Here we inject an ``httpx.MockTransport`` into the real ``httpx.AsyncClient``
(mirroring the git-adapter precedent — ``GitHubAdapter(async_transport=...)``
in tests/integrations/git/adapters/test_github_adapter.py). A real request is
constructed and serialized; the handler inspects the real ``httpx.Request``
and we assert the exact signed body bytes, the signature header, and that a
receiver re-hashing the received body reproduces our signature. Response-shape
branching (2xx / non-2xx / timeout / connection-error) is exercised through
the same real seam.

No network, no credentials — a keyless clone runs these in CI and stays green.
"""

from __future__ import annotations

import json

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.webhooks.webhook import Webhook, WebhookEvent
from app.models.workspace import Workspace
from app.schemas.webhooks.webhook import WebhookCreate
from app.services.webhooks.event_emitter import EventEmitter, compute_hmac_signature
from app.services.webhooks.webhook import WebhookService


async def _seed_webhook(
    db: AsyncSession,
    workspace: Workspace,
    user: User,
    *,
    url: str = "https://example.com/hook",
    secret: str = "topsecret",
) -> Webhook:
    service = WebhookService(db)
    return await service.create(
        workspace.id,
        user.id,
        WebhookCreate(url=url, events=[WebhookEvent.card_created], secret=secret),
    )


def _capturing_handler(captured: dict) -> "httpx.MockTransport":
    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["headers"] = request.headers
        captured["body"] = request.content
        return httpx.Response(200)

    return httpx.MockTransport(handler)


async def test_signed_request_reaches_the_wire(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """The real request carries the signature computed over the real body bytes.

    The crux the mock-blind tests missed: the header a receiver verifies,
    computed over the bytes actually transmitted.
    """
    await _seed_webhook(db_session, test_workspace, test_user, secret="topsecret")
    captured: dict = {}

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": "abc", "title": "hello"},
        transport=_capturing_handler(captured),
    )

    assert results[0]["delivered"] is True
    assert captured["method"] == "POST"
    assert captured["url"] == "https://example.com/hook"
    assert captured["headers"]["Content-Type"] == "application/json"
    assert captured["headers"]["X-Webhook-Event"] == "card.created"

    expected_sig = compute_hmac_signature(captured["body"].decode(), "topsecret")
    assert captured["headers"]["X-Webhook-Signature-256"] == f"sha256={expected_sig}"
    # The signed bytes are the envelope the service builds, not the bare payload.
    sent = json.loads(captured["body"])
    assert sent["event"] == "card.created"
    assert sent["payload"] == {"card_id": "abc", "title": "hello"}
    assert "timestamp" in sent


async def test_receiver_reproduces_signature_from_received_body(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """A receiver re-hashing the body it got reproduces our signature.

    The integrity property asserted from the receiver's side — the whole point
    of the HMAC contract — which a mock that never serializes can't prove.
    """
    await _seed_webhook(
        db_session, test_workspace, test_user, secret="receiver-shared-secret"
    )
    verified: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        header = request.headers["X-Webhook-Signature-256"]
        assert header.startswith("sha256=")
        sent_sig = header.removeprefix("sha256=")
        recomputed = compute_hmac_signature(
            request.content.decode(), "receiver-shared-secret"
        )
        verified["match"] = (sent_sig == recomputed)
        return httpx.Response(204)

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": "x"},
        transport=httpx.MockTransport(handler),
    )

    assert results[0]["delivered"] is True
    assert verified["match"] is True


async def test_2xx_non_200_counts_as_delivered(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    await _seed_webhook(db_session, test_workspace, test_user)
    transport = httpx.MockTransport(lambda r: httpx.Response(202))

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": "x"},
        transport=transport,
    )

    assert results[0]["delivered"] is True
    assert results[0]["status_code"] == 202


async def test_non_2xx_marks_failure(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    webhook = await _seed_webhook(db_session, test_workspace, test_user)
    transport = httpx.MockTransport(lambda r: httpx.Response(500, text="boom"))

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": "x"},
        transport=transport,
    )

    assert results[0]["delivered"] is False
    assert results[0]["status_code"] == 500
    await db_session.refresh(webhook)
    assert webhook.failure_count == 1


async def test_timeout_marks_failure(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    webhook = await _seed_webhook(db_session, test_workspace, test_user)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("slow", request=request)

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": "x"},
        transport=httpx.MockTransport(handler),
    )

    assert results[0]["delivered"] is False
    assert results[0]["status_code"] is None
    await db_session.refresh(webhook)
    assert webhook.failure_count == 1


async def test_connection_error_marks_failure(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    webhook = await _seed_webhook(db_session, test_workspace, test_user)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    emitter = EventEmitter(db_session)
    results = await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": "x"},
        transport=httpx.MockTransport(handler),
    )

    assert results[0]["delivered"] is False
    await db_session.refresh(webhook)
    assert webhook.failure_count == 1


async def test_fanout_signs_each_subscriber_with_its_own_secret(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """Fan-out delivers to every subscriber, each signed with its own secret."""
    await _seed_webhook(
        db_session, test_workspace, test_user, url="https://a.example/hook", secret="secret-a"
    )
    await _seed_webhook(
        db_session, test_workspace, test_user, url="https://b.example/hook", secret="secret-b"
    )
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen[str(request.url)] = request.headers["X-Webhook-Signature-256"]
        return httpx.Response(200)

    emitter = EventEmitter(db_session)
    await emitter.emit(
        workspace_id=test_workspace.id,
        event="card.created",
        payload={"card_id": "x"},
        transport=httpx.MockTransport(handler),
    )

    assert set(seen) == {"https://a.example/hook", "https://b.example/hook"}
    # Same body, different secret → different signature. Proves per-webhook
    # signing (not one shared signature blasted to all subscribers).
    assert seen["https://a.example/hook"] != seen["https://b.example/hook"]
