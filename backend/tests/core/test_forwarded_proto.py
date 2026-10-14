# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Behind Cloud Run, TLS ends at Google's front end and the container sees
plain http; anything built from the request URL (redirect Locations) must
carry the scheme the edge reports, never downgrade to http://.

Only the scheme is taken from forwarded headers. The client address stays the
socket peer: X-Forwarded-For is client-settable, and trusting it here would let
anyone rotate the IP the rate limiter and audit log key on."""

import pytest
from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse
from httpx import ASGITransport, AsyncClient

from app.main import create_app


@pytest.fixture
async def probe_client():
    app = create_app()

    @app.get("/__probe/redirect")
    async def redirect(request: Request):
        return RedirectResponse(str(request.url_for("echo")))

    @app.get("/__probe/echo", name="echo")
    async def echo(request: Request):
        return JSONResponse(
            {"scheme": request.url.scheme, "client": request.client.host}
        )

    async with AsyncClient(
        transport=ASGITransport(app), base_url="http://test"
    ) as client:
        yield client


async def test_redirect_honours_forwarded_https(probe_client):
    response = await probe_client.get(
        "/__probe/redirect", headers={"X-Forwarded-Proto": "https"}
    )
    assert response.status_code == 307
    assert response.headers["location"] == "https://test/__probe/echo"


async def test_redirect_keeps_the_socket_scheme_without_a_forwarded_proto(probe_client):
    response = await probe_client.get("/__probe/redirect")
    assert response.headers["location"] == "http://test/__probe/echo"


@pytest.mark.parametrize(
    ("forwarded", "scheme"),
    [
        ("http, https", "https"),  # the hop nearest us appends last
        ("https, http", "http"),
        ("javascript", "http"),
        ("", "http"),
    ],
)
async def test_only_the_nearest_known_scheme_is_trusted(
    probe_client, forwarded, scheme
):
    response = await probe_client.get(
        "/__probe/echo", headers={"X-Forwarded-Proto": forwarded}
    )
    assert response.json()["scheme"] == scheme


async def test_forwarded_for_never_rewrites_the_client_address(probe_client):
    response = await probe_client.get(
        "/__probe/echo",
        headers={"X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.9"},
    )
    assert response.json()["client"] == "127.0.0.1"
