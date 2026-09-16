# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Board config flags — additive `loop_configured` / `has_definition` on BoardRead.

RED phase for sub-fix A1 of BP-005: the seeded happy path logs red 404s because
the frontend probes GET /loop and GET /definitions on never-configured boards.
The 404 contract is load-bearing (the Go runner inspects the body) and STAYS;
instead board reads gain flags so the frontend can skip requests that would 404.

Pinned contract:
  - `loop_configured: bool` — derives from Board.loop_config IS NOT NULL;
    present on EVERY BoardRead/BoardDetailRead response.
  - `has_definition: bool | None` — tri-state, mirrors the `card_count`
    pattern: computed on the list and detail endpoints, None elsewhere
    (e.g. create) where it isn't computed.
"""

from httpx import AsyncClient

from app.models.kanban.board import Board
from app.models.workspace import Workspace


BASE_URL = "/api/workspaces/default/boards"

MINIMAL_LOOP_PUT_BODY: dict = {}  # canonicalized to full defaults by the PUT

DEFINITION_PUT_BODY = {
    "scope": "Build the MVP",
    "content": {"tech_stack": ["Python"]},
}


async def test_board_detail_flags_unconfigured(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.get(f"{BASE_URL}/{test_board.id}")
    assert response.status_code == 200
    data = response.json()
    assert data["loop_configured"] is False
    assert data["has_definition"] is False


async def test_board_detail_flags_configured(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    put_loop = await client.put(
        f"{BASE_URL}/{test_board.id}/loop", json=MINIMAL_LOOP_PUT_BODY
    )
    assert put_loop.status_code in (200, 201), put_loop.text
    put_definition = await client.put(
        f"{BASE_URL}/{test_board.id}/definitions", json=DEFINITION_PUT_BODY
    )
    assert put_definition.status_code == 200, put_definition.text

    response = await client.get(f"{BASE_URL}/{test_board.id}")
    assert response.status_code == 200
    data = response.json()
    assert data["loop_configured"] is True
    assert data["has_definition"] is True


async def test_board_list_flags(
    client: AsyncClient, test_workspace: Workspace
):
    configured = await client.post(BASE_URL, json={"name": "Configured Board"})
    plain = await client.post(BASE_URL, json={"name": "Plain Board"})
    assert configured.status_code == 201 and plain.status_code == 201
    configured_id = configured.json()["id"]

    put_loop = await client.put(
        f"{BASE_URL}/{configured_id}/loop", json=MINIMAL_LOOP_PUT_BODY
    )
    assert put_loop.status_code in (200, 201), put_loop.text
    put_definition = await client.put(
        f"{BASE_URL}/{configured_id}/definitions", json=DEFINITION_PUT_BODY
    )
    assert put_definition.status_code == 200, put_definition.text

    response = await client.get(BASE_URL)
    assert response.status_code == 200
    by_name = {b["name"]: b for b in response.json()}
    assert by_name["Configured Board"]["loop_configured"] is True
    assert by_name["Configured Board"]["has_definition"] is True
    assert by_name["Plain Board"]["loop_configured"] is False
    assert by_name["Plain Board"]["has_definition"] is False


async def test_create_board_flags_default(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(BASE_URL, json={"name": "Fresh Board"})
    assert response.status_code == 201, response.text
    data = response.json()
    assert data["loop_configured"] is False
    # Create flows through get_full_board, which stamps the tri-state flag —
    # pin False (not None) so a silent stamping regression is visible here.
    assert data["has_definition"] is False


async def test_get_loop_unconfigured_still_404(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Contract guard, co-located with the flags on purpose: the flags are the
    fix; the runner-facing 404 body for "never configured" must NOT change."""
    response = await client.get(f"{BASE_URL}/{test_board.id}/loop")
    assert response.status_code == 404, response.text
    assert response.json().get("error_code") == "not_found", response.text
