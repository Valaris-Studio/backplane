# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Client IP resolution against a spoofed X-Forwarded-For, per deployment topology.

Every Google hop APPENDS to whatever X-Forwarded-For the caller sent, so the
leftmost entries are attacker-chosen. Each topology below prepends forged hops
and asserts the resolved IP is the one Google observed.
"""

import logging
from types import SimpleNamespace

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.datastructures import Headers

from app.config import Settings
from app.config import settings as app_settings
from app.core.auth import PROXY_SECRET_HEADER, resolve_client_ip
from app.core.client_ip import EDGE_FORWARDED_FOR_HEADER, EDGE_SECRET_HEADER
from app.core.rate_limit import (
    LOGIN_LIMIT,
    PAIRING_POLL_LIMIT,
    PAIRING_POLL_PATH,
    PAIRING_START_LIMIT,
    PAIRING_START_PATH,
    UNAUTHENTICATED_LIMIT,
    RateLimitMiddleware,
)

CLIENT = "203.0.113.7"
FORGED = "198.51.100.66"
LB_VIP = "192.0.2.10"
CLOUD_RUN_PEER = "169.254.1.1"
FRONTEND_EGRESS = "34.0.2.3"
SOCKET_PEER = "10.0.0.1"
EDGE_SECRET = "edge-s3cret"


def _request(
    forwarded_for: list[str] | None = None,
    extra: dict[str, str] | None = None,
    peer: str | None = SOCKET_PEER,
    method: str = "GET",
    path: str = "/api/health",
):
    raw = [(b"x-forwarded-for", value.encode()) for value in forwarded_for or []]
    raw += [(k.lower().encode(), v.encode()) for k, v in (extra or {}).items()]
    return SimpleNamespace(
        headers=Headers(raw=raw),
        client=SimpleNamespace(host=peer) if peer else None,
        cookies={},
        method=method,
        url=SimpleNamespace(path=path),
    )


@pytest.fixture
def behind_iap(monkeypatch):
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "/projects/1/x/2")
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", False)
    monkeypatch.setattr(app_settings, "FORWARDED_TRUSTED_PROXIES", "")
    monkeypatch.setattr(app_settings, "EDGE_PROXY_SECRET", "")
    return monkeypatch


# ── (a) client → GFE → Cloud Run (public run.app) ──


def test_direct_run_app_takes_the_hop_google_appended(behind_iap):
    assert resolve_client_ip(_request([CLIENT])) == CLIENT
    assert resolve_client_ip(_request([f"{FORGED}, {CLIENT}"])) == CLIENT
    assert resolve_client_ip(_request([f"1.1.1.1, {FORGED}, {CLIENT}"])) == CLIENT


def test_direct_run_app_ignores_forged_trusted_proxy_hops(behind_iap):
    behind_iap.setattr(app_settings, "FORWARDED_TRUSTED_PROXIES", LB_VIP)
    forged_lb_chain = f"{FORGED}, {LB_VIP}, {CLIENT}"
    assert resolve_client_ip(_request([forged_lb_chain])) == CLIENT


def test_forged_xff_sent_as_separate_header_line_cannot_win(behind_iap):
    request = _request([FORGED, f"{FORGED}, {CLIENT}"])
    assert resolve_client_ip(request) == CLIENT


# ── (c) client → ALB → serverless NEG → Cloud Run ──


def test_load_balancer_path_peels_the_configured_lb_address(behind_iap):
    behind_iap.setattr(app_settings, "FORWARDED_TRUSTED_PROXIES", LB_VIP)
    assert resolve_client_ip(_request([f"{CLIENT}, {LB_VIP}"])) == CLIENT
    assert resolve_client_ip(_request([f"{FORGED}, {CLIENT}, {LB_VIP}"])) == CLIENT


def test_load_balancer_path_ignores_forged_lb_hops_left_of_the_client(behind_iap):
    behind_iap.setattr(app_settings, "FORWARDED_TRUSTED_PROXIES", LB_VIP)
    chain = f"{LB_VIP}, {FORGED}, {LB_VIP}, {CLIENT}, {LB_VIP}"
    assert resolve_client_ip(_request([chain])) == CLIENT


def test_load_balancer_path_without_trusted_proxies_collapses_never_spoofs(
    behind_iap,
):
    chain = f"{FORGED}, {CLIENT}, {LB_VIP}"
    assert resolve_client_ip(_request([chain])) == LB_VIP


def test_trusted_proxies_accept_cidr_ranges(behind_iap):
    behind_iap.setattr(
        app_settings, "FORWARDED_TRUSTED_PROXIES", f"{LB_VIP}, 35.191.0.0/16"
    )
    chain = f"{FORGED}, {CLIENT}, {LB_VIP}, 35.191.8.9"
    assert resolve_client_ip(_request([chain])) == CLIENT


# ── (b) client → ALB → nginx (Cloud Run) → public run.app backend ──


def _via_nginx(edge_secret: str | None, forged: str = FORGED):
    # nginx forwards $proxy_add_x_forwarded_for in both headers; the backend's
    # own GFE then appends the frontend's egress address to X-Forwarded-For only.
    nginx_chain = f"{forged}, {CLIENT}, {LB_VIP}, {CLOUD_RUN_PEER}"
    extra = {EDGE_FORWARDED_FOR_HEADER: nginx_chain}
    if edge_secret is not None:
        extra[EDGE_SECRET_HEADER] = edge_secret
    return _request([f"{nginx_chain}, {FRONTEND_EGRESS}"], extra=extra)


@pytest.fixture
def nginx_edge(behind_iap):
    behind_iap.setattr(
        app_settings, "FORWARDED_TRUSTED_PROXIES", f"{LB_VIP}, 169.254.0.0/16"
    )
    behind_iap.setattr(app_settings, "EDGE_PROXY_SECRET", EDGE_SECRET)
    return behind_iap


def test_nginx_path_reads_the_authenticated_edge_chain(nginx_edge):
    assert resolve_client_ip(_via_nginx(EDGE_SECRET)) == CLIENT
    assert resolve_client_ip(_via_nginx(EDGE_SECRET, forged=LB_VIP)) == CLIENT


def test_edge_chain_with_wrong_or_missing_secret_is_ignored(nginx_edge):
    assert resolve_client_ip(_via_nginx("guess")) == FRONTEND_EGRESS
    assert resolve_client_ip(_via_nginx(None)) == FRONTEND_EGRESS


def test_forged_edge_header_on_direct_run_app_is_ignored(nginx_edge):
    forged = _request(
        [f"{FORGED}, {CLIENT}"],
        extra={EDGE_FORWARDED_FOR_HEADER: FORGED, EDGE_SECRET_HEADER: ""},
    )
    assert resolve_client_ip(forged) == CLIENT


def test_edge_chain_is_ignored_while_no_edge_secret_is_configured(behind_iap):
    request = _via_nginx("")
    assert resolve_client_ip(request) == FRONTEND_EGRESS


def test_edge_chain_serves_self_hosts_without_iap(monkeypatch):
    """Compose nginx is the edge: its appended peer is the real client."""
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "")
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", False)
    monkeypatch.setattr(app_settings, "FORWARDED_TRUSTED_PROXIES", "")
    monkeypatch.setattr(app_settings, "EDGE_PROXY_SECRET", EDGE_SECRET)
    request = _request(
        extra={
            EDGE_FORWARDED_FOR_HEADER: f"{FORGED}, {CLIENT}",
            EDGE_SECRET_HEADER: EDGE_SECRET,
        },
        peer="172.18.0.5",
    )
    assert resolve_client_ip(request) == CLIENT


# ── (d) dev / local and no-verifier deployments ──


def test_without_a_verifier_xff_is_never_read(monkeypatch):
    monkeypatch.setattr(app_settings, "ENV", "development")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "")
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", False)
    monkeypatch.setattr(app_settings, "EDGE_PROXY_SECRET", "")
    assert resolve_client_ip(_request([f"{FORGED}, {CLIENT}"])) == SOCKET_PEER
    assert resolve_client_ip(_request()) == SOCKET_PEER


def test_trusted_proxy_mode_takes_the_hop_its_proxy_appended(monkeypatch):
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "")
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", True)
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_SECRET", "s3cret")
    monkeypatch.setattr(app_settings, "FORWARDED_TRUSTED_PROXIES", "")
    monkeypatch.setattr(app_settings, "EDGE_PROXY_SECRET", "")
    request = _request([f"{FORGED}, {CLIENT}"], extra={PROXY_SECRET_HEADER: "s3cret"})
    assert resolve_client_ip(request) == CLIENT


# ── missing / malformed ──


@pytest.mark.parametrize(
    "forwarded_for",
    [
        [],
        [""],
        ["  ,  "],
        [f"{CLIENT}, garbage"],
        [f"{CLIENT},"],
        [f"{CLIENT}:443"],
        [f"{FORGED}, unknown"],
        ["999.1.1.1"],
    ],
)
def test_missing_or_malformed_xff_falls_back_to_the_socket_peer(
    behind_iap, forwarded_for
):
    assert resolve_client_ip(_request(forwarded_for)) == SOCKET_PEER


def test_malformed_hop_left_of_the_client_does_not_matter(behind_iap):
    assert resolve_client_ip(_request([f"<script>, {CLIENT}"])) == CLIENT


def test_malformed_edge_chain_falls_back_to_the_forwarded_chain(nginx_edge):
    request = _request(
        [f"{FORGED}, {CLIENT}"],
        extra={EDGE_FORWARDED_FOR_HEADER: "nonsense", EDGE_SECRET_HEADER: EDGE_SECRET},
    )
    assert resolve_client_ip(request) == CLIENT


def test_ipv6_hops_are_normalized(behind_iap):
    request = _request([f"{FORGED}, 2001:DB8::0:1"])
    assert resolve_client_ip(request) == "2001:db8::1"


def test_no_peer_and_no_xff_is_unknown(behind_iap):
    assert resolve_client_ip(_request(peer=None)) == "unknown"


def test_invalid_trusted_proxy_entry_fails_settings_load():
    with pytest.raises(ValueError, match="FORWARDED_TRUSTED_PROXIES"):
        Settings(FORWARDED_TRUSTED_PROXIES="192.0.2.10, not-an-ip")


# ── rate-limit bucket keying ──


@pytest.mark.parametrize(
    ("method", "path", "bucket", "limit"),
    [
        ("POST", "/api/auth/login", "login", LOGIN_LIMIT),
        ("POST", PAIRING_START_PATH, "pair-start", PAIRING_START_LIMIT),
        ("POST", PAIRING_POLL_PATH, "pair-poll", PAIRING_POLL_LIMIT),
        ("GET", "/api/health", "ip", UNAUTHENTICATED_LIMIT),
    ],
)
def test_rotating_forged_hops_cannot_mint_fresh_buckets(
    behind_iap, method, path, bucket, limit
):
    behind_iap.setattr(app_settings, "COMPANION_ENABLED", True)
    limiter = RateLimitMiddleware(app=lambda scope, receive, send: None)
    keys = set()
    for forged in ("198.51.100.1", "198.51.100.2", LB_VIP):
        request = _request([f"{forged}, {CLIENT}"], method=method, path=path)
        key, request_limit = limiter._get_client_key(request)
        assert request_limit == limit
        keys.add(key)
    assert keys == {f"{bucket}:{CLIENT}"}


def test_distinct_clients_still_get_distinct_buckets(behind_iap):
    limiter = RateLimitMiddleware(app=lambda scope, receive, send: None)
    first, _ = limiter._get_client_key(
        _request([CLIENT], method="POST", path="/api/auth/login")
    )
    second, _ = limiter._get_client_key(
        _request(["203.0.113.8"], method="POST", path="/api/auth/login")
    )
    assert first != second


# ── WebSocket audit IP ──


@pytest_asyncio.fixture
async def ws_session_factory(db_engine, monkeypatch):
    import app.routers.events as events_module

    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(events_module, "async_session", factory)
    return factory


@pytest.mark.asyncio
async def test_ws_rejection_logs_the_google_appended_hop(
    behind_iap, ws_session_factory, caplog
):
    from app.routers.events import _authenticate_ws

    websocket = SimpleNamespace(
        headers=Headers(raw=[(b"x-forwarded-for", f"{FORGED}, {CLIENT}".encode())]),
        client=SimpleNamespace(host=SOCKET_PEER),
        cookies={},
        query_params={},
    )
    with caplog.at_level(logging.WARNING):
        user, _ = await _authenticate_ws(websocket)
    assert user is None
    assert f"ip={CLIENT}" in caplog.text
    assert FORGED not in caplog.text
