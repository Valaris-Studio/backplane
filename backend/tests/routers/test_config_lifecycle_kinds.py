# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Integration test for GET /api/config/lifecycle-kinds (LIFECYCLE-1 A.1)."""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from app.services.agents.lifecycle_kinds import KIND_DOCS, LIFECYCLE_KINDS


@pytest.mark.asyncio
async def test_get_lifecycle_kinds_returns_full_registry(client: AsyncClient):
    response = await client.get("/api/config/lifecycle-kinds")
    assert response.status_code == 200, response.text

    payload = response.json()
    assert "kinds" in payload, f"expected `kinds` envelope, got {payload!r}"

    kinds = payload["kinds"]
    assert set(kinds.keys()) == set(LIFECYCLE_KINDS.keys()), (
        f"endpoint kinds {sorted(kinds)} != source {sorted(LIFECYCLE_KINDS)}"
    )

    for name, schema in kinds.items():
        assert schema["name"] == name
        assert isinstance(schema["params_schema"], dict)
        assert isinstance(schema["produces_decision"], bool)
        assert isinstance(schema["terminal"], bool)


@pytest.mark.asyncio
async def test_get_lifecycle_kinds_returns_docs_for_every_kind(client: AsyncClient):
    """Every kind carries operator-facing knowledge so the editor can explain
    what each step does — no kind may ship undocumented (the completeness gate).
    """
    response = await client.get("/api/config/lifecycle-kinds")
    assert response.status_code == 200, response.text

    payload = response.json()
    assert "docs" in payload, f"expected `docs` envelope, got {payload!r}"

    docs = payload["docs"]
    assert set(docs.keys()) == set(LIFECYCLE_KINDS.keys()), (
        f"docs cover {sorted(docs)} but registry has {sorted(LIFECYCLE_KINDS)}"
    )

    for name, doc in docs.items():
        assert doc["summary"].strip(), f"{name}: empty summary"
        assert doc["when_to_use"].strip(), f"{name}: empty when_to_use"
        # gotcha is optional (only where a real trap exists) but must be a string.
        assert isinstance(doc.get("gotcha", ""), str)


def test_kind_docs_cover_every_registered_kind():
    """Unit-level guard mirroring the endpoint test: KIND_DOCS and
    LIFECYCLE_KINDS never drift. Adding a kind without a doc fails here.
    """
    assert set(KIND_DOCS.keys()) == set(LIFECYCLE_KINDS.keys()), (
        f"KIND_DOCS {sorted(KIND_DOCS)} != LIFECYCLE_KINDS {sorted(LIFECYCLE_KINDS)}"
    )
