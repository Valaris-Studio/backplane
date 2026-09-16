# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest


@pytest.mark.asyncio
async def test_documentation_index_and_bounded_versioned_read(client):
    response = await client.get(
        "/api/documentation", params={"locale": "es", "limit": 2}
    )
    assert response.status_code == 200
    index = response.json()
    assert index["total"] >= 55
    assert len(index["sections"]) == 2
    assert "markdown" not in index["sections"][0]
    slug = index["sections"][0]["slug"]
    response = await client.get(
        f"/api/documentation/{slug}",
        params={"locale": "es", "version": index["version"], "limit": 100},
    )
    assert response.status_code == 200
    read = response.json()
    assert len(read["markdown"]) == 100
    assert read["next_offset"] == 100
    assert read["version"] == index["version"]
    assert read["locale"] == "es"
    assert (
        await client.get(f"/api/documentation/{slug}", params={"version": "stale"})
    ).status_code == 409
    assert (await client.get("/api/documentation/missing")).status_code == 404
    assert (
        await client.get("/api/documentation", params={"locale": "xx"})
    ).status_code == 422
    assert (
        await client.get("/api/documentation", params={"limit": 1000})
    ).status_code == 422


@pytest.mark.asyncio
async def test_documentation_preserves_authentication(client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "ENV", "production")
    from app.core.auth import get_current_user

    client._transport.app.dependency_overrides.pop(get_current_user)
    assert (await client.get("/api/documentation")).status_code in (401, 403)


@pytest.mark.asyncio
async def test_missing_artifact_fails_explicitly_without_bundled_fallback(
    client, monkeypatch
):
    from app.repositories.product_documentation import ProductDocumentationRepository

    def missing():
        raise FileNotFoundError("internal path must not leak")

    monkeypatch.setattr(ProductDocumentationRepository, "read_catalog", missing)
    response = await client.get("/api/documentation")
    assert response.status_code == 503
    assert "internal path" not in response.text
