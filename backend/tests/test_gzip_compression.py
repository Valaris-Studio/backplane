# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest
from fastapi.responses import JSONResponse, PlainTextResponse
from httpx import ASGITransport, AsyncClient

from app.main import create_app


def _app_with_probe_routes():
    """Real app (full middleware stack) plus two throwaway routes: one large,
    one tiny. Routes added post-build still traverse the existing middleware."""
    app = create_app()

    @app.get("/_probe/large")
    async def _large():
        # Comfortably over GZipMiddleware's minimum_size=1024 and highly
        # compressible so the encoded body is unambiguously smaller.
        return JSONResponse({"items": ["x" * 100 for _ in range(200)]})

    @app.get("/_probe/tiny")
    async def _tiny():
        return PlainTextResponse("ok")

    return app


@pytest.mark.asyncio
async def test_large_response_is_gzip_encoded_when_accepted():
    app = _app_with_probe_routes()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get(
            "/_probe/large", headers={"accept-encoding": "gzip"}
        )

    assert response.status_code == 200
    assert response.headers.get("content-encoding") == "gzip"


@pytest.mark.asyncio
async def test_tiny_response_is_not_gzip_encoded():
    app = _app_with_probe_routes()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get(
            "/_probe/tiny", headers={"accept-encoding": "gzip"}
        )

    assert response.status_code == 200
    assert response.headers.get("content-encoding") != "gzip"


@pytest.mark.asyncio
async def test_no_gzip_when_client_does_not_accept_it():
    app = _app_with_probe_routes()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get(
            "/_probe/large", headers={"accept-encoding": "identity"}
        )

    assert response.status_code == 200
    assert response.headers.get("content-encoding") != "gzip"


@pytest.mark.asyncio
async def test_security_headers_survive_gzip_compression():
    """GZip must not strip the security headers applied by the inner
    SecurityHeadersMiddleware on a compressed response."""
    app = _app_with_probe_routes()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get(
            "/_probe/large", headers={"accept-encoding": "gzip"}
        )

    assert response.headers.get("content-encoding") == "gzip"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert "default-src 'none'" in response.headers["content-security-policy"]
