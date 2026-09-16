# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Short-id prefix resolution across the MUTATING card tools + get_note.

`get_card` has accepted a UUID prefix since card b9739710, but every mutating
card tool interpolated the raw id into a strict `uuid.UUID` route, so a prefix
422'd before any handler ran. These tests pin the shared MCP-layer resolver:
a fragment shorter than a full UUID is resolved through the board's `/resolve`
endpoint first, then the strict route is called with the full id.

A FULL uuid must skip resolution entirely — asserted by call count, because an
extra round-trip per mutation is the cost this whole change exists to avoid.
"""
from __future__ import annotations

import json

import pytest

FULL = "aaaaaaaa-0000-4000-8000-000000000001"
PREFIX = "aaaaaaaa"


@pytest.fixture
def resolving_client(mock_client):
    """A client whose /resolve GET returns the full-UUID card."""
    mock_client.get.return_value = {"id": FULL, "title": "Resolved"}
    return mock_client


def _resolve_path(board: str = "b1") -> str:
    return f"/workspaces/test/boards/{board}/cards/resolve?prefix={PREFIX}"


@pytest.mark.anyio
async def test_update_card_resolves_prefix(resolving_client, ctx):
    from valaris_mcp.tools.cards import update_card

    resolving_client.patch.return_value = {"id": FULL}
    await update_card("test", "b1", PREFIX, title="New", ctx=ctx)

    resolving_client.get.assert_called_once_with(_resolve_path())
    assert resolving_client.patch.call_args[0][0] == (
        f"/workspaces/test/boards/b1/cards/{FULL}"
    )


@pytest.mark.anyio
async def test_update_card_full_uuid_skips_resolution(mock_client, ctx):
    from valaris_mcp.tools.cards import update_card

    mock_client.patch.return_value = {"id": FULL}
    await update_card("test", "b1", FULL, title="New", ctx=ctx)

    mock_client.get.assert_not_called()
    assert mock_client.patch.call_args[0][0] == (
        f"/workspaces/test/boards/b1/cards/{FULL}"
    )


@pytest.mark.anyio
async def test_move_card_resolves_prefix(resolving_client, ctx):
    from valaris_mcp.tools.cards import move_card

    resolving_client.patch.return_value = {"id": FULL}
    await move_card("test", "b1", PREFIX, "col2", 512.0, ctx=ctx)

    resolving_client.get.assert_called_once_with(_resolve_path())
    resolving_client.patch.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{FULL}/move",
        {"column_id": "col2", "position": 512.0},
    )


@pytest.mark.anyio
async def test_move_card_omits_position_when_not_given(mock_client, ctx):
    """A claim-style column move should not force the agent to invent a position."""
    from valaris_mcp.tools.cards import move_card

    mock_client.patch.return_value = {"id": FULL}
    await move_card("test", "b1", FULL, "col2", ctx=ctx)

    mock_client.patch.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{FULL}/move",
        {"column_id": "col2"},
    )


@pytest.mark.anyio
async def test_delete_card_resolves_prefix(resolving_client, ctx):
    from valaris_mcp.tools.cards import delete_card

    await delete_card("test", "b1", PREFIX, ctx=ctx)

    resolving_client.get.assert_called_once_with(_resolve_path())
    resolving_client.delete.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{FULL}"
    )


@pytest.mark.anyio
async def test_add_card_participant_resolves_prefix(resolving_client, ctx):
    from valaris_mcp.tools.cards import add_card_participant

    resolving_client.post.return_value = {"id": FULL}
    await add_card_participant("test", "b1", PREFIX, "u1", ctx=ctx)

    resolving_client.get.assert_called_once_with(_resolve_path())
    assert resolving_client.post.call_args[0][0] == (
        f"/workspaces/test/boards/b1/cards/{FULL}/participants"
    )


@pytest.mark.anyio
async def test_remove_card_participant_resolves_prefix(resolving_client, ctx):
    from valaris_mcp.tools.cards import remove_card_participant

    await remove_card_participant("test", "b1", PREFIX, "u1", ctx=ctx)

    resolving_client.get.assert_called_once_with(_resolve_path())
    resolving_client.delete.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{FULL}/participants/u1"
    )


@pytest.mark.anyio
async def test_ambiguous_prefix_error_propagates_unchanged(mock_client, ctx):
    """The backend's candidate-listing 409 is the useful message — don't swallow it."""
    import httpx

    from valaris_mcp.tools.cards import update_card

    response = httpx.Response(
        409,
        json={"detail": "Prefix 'aaaaaaaa' is ambiguous; matches 2 cards: ..."},
        request=httpx.Request("GET", "http://test/resolve"),
    )
    mock_client.get.side_effect = httpx.HTTPStatusError(
        "409", request=response.request, response=response
    )
    result = await update_card("test", "b1", PREFIX, title="New", ctx=ctx)

    assert "ambiguous" in result
    mock_client.patch.assert_not_called()


# -- card_dependencies tools --------------------------------------------------
#
# These interpolate card ids into the same strict `uuid.UUID` routes the card
# tools use, but the module never imported the resolver — so a prefix that
# worked on get_card 422'd on get_card_dependency_status. Fifteen consecutive
# loop iterations hit that asymmetry (card 157ddc02).

DEP_FULL = "cccccccc-0000-4000-8000-000000000003"
DEP_PREFIX = "cccccccc"


@pytest.mark.anyio
async def test_get_card_dependency_status_resolves_prefix(mock_client, ctx):
    from valaris_mcp.tools.card_dependencies import get_card_dependency_status

    mock_client.get.side_effect = [
        {"id": FULL},
        {"depends_on": [], "blocks": []},
    ]
    await get_card_dependency_status("test", "b1", PREFIX, ctx=ctx)

    assert mock_client.get.call_args_list[0][0][0] == _resolve_path()
    assert mock_client.get.call_args_list[1][0][0] == (
        f"/workspaces/test/boards/b1/cards/{FULL}/dependencies"
    )


@pytest.mark.anyio
async def test_get_card_dependency_status_full_uuid_skips_resolution(mock_client, ctx):
    from valaris_mcp.tools.card_dependencies import get_card_dependency_status

    mock_client.get.return_value = {"depends_on": [], "blocks": []}
    await get_card_dependency_status("test", "b1", FULL, ctx=ctx)

    mock_client.get.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{FULL}/dependencies"
    )


@pytest.mark.anyio
async def test_get_card_dependency_status_reports_the_resolved_id(mock_client, ctx):
    """The echoed card_id must be the full UUID, not the prefix the caller sent."""
    from valaris_mcp.tools.card_dependencies import get_card_dependency_status

    mock_client.get.side_effect = [
        {"id": FULL},
        {"depends_on": [], "blocks": []},
    ]
    result = json.loads(await get_card_dependency_status("test", "b1", PREFIX, ctx=ctx))

    assert result["card_id"] == FULL


@pytest.mark.anyio
async def test_list_card_dependencies_resolves_prefix(resolving_client, ctx):
    from valaris_mcp.tools.card_dependencies import list_card_dependencies

    await list_card_dependencies("test", "b1", PREFIX, ctx=ctx)

    assert resolving_client.get.call_args_list[0][0][0] == _resolve_path()
    assert resolving_client.get.call_args_list[1][0][0] == (
        f"/workspaces/test/boards/b1/cards/{FULL}/dependencies"
    )


@pytest.mark.anyio
async def test_get_card_verdict_resolves_prefix(resolving_client, ctx):
    from valaris_mcp.tools.card_dependencies import get_card_verdict

    await get_card_verdict("test", "b1", PREFIX, ctx=ctx)

    assert resolving_client.get.call_args_list[0][0][0] == _resolve_path()
    assert resolving_client.get.call_args_list[1][0][0] == (
        f"/workspaces/test/boards/b1/cards/{FULL}/verdict"
    )


@pytest.mark.anyio
async def test_add_card_dependency_resolves_both_ends(mock_client, ctx):
    """Both ends are card identities — a prefix must work on either side."""
    from valaris_mcp.tools.card_dependencies import add_card_dependency

    mock_client.get.side_effect = [{"id": FULL}, {"id": DEP_FULL}]
    mock_client.post.return_value = {"id": "edge"}
    await add_card_dependency("test", "b1", PREFIX, DEP_PREFIX, ctx=ctx)

    mock_client.post.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{FULL}/dependencies",
        {"depends_on_card_id": DEP_FULL},
    )


@pytest.mark.anyio
async def test_remove_card_dependency_resolves_both_ends(mock_client, ctx):
    from valaris_mcp.tools.card_dependencies import remove_card_dependency

    mock_client.get.side_effect = [{"id": FULL}, {"id": DEP_FULL}]
    await remove_card_dependency("test", "b1", PREFIX, DEP_PREFIX, ctx=ctx)

    mock_client.delete.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{FULL}/dependencies/{DEP_FULL}"
    )


@pytest.mark.anyio
async def test_bulk_set_card_dependencies_resolves_every_prerequisite(mock_client, ctx):
    from valaris_mcp.tools.card_dependencies import bulk_set_card_dependencies

    mock_client.get.side_effect = [{"id": FULL}, {"id": DEP_FULL}]
    mock_client.put.return_value = {"depends_on": []}
    # Mixed list: a prefix resolves, a full UUID passes through untouched.
    await bulk_set_card_dependencies("test", "b1", PREFIX, [DEP_PREFIX, FULL], ctx=ctx)

    mock_client.put.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{FULL}/dependencies",
        {"depends_on_card_ids": [DEP_FULL, FULL]},
    )


@pytest.mark.anyio
async def test_bulk_set_empty_list_clears_without_resolving(mock_client, ctx):
    """An empty set is the documented 'clear my deps' call — no resolve hops."""
    from valaris_mcp.tools.card_dependencies import bulk_set_card_dependencies

    mock_client.put.return_value = {"depends_on": []}
    await bulk_set_card_dependencies("test", "b1", FULL, [], ctx=ctx)

    mock_client.get.assert_not_called()
    mock_client.put.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{FULL}/dependencies",
        {"depends_on_card_ids": []},
    )


@pytest.mark.anyio
async def test_dependency_ambiguous_prefix_error_propagates_unchanged(mock_client, ctx):
    import httpx

    from valaris_mcp.tools.card_dependencies import get_card_dependency_status

    response = httpx.Response(
        409,
        json={"detail": "Prefix 'aaaaaaaa' is ambiguous; matches 2 cards: ..."},
        request=httpx.Request("GET", "http://test/resolve"),
    )
    mock_client.get.side_effect = httpx.HTTPStatusError(
        "409", request=response.request, response=response
    )
    result = await get_card_dependency_status("test", "b1", PREFIX, ctx=ctx)

    assert "ambiguous" in result


NOTE_FULL = "bbbbbbbb-0000-4000-8000-000000000002"
NOTE_PREFIX = "bbbbbbbb"


@pytest.mark.anyio
async def test_get_note_resolves_prefix_on_board(mock_client, ctx):
    from valaris_mcp.tools.notes import get_note

    mock_client.get.side_effect = [
        {"id": NOTE_FULL},
        {"id": NOTE_FULL, "title": "Run log"},
    ]
    result = json.loads(
        await get_note("test", NOTE_PREFIX, board_id="b1", format="markdown", ctx=ctx)
    )

    assert mock_client.get.call_args_list[0][0][0] == (
        f"/workspaces/test/boards/b1/notes/resolve?prefix={NOTE_PREFIX}"
    )
    assert mock_client.get.call_args_list[1][0][0] == (
        f"/workspaces/test/boards/b1/notes/{NOTE_FULL}?format=markdown"
    )
    assert result["title"] == "Run log"


@pytest.mark.anyio
async def test_get_note_resolves_prefix_at_workspace_scope(mock_client, ctx):
    from valaris_mcp.tools.notes import get_note

    mock_client.get.side_effect = [{"id": NOTE_FULL}, {"id": NOTE_FULL}]
    await get_note("test", NOTE_PREFIX, ctx=ctx)

    assert mock_client.get.call_args_list[0][0][0] == (
        f"/workspaces/test/notes/resolve?prefix={NOTE_PREFIX}"
    )
    assert mock_client.get.call_args_list[1][0][0] == (
        f"/workspaces/test/notes/{NOTE_FULL}"
    )


@pytest.mark.anyio
async def test_get_note_full_uuid_skips_resolution(mock_client, ctx):
    from valaris_mcp.tools.notes import get_note

    mock_client.get.return_value = {"id": NOTE_FULL}
    await get_note("test", NOTE_FULL, board_id="b1", ctx=ctx)

    mock_client.get.assert_called_once_with(
        f"/workspaces/test/boards/b1/notes/{NOTE_FULL}"
    )
