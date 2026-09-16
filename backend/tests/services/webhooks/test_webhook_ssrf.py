# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""SSRF guard on webhook registration.

A webhook URL is fetched server-side on every matching event, so an
attacker who can register one gains a server-side request primitive.
Registration must reject non-https schemes and any host that resolves to
a loopback / private / link-local / reserved address (e.g. the cloud
metadata endpoint 169.254.169.254).
"""

import socket

import pytest

from app.exceptions import BadRequestError
from app.models.user import User
from app.models.webhooks.webhook import WebhookEvent
from app.models.workspace import Workspace
from app.schemas.webhooks.webhook import WebhookCreate, WebhookUpdate
from app.services.webhooks.webhook import WebhookService


def _create(url: str) -> WebhookCreate:
    return WebhookCreate(
        url=url,
        events=[WebhookEvent.card_created],
        secret="secret",
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/",  # cloud metadata
        "http://127.0.0.1/hook",  # loopback literal
        "http://localhost/hook",  # loopback hostname
        "http://10.1.2.3/hook",  # private A
        "http://192.168.0.5/hook",  # private C
        "http://[::1]/hook",  # loopback v6
        "ftp://example.com/hook",  # non-http(s) scheme
        "https:///nohost",  # missing host
    ],
)
async def test_create_webhook_rejects_ssrf_targets(
    db_session, test_user: User, test_workspace: Workspace, url: str
):
    service = WebhookService(db_session)
    with pytest.raises(BadRequestError):
        await service.create(test_workspace.id, test_user.id, _create(url))


async def test_create_webhook_rejects_plain_http_public_host(
    db_session, test_user: User, test_workspace: Workspace, monkeypatch
):
    # A public host over plain http is still rejected outside development.
    monkeypatch.setattr(
        "app.services.webhooks.url_guard.settings.ENV", "production"
    )
    monkeypatch.setattr(
        "app.services.webhooks.url_guard.socket.getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, None, None, "", ("93.184.216.34", 0))],
    )
    service = WebhookService(db_session)
    with pytest.raises(BadRequestError):
        await service.create(
            test_workspace.id, test_user.id, _create("http://example.com/hook")
        )


async def test_create_webhook_accepts_public_https(
    db_session, test_user: User, test_workspace: Workspace, monkeypatch
):
    monkeypatch.setattr(
        "app.services.webhooks.url_guard.socket.getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, None, None, "", ("93.184.216.34", 0))],
    )
    service = WebhookService(db_session)
    webhook = await service.create(
        test_workspace.id, test_user.id, _create("https://example.com/hook")
    )
    assert webhook.url == "https://example.com/hook"


async def test_update_webhook_rejects_ssrf_target(
    db_session, test_user: User, test_workspace: Workspace, monkeypatch
):
    # Stub only the example.com lookup; a literal IP host (the metadata
    # address) must resolve to itself so the guard still sees it.
    def _resolve(host, *a, **k):
        addr = "93.184.216.34" if host == "example.com" else host
        return [(socket.AF_INET, None, None, "", (addr, 0))]

    monkeypatch.setattr(
        "app.services.webhooks.url_guard.socket.getaddrinfo", _resolve
    )
    service = WebhookService(db_session)
    webhook = await service.create(
        test_workspace.id, test_user.id, _create("https://example.com/hook")
    )

    with pytest.raises(BadRequestError):
        await service.update(
            webhook.id,
            test_workspace.id,
            WebhookUpdate(url="http://169.254.169.254/latest/meta-data/"),
        )
