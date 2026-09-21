# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import httpx

import pytest

# Toy ids like "c1" are now PREFIXES to the card/note tools (they resolve
# through /resolve). Path-shape assertions therefore use full UUIDs.
CARD_UUID = "aaaaaaaa-0000-4000-8000-00000000000c"
NOTE_UUID = "bbbbbbbb-0000-4000-8000-000000000001"


# -- Workspaces ---------------------------------------------------------------


@pytest.mark.anyio
async def test_list_workspaces(mock_client, ctx):
    from valaris_mcp.tools.workspaces import list_workspaces

    mock_client.get.return_value = [{"slug": "test"}]
    result = json.loads(await list_workspaces(ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces")
    assert result["total"] == 1


@pytest.mark.anyio
async def test_list_workspaces_empty_hint(mock_client, ctx):
    from valaris_mcp.tools.workspaces import list_workspaces

    mock_client.get.return_value = []
    result = json.loads(await list_workspaces(ctx=ctx))
    assert result["total"] == 0
    assert "_hint" in result


@pytest.mark.anyio
async def test_get_workspace(mock_client, ctx):
    from valaris_mcp.tools.workspaces import get_workspace

    mock_client.get.return_value = {"slug": "test", "members": []}
    result = json.loads(await get_workspace("test", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/test")
    assert result["slug"] == "test"


@pytest.mark.anyio
async def test_get_workspace_summary(mock_client, ctx):
    from valaris_mcp.tools.workspaces import get_workspace_summary

    mock_client.get.return_value = {"board_count": 3, "card_count": 10}
    result = json.loads(await get_workspace_summary("test", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/test/summary")
    assert result["board_count"] == 3


@pytest.mark.anyio
async def test_create_workspace_new(mock_client, ctx):
    from valaris_mcp.tools.workspaces import create_workspace

    import httpx

    resp = httpx.Response(404, request=httpx.Request("GET", "http://test"))
    mock_client.get.side_effect = httpx.HTTPStatusError(
        "Not Found", request=resp.request, response=resp
    )
    mock_client.post.return_value = {"slug": "my-ws"}
    result = json.loads(await create_workspace("My WS", ctx=ctx))
    mock_client.post.assert_called_once_with("/workspaces", {"name": "My WS", "slug": "my-ws"})
    assert result["slug"] == "my-ws"


@pytest.mark.anyio
async def test_create_workspace_duplicate(mock_client, ctx):
    from valaris_mcp.tools.workspaces import create_workspace

    mock_client.get.return_value = {"slug": "existing"}
    result = json.loads(await create_workspace("Existing", slug="existing", ctx=ctx))
    assert "error" in result
    mock_client.post.assert_not_called()


@pytest.mark.anyio
async def test_create_workspace_with_explicit_slug(mock_client, ctx):
    from valaris_mcp.tools.workspaces import create_workspace

    import httpx

    resp = httpx.Response(403, request=httpx.Request("GET", "http://test"))
    mock_client.get.side_effect = httpx.HTTPStatusError(
        "Forbidden", request=resp.request, response=resp
    )
    mock_client.post.return_value = {"slug": "custom-slug"}
    result = json.loads(await create_workspace("My WS", slug="custom-slug", ctx=ctx))
    mock_client.post.assert_called_once_with("/workspaces", {"name": "My WS", "slug": "custom-slug"})
    assert result["slug"] == "custom-slug"


@pytest.mark.anyio
async def test_create_workspace_collision_409_surfaces_clean_error(mock_client, ctx):
    """Card 3dfd1412: the backend 409s a non-member's slug collision. The
    stranger flow here is GET 403 (not visible) then POST 409 (slug taken):
    handle_api_errors must render it as the boolean-error payload with the
    backend's status and error_code — never a raised exception, and never
    the string-"error"+existing shape reserved for the member short-circuit."""
    from valaris_mcp.tools.workspaces import create_workspace

    import httpx

    get_resp = httpx.Response(403, request=httpx.Request("GET", "http://test"))
    mock_client.get.side_effect = httpx.HTTPStatusError(
        "Forbidden", request=get_resp.request, response=get_resp
    )
    post_resp = httpx.Response(
        409,
        request=httpx.Request("POST", "http://test"),
        json={
            "detail": "Workspace slug 'existing' is already taken",
            "error_code": "conflict",
            "error_params": {},
            "context": None,
        },
    )
    mock_client.post.side_effect = httpx.HTTPStatusError(
        "Conflict", request=post_resp.request, response=post_resp
    )

    result = json.loads(await create_workspace("Existing", slug="existing", ctx=ctx))

    assert result["error"] is True
    assert result["status"] == 409
    assert result["error_code"] == "conflict"
    assert "existing" not in result, "409 path must not carry workspace metadata"


@pytest.mark.anyio
async def test_add_workspace_member(mock_client, ctx):
    from valaris_mcp.tools.workspaces import add_workspace_member

    mock_client.post.return_value = {"user_id": "u1", "role": "admin"}
    result = json.loads(await add_workspace_member("test", "user@test.com", "admin", ctx=ctx))
    mock_client.post.assert_called_once_with(
        "/workspaces/test/members", {"email": "user@test.com", "role": "admin"}
    )
    assert result["role"] == "admin"


@pytest.mark.anyio
async def test_remove_workspace_member(mock_client, ctx):
    from valaris_mcp.tools.workspaces import remove_workspace_member

    result = await remove_workspace_member("test", "user-123", ctx=ctx)
    mock_client.delete.assert_called_once_with("/workspaces/test/members/user-123")
    assert "user-123" in result


# -- Boards -------------------------------------------------------------------


@pytest.mark.anyio
async def test_list_boards(mock_client, ctx):
    from valaris_mcp.tools.boards import list_boards

    mock_client.get.return_value = [{"id": "b1", "name": "Board"}]
    result = json.loads(await list_boards("test", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/test/boards")
    assert result["total"] == 1


@pytest.mark.anyio
async def test_list_boards_empty_hint(mock_client, ctx):
    from valaris_mcp.tools.boards import list_boards

    mock_client.get.return_value = []
    result = json.loads(await list_boards("test", ctx=ctx))
    assert result["total"] == 0
    assert "_hint" in result


@pytest.mark.anyio
async def test_get_board_with_columns(mock_client, ctx):
    from valaris_mcp.tools.boards import get_board

    mock_client.get.return_value = {
        "id": "b1",
        "columns": [
            {"id": "c1", "name": "Todo", "cards": [{"id": "card1"}, {"id": "card2"}]},
            {"id": "c2", "name": "Done", "cards": []},
        ],
    }
    result = json.loads(await get_board("test", "b1", ctx=ctx))
    assert result["columns"][0]["_card_count"] == 2
    assert result["columns"][1]["_card_count"] == 0


@pytest.mark.anyio
async def test_get_board_empty_hint(mock_client, ctx):
    from valaris_mcp.tools.boards import get_board

    mock_client.get.return_value = {"id": "b1", "columns": []}
    result = json.loads(await get_board("test", "b1", ctx=ctx))
    assert "_hint" in result
    assert "create_column" in result["_hint"]


@pytest.mark.anyio
async def test_get_board_summary_only(mock_client, ctx):
    from valaris_mcp.tools.boards import get_board

    mock_client.get.return_value = {
        "id": "b1",
        "columns": [
            {
                "id": "c1",
                "name": "Todo",
                "cards": [
                    {"id": "1", "priority": "high", "status": "open"},
                    {"id": "2", "priority": "high", "status": "closed"},
                ],
            },
        ],
    }
    result = json.loads(await get_board("test", "b1", summary_only=True, ctx=ctx))
    col = result["columns"][0]
    assert "cards" not in col
    assert col["card_count"] == 2
    assert col["priorities"]["high"] == 2
    assert col["statuses"]["open"] == 1


@pytest.mark.anyio
async def test_get_board_uses_board_path(mock_client, ctx):
    from valaris_mcp.tools.boards import get_board

    mock_client.get.return_value = {"id": "b1", "columns": []}
    await get_board("ws", "board-42", ctx=ctx)
    mock_client.get.assert_called_once_with("/workspaces/ws/boards/board-42")


@pytest.mark.anyio
async def test_get_board_titles_only_slims_cards(mock_client, ctx):
    # titles_only keeps the cards array but strips every card down to the
    # identity + triage fields an agent scans by — the heavy CardRead payload
    # (description, participants, derived presence/dependency fields) is dropped
    # so a large board doesn't blow the MCP token cap.
    from valaris_mcp.tools.boards import get_board

    mock_client.get.return_value = {
        "id": "b1",
        "columns": [
            {
                "id": "c1",
                "name": "Todo",
                "cards": [
                    {
                        "id": "1",
                        "title": "Build login",
                        "status": "open",
                        "priority": "high",
                        "card_type": "task",
                        "labels": ["auth"],
                        "column_id": "c1",
                        "description": "a" * 5000,
                        "participants": [{"user_id": "u1"}],
                        "agent_presence": "active",
                        "depends_on_count": 2,
                    },
                ],
            },
        ],
    }
    result = json.loads(await get_board("test", "b1", titles_only=True, ctx=ctx))
    card = result["columns"][0]["cards"][0]
    # Kept: identity + triage fields.
    assert card["id"] == "1"
    assert card["title"] == "Build login"
    assert card["status"] == "open"
    assert card["priority"] == "high"
    assert card["labels"] == ["auth"]
    # Dropped: the heavy/derived fields.
    assert "description" not in card
    assert "participants" not in card
    assert "agent_presence" not in card
    assert "depends_on_count" not in card
    # Count is still surfaced.
    assert result["columns"][0]["_card_count"] == 1


@pytest.mark.anyio
async def test_get_board_titles_only_and_summary_only_prefers_summary(mock_client, ctx):
    # summary_only is the most compact mode; if both are set it wins (cards are
    # dropped entirely), so titles_only must not resurrect a cards array.
    from valaris_mcp.tools.boards import get_board

    mock_client.get.return_value = {
        "id": "b1",
        "columns": [
            {
                "id": "c1",
                "name": "Todo",
                "cards": [{"id": "1", "title": "X", "priority": "low", "status": "open"}],
            },
        ],
    }
    result = json.loads(
        await get_board("test", "b1", summary_only=True, titles_only=True, ctx=ctx)
    )
    col = result["columns"][0]
    assert "cards" not in col
    assert col["card_count"] == 1


@pytest.mark.anyio
async def test_create_board(mock_client, ctx):
    from valaris_mcp.tools.boards import create_board

    mock_client.post.return_value = {"id": "b1", "name": "New"}
    result = json.loads(await create_board("test", "New", ctx=ctx))
    assert "_hint" in result
    mock_client.post.assert_called_once()


@pytest.mark.anyio
async def test_create_board_with_tags(mock_client, ctx):
    from valaris_mcp.tools.boards import create_board

    mock_client.post.return_value = {"id": "b1"}
    await create_board("test", "Board", tags=["v1", "mvp"], ctx=ctx)
    body = mock_client.post.call_args[0][1]
    assert body["tags"] == ["v1", "mvp"]


@pytest.mark.anyio
async def test_create_board_skip_default_columns(mock_client, ctx):
    from valaris_mcp.tools.boards import create_board

    mock_client.post.return_value = {"id": "b1"}
    await create_board("test", "Board", skip_default_columns=True, ctx=ctx)
    body = mock_client.post.call_args[0][1]
    assert body["skip_default_columns"] is True


@pytest.mark.anyio
async def test_create_board_default_columns_not_sent_by_default(mock_client, ctx):
    from valaris_mcp.tools.boards import create_board

    mock_client.post.return_value = {"id": "b1"}
    await create_board("test", "Board", ctx=ctx)
    body = mock_client.post.call_args[0][1]
    assert "skip_default_columns" not in body


@pytest.mark.anyio
async def test_update_board_filters_none(mock_client, ctx):
    from valaris_mcp.tools.boards import update_board

    mock_client.patch.return_value = {"id": "b1", "name": "Updated"}
    await update_board("test", "b1", name="Updated", ctx=ctx)
    mock_client.patch.assert_called_once_with("/workspaces/test/boards/b1", {"name": "Updated"})


@pytest.mark.anyio
async def test_update_board_multiple_fields(mock_client, ctx):
    from valaris_mcp.tools.boards import update_board

    mock_client.patch.return_value = {"id": "b1"}
    await update_board("test", "b1", name="X", description="Y", tags=["z"], ctx=ctx)
    body = mock_client.patch.call_args[0][1]
    assert body == {"name": "X", "description": "Y", "tags": ["z"]}


@pytest.mark.anyio
async def test_freeze_board(mock_client, ctx):
    from valaris_mcp.tools.boards import freeze_board

    mock_client.post.return_value = {"id": "b1", "is_frozen": True}
    result = json.loads(await freeze_board("test", "b1", ctx=ctx))
    mock_client.post.assert_called_once_with("/workspaces/test/boards/b1/freeze")
    assert result["is_frozen"] is True
    assert "_hint" in result


@pytest.mark.anyio
async def test_unfreeze_board(mock_client, ctx):
    from valaris_mcp.tools.boards import unfreeze_board

    mock_client.post.return_value = {"id": "b1", "is_frozen": False}
    result = json.loads(await unfreeze_board("test", "b1", ctx=ctx))
    mock_client.post.assert_called_once_with("/workspaces/test/boards/b1/unfreeze")
    assert result["is_frozen"] is False
    assert "_hint" in result


@pytest.mark.anyio
async def test_get_board_loop(mock_client, ctx):
    from valaris_mcp.tools.boards import get_board_loop

    mock_client.get.return_value = {
        "enabled": True,
        "loop_prompt": "iterate",
        "version": 3,
        "disabled_reason": None,
    }
    result = json.loads(await get_board_loop("test", "b1", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/test/boards/b1/loop", headers={"X-Backplane-Completion-Version": "1"})
    assert result["enabled"] is True
    assert result["version"] == 3


@pytest.mark.anyio
async def test_get_board_loop_not_configured(mock_client, ctx):
    """Backend 404 = "loop mode not configured" — must come back as a helpful
    error payload (handle_api_errors passthrough), never raise."""
    from valaris_mcp.tools.boards import get_board_loop

    import httpx

    resp = httpx.Response(
        404,
        json={"detail": "Loop mode not configured for this board", "error_code": "not_found"},
        request=httpx.Request("GET", "http://test"),
    )
    mock_client.get.side_effect = httpx.HTTPStatusError(
        "Not Found", request=resp.request, response=resp
    )
    result = json.loads(await get_board_loop("test", "b1", ctx=ctx))
    assert result["error"] is True
    assert result["status"] == 404
    assert "not configured" in result["message"]


@pytest.mark.anyio
async def test_set_board_loop_disable(mock_client, ctx):
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.patch.return_value = {
        "enabled": False,
        "disabled_reason": "objective complete",
        "version": 4,
    }
    result = json.loads(
        await set_board_loop("test", "b1", False, reason="objective complete", ctx=ctx)
    )
    mock_client.patch.assert_called_once_with(
        "/workspaces/test/boards/b1/loop/state",
        {"enabled": False, "reason": "objective complete"},
    )
    assert result["enabled"] is False
    assert "_hint" in result


@pytest.mark.anyio
async def test_set_board_loop_enable_default_empty_reason(mock_client, ctx):
    """reason defaults to "" and is ALWAYS sent — the backend PATCH shape is
    exactly {"enabled": bool, "reason": str}, never a missing key."""
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.patch.return_value = {"enabled": True, "disabled_reason": None, "version": 5}
    result = json.loads(await set_board_loop("test", "b1", True, ctx=ctx))
    mock_client.patch.assert_called_once_with(
        "/workspaces/test/boards/b1/loop/state",
        {"enabled": True, "reason": ""},
    )
    assert result["enabled"] is True


def test_set_board_loop_docstring_has_off_switch_instruction():
    """The docstring is the loop agent's contract: it must carry the exact
    off-switch instruction so loop-mode prompts can rely on it."""
    from valaris_mcp.tools.boards import set_board_loop

    doc = set_board_loop.__doc__ or ""
    assert (
        "When running in loop mode: call this with enabled=false and a "
        "concise reason when the objective is complete or you are blocked."
    ) in " ".join(doc.split())


# -- Columns ------------------------------------------------------------------


@pytest.mark.anyio
async def test_create_column(mock_client, ctx):
    from valaris_mcp.tools.columns import create_column

    mock_client.post.return_value = {"id": "col1", "name": "Backlog"}
    result = json.loads(await create_column("test", "b1", "Backlog", ctx=ctx))
    mock_client.post.assert_called_once_with(
        "/workspaces/test/boards/b1/columns", {"name": "Backlog"}
    )
    assert "_hint" in result


@pytest.mark.anyio
async def test_create_column_with_color(mock_client, ctx):
    from valaris_mcp.tools.columns import create_column

    mock_client.post.return_value = {"id": "col1"}
    await create_column("test", "b1", "Done", color="#00ff00", ctx=ctx)
    mock_client.post.assert_called_once_with(
        "/workspaces/test/boards/b1/columns", {"name": "Done", "color": "#00ff00"}
    )


@pytest.mark.anyio
async def test_update_column_filters_none(mock_client, ctx):
    from valaris_mcp.tools.columns import update_column

    mock_client.patch.return_value = {"id": "col1", "name": "Renamed"}
    await update_column("test", "b1", "col1", name="Renamed", ctx=ctx)
    mock_client.patch.assert_called_once_with(
        "/workspaces/test/boards/b1/columns/col1", {"name": "Renamed"}
    )


@pytest.mark.anyio
async def test_update_column_name_and_color(mock_client, ctx):
    from valaris_mcp.tools.columns import update_column

    mock_client.patch.return_value = {"id": "col1"}
    await update_column("test", "b1", "col1", name="X", color="#ff0000", ctx=ctx)
    mock_client.patch.assert_called_once_with(
        "/workspaces/test/boards/b1/columns/col1", {"name": "X", "color": "#ff0000"}
    )


@pytest.mark.anyio
async def test_update_column_sets_column_type(mock_client, ctx):
    from valaris_mcp.tools.columns import update_column

    mock_client.patch.return_value = {"id": "col1"}
    await update_column("test", "b1", "col1", column_type="review", ctx=ctx)
    mock_client.patch.assert_called_once_with(
        "/workspaces/test/boards/b1/columns/col1", {"column_type": "review"}
    )


@pytest.mark.anyio
async def test_update_column_clears_column_type_via_null_sentinel(mock_client, ctx):
    from valaris_mcp.tools.columns import update_column

    mock_client.patch.return_value = {"id": "col1", "column_type": None}
    # "null", "none", and "" all clear the type — runner-only invariant.
    for sentinel in ("null", "none", ""):
        mock_client.patch.reset_mock()
        await update_column("test", "b1", "col1", column_type=sentinel, ctx=ctx)
        mock_client.patch.assert_called_once_with(
            "/workspaces/test/boards/b1/columns/col1", {"column_type": None}
        )


@pytest.mark.anyio
async def test_delete_column(mock_client, ctx):
    from valaris_mcp.tools.columns import delete_column

    result = await delete_column("test", "b1", "col1", ctx=ctx)
    mock_client.delete.assert_called_once_with("/workspaces/test/boards/b1/columns/col1")
    assert "col1" in result


@pytest.mark.anyio
async def test_reorder_columns(mock_client, ctx):
    from valaris_mcp.tools.columns import reorder_columns

    mock_client.patch.return_value = {"status": "ok"}
    await reorder_columns("test", "b1", ["c2", "c1"], ctx=ctx)
    mock_client.patch.assert_called_once_with(
        "/workspaces/test/boards/b1/columns/reorder", {"column_ids": ["c2", "c1"]}
    )


# -- Cards --------------------------------------------------------------------


@pytest.mark.anyio
async def test_list_cards_with_counts(mock_client, ctx):
    from valaris_mcp.tools.cards import list_cards

    mock_client.get.return_value = {
        "columns": [
            {"id": "c1", "name": "Todo", "cards": [{"id": "1"}, {"id": "2"}]},
            {"id": "c2", "name": "Done", "cards": [{"id": "3"}]},
        ]
    }
    result = json.loads(await list_cards("test", "b1", ctx=ctx))
    assert result["total_cards"] == 3
    assert result["columns"][0]["card_count"] == 2
    assert result["columns"][1]["card_count"] == 1


@pytest.mark.anyio
async def test_list_cards_empty_hint(mock_client, ctx):
    from valaris_mcp.tools.cards import list_cards

    mock_client.get.return_value = {"columns": [{"id": "c1", "name": "Todo", "cards": []}]}
    result = json.loads(await list_cards("test", "b1", ctx=ctx))
    assert result["total_cards"] == 0
    assert "_hint" in result


@pytest.mark.anyio
async def test_list_cards_uses_board_path(mock_client, ctx):
    from valaris_mcp.tools.cards import list_cards

    mock_client.get.return_value = {"columns": []}
    await list_cards("ws", "b99", ctx=ctx)
    mock_client.get.assert_called_once_with("/workspaces/ws/boards/b99")


@pytest.mark.anyio
async def test_get_card(mock_client, ctx):
    from valaris_mcp.tools.cards import get_card

    # A full 36-char UUID takes the strict GET path (prefix resolution only
    # kicks in for shorter fragments — see test_get_card_prefix_resolves).
    # format=markdown so agents read faithful markdown descriptions, not the
    # canonical PM JSON the backend stores (editor P0-3).
    full = "aaaaaaaa-0000-4000-8000-000000000001"
    mock_client.get.return_value = {"id": full, "title": "Test"}
    result = json.loads(await get_card("test", "b1", full, ctx=ctx))
    mock_client.get.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{full}?format=markdown"
    )
    assert result["title"] == "Test"


@pytest.mark.anyio
async def test_create_card_minimal(mock_client, ctx):
    from valaris_mcp.tools.cards import create_card

    mock_client.post.return_value = {"id": "c1"}
    await create_card("test", "b1", "col1", "My Card", ctx=ctx)
    call_body = mock_client.post.call_args[0][1]
    assert call_body["title"] == "My Card"
    assert call_body["column_id"] == "col1"
    assert call_body["card_type"] == "task"
    assert call_body["priority"] == "none"
    assert "due_date" not in call_body
    assert "labels" not in call_body
    assert "status" not in call_body


@pytest.mark.anyio
async def test_create_card_full(mock_client, ctx):
    from valaris_mcp.tools.cards import create_card

    mock_client.post.return_value = {"id": "c1"}
    await create_card(
        "test", "b1", "col1", "Card",
        due_date="2026-04-01", labels=["urgent"], status="open", ctx=ctx,
    )
    call_body = mock_client.post.call_args[0][1]
    assert call_body["due_date"] == "2026-04-01"
    assert call_body["labels"] == ["urgent"]
    assert call_body["status"] == "open"


@pytest.mark.anyio
async def test_create_card_posts_to_correct_path(mock_client, ctx):
    from valaris_mcp.tools.cards import create_card

    mock_client.post.return_value = {"id": "c1"}
    await create_card("ws", "board-1", "col-1", "T", ctx=ctx)
    assert mock_client.post.call_args[0][0] == "/workspaces/ws/boards/board-1/cards"


@pytest.mark.anyio
async def test_create_card_with_git_repo_slug(mock_client, ctx):
    from valaris_mcp.tools.cards import create_card

    mock_client.post.return_value = {"id": "c1"}
    await create_card("test", "b1", "col1", "FE card", git_repo_slug="frontend", ctx=ctx)
    call_body = mock_client.post.call_args[0][1]
    assert call_body["git_repo_slug"] == "frontend"


@pytest.mark.anyio
async def test_create_card_omits_git_repo_slug_when_none(mock_client, ctx):
    from valaris_mcp.tools.cards import create_card

    mock_client.post.return_value = {"id": "c1"}
    await create_card("test", "b1", "col1", "plain", ctx=ctx)
    assert "git_repo_slug" not in mock_client.post.call_args[0][1]


@pytest.mark.anyio
async def test_update_card_with_git_repo_slug(mock_client, ctx):
    from valaris_mcp.tools.cards import update_card

    mock_client.patch.return_value = {"id": "c1"}
    await update_card("test", "b1", "c1", git_repo_slug="backend", ctx=ctx)
    assert mock_client.patch.call_args[0][1]["git_repo_slug"] == "backend"


@pytest.mark.anyio
async def test_update_card_with_pr_url_and_branch_name(mock_client, ctx):
    """Read-back, not just a 200: the silent-drop bug returned success either way.

    FastMCP discards kwargs the tool signature does not declare, so the PATCH
    went out without them and the response came back with both fields still
    null. Echoing the request body through the mock is what makes an assertion
    on the RETURNED card able to fail.
    """
    from valaris_mcp.tools.cards import update_card

    mock_client.patch.side_effect = lambda _path, body: {"id": "c1", **body}
    result = await update_card(
        "test",
        "b1",
        "c1",
        pr_url="https://github.com/example/project/pull/86",
        branch_name="loop2/mcp-update-card-pr-url",
        ctx=ctx,
    )

    sent = mock_client.patch.call_args[0][1]
    assert sent["pr_url"] == "https://github.com/example/project/pull/86"
    assert sent["branch_name"] == "loop2/mcp-update-card-pr-url"

    read_back = json.loads(result)
    assert read_back["pr_url"] == "https://github.com/example/project/pull/86"
    assert read_back["branch_name"] == "loop2/mcp-update-card-pr-url"


@pytest.mark.anyio
async def test_update_card_omits_pr_url_and_branch_name_when_none(mock_client, ctx):
    from valaris_mcp.tools.cards import update_card

    mock_client.patch.return_value = {"id": "c1"}
    await update_card("test", "b1", "c1", title="unrelated edit", ctx=ctx)
    sent = mock_client.patch.call_args[0][1]
    assert "pr_url" not in sent
    assert "branch_name" not in sent


@pytest.mark.anyio
async def test_update_card_filters_none(mock_client, ctx):
    from valaris_mcp.tools.cards import update_card

    mock_client.patch.return_value = {"id": CARD_UUID, "title": "New"}
    await update_card("test", "b1", CARD_UUID, title="New", ctx=ctx)
    mock_client.patch.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{CARD_UUID}", {"title": "New"}
    )


@pytest.mark.anyio
async def test_update_card_multiple_fields(mock_client, ctx):
    from valaris_mcp.tools.cards import update_card

    mock_client.patch.return_value = {"id": CARD_UUID}
    await update_card(
        "test", "b1", CARD_UUID, title="X", priority="high", labels=["a"], ctx=ctx
    )
    body = mock_client.patch.call_args[0][1]
    assert body == {"title": "X", "priority": "high", "labels": ["a"]}


STATUS_MAX_LENGTH = 255

# Verbatim shape of an agent closure status: sha, PR number, Spanish clause.
# The old 100-char cap could not hold it, so agents recorded closure in
# description prose instead and the structured field went unused.
REALISTIC_CLOSURE_STATUS = (
    "shipped 639c5468 (PR #96, self-improve-3) — log de iteraciones completo "
    "con paginación, filtros por outcome y búsqueda; gates verdes, sin reds "
    "conocidos, merge sin conflictos"
)


@pytest.mark.anyio
async def test_update_card_passes_through_realistic_closure_status(mock_client, ctx):
    """The tool must not truncate or reject what the backend now accepts."""
    from valaris_mcp.tools.cards import update_card

    assert 100 < len(REALISTIC_CLOSURE_STATUS) <= STATUS_MAX_LENGTH

    mock_client.patch.side_effect = lambda _path, body: {"id": CARD_UUID, **body}
    result = await update_card(
        "test", "b1", CARD_UUID, status=REALISTIC_CLOSURE_STATUS, ctx=ctx
    )

    assert mock_client.patch.call_args[0][1]["status"] == REALISTIC_CLOSURE_STATUS
    # Parsed, not substring-matched: the tool serializes with ensure_ascii, so
    # the accented characters come back \u-escaped in the raw JSON string.
    assert json.loads(result)["status"] == REALISTIC_CLOSURE_STATUS


def test_card_tool_docstrings_quote_the_backend_status_limit():
    """Docstrings are the agent's only view of the cap — pin them to the source.

    The number lives in three places (backend schema, two MCP docstrings, the
    mcp-reference docs data). Asserting the docstrings against a literal is
    what makes the next widen fail loudly here instead of silently telling
    agents a stale limit.
    """
    from valaris_mcp.tools.cards import create_card, update_card

    for tool in (create_card, update_card):
        assert f"Max {STATUS_MAX_LENGTH} characters" in tool.__doc__


@pytest.mark.anyio
async def test_delete_card(mock_client, ctx):
    from valaris_mcp.tools.cards import delete_card

    result = await delete_card("test", "b1", CARD_UUID, ctx=ctx)
    mock_client.delete.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{CARD_UUID}"
    )
    assert CARD_UUID in result


@pytest.mark.anyio
async def test_move_card(mock_client, ctx):
    from valaris_mcp.tools.cards import move_card

    mock_client.patch.return_value = {"id": CARD_UUID}
    await move_card("test", "b1", CARD_UUID, "col2", 512.0, ctx=ctx)
    mock_client.patch.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{CARD_UUID}/move",
        {"column_id": "col2", "position": 512.0},
    )


@pytest.mark.anyio
async def test_add_card_participant(mock_client, ctx):
    from valaris_mcp.tools.cards import add_card_participant

    mock_client.post.return_value = {"user_id": "u1", "role": "hero"}
    await add_card_participant("test", "b1", CARD_UUID, "u1", ctx=ctx)
    mock_client.post.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{CARD_UUID}/participants",
        {"user_id": "u1", "role": "hero"},
    )


@pytest.mark.anyio
async def test_add_card_participant_custom_role(mock_client, ctx):
    from valaris_mcp.tools.cards import add_card_participant

    mock_client.post.return_value = {"user_id": "u1", "role": "viewer"}
    await add_card_participant("test", "b1", "c1", "u1", role="viewer", ctx=ctx)
    body = mock_client.post.call_args[0][1]
    assert body["role"] == "viewer"


@pytest.mark.anyio
async def test_add_card_participant_with_pipeline_role(mock_client, ctx):
    from valaris_mcp.tools.cards import add_card_participant

    mock_client.post.return_value = {"user_id": "u1", "role": "hero"}
    await add_card_participant(
        "test", "b1", "c1", "u1", role="hero",
        pipeline_role="implementer", ctx=ctx,
    )
    body = mock_client.post.call_args[0][1]
    assert body["pipeline_role"] == "implementer"


@pytest.mark.anyio
async def test_add_card_participant_omits_pipeline_role_when_none(mock_client, ctx):
    """Back-compat: pipeline_role is not sent when caller doesn't pass it."""
    from valaris_mcp.tools.cards import add_card_participant

    mock_client.post.return_value = {"user_id": "u1", "role": "hero"}
    await add_card_participant("test", "b1", "c1", "u1", ctx=ctx)
    body = mock_client.post.call_args[0][1]
    assert "pipeline_role" not in body


@pytest.mark.anyio
async def test_remove_card_participant(mock_client, ctx):
    from valaris_mcp.tools.cards import remove_card_participant

    result = await remove_card_participant("test", "b1", CARD_UUID, "u1", ctx=ctx)
    mock_client.delete.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{CARD_UUID}/participants/u1"
    )
    assert "u1" in result


@pytest.mark.anyio
async def test_remove_card_participants_by_role(mock_client, ctx):
    from valaris_mcp.tools.cards import remove_card_participants_by_role

    result = await remove_card_participants_by_role(
        "test", "b1", "c1", "implementer", ctx=ctx,
    )
    mock_client.delete.assert_called_once_with(
        "/workspaces/test/boards/b1/cards/c1/participants/by-pipeline-role/implementer"
    )
    assert "implementer" in result


# -- Notes --------------------------------------------------------------------


@pytest.mark.anyio
async def test_list_notes_workspace(mock_client, ctx):
    from valaris_mcp.tools.notes import list_notes

    mock_client.request_raw.return_value = httpx.Response(200, json=[{"id": "n1"}], headers={"X-Total-Count": "1"})
    result = json.loads(await list_notes("test", ctx=ctx))
    assert result["notes"] == [{"id": "n1"}]
    mock_client.request_raw.assert_called_once_with("GET", "/workspaces/test/notes", params={"summary_only": "true", "limit": 25, "offset": 0})


@pytest.mark.anyio
async def test_list_notes_board(mock_client, ctx):
    from valaris_mcp.tools.notes import list_notes

    mock_client.request_raw.return_value = httpx.Response(200, json=[{"id": "n1"}], headers={"X-Total-Count": "1"})
    await list_notes("test", board_id="b1", ctx=ctx)
    mock_client.request_raw.assert_called_once_with("GET", "/workspaces/test/boards/b1/notes", params={"summary_only": "true", "limit": 25, "offset": 0})


@pytest.mark.anyio
async def test_create_note(mock_client, ctx):
    from valaris_mcp.tools.notes import create_note

    mock_client.post.return_value = {"id": "n1"}
    await create_note("test", "My Note", content="body", pinned=True, ctx=ctx)
    mock_client.post.assert_called_once_with(
        "/workspaces/test/notes",
        {"title": "My Note", "content": "body", "pinned": True, "kind": "user_note"},
    )


@pytest.mark.anyio
async def test_create_note_passes_kind_when_provided(mock_client, ctx):
    """LLM-driven flows need to write structural notes (plan, rework_brief,
    review_verdict). The MCP tool must forward kind verbatim to the backend
    which owns the closed-set validation."""
    from valaris_mcp.tools.notes import create_note

    mock_client.post.return_value = {"id": "n1"}
    await create_note("test", "Plan", content="body", kind="plan", ctx=ctx)
    body = mock_client.post.call_args[0][1]
    assert body["kind"] == "plan"


@pytest.mark.anyio
async def test_create_note_sends_default_kind_user_note(mock_client, ctx):
    """Locked decision: kind is ALWAYS on the wire, even when default.
    Keeps the contract explicit and prevents silent kind drift."""
    from valaris_mcp.tools.notes import create_note

    mock_client.post.return_value = {"id": "n1"}
    await create_note("test", "Note", ctx=ctx)
    body = mock_client.post.call_args[0][1]
    assert body["kind"] == "user_note"


@pytest.mark.anyio
async def test_create_note_accepts_other_closed_set_kinds(mock_client, ctx):
    from valaris_mcp.tools.notes import create_note

    mock_client.post.return_value = {"id": "n1"}
    for kind in ("review_verdict", "rework_brief"):
        mock_client.post.reset_mock()
        await create_note("test", "T", kind=kind, ctx=ctx)
        body = mock_client.post.call_args[0][1]
        assert body["kind"] == kind


def test_create_note_docstring_documents_markdown_contract():
    """The docstring is the contract agents read. If "markdown" disappears
    from it the harness-escape trap returns: agents fall back to ad-hoc
    JSON encoding and notes render as flat blobs."""
    from valaris_mcp.tools.notes import create_note, update_note

    for fn in (create_note, update_note):
        # FastMCP wraps the function; grab the underlying docstring.
        doc = (fn.fn.__doc__ if hasattr(fn, "fn") else fn.__doc__) or ""
        assert "markdown" in doc.lower(), f"{fn} docstring missing markdown contract"
        assert "ProseMirror" in doc, f"{fn} docstring missing ProseMirror contract"


@pytest.mark.anyio
async def test_create_note_passes_markdown_content_unchanged(mock_client, ctx):
    """MCP is a thin passthrough — backend owns normalization. The tool
    must not re-encode markdown into JSON or otherwise mangle it."""
    from valaris_mcp.tools.notes import create_note

    mock_client.post.return_value = {"id": "n1"}
    md = "# Heading\n\n- a\n- b"
    await create_note("test", "T", content=md, ctx=ctx)
    body = mock_client.post.call_args[0][1]
    assert body["content"] == md


@pytest.mark.anyio
async def test_create_note_board_scoped(mock_client, ctx):
    from valaris_mcp.tools.notes import create_note

    mock_client.post.return_value = {"id": "n1"}
    await create_note("test", "Note", board_id="b1", ctx=ctx)
    assert mock_client.post.call_args[0][0] == "/workspaces/test/boards/b1/notes"


@pytest.mark.anyio
async def test_update_note_filters_none(mock_client, ctx):
    from valaris_mcp.tools.notes import update_note

    mock_client.put.return_value = {"id": "n1", "title": "Updated"}
    await update_note("test", "n1", title="Updated", ctx=ctx)
    mock_client.put.assert_called_once_with("/workspaces/test/notes/n1", {"title": "Updated"})


@pytest.mark.anyio
async def test_update_note_multiple_fields(mock_client, ctx):
    from valaris_mcp.tools.notes import update_note

    mock_client.put.return_value = {"id": "n1"}
    await update_note("test", "n1", title="T", content="C", pinned=True, ctx=ctx)
    body = mock_client.put.call_args[0][1]
    assert body == {"title": "T", "content": "C", "pinned": True}


@pytest.mark.anyio
async def test_append_note_workspace_scoped(mock_client, ctx):
    from valaris_mcp.tools.notes import append_note

    mock_client.post.return_value = {"id": "n1"}
    await append_note("test", "n1", "## Session 5", ctx=ctx)
    mock_client.post.assert_called_once_with(
        "/workspaces/test/notes/n1/append", {"content": "## Session 5"}
    )


@pytest.mark.anyio
async def test_append_note_board_scoped(mock_client, ctx):
    from valaris_mcp.tools.notes import append_note

    mock_client.post.return_value = {"id": "n1"}
    await append_note("test", "n1", "entry", board_id="b1", ctx=ctx)
    assert mock_client.post.call_args[0][0] == "/workspaces/test/boards/b1/notes/n1/append"


@pytest.mark.anyio
async def test_append_note_sends_only_content(mock_client, ctx):
    """Append is content-only by contract — title/pinned stay untouched, which
    is the whole reason to reach for it over update_note."""
    from valaris_mcp.tools.notes import append_note

    mock_client.post.return_value = {"id": "n1"}
    await append_note("test", "n1", "entry", ctx=ctx)
    assert mock_client.post.call_args[0][1] == {"content": "entry"}


@pytest.mark.anyio
async def test_replace_note_section_workspace_scoped(mock_client, ctx):
    from valaris_mcp.tools.notes import replace_note_section

    mock_client.post.return_value = {"id": "n1"}
    await replace_note_section("test", "n1", "Cluster I", "Done.", ctx=ctx)
    mock_client.post.assert_called_once_with(
        "/workspaces/test/notes/n1/replace-section",
        {"anchor_heading": "Cluster I", "content": "Done."},
    )


@pytest.mark.anyio
async def test_replace_note_section_board_scoped(mock_client, ctx):
    from valaris_mcp.tools.notes import replace_note_section

    mock_client.post.return_value = {"id": "n1"}
    await replace_note_section("test", "n1", "Cluster I", "Done.", board_id="b1", ctx=ctx)
    assert (
        mock_client.post.call_args[0][0]
        == "/workspaces/test/boards/b1/notes/n1/replace-section"
    )


@pytest.mark.anyio
async def test_replace_note_section_defaults_content_to_empty(mock_client, ctx):
    """Omitting content clears the section — a legitimate intent here, unlike
    append_note where an empty payload means the caller lost it."""
    from valaris_mcp.tools.notes import replace_note_section

    mock_client.post.return_value = {"id": "n1"}
    await replace_note_section("test", "n1", "Cluster I", ctx=ctx)
    assert mock_client.post.call_args[0][1] == {"anchor_heading": "Cluster I", "content": ""}


@pytest.mark.anyio
async def test_delete_note(mock_client, ctx):
    from valaris_mcp.tools.notes import delete_note

    result = await delete_note("test", "n1", ctx=ctx)
    mock_client.delete.assert_called_once_with("/workspaces/test/notes/n1")
    assert "n1" in result


@pytest.mark.anyio
async def test_delete_note_board_scoped(mock_client, ctx):
    from valaris_mcp.tools.notes import delete_note

    await delete_note("test", "n1", board_id="b1", ctx=ctx)
    mock_client.delete.assert_called_once_with("/workspaces/test/boards/b1/notes/n1")


# -- Activity -----------------------------------------------------------------


@pytest.mark.anyio
async def test_list_activity_workspace(mock_client, ctx):
    from valaris_mcp.tools.activity import list_activity

    mock_client.get.return_value = [{"action": "created"}]
    await list_activity("test", ctx=ctx)
    mock_client.get.assert_called_once_with("/workspaces/test/history", limit=50)


@pytest.mark.anyio
async def test_list_activity_board_with_filters(mock_client, ctx):
    from valaris_mcp.tools.activity import list_activity

    mock_client.get.return_value = []
    await list_activity(
        "test", board_id="b1", limit=10, entity_type="card", action="created", ctx=ctx
    )
    mock_client.get.assert_called_once_with(
        "/workspaces/test/boards/b1/history",
        limit=10,
        entity_type="card",
        action="created",
    )


@pytest.mark.anyio
async def test_list_activity_with_search(mock_client, ctx):
    from valaris_mcp.tools.activity import list_activity

    mock_client.get.return_value = []
    await list_activity("test", search="deploy", ctx=ctx)
    mock_client.get.assert_called_once_with(
        "/workspaces/test/history", limit=50, search="deploy"
    )


# -- Definitions --------------------------------------------------------------


@pytest.mark.anyio
async def test_get_definition(mock_client, ctx):
    from valaris_mcp.tools.definitions import get_definition

    mock_client.get.return_value = {"scope": "MVP"}
    result = json.loads(await get_definition("test", "b1", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/test/boards/b1/definitions")
    assert result["scope"] == "MVP"


@pytest.mark.anyio
async def test_update_definition_scope(mock_client, ctx):
    from valaris_mcp.tools.definitions import update_definition

    mock_client.put.return_value = {"scope": "V2"}
    await update_definition("test", "b1", scope="V2", ctx=ctx)
    mock_client.put.assert_called_once_with(
        "/workspaces/test/boards/b1/definitions", {"scope": "V2"}
    )


@pytest.mark.anyio
async def test_update_definition_content(mock_client, ctx):
    from valaris_mcp.tools.definitions import update_definition

    mock_client.put.return_value = {"content": {"stack": "python"}}
    await update_definition("test", "b1", content={"stack": "python"}, ctx=ctx)
    body = mock_client.put.call_args[0][1]
    assert body == {"content": {"stack": "python"}}


@pytest.mark.anyio
async def test_update_definition_filters_none(mock_client, ctx):
    from valaris_mcp.tools.definitions import update_definition

    mock_client.put.return_value = {}
    await update_definition("test", "b1", ctx=ctx)
    mock_client.put.assert_called_once_with("/workspaces/test/boards/b1/definitions", {})


@pytest.mark.anyio
async def test_update_definition_structured_fields(mock_client, ctx):
    from valaris_mcp.tools.definitions import update_definition

    mock_client.put.return_value = {}
    await update_definition(
        "test",
        "b1",
        scope="Build X",
        objectives=[{"text": "Ship MVP", "priority": "high"}],
        exclusions=["no mobile"],
        tech_stack=["python", "react"],
        coding_standards="black + ruff",
        ctx=ctx,
    )
    body = mock_client.put.call_args[0][1]
    assert body["scope"] == "Build X"
    assert body["content"]["objectives"] == [{"text": "Ship MVP", "priority": "high"}]
    assert body["content"]["exclusions"] == ["no mobile"]
    assert body["content"]["tech_stack"] == ["python", "react"]
    assert body["content"]["coding_standards"] == "black + ruff"


@pytest.mark.anyio
async def test_update_definition_explicit_over_content(mock_client, ctx):
    from valaris_mcp.tools.definitions import update_definition

    mock_client.put.return_value = {}
    await update_definition(
        "test",
        "b1",
        content={"tech_stack": ["go"], "x_custom": 1},
        tech_stack=["python"],
        ctx=ctx,
    )
    body = mock_client.put.call_args[0][1]
    # explicit param wins; unknown passthrough key preserved
    assert body["content"]["tech_stack"] == ["python"]
    assert body["content"]["x_custom"] == 1


@pytest.mark.anyio
async def test_update_definition_no_content_key_when_only_scope(mock_client, ctx):
    from valaris_mcp.tools.definitions import update_definition

    mock_client.put.return_value = {}
    await update_definition("test", "b1", scope="only scope", ctx=ctx)
    body = mock_client.put.call_args[0][1]
    assert body == {"scope": "only scope"}


@pytest.mark.anyio
async def test_create_board_with_definition_issues_put(mock_client, ctx):
    from valaris_mcp.tools.boards import create_board

    mock_client.post.return_value = {"id": "b1", "name": "New"}
    mock_client.put.return_value = {"scope": "Build X"}
    await create_board(
        "test",
        "New",
        scope="Build X",
        objectives=[{"text": "Ship"}],
        ctx=ctx,
    )
    mock_client.put.assert_called_once()
    path, body = mock_client.put.call_args[0]
    assert path == "/workspaces/test/boards/b1/definitions"
    assert body["scope"] == "Build X"
    assert body["content"]["objectives"] == [{"text": "Ship"}]


@pytest.mark.anyio
async def test_create_board_without_definition_no_put(mock_client, ctx):
    from valaris_mcp.tools.boards import create_board

    mock_client.post.return_value = {"id": "b1", "name": "New"}
    await create_board("test", "New", ctx=ctx)
    mock_client.put.assert_not_called()


@pytest.mark.anyio
async def test_create_board_with_definition_idempotent_existing_board(mock_client, ctx):
    from valaris_mcp.tools.boards import create_board

    # backend returns the existing board (idempotent create) — still gets the definition
    mock_client.post.return_value = {"id": "existing", "name": "New", "_existing": True}
    mock_client.put.return_value = {"scope": "S"}
    result = json.loads(await create_board("test", "New", scope="S", ctx=ctx))
    mock_client.put.assert_called_once()
    assert mock_client.put.call_args[0][0] == "/workspaces/test/boards/existing/definitions"
    assert "definition" in result


# -- Resources ----------------------------------------------------------------


@pytest.mark.anyio
async def test_list_resources_workspace(mock_client, ctx):
    from valaris_mcp.tools.resources import list_resources

    mock_client.get.return_value = []
    await list_resources("test", ctx=ctx)
    mock_client.get.assert_called_once_with("/workspaces/test/resources")


@pytest.mark.anyio
async def test_list_resources_board(mock_client, ctx):
    from valaris_mcp.tools.resources import list_resources

    mock_client.get.return_value = []
    await list_resources("test", board_id="b1", ctx=ctx)
    mock_client.get.assert_called_once_with("/workspaces/test/boards/b1/resources")


@pytest.mark.anyio
async def test_list_resources_with_filters(mock_client, ctx):
    from valaris_mcp.tools.resources import list_resources

    mock_client.get.return_value = []
    await list_resources("test", board_id="b1", search="readme", resource_type="file", ctx=ctx)
    mock_client.get.assert_called_once_with(
        "/workspaces/test/boards/b1/resources", q="readme", resource_type="file"
    )


@pytest.mark.anyio
async def test_list_resources_with_parent_and_tag(mock_client, ctx):
    from valaris_mcp.tools.resources import list_resources

    mock_client.get.return_value = []
    await list_resources("test", parent_id="p1", tag="docs", ctx=ctx)
    mock_client.get.assert_called_once_with(
        "/workspaces/test/resources", parent_id="p1", tag="docs"
    )


@pytest.mark.anyio
async def test_create_resource(mock_client, ctx):
    from valaris_mcp.tools.resources import create_resource

    mock_client.post.return_value = {"id": "r1"}
    await create_resource("test", "docs", resource_type="folder", ctx=ctx)
    mock_client.post.assert_called_once_with(
        "/workspaces/test/resources", {"name": "docs", "resource_type": "folder"}
    )


@pytest.mark.anyio
async def test_create_resource_with_all_fields(mock_client, ctx):
    from valaris_mcp.tools.resources import create_resource

    mock_client.post.return_value = {"id": "r1"}
    await create_resource(
        "test", "readme.md",
        parent_id="p1", description="Top-level readme", metadata={"size": 1024},
        board_id="b1", ctx=ctx,
    )
    body = mock_client.post.call_args[0][1]
    assert body["parent_id"] == "p1"
    assert body["description"] == "Top-level readme"
    assert body["metadata"] == {"size": 1024}
    assert mock_client.post.call_args[0][0] == "/workspaces/test/boards/b1/resources"


@pytest.mark.anyio
async def test_update_resource(mock_client, ctx):
    from valaris_mcp.tools.resources import update_resource

    mock_client.put.return_value = {"id": "r1", "name": "new"}
    await update_resource("test", "r1", name="new", ctx=ctx)
    mock_client.put.assert_called_once_with("/workspaces/test/resources/r1", {"name": "new"})


@pytest.mark.anyio
async def test_update_resource_filters_none(mock_client, ctx):
    from valaris_mcp.tools.resources import update_resource

    mock_client.put.return_value = {"id": "r1"}
    await update_resource("test", "r1", name="x", ctx=ctx)
    body = mock_client.put.call_args[0][1]
    assert body == {"name": "x"}
    assert "description" not in body
    assert "metadata" not in body


@pytest.mark.anyio
async def test_delete_resource(mock_client, ctx):
    from valaris_mcp.tools.resources import delete_resource

    result = await delete_resource("test", "r1", ctx=ctx)
    mock_client.delete.assert_called_once_with("/workspaces/test/resources/r1")
    assert "r1" in result


@pytest.mark.anyio
async def test_delete_resource_board_scoped(mock_client, ctx):
    from valaris_mcp.tools.resources import delete_resource

    await delete_resource("test", "r1", board_id="b1", ctx=ctx)
    mock_client.delete.assert_called_once_with("/workspaces/test/boards/b1/resources/r1")


# -- Channels -----------------------------------------------------------------


@pytest.mark.anyio
async def test_list_channels(mock_client, ctx):
    from valaris_mcp.tools.channels import list_channels

    mock_client.get.return_value = []
    await list_channels("test", ctx=ctx)
    mock_client.get.assert_called_once_with("/workspaces/test/channels")


@pytest.mark.anyio
async def test_create_channel(mock_client, ctx):
    from valaris_mcp.tools.channels import create_channel

    mock_client.post.return_value = {"id": "ch1"}
    await create_channel("test", "Support", "email", "help@test.com", ctx=ctx)
    body = mock_client.post.call_args[0][1]
    assert body["name"] == "Support"
    assert body["channel_type"] == "email"
    assert body["contact_value"] == "help@test.com"
    assert body["description"] == ""


@pytest.mark.anyio
async def test_create_channel_with_metadata(mock_client, ctx):
    from valaris_mcp.tools.channels import create_channel

    mock_client.post.return_value = {"id": "ch1"}
    await create_channel(
        "test", "Slack", "slack", "#general",
        metadata_json={"webhook": "https://hooks.slack.com/x"}, ctx=ctx,
    )
    body = mock_client.post.call_args[0][1]
    assert body["metadata_json"] == {"webhook": "https://hooks.slack.com/x"}


@pytest.mark.anyio
async def test_update_channel_uses_put(mock_client, ctx):
    from valaris_mcp.tools.channels import update_channel

    mock_client.put.return_value = {"id": "ch1"}
    await update_channel("test", "ch1", name="Renamed", ctx=ctx)
    mock_client.put.assert_called_once()
    assert mock_client.patch.call_count == 0


@pytest.mark.anyio
async def test_update_channel_filters_none(mock_client, ctx):
    from valaris_mcp.tools.channels import update_channel

    mock_client.put.return_value = {"id": "ch1"}
    await update_channel("test", "ch1", name="X", ctx=ctx)
    body = mock_client.put.call_args[0][1]
    assert body == {"name": "X"}
    assert "channel_type" not in body


@pytest.mark.anyio
async def test_delete_channel(mock_client, ctx):
    from valaris_mcp.tools.channels import delete_channel

    result = await delete_channel("test", "ch1", ctx=ctx)
    mock_client.delete.assert_called_once_with("/workspaces/test/channels/ch1")
    assert "ch1" in result


# -- Git Repos ----------------------------------------------------------------


@pytest.mark.anyio
async def test_list_git_repos(mock_client, ctx):
    from valaris_mcp.tools.git_repos import list_git_repos

    mock_client.get.return_value = []
    await list_git_repos("test", "b1", ctx=ctx)
    mock_client.get.assert_called_once_with("/workspaces/test/boards/b1/git-repos")


@pytest.mark.anyio
async def test_create_git_repo(mock_client, ctx):
    from valaris_mcp.tools.git_repos import create_git_repo

    mock_client.post.return_value = {"id": "g1"}
    await create_git_repo("test", "b1", "My Repo", "https://github.com/o/r", "github", ctx=ctx)
    body = mock_client.post.call_args[0][1]
    assert body["provider"] == "github"
    assert body["default_branch"] == "main"
    assert body["name"] == "My Repo"
    assert body["url"] == "https://github.com/o/r"


@pytest.mark.anyio
async def test_create_git_repo_custom_branch(mock_client, ctx):
    from valaris_mcp.tools.git_repos import create_git_repo

    mock_client.post.return_value = {"id": "g1"}
    await create_git_repo(
        "test", "b1", "Repo", "https://gitlab.com/o/r", "gitlab",
        default_branch="develop", ctx=ctx,
    )
    body = mock_client.post.call_args[0][1]
    assert body["default_branch"] == "develop"
    assert body["provider"] == "gitlab"


@pytest.mark.anyio
async def test_create_git_repo_with_slug(mock_client, ctx):
    from valaris_mcp.tools.git_repos import create_git_repo

    mock_client.post.return_value = {"id": "g1"}
    await create_git_repo(
        "test", "b1", "Frontend", "https://github.com/o/r", "github",
        slug="frontend", ctx=ctx,
    )
    body = mock_client.post.call_args[0][1]
    assert body["slug"] == "frontend"


@pytest.mark.anyio
async def test_create_git_repo_omits_slug_when_none(mock_client, ctx):
    from valaris_mcp.tools.git_repos import create_git_repo

    mock_client.post.return_value = {"id": "g1"}
    await create_git_repo("test", "b1", "Repo", "https://github.com/o/r", "github", ctx=ctx)
    assert "slug" not in mock_client.post.call_args[0][1]


@pytest.mark.anyio
async def test_update_git_repo_with_slug(mock_client, ctx):
    from valaris_mcp.tools.git_repos import update_git_repo

    mock_client.put.return_value = {"id": "g1"}
    await update_git_repo("test", "b1", "g1", slug="backend", ctx=ctx)
    assert mock_client.put.call_args[0][1]["slug"] == "backend"


@pytest.mark.anyio
async def test_update_git_repo_uses_put(mock_client, ctx):
    from valaris_mcp.tools.git_repos import update_git_repo

    mock_client.put.return_value = {"id": "g1"}
    await update_git_repo("test", "b1", "g1", name="Renamed", ctx=ctx)
    mock_client.put.assert_called_once()
    assert mock_client.patch.call_count == 0


@pytest.mark.anyio
async def test_update_git_repo_filters_none(mock_client, ctx):
    from valaris_mcp.tools.git_repos import update_git_repo

    mock_client.put.return_value = {"id": "g1"}
    await update_git_repo("test", "b1", "g1", name="X", ctx=ctx)
    body = mock_client.put.call_args[0][1]
    assert body == {"name": "X"}


@pytest.mark.anyio
async def test_delete_git_repo(mock_client, ctx):
    from valaris_mcp.tools.git_repos import delete_git_repo

    result = await delete_git_repo("test", "b1", "g1", ctx=ctx)
    mock_client.delete.assert_called_once_with("/workspaces/test/boards/b1/git-repos/g1")
    assert "g1" in result


# -- Context ------------------------------------------------------------------


@pytest.mark.anyio
async def test_get_project_context(mock_client, ctx):
    from valaris_mcp.tools.context import get_project_context

    mock_client.get.return_value = {
        "board": {"id": "b1", "name": "Test"},
        "definition": None,
        "notes": [],
        "git_repos": [],
        "recent_activity": [],
    }
    result = json.loads(await get_project_context("ws", "b1", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/ws/boards/b1/context")
    assert result["board"]["name"] == "Test"


@pytest.mark.anyio
async def test_get_project_context_caps_notes(mock_client, ctx):
    # The board summary is small, but a board with many (long) notes can push
    # the composite past the MCP token cap. Cap the notes list and tell the
    # agent how many were dropped + how to fetch them.
    from valaris_mcp.tools.context import MAX_NOTES, get_project_context

    notes = [
        {"id": str(i), "title": f"Note {i}", "pinned": False} for i in range(MAX_NOTES + 7)
    ]
    mock_client.get.return_value = {
        "board": {"id": "b1", "name": "Test", "columns": []},
        "definition": None,
        "notes": notes,
        "git_repos": [],
        "recent_activity": [],
    }
    result = json.loads(await get_project_context("ws", "b1", ctx=ctx))
    assert len(result["notes"]) == MAX_NOTES
    assert result["_notes_truncated"] == 7
    assert "list_notes" in result["_hint"]


@pytest.mark.anyio
async def test_get_project_context_caps_activity(mock_client, ctx):
    from valaris_mcp.tools.context import MAX_ACTIVITY, get_project_context

    activity = [
        {"id": str(i), "action": "moved", "summary": "x"} for i in range(MAX_ACTIVITY + 4)
    ]
    mock_client.get.return_value = {
        "board": {"id": "b1", "name": "Test", "columns": []},
        "definition": None,
        "notes": [],
        "git_repos": [],
        "recent_activity": activity,
    }
    result = json.loads(await get_project_context("ws", "b1", ctx=ctx))
    assert len(result["recent_activity"]) == MAX_ACTIVITY
    assert result["_activity_truncated"] == 4


@pytest.mark.anyio
async def test_get_project_context_truncates_long_definition(mock_client, ctx):
    # A bloated definition.content (coding_standards / scope free-text) is the
    # other heavy section — truncate oversized string leaves so the briefing
    # stays bounded, with a marker pointing at get_definition for the full text.
    from valaris_mcp.tools.context import MAX_DEFINITION_FIELD_CHARS, get_project_context

    mock_client.get.return_value = {
        "board": {"id": "b1", "name": "Test", "columns": []},
        "definition": {
            "scope": "ok",
            "content": {"coding_standards": "x" * (MAX_DEFINITION_FIELD_CHARS + 500)},
            "updated_at": "2026-06-15T00:00:00",
        },
        "notes": [],
        "git_repos": [],
        "recent_activity": [],
    }
    result = json.loads(await get_project_context("ws", "b1", ctx=ctx))
    standards = result["definition"]["content"]["coding_standards"]
    assert len(standards) <= MAX_DEFINITION_FIELD_CHARS + len("… [truncated]")
    assert standards.endswith("… [truncated]")
    assert result["_definition_truncated"] is True
    assert "get_definition" in result["_hint"]


@pytest.mark.anyio
async def test_get_project_context_caps_total_definition_size(mock_client, ctx):
    # Bloat spread across MANY small string leaves (no single field over the
    # per-field limit) must still be bounded by the total-size backstop, so the
    # definition section can't overflow regardless of field shape.
    from valaris_mcp.tools.context import MAX_DEFINITION_TOTAL_CHARS, get_project_context

    fat_list = ["entry " + "y" * 200 for _ in range(200)]  # ~40KB across a list
    mock_client.get.return_value = {
        "board": {"id": "b1", "name": "Test", "columns": []},
        "definition": {
            "scope": "ok",
            "content": {"decisions": fat_list},
            "updated_at": "2026-06-15T00:00:00",
        },
        "notes": [],
        "git_repos": [],
        "recent_activity": [],
    }
    result = json.loads(await get_project_context("ws", "b1", ctx=ctx))
    defn_chars = len(json.dumps(result["definition"], default=str))
    assert defn_chars <= MAX_DEFINITION_TOTAL_CHARS + 200  # marker slack
    assert result["_definition_truncated"] is True
    assert "get_definition" in result["_hint"]


@pytest.mark.anyio
async def test_get_project_context_no_truncation_no_markers(mock_client, ctx):
    # Small board: nothing trimmed, no truncation markers, no _hint noise.
    from valaris_mcp.tools.context import get_project_context

    mock_client.get.return_value = {
        "board": {"id": "b1", "name": "Test", "columns": []},
        "definition": {"scope": "ok", "content": {"scope": "short"}},
        "notes": [{"id": "1", "title": "N", "pinned": False}],
        "git_repos": [],
        "recent_activity": [{"id": "1", "action": "moved", "summary": "x"}],
    }
    result = json.loads(await get_project_context("ws", "b1", ctx=ctx))
    assert "_notes_truncated" not in result
    assert "_activity_truncated" not in result
    assert "_definition_truncated" not in result
    assert "_hint" not in result


# -- Search -------------------------------------------------------------------


@pytest.mark.anyio
async def test_search_cards(mock_client, ctx):
    from valaris_mcp.tools.search import search_cards

    mock_client.get.return_value = [{"id": "c1", "title": "Found"}]
    result = json.loads(await search_cards("ws", "b1", q="Found", ctx=ctx))
    assert result["total"] == 1
    assert result["cards"][0]["title"] == "Found"


@pytest.mark.anyio
async def test_search_cards_assignee_id(mock_client, ctx):
    from valaris_mcp.tools.search import search_cards

    mock_client.get.return_value = [{"id": "c1", "title": "Assigned"}]
    result = json.loads(await search_cards("ws", "b1", assignee_id="user-uuid-1", ctx=ctx))
    assert result["total"] == 1
    mock_client.get.assert_called_once_with(
        "/workspaces/ws/boards/b1/cards/search",
        limit=50,
        assignee_id="user-uuid-1",
    )


@pytest.mark.anyio
async def test_search_cards_tool_forwards_include_untyped_false(mock_client, ctx):
    from valaris_mcp.tools.search import search_cards

    mock_client.get.return_value = [{"id": "c1", "title": "Active card"}]
    result = json.loads(await search_cards("ws", "b1", include_untyped=False, ctx=ctx))
    assert result["total"] == 1
    mock_client.get.assert_called_once_with(
        "/workspaces/ws/boards/b1/cards/search",
        limit=50,
        include_untyped="false",
    )


@pytest.mark.anyio
async def test_search_cards_empty(mock_client, ctx):
    from valaris_mcp.tools.search import search_cards

    mock_client.get.return_value = []
    result = json.loads(await search_cards("ws", "b1", q="nothing", ctx=ctx))
    assert result["total"] == 0
    assert "_hint" in result


@pytest.mark.anyio
async def test_search_cards_empty_omitted_untyped_no_exclusion_hint(mock_client, ctx):
    from valaris_mcp.tools.search import search_cards

    mock_client.get.return_value = []
    result = json.loads(await search_cards("ws", "b1", q="nothing", ctx=ctx))
    # Omitted include_untyped means INCLUDED (the backend default) — the hint
    # must not claim untyped-column cards were excluded.
    assert "were excluded" not in result["_hint"]


@pytest.mark.anyio
async def test_search_cards_empty_include_untyped_false_hint(mock_client, ctx):
    from valaris_mcp.tools.search import search_cards

    mock_client.get.return_value = []
    result = json.loads(
        await search_cards("ws", "b1", q="nothing", include_untyped=False, ctx=ctx)
    )
    assert "were excluded (include_untyped=False)" in result["_hint"]
    assert "do not retry" in result["_hint"]


@pytest.mark.anyio
async def test_search_cards_summary_only_forwarded_to_backend(mock_client, ctx):
    from valaris_mcp.tools.search import search_cards

    mock_client.get.return_value = [
        {
            "id": "c1",
            "title": "Compact",
            "column_id": "col1",
            "column_name": "To Do",
            "column_type": "backlog",
            "labels": ["loop-2"],
            "priority": "high",
            "status": None,
            "card_type": "bug",
        }
    ]
    result = json.loads(await search_cards("ws", "b1", label="loop-2", summary_only=True, ctx=ctx))
    mock_client.get.assert_called_once_with(
        "/workspaces/ws/boards/b1/cards/search",
        limit=50,
        label="loop-2",
        summary_only="true",
    )
    assert result["total"] == 1
    assert result["cards"][0]["column_name"] == "To Do"


@pytest.mark.anyio
async def test_search_cards_summary_only_omitted_not_forwarded(mock_client, ctx):
    from valaris_mcp.tools.search import search_cards

    mock_client.get.return_value = [{"id": "c1", "title": "Full", "description": "body"}]
    await search_cards("ws", "b1", q="Full", ctx=ctx)
    # Default stays byte-compatible for existing callers: no new query param.
    mock_client.get.assert_called_once_with(
        "/workspaces/ws/boards/b1/cards/search",
        limit=50,
        q="Full",
    )


@pytest.mark.anyio
async def test_search_cards_docstring_recommends_summary_only(mock_client, ctx):
    from valaris_mcp.tools.search import search_cards

    doc = search_cards.__doc__ or ""
    assert "summary_only" in doc
    assert "column_name" in doc


# -- Health -------------------------------------------------------------------


@pytest.mark.anyio
async def test_get_board_health(mock_client, ctx):
    from valaris_mcp.tools.health import get_board_health

    mock_client.get.return_value = {"health_score": 85, "total_cards": 10}
    result = json.loads(await get_board_health("ws", "b1", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/ws/boards/b1/health")
    assert result["health_score"] == 85


# -- Bulk ---------------------------------------------------------------------


@pytest.mark.anyio
async def test_bulk_create_cards(mock_client, ctx):
    from valaris_mcp.tools.bulk import bulk_create_cards

    mock_client.post.return_value = {"created": 3, "cards": [{"id": "c1"}, {"id": "c2"}, {"id": "c3"}]}
    result = json.loads(await bulk_create_cards("ws", "b1", cards=[
        {"column_id": "col1", "title": "Card 1"},
        {"column_id": "col1", "title": "Card 2"},
        {"column_id": "col1", "title": "Card 3"},
    ], ctx=ctx))
    mock_client.post.assert_called_once()
    assert result["created"] == 3
    assert "_hint" in result


# -- Agents -------------------------------------------------------------------


@pytest.mark.anyio
async def test_log_execution_start(mock_client, ctx):
    from valaris_mcp.tools.agents import log_execution_start

    mock_client.get.return_value = {"id": "u1", "email": "agent@valaris.dev", "agent_id": "a1"}
    mock_client.post.return_value = {
        "id": "exec-1",
        "agent_id": "a1",
        "action": "standup",
        "status": "running",
    }
    result = json.loads(
        await log_execution_start(
            workspace_slug="default",
            agent_id="a1",
            action="standup",
            input_summary="Generate daily standup report",
            board_id="b1",
            session_id="sess-abc",
            ctx=ctx,
        )
    )
    mock_client.post.assert_called_once_with(
        "/agents/a1/executions",
        {
            "workspace_slug": "default",
            "action": "standup",
            "input_summary": "Generate daily standup report",
            "board_id": "b1",
            "session_id": "sess-abc",
        },
    )
    assert result["id"] == "exec-1"
    assert result["status"] == "running"
    assert "_hint" in result


@pytest.mark.anyio
async def test_log_execution_start_minimal(mock_client, ctx):
    from valaris_mcp.tools.agents import log_execution_start

    mock_client.post.return_value = {
        "id": "exec-2",
        "agent_id": "a1",
        "action": "review_pr",
        "status": "running",
    }
    result = json.loads(
        await log_execution_start(
            workspace_slug="default",
            agent_id="a1",
            action="review_pr",
            input_summary="Review PR #42",
            ctx=ctx,
        )
    )
    mock_client.post.assert_called_once_with(
        "/agents/a1/executions",
        {
            "workspace_slug": "default",
            "action": "review_pr",
            "input_summary": "Review PR #42",
        },
    )
    assert result["id"] == "exec-2"
    assert "_hint" in result


@pytest.mark.anyio
async def test_log_execution_start_with_parent_id(mock_client, ctx):
    from valaris_mcp.tools.agents import log_execution_start

    mock_client.post.return_value = {
        "id": "exec-3",
        "agent_id": "a1",
        "action": "implement",
        "status": "running",
        "parent_execution_id": "exec-1",
    }
    result = json.loads(
        await log_execution_start(
            workspace_slug="default",
            agent_id="a1",
            action="implement",
            input_summary="Retry after failure",
            parent_execution_id="exec-1",
            ctx=ctx,
        )
    )
    mock_client.post.assert_called_once_with(
        "/agents/a1/executions",
        {
            "workspace_slug": "default",
            "action": "implement",
            "input_summary": "Retry after failure",
            "parent_execution_id": "exec-1",
        },
    )
    assert result["id"] == "exec-3"
    assert result["parent_execution_id"] == "exec-1"
    assert "_hint" in result


@pytest.mark.anyio
async def test_log_execution_start_with_input_prompt(mock_client, ctx):
    from valaris_mcp.tools.agents import log_execution_start

    mock_client.post.return_value = {
        "id": "exec-4",
        "agent_id": "a1",
        "action": "implement",
        "status": "running",
        "input_prompt": "You are a coding agent. Build auth middleware.",
    }
    result = json.loads(
        await log_execution_start(
            workspace_slug="default",
            agent_id="a1",
            action="implement",
            input_summary="Build auth middleware",
            input_prompt="You are a coding agent. Build auth middleware.",
            ctx=ctx,
        )
    )
    call_body = mock_client.post.call_args[0][1]
    assert call_body["input_prompt"] == "You are a coding agent. Build auth middleware."
    assert result["id"] == "exec-4"
    assert result["input_prompt"] == "You are a coding agent. Build auth middleware."


@pytest.mark.anyio
async def test_log_execution_start_without_input_prompt_omits_key(mock_client, ctx):
    from valaris_mcp.tools.agents import log_execution_start

    mock_client.post.return_value = {
        "id": "exec-5",
        "agent_id": "a1",
        "action": "standup",
        "status": "running",
    }
    await log_execution_start(
        workspace_slug="default",
        agent_id="a1",
        action="standup",
        input_summary="Daily standup",
        ctx=ctx,
    )
    call_body = mock_client.post.call_args[0][1]
    assert "input_prompt" not in call_body


@pytest.mark.anyio
async def test_log_execution_update_with_input_prompt(mock_client, ctx):
    from valaris_mcp.tools.agents import log_execution_update

    mock_client.patch.return_value = {
        "id": "exec-1",
        "agent_id": "a1",
        "status": "running",
        "input_prompt": "You are a reviewer. Check PR #99.",
    }
    result = json.loads(
        await log_execution_update(
            agent_id="a1",
            execution_id="exec-1",
            status="running",
            input_prompt="You are a reviewer. Check PR #99.",
            ctx=ctx,
        )
    )
    call_body = mock_client.patch.call_args[0][1]
    assert call_body["input_prompt"] == "You are a reviewer. Check PR #99."
    assert result["input_prompt"] == "You are a reviewer. Check PR #99."


@pytest.mark.anyio
async def test_log_execution_update(mock_client, ctx):
    from valaris_mcp.tools.agents import log_execution_update

    mock_client.patch.return_value = {
        "id": "exec-1",
        "agent_id": "a1",
        "status": "completed",
        "output_summary": "Standup report created",
        "tools_used": ["get_board_health", "create_note"],
        "cards_affected": ["c1", "c2"],
        "tool_calls_count": 5,
    }
    result = json.loads(
        await log_execution_update(
            agent_id="a1",
            execution_id="exec-1",
            status="completed",
            output_summary="Standup report created",
            tools_used=["get_board_health", "create_note"],
            cards_affected=["c1", "c2"],
            tool_calls_count=5,
            ctx=ctx,
        )
    )
    mock_client.patch.assert_called_once_with(
        "/agents/a1/executions/exec-1",
        {
            "status": "completed",
            "output_summary": "Standup report created",
            "tools_used": ["get_board_health", "create_note"],
            "cards_affected": ["c1", "c2"],
            "tool_calls_count": 5,
        },
    )
    assert result["status"] == "completed"
    assert "_hint" in result


@pytest.mark.anyio
async def test_log_execution_update_with_duration_seconds(mock_client, ctx):
    """Backend ExecutionUpdate accepts duration_seconds; MCP tool must expose it."""
    from valaris_mcp.tools.agents import log_execution_update

    mock_client.patch.return_value = {
        "id": "exec-1",
        "agent_id": "a1",
        "status": "completed",
        "duration_seconds": 12.5,
    }
    await log_execution_update(
        agent_id="a1",
        execution_id="exec-1",
        status="completed",
        duration_seconds=12.5,
        ctx=ctx,
    )
    body = mock_client.patch.call_args[0][1]
    assert body["duration_seconds"] == 12.5


@pytest.mark.anyio
async def test_log_execution_update_with_ship_warnings(mock_client, ctx):
    """B16: runners forward non-fatal stage warnings (e.g. auto-merge arming
    failed) via log_execution_update so the UI can surface them."""
    from valaris_mcp.tools.agents import log_execution_update

    warnings = [
        "auto-merge arming failed: Protected branch rules not configured for this branch",
    ]
    mock_client.patch.return_value = {
        "id": "exec-1",
        "agent_id": "a1",
        "status": "completed",
        "ship_warnings": warnings,
    }
    await log_execution_update(
        agent_id="a1",
        execution_id="exec-1",
        status="completed",
        ship_warnings=warnings,
        ctx=ctx,
    )
    body = mock_client.patch.call_args[0][1]
    assert body["ship_warnings"] == warnings


@pytest.mark.anyio
async def test_log_execution_update_error(mock_client, ctx):
    from valaris_mcp.tools.agents import log_execution_update

    mock_client.patch.return_value = {
        "id": "exec-1",
        "agent_id": "a1",
        "status": "failed",
        "error_message": "API timeout",
    }
    result = json.loads(
        await log_execution_update(
            agent_id="a1",
            execution_id="exec-1",
            status="failed",
            error_message="API timeout",
            ctx=ctx,
        )
    )
    mock_client.patch.assert_called_once_with(
        "/agents/a1/executions/exec-1",
        {
            "status": "failed",
            "error_message": "API timeout",
        },
    )
    assert result["status"] == "failed"
    assert "_hint" in result


@pytest.mark.anyio
async def test_cancel_execution_aborts_by_default(mock_client, ctx):
    """Recovering a zombie execution PATCHes it to a terminal status (default
    'aborted'), clearing the backend busy-guard that wedges the pipeline."""
    from valaris_mcp.tools.agents import cancel_execution

    mock_client.patch.return_value = {
        "id": "exec-1",
        "agent_id": "a1",
        "status": "aborted",
    }
    result = json.loads(
        await cancel_execution(
            agent_id="a1",
            execution_id="exec-1",
            ctx=ctx,
        )
    )
    mock_client.patch.assert_called_once_with(
        "/agents/a1/executions/exec-1",
        {"status": "aborted"},
    )
    assert result["status"] == "aborted"
    assert "_hint" in result


@pytest.mark.anyio
async def test_cancel_execution_with_reason(mock_client, ctx):
    from valaris_mcp.tools.agents import cancel_execution

    mock_client.patch.return_value = {"id": "exec-1", "status": "aborted"}
    await cancel_execution(
        agent_id="a1",
        execution_id="exec-1",
        reason="zombie row from crashed tick",
        ctx=ctx,
    )
    mock_client.patch.assert_called_once_with(
        "/agents/a1/executions/exec-1",
        {"status": "aborted", "output_summary": "zombie row from crashed tick"},
    )


@pytest.mark.anyio
async def test_cancel_execution_accepts_completed(mock_client, ctx):
    from valaris_mcp.tools.agents import cancel_execution

    mock_client.patch.return_value = {"id": "exec-1", "status": "completed"}
    await cancel_execution(
        agent_id="a1",
        execution_id="exec-1",
        status="completed",
        ctx=ctx,
    )
    body = mock_client.patch.call_args[0][1]
    assert body["status"] == "completed"


@pytest.mark.anyio
async def test_cancel_execution_rejects_non_terminal_status(mock_client, ctx):
    """A non-terminal status would not clear the busy-guard — reject it
    client-side without issuing the PATCH."""
    from valaris_mcp.tools.agents import cancel_execution

    result = json.loads(
        await cancel_execution(
            agent_id="a1",
            execution_id="exec-1",
            status="running",
            ctx=ctx,
        )
    )
    assert result["error"] is True
    assert "running" in result["message"]
    mock_client.patch.assert_not_called()


@pytest.mark.anyio
async def test_get_agent_config(mock_client, ctx):
    from valaris_mcp.tools.agents import get_agent_config

    mock_client.get.return_value = {
        "id": "a1",
        "name": "ci-agent",
        "agent_type": "coding",
        "description": "CI agent",
        "is_active": True,
        "allowed_workspaces": ["internal"],
        "allowed_actions": None,
        "max_requests_per_minute": 100,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }
    result = json.loads(await get_agent_config(ctx=ctx))
    mock_client.get.assert_called_once_with("/agents/me")
    assert result["id"] == "a1"
    assert result["name"] == "ci-agent"
    assert result["is_active"] is True
    assert "constraints" in result["_hint"]


@pytest.mark.anyio
async def test_get_agent_config_fallback(mock_client, ctx):
    from valaris_mcp.tools.agents import get_agent_config

    import httpx

    resp_404 = httpx.Response(404, request=httpx.Request("GET", "http://test/api/agents/me"))
    error_404 = httpx.HTTPStatusError("Not Found", request=resp_404.request, response=resp_404)

    # First call (/agents/me) raises 404, second call (/me) returns user data
    mock_client.get.side_effect = [error_404, {"id": "u1", "email": "human@valaris.dev", "name": "Human"}]

    result = json.loads(await get_agent_config(ctx=ctx))
    assert mock_client.get.call_count == 2
    mock_client.get.assert_any_call("/agents/me")
    mock_client.get.assert_any_call("/me")
    assert result["email"] == "human@valaris.dev"
    assert "No runner linked" in result["_hint"]


# -- Approvals ----------------------------------------------------------------


@pytest.mark.anyio
async def test_request_approval_full(mock_client, ctx):
    from valaris_mcp.tools.approvals import request_approval

    mock_client.post.return_value = {
        "id": "apr-1",
        "status": "pending",
        "category": "deletion",
        "agent_id": "a1",
    }
    result = json.loads(
        await request_approval(
            workspace_slug="test",
            category="deletion",
            action_description="Delete all archived cards older than 90 days",
            action_payload={"target": "archived_cards", "older_than_days": 90},
            agent_id="a1",
            board_id="b1",
            ctx=ctx,
        )
    )
    mock_client.post.assert_called_once_with(
        "/workspaces/test/approvals",
        {
            "category": "deletion",
            "action_description": "Delete all archived cards older than 90 days",
            "action_payload": {"target": "archived_cards", "older_than_days": 90},
            "agent_id": "a1",
            "board_id": "b1",
        },
    )
    assert result["id"] == "apr-1"
    assert result["status"] == "pending"
    assert "_hint" in result
    assert "poll" in result["_hint"].lower()


@pytest.mark.anyio
async def test_request_approval_minimal(mock_client, ctx):
    from valaris_mcp.tools.approvals import request_approval

    mock_client.post.return_value = {
        "id": "apr-2",
        "status": "pending",
        "category": "deployment",
        "agent_id": "a1",
    }
    result = json.loads(
        await request_approval(
            workspace_slug="test",
            category="deployment",
            action_description="Deploy v2.1.0 to production",
            action_payload={"version": "2.1.0", "env": "production"},
            agent_id="a1",
            ctx=ctx,
        )
    )
    mock_client.post.assert_called_once_with(
        "/workspaces/test/approvals",
        {
            "category": "deployment",
            "action_description": "Deploy v2.1.0 to production",
            "action_payload": {"version": "2.1.0", "env": "production"},
            "agent_id": "a1",
        },
    )
    assert result["id"] == "apr-2"
    assert "_hint" in result


@pytest.mark.anyio
async def test_get_approval_status(mock_client, ctx):
    from valaris_mcp.tools.approvals import get_approval_status

    mock_client.get.return_value = {
        "id": "apr-1",
        "status": "approved",
        "category": "deletion",
        "decided_by": "admin@valaris.dev",
    }
    result = json.loads(
        await get_approval_status(
            workspace_slug="test",
            approval_id="apr-1",
            ctx=ctx,
        )
    )
    mock_client.get.assert_called_once_with("/workspaces/test/approvals/apr-1")
    assert result["status"] == "approved"
    assert "_hint" in result
    assert "proceed" in result["_hint"].lower()


# -- Webhooks -----------------------------------------------------------------


@pytest.mark.anyio
async def test_create_webhook(mock_client, ctx):
    from valaris_mcp.tools.webhooks import create_webhook

    mock_client.post.return_value = {
        "id": "wh-1",
        "url": "https://example.com/hook",
        "events": ["card.created"],
        "is_active": True,
    }
    result = json.loads(
        await create_webhook(
            workspace_slug="test",
            url="https://example.com/hook",
            events=["card.created"],
            secret="my-secret",
            ctx=ctx,
        )
    )
    mock_client.post.assert_called_once_with(
        "/workspaces/test/webhooks",
        {"url": "https://example.com/hook", "events": ["card.created"], "secret": "my-secret"},
    )
    assert result["id"] == "wh-1"
    assert result["is_active"] is True
    assert "_hint" in result


@pytest.mark.anyio
async def test_list_webhooks(mock_client, ctx):
    from valaris_mcp.tools.webhooks import list_webhooks

    mock_client.get.return_value = [
        {"id": "wh-1", "url": "https://example.com/hook1"},
        {"id": "wh-2", "url": "https://example.com/hook2"},
    ]
    result = json.loads(await list_webhooks(workspace_slug="test", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/test/webhooks")
    assert result["count"] == 2
    assert len(result["webhooks"]) == 2
    assert "_hint" in result


@pytest.mark.anyio
async def test_list_webhooks_active_only(mock_client, ctx):
    from valaris_mcp.tools.webhooks import list_webhooks

    mock_client.get.return_value = [{"id": "wh-1", "url": "https://example.com/hook"}]
    result = json.loads(await list_webhooks(workspace_slug="test", is_active=True, ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/test/webhooks", is_active="true")
    assert result["count"] == 1


# -- Teams --------------------------------------------------------------------


@pytest.mark.anyio
async def test_list_teams(mock_client, ctx):
    from valaris_mcp.tools.teams import list_teams

    mock_client.get.return_value = [{"id": "t1", "name": "Alpha"}]
    result = json.loads(await list_teams(workspace_slug="test", ctx=ctx))
    assert isinstance(result, list)
    assert len(result) == 1


@pytest.mark.anyio
async def test_list_teams_include_inactive_is_top_level_kwarg(mock_client, ctx):
    """Client.get(path, **params) expects spread kwargs, not a params=dict.

    Passing params={...} collapses include_inactive into an unused 'params' kwarg,
    so the backend never receives the filter. Assert the kwarg is top-level.
    """
    from valaris_mcp.tools.teams import list_teams

    mock_client.get.return_value = []
    await list_teams(workspace_slug="test", include_inactive=True, ctx=ctx)
    call_kwargs = mock_client.get.call_args.kwargs
    assert "params" not in call_kwargs
    assert call_kwargs.get("include_inactive") == "true"


@pytest.mark.anyio
async def test_get_team(mock_client, ctx):
    from valaris_mcp.tools.teams import get_team

    mock_client.get.return_value = {"id": "t1", "name": "Alpha", "members": []}
    result = json.loads(await get_team("test", "t1", ctx=ctx))
    assert result["name"] == "Alpha"
    assert "_hint" in result


@pytest.mark.anyio
async def test_create_team(mock_client, ctx):
    from valaris_mcp.tools.teams import create_team

    mock_client.post.return_value = {"id": "t1", "name": "Beta"}
    result = json.loads(await create_team("test", "Beta", description="desc", ctx=ctx))
    mock_client.post.assert_called_once()
    assert result["name"] == "Beta"
    assert "_hint" in result


@pytest.mark.anyio
async def test_update_team(mock_client, ctx):
    from valaris_mcp.tools.teams import update_team

    mock_client.patch.return_value = {"id": "t1", "name": "Gamma"}
    result = json.loads(await update_team("test", "t1", name="Gamma", ctx=ctx))
    mock_client.patch.assert_called_once()
    assert result["name"] == "Gamma"


@pytest.mark.anyio
async def test_deactivate_team(mock_client, ctx):
    from valaris_mcp.tools.teams import deactivate_team

    mock_client.delete.return_value = {"id": "t1", "is_active": False}
    result = json.loads(await deactivate_team("test", "t1", ctx=ctx))
    mock_client.delete.assert_called_once()
    assert result["is_active"] is False


@pytest.mark.anyio
async def test_add_team_member(mock_client, ctx):
    from valaris_mcp.tools.teams import add_team_member

    mock_client.post.return_value = {"id": "t1", "members": [{"agent_id": "a1", "roles": ["reviewer"]}]}
    result = json.loads(await add_team_member("test", "t1", "a1", roles=["reviewer"], ctx=ctx))
    mock_client.post.assert_called_once()
    body = mock_client.post.call_args[0][1]
    assert body["agent_id"] == "a1"
    assert body["roles"] == ["reviewer"]
    assert "_hint" in result


@pytest.mark.anyio
async def test_remove_team_member(mock_client, ctx):
    from valaris_mcp.tools.teams import remove_team_member

    mock_client.delete.return_value = {"id": "t1", "members": []}
    json.loads(await remove_team_member("test", "t1", "a1", ctx=ctx))
    mock_client.delete.assert_called_once()


# -- Claim Card ---------------------------------------------------------------


@pytest.mark.anyio
async def test_claim_card(mock_client, ctx):
    from valaris_mcp.tools.cards import claim_card

    mock_client.post.return_value = {"id": "c1", "participants": [{"user_id": "a1", "role": "hero"}]}
    result = json.loads(await claim_card("test", "b1", "c1", "a1", ctx=ctx))
    mock_client.post.assert_called_once()
    assert "_hint" in result
    assert result["id"] == "c1"


@pytest.mark.anyio
async def test_claim_card_path(mock_client, ctx):
    from valaris_mcp.tools.cards import claim_card

    mock_client.post.return_value = {"id": "c1"}
    await claim_card("ws", "board-1", "card-1", "agent-1", ctx=ctx)
    path = mock_client.post.call_args[0][0]
    assert "/boards/board-1/cards/card-1/claim" in path


# -- Agent CRUD ---------------------------------------------------------------


@pytest.mark.anyio
async def test_create_agent(mock_client, ctx):
    from valaris_mcp.tools.agents import create_agent

    mock_client.post.return_value = {
        "id": "a1",
        "name": "ci-bot",
        "agent_type": "coding",
        "raw_api_key": "vk_abc123",
    }
    result = json.loads(
        await create_agent(
            name="ci-bot",
            agent_type="coding",
            description="CI pipeline agent",
            allowed_workspaces=["internal"],
            max_requests_per_minute=50,
            budget_usd=10.0,
            ctx=ctx,
        )
    )
    mock_client.post.assert_called_once_with(
        "/agents",
        {
            "name": "ci-bot",
            "agent_type": "coding",
            "description": "CI pipeline agent",
            "allowed_workspaces": ["internal"],
            "max_requests_per_minute": 50,
            "budget_usd": 10.0,
        },
    )
    assert result["id"] == "a1"
    assert result["raw_api_key"] == "vk_abc123"
    assert "_hint" in result
    assert "raw_api_key" in result["_hint"]


def test_create_agent_docstring_matches_agent_type_enum():
    """Docstring must list the real AgentType values, not team_role values.

    Backend AgentType is {coding, manager, reviewer, secretary, improver}.
    'documentator' is a team_role — using it as agent_type yields 422.
    """
    from valaris_mcp.tools.agents import create_agent

    fn = getattr(create_agent, "fn", create_agent)
    doc = fn.__doc__ or ""
    assert "documentator" not in doc
    for value in ("coding", "manager", "reviewer", "secretary", "improver"):
        assert value in doc, f"Docstring missing agent_type value: {value}"


def test_create_prompt_config_docstring_matches_agent_type_enum():
    from valaris_mcp.tools.prompt_configs import create_prompt_config

    fn = getattr(create_prompt_config, "fn", create_prompt_config)
    doc = fn.__doc__ or ""
    agent_type_line = next(
        (line for line in doc.splitlines() if "agent_type" in line), ""
    )
    assert "documentator" not in agent_type_line
    for value in ("coding", "manager", "reviewer", "secretary", "improver"):
        assert value in agent_type_line, f"agent_type doc missing: {value}"


@pytest.mark.anyio
async def test_update_agent(mock_client, ctx):
    from valaris_mcp.tools.agents import update_agent

    mock_client.patch.return_value = {
        "id": "a1",
        "name": "ci-bot-v2",
        "is_active": True,
    }
    result = json.loads(
        await update_agent(
            agent_id="a1",
            name="ci-bot-v2",
            is_active=True,
            ctx=ctx,
        )
    )
    mock_client.patch.assert_called_once_with(
        "/agents/a1",
        {"name": "ci-bot-v2", "is_active": True},
    )
    assert result["id"] == "a1"
    assert result["name"] == "ci-bot-v2"
    assert "_hint" in result
    assert "heartbeat" in result["_hint"].lower()


@pytest.mark.anyio
async def test_get_agent(mock_client, ctx):
    from valaris_mcp.tools.agents import get_agent

    mock_client.get.return_value = {
        "id": "a1",
        "name": "ci-bot",
        "agent_type": "coding",
        "is_active": True,
    }
    result = json.loads(await get_agent(agent_id="a1", ctx=ctx))
    mock_client.get.assert_called_once_with("/agents/a1")
    assert result["id"] == "a1"
    assert result["agent_type"] == "coding"
    assert "_hint" in result
    assert "update_agent" in result["_hint"]


# -- Approval Decisions -------------------------------------------------------


@pytest.mark.anyio
async def test_decide_approval_approved(mock_client, ctx):
    from valaris_mcp.tools.approvals import decide_approval

    mock_client.post.return_value = {
        "id": "apr-1",
        "status": "approved",
        "decided_by": "admin@valaris.dev",
    }
    result = json.loads(
        await decide_approval(
            workspace_slug="test",
            approval_id="apr-1",
            decision="approved",
            reason="Looks good",
            ctx=ctx,
        )
    )
    mock_client.post.assert_called_once_with(
        "/workspaces/test/approvals/apr-1/decide",
        {"decision": "approved", "reason": "Looks good"},
    )
    assert result["status"] == "approved"
    assert "_hint" in result
    assert "granted" in result["_hint"].lower()


@pytest.mark.anyio
async def test_decide_approval_rejected(mock_client, ctx):
    from valaris_mcp.tools.approvals import decide_approval

    mock_client.post.return_value = {
        "id": "apr-2",
        "status": "rejected",
        "decided_by": "admin@valaris.dev",
    }
    result = json.loads(
        await decide_approval(
            workspace_slug="test",
            approval_id="apr-2",
            decision="rejected",
            ctx=ctx,
        )
    )
    mock_client.post.assert_called_once_with(
        "/workspaces/test/approvals/apr-2/decide",
        {"decision": "rejected"},
    )
    assert result["status"] == "rejected"
    assert "_hint" in result
    assert "rejected" in result["_hint"].lower()


# -- Prompt Configs -----------------------------------------------------------


@pytest.mark.anyio
async def test_list_prompt_configs(mock_client, ctx):
    from valaris_mcp.tools.prompt_configs import list_prompt_configs

    mock_client.get.return_value = [
        {"id": "pc-1", "name": "Review Prompt", "slug": "review"},
        {"id": "pc-2", "name": "Implement Prompt", "slug": "implement"},
    ]
    result = json.loads(
        await list_prompt_configs(workspace_slug="test", team_role="reviewer", ctx=ctx)
    )
    mock_client.get.assert_called_once_with(
        "/workspaces/test/prompt-configs", team_role="reviewer"
    )
    assert result["total"] == 2
    assert len(result["items"]) == 2
    assert "_hint" in result


@pytest.mark.anyio
async def test_get_prompt_config(mock_client, ctx):
    from valaris_mcp.tools.prompt_configs import get_prompt_config

    mock_client.get.return_value = {
        "id": "pc-1",
        "name": "Review Prompt",
        "slug": "review",
        "stage": "review",
        "content": "You are a code reviewer...",
    }
    result = json.loads(
        await get_prompt_config(workspace_slug="test", config_id="pc-1", ctx=ctx)
    )
    mock_client.get.assert_called_once_with("/workspaces/test/prompt-configs/pc-1")
    assert result["id"] == "pc-1"
    assert result["slug"] == "review"
    assert "_hint" in result


@pytest.mark.anyio
async def test_create_prompt_config(mock_client, ctx):
    from valaris_mcp.tools.prompt_configs import create_prompt_config

    mock_client.post.return_value = {
        "id": "pc-3",
        "name": "Plan Prompt",
        "slug": "plan",
        "stage": "plan",
        "content": "You are a planner...",
    }
    result = json.loads(
        await create_prompt_config(
            workspace_slug="test",
            name="Plan Prompt",
            slug="plan",
            stage="plan",
            content="You are a planner...",
            agent_type="coding",
            team_role="orchestrator",
            ctx=ctx,
        )
    )
    mock_client.post.assert_called_once_with(
        "/workspaces/test/prompt-configs",
        {
            "name": "Plan Prompt",
            "slug": "plan",
            "stage": "plan",
            "content": "You are a planner...",
            "agent_type": "coding",
            "team_role": "orchestrator",
        },
    )
    assert result["id"] == "pc-3"
    assert "_hint" in result
    assert "config refresh" in result["_hint"].lower()


@pytest.mark.anyio
async def test_update_prompt_config(mock_client, ctx):
    from valaris_mcp.tools.prompt_configs import update_prompt_config

    mock_client.patch.return_value = {
        "id": "pc-1",
        "name": "Updated Review",
        "content": "Updated content...",
    }
    result = json.loads(
        await update_prompt_config(
            workspace_slug="test",
            config_id="pc-1",
            name="Updated Review",
            content="Updated content...",
            ctx=ctx,
        )
    )
    mock_client.patch.assert_called_once_with(
        "/workspaces/test/prompt-configs/pc-1",
        {"name": "Updated Review", "content": "Updated content..."},
    )
    assert result["id"] == "pc-1"
    assert result["name"] == "Updated Review"
    assert "_hint" in result


@pytest.mark.anyio
async def test_delete_prompt_config(mock_client, ctx):
    from valaris_mcp.tools.prompt_configs import delete_prompt_config

    mock_client.delete.return_value = None
    result = json.loads(
        await delete_prompt_config(workspace_slug="test", config_id="pc-1", ctx=ctx)
    )
    mock_client.delete.assert_called_once_with("/workspaces/test/prompt-configs/pc-1")
    assert result["deleted"] is True
    assert result["config_id"] == "pc-1"
    assert "_hint" in result


@pytest.mark.anyio
async def test_next_assignment_returns_bundle(mock_client, ctx):
    from unittest.mock import MagicMock
    from valaris_mcp.tools.assignments import next_assignment

    fake_resp = MagicMock()
    fake_resp.status_code = 200
    fake_resp.json.return_value = {
        "card": {"id": "c1", "title": "Do thing"},
        "board": {"id": "b1", "slug": "main", "name": "Main"},
        "column": {"id": "col1", "name": "To Do", "column_type": "backlog"},
        "repo": {"id": "r1", "slug": "acme", "name": "acme",
                 "url": "https://github.com/x/y", "default_branch": "main"},
        "role": "orchestrator",
        "stage_action": "implement_card",
        "reservation": {"id": "res1", "expires_at": "2026-04-24T10:00:00"},
    }
    mock_client.request_raw.return_value = fake_resp

    result = json.loads(
        await next_assignment(
            workspace_slug="default",
            agent_id="a1",
            ctx=ctx,
        )
    )
    mock_client.request_raw.assert_called_once_with(
        "POST", "/workspaces/default/agents/a1/next-assignment", json={}
    )
    assert result["card"]["id"] == "c1"
    assert result["role"] == "orchestrator"
    assert "_hint" in result


@pytest.mark.anyio
async def test_next_assignment_204_returns_no_work(mock_client, ctx):
    from unittest.mock import MagicMock
    from valaris_mcp.tools.assignments import next_assignment

    fake_resp = MagicMock()
    fake_resp.status_code = 204
    mock_client.request_raw.return_value = fake_resp

    result = json.loads(
        await next_assignment(
            workspace_slug="default",
            agent_id="a1",
            role_override="reviewer",
            board_id="b1",
            ctx=ctx,
        )
    )
    mock_client.request_raw.assert_called_once_with(
        "POST",
        "/workspaces/default/agents/a1/next-assignment",
        json={"role_override": "reviewer", "board_id": "b1"},
    )
    assert result["status"] == "no_work"
    assert "_hint" in result


# -- Merge Queue (PAR-2) ------------------------------------------------------


@pytest.mark.anyio
async def test_list_merge_queue(mock_client, ctx):
    from valaris_mcp.tools.merge_queue import list_merge_queue

    mock_client.get.return_value = []
    await list_merge_queue("default", ctx=ctx)
    mock_client.get.assert_called_once_with("/workspaces/default/merge-queue")


@pytest.mark.anyio
async def test_get_merge_queue_entry(mock_client, ctx):
    from valaris_mcp.tools.merge_queue import get_merge_queue_entry

    mock_client.get.return_value = {"id": "e1", "state": "queued"}
    await get_merge_queue_entry("default", "e1", ctx=ctx)
    mock_client.get.assert_called_once_with("/workspaces/default/merge-queue/e1")


@pytest.mark.anyio
async def test_cancel_merge_queue_entry(mock_client, ctx):
    import json

    from valaris_mcp.tools.merge_queue import cancel_merge_queue_entry

    # The cancel endpoint returns 204 No Content: the tool must use
    # request_raw, never post().json() — that raised "Expecting value" on
    # the empty body, reporting failure on every SUCCESSFUL cancel
    # (found live 2026-08-08 clearing a field merge queue).
    raw = await cancel_merge_queue_entry("default", "e1", ctx=ctx)
    mock_client.request_raw.assert_called_once_with(
        "POST", "/workspaces/default/merge-queue/e1/cancel"
    )
    mock_client.post.assert_not_called()
    body = json.loads(raw)
    assert body["status"] == "cancelled"
    assert body["entry_id"] == "e1"


# -- Card Dependencies (DEP-5) ------------------------------------------------
#
# Full UUIDs, not toy ids: since card 157ddc02 these tools resolve anything
# shorter than 36 chars through the board's /resolve endpoint, so a "c1" would
# exercise the prefix path instead of the strict route these tests pin.
# Prefix behaviour has its own file (test_id_prefix_resolution.py).

DEP_CARD = "11111111-0000-4000-8000-00000000c001"
DEP_PREREQ = "22222222-0000-4000-8000-00000000c002"
DEP_PREREQ_2 = "33333333-0000-4000-8000-00000000c003"


@pytest.mark.anyio
async def test_add_card_dependency(mock_client, ctx):
    from valaris_mcp.tools.card_dependencies import add_card_dependency

    mock_client.post.return_value = {
        "card_id": DEP_CARD,
        "depends_on_card_id": DEP_PREREQ,
    }
    raw = await add_card_dependency("test", "b1", DEP_CARD, DEP_PREREQ, ctx=ctx)
    mock_client.post.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{DEP_CARD}/dependencies",
        {"depends_on_card_id": DEP_PREREQ},
    )
    body = json.loads(raw)
    assert body["depends_on_card_id"] == DEP_PREREQ


@pytest.mark.anyio
async def test_remove_card_dependency(mock_client, ctx):
    from valaris_mcp.tools.card_dependencies import remove_card_dependency

    raw = await remove_card_dependency("test", "b1", DEP_CARD, DEP_PREREQ, ctx=ctx)
    mock_client.delete.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{DEP_CARD}/dependencies/{DEP_PREREQ}"
    )
    body = json.loads(raw)
    assert body["removed"] is True
    assert body["card_id"] == DEP_CARD
    assert body["depends_on_card_id"] == DEP_PREREQ


@pytest.mark.anyio
async def test_list_card_dependencies(mock_client, ctx):
    from valaris_mcp.tools.card_dependencies import list_card_dependencies

    mock_client.get.return_value = {"depends_on": [], "blocks": []}
    raw = await list_card_dependencies("test", "b1", DEP_CARD, ctx=ctx)
    mock_client.get.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{DEP_CARD}/dependencies"
    )
    body = json.loads(raw)
    assert body["depends_on"] == []


@pytest.mark.anyio
async def test_bulk_set_card_dependencies(mock_client, ctx):
    from valaris_mcp.tools.card_dependencies import bulk_set_card_dependencies

    mock_client.put.return_value = {
        "depends_on": [
            {"card_id": DEP_CARD, "depends_on_card_id": DEP_PREREQ},
            {"card_id": DEP_CARD, "depends_on_card_id": DEP_PREREQ_2},
        ],
        "blocks": [],
    }
    raw = await bulk_set_card_dependencies(
        "test", "b1", DEP_CARD, [DEP_PREREQ, DEP_PREREQ_2], ctx=ctx
    )
    mock_client.put.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{DEP_CARD}/dependencies",
        {"depends_on_card_ids": [DEP_PREREQ, DEP_PREREQ_2]},
    )
    body = json.loads(raw)
    assert {dep["depends_on_card_id"] for dep in body["depends_on"]} == {
        DEP_PREREQ,
        DEP_PREREQ_2,
    }


@pytest.mark.anyio
async def test_bulk_set_card_dependencies_accepts_empty_list(mock_client, ctx):
    """Passing [] clears the depends_on set."""
    from valaris_mcp.tools.card_dependencies import bulk_set_card_dependencies

    mock_client.put.return_value = {"depends_on": [], "blocks": []}
    await bulk_set_card_dependencies("test", "b1", DEP_CARD, [], ctx=ctx)
    mock_client.put.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{DEP_CARD}/dependencies",
        {"depends_on_card_ids": []},
    )


@pytest.mark.anyio
async def test_validate_board_dependencies(mock_client, ctx):
    from valaris_mcp.tools.card_dependencies import validate_board_dependencies

    mock_client.get.return_value = {
        "ok": False,
        "cycles": [
            {"card_ids": ["c1", "c2"], "titles": ["A", "B"], "summary": "A <-> B"}
        ],
        "conflicts": [],
        "orphans": [],
    }
    raw = await validate_board_dependencies("test", "b1", ctx=ctx)
    mock_client.get.assert_called_once_with(
        "/workspaces/test/boards/b1/dependencies/validation"
    )
    body = json.loads(raw)
    assert body["ok"] is False
    assert body["cycles"][0]["card_ids"] == ["c1", "c2"]


@pytest.mark.anyio
async def test_validate_board_dependencies_clean(mock_client, ctx):
    from valaris_mcp.tools.card_dependencies import validate_board_dependencies

    mock_client.get.return_value = {
        "ok": True,
        "cycles": [],
        "conflicts": [],
        "orphans": [],
    }
    raw = await validate_board_dependencies("test", "b1", ctx=ctx)
    body = json.loads(raw)
    assert body["ok"] is True


# ---------------------------------------------------------------------------
# CTX-8: dependency-aware query tools
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_get_card_dependency_status_satisfied(mock_client, ctx):
    """All prerequisites in a done column → satisfied=True, empty blocking."""
    from valaris_mcp.tools.card_dependencies import get_card_dependency_status

    mock_client.get.return_value = {
        "depends_on": [
            {
                "depends_on_card_id": "c2",
                "depends_on_title": "Prereq A",
                "depends_on_status": "shipped",
                "depends_on_column_type": "done",
            },
        ],
        "blocks": [
            {"card_id": "c9", "depends_on_title": "Downstream"},
        ],
    }
    raw = await get_card_dependency_status("test", "b1", DEP_CARD, ctx=ctx)
    mock_client.get.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{DEP_CARD}/dependencies"
    )
    body = json.loads(raw)
    assert body["satisfied"] is True
    assert body["blocking"] == []
    assert body["total_prerequisites"] == 1
    assert body["blocks_count"] == 1


@pytest.mark.anyio
async def test_get_card_dependency_status_blocked(mock_client, ctx):
    """A prerequisite not in a done column → satisfied=False, lists blockers."""
    from valaris_mcp.tools.card_dependencies import get_card_dependency_status

    mock_client.get.return_value = {
        "depends_on": [
            {
                "depends_on_card_id": "c2",
                "depends_on_title": "Done Prereq",
                "depends_on_status": "shipped",
                "depends_on_column_type": "done",
            },
            {
                "depends_on_card_id": "c3",
                "depends_on_title": "Open Prereq",
                "depends_on_status": "working",
                "depends_on_column_type": "active",
            },
        ],
        "blocks": [],
    }
    raw = await get_card_dependency_status("test", "b1", DEP_CARD, ctx=ctx)
    body = json.loads(raw)
    assert body["satisfied"] is False
    assert len(body["blocking"]) == 1
    assert body["blocking"][0]["card_id"] == "c3"
    assert body["blocking"][0]["title"] == "Open Prereq"
    assert "_hint" in body


@pytest.mark.anyio
async def test_get_card_dependency_status_no_dependencies(mock_client, ctx):
    """A card with no prerequisites is trivially satisfied."""
    from valaris_mcp.tools.card_dependencies import get_card_dependency_status

    mock_client.get.return_value = {"depends_on": [], "blocks": []}
    raw = await get_card_dependency_status("test", "b1", DEP_CARD, ctx=ctx)
    body = json.loads(raw)
    assert body["satisfied"] is True
    assert body["total_prerequisites"] == 0


@pytest.mark.anyio
async def test_get_card_verdict(mock_client, ctx):
    from valaris_mcp.tools.card_dependencies import get_card_verdict

    mock_client.get.return_value = {
        "decision": "request_changes",
        "content": "The migration drops a column still read by old code.",
        "created_at": "2026-05-24T10:00:00",
    }
    raw = await get_card_verdict("test", "b1", DEP_CARD, ctx=ctx)
    mock_client.get.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{DEP_CARD}/verdict"
    )
    body = json.loads(raw)
    assert body["decision"] == "request_changes"
    assert "migration" in body["content"]


# -- delete_board (P1-1) ------------------------------------------------------


@pytest.mark.anyio
async def test_delete_board(mock_client, ctx):
    from valaris_mcp.tools.boards import delete_board

    mock_client.delete.return_value = None
    result = await delete_board("test", "board-1", ctx=ctx)
    mock_client.delete.assert_called_once_with("/workspaces/test/boards/board-1")
    # Delete tools return a plain confirmation string (client.delete → None),
    # matching delete_card / delete_note.
    assert isinstance(result, str)
    assert "board-1" in result
    assert "deleted" in result.lower()


# -- list_workspace_members + whoami (P1-2) -----------------------------------


@pytest.mark.anyio
async def test_list_workspace_members(mock_client, ctx):
    from valaris_mcp.tools.workspaces import list_workspace_members

    mock_client.get.return_value = [
        {"user_id": "u1", "email": "a@x.com", "name": "A", "role": "owner"},
        {"user_id": "u2", "email": "b@x.com", "name": "B", "role": "member"},
    ]
    result = json.loads(await list_workspace_members("test", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/test/members")
    assert result["total"] == 2
    assert result["members"][0]["email"] == "a@x.com"


@pytest.mark.anyio
async def test_list_workspace_members_with_query(mock_client, ctx):
    from valaris_mcp.tools.workspaces import list_workspace_members

    mock_client.get.return_value = [{"user_id": "u1", "email": "ann@x.com", "role": "member"}]
    result = json.loads(await list_workspace_members("test", query="ann", limit=5, ctx=ctx))
    # query + limit go on the querystring so the backend runs its ILIKE search.
    mock_client.get.assert_called_once_with("/workspaces/test/members?q=ann&limit=5")
    assert result["total"] == 1


@pytest.mark.anyio
async def test_list_workspace_members_empty_hint(mock_client, ctx):
    from valaris_mcp.tools.workspaces import list_workspace_members

    mock_client.get.return_value = []
    result = json.loads(await list_workspace_members("test", ctx=ctx))
    assert result["total"] == 0
    assert "_hint" in result


@pytest.mark.anyio
async def test_whoami(mock_client, ctx):
    from valaris_mcp.tools.workspaces import whoami

    mock_client.get.return_value = {"id": "u1", "email": "me@valaris.dev", "name": "Me"}
    result = json.loads(await whoami(ctx=ctx))
    mock_client.get.assert_called_once_with("/me")
    assert result["email"] == "me@valaris.dev"


# -- get_server_info (P3-6) ---------------------------------------------------


@pytest.mark.anyio
async def test_get_server_info(mock_client, ctx, monkeypatch):
    from valaris_mcp.tools.server_info import get_server_info

    # No allowlist env → all tools enabled (unrestricted).
    monkeypatch.delenv("VALARIS_MCP_ALLOWLIST", raising=False)
    # Backend health ping succeeds.
    mock_client.get.return_value = {"status": "ok"}
    result = json.loads(await get_server_info(ctx=ctx))
    assert result["version"]  # server version present
    assert isinstance(result["tools"], list)
    assert "get_server_info" in result["tools"]
    assert result["tool_count"] == len(result["tools"])
    # Unrestricted → allowlist is null/None, enabled == all tools.
    assert result["allowlist"] is None
    assert result["backend"]["reachable"] is True


@pytest.mark.anyio
async def test_get_server_info_with_allowlist(mock_client, monkeypatch):
    from tests.conftest import make_ctx
    from valaris_mcp.hand import load_hand
    from valaris_mcp.tools.server_info import get_server_info

    monkeypatch.delenv("VALARIS_MCP_TOOLSETS", raising=False)
    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", "get_board,get_card")
    mock_client.get.return_value = {"status": "ok"}
    result = json.loads(await get_server_info(ctx=make_ctx(mock_client, hand=load_hand())))
    assert sorted(result["allowlist"]) == ["get_board", "get_card"]
    # enabled_tools = intersection of registered ∩ allowlist: an allowlist with
    # no toolsets env is the runner shape, where the allowlist is the hand.
    assert set(result["enabled_tools"]) <= set(result["tools"])
    assert result["enabled_tools"] == ["get_board", "get_card"]
    assert result["toolsets"]["loaded"] == ["all"]


@pytest.mark.anyio
async def test_get_server_info_backend_unreachable(mock_client, ctx, monkeypatch):
    import httpx

    from valaris_mcp.tools.server_info import get_server_info

    monkeypatch.delenv("VALARIS_MCP_ALLOWLIST", raising=False)
    mock_client.get.side_effect = httpx.ConnectError("boom")
    result = json.loads(await get_server_info(ctx=ctx))
    # Server info must still return (version/tools are local); backend just marked
    # unreachable rather than erroring the whole call.
    assert result["backend"]["reachable"] is False
    assert result["version"]


# -- get_server_info token census (MCP #1) -----------------------------------


def _compact_listing_bytes(tools) -> int:
    return sum(len(t.model_dump_json(exclude_none=True, by_alias=True)) for t in tools)


@pytest.mark.anyio
async def test_get_server_info_reports_listing_census_unrestricted(mock_client, ctx, monkeypatch):
    from valaris_mcp.server import mcp
    from valaris_mcp.tools.server_info import get_server_info

    monkeypatch.delenv("VALARIS_MCP_ALLOWLIST", raising=False)
    # Unrestricted means the full surface: since toolsets landed, an unset
    # VALARIS_MCP_TOOLSETS loads the default hand, so "all" is explicit here.
    monkeypatch.setenv("VALARIS_MCP_TOOLSETS", "all")
    mock_client.get.return_value = {"status": "ok"}
    result = json.loads(await get_server_info(ctx=ctx))

    assert isinstance(result["listing_bytes"], int)
    assert result["listing_bytes"] > 0
    assert result["listing_bytes"] == _compact_listing_bytes(await mcp.list_tools())
    # 4 bytes/token heuristic — derived, never typed.
    assert result["listing_tokens_estimate"] == round(result["listing_bytes"] / 4)
    assert result["annotated_tools"] == result["tool_count"]


@pytest.mark.anyio
async def test_get_server_info_under_allowlist_keeps_full_surface_and_shrinks_census(
    mock_client, monkeypatch
):
    from tests.conftest import make_ctx
    from valaris_mcp.allowlist import listed_tools
    from valaris_mcp.hand import load_hand
    from valaris_mcp.server import mcp
    from valaris_mcp.tools.server_info import get_server_info

    mock_client.get.return_value = {"status": "ok"}

    monkeypatch.delenv("VALARIS_MCP_ALLOWLIST", raising=False)
    unrestricted = json.loads(await get_server_info(ctx=make_ctx(mock_client, hand=load_hand())))

    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", "get_board,get_card")
    restricted = json.loads(await get_server_info(ctx=make_ctx(mock_client, hand=load_hand())))

    # `tools` keeps meaning the full surface even when the listing is filtered.
    assert restricted["tool_count"] == unrestricted["tool_count"]
    assert len(restricted["tools"]) == restricted["tool_count"] > 2
    assert restricted["enabled_tools"] == ["get_board", "get_card"]

    # The census describes the CURRENT hand: compact bytes over the enabled set.
    hand = listed_tools(await mcp.list_tools(), frozenset({"get_board", "get_card"}))
    assert {t.name for t in hand} == {"get_board", "get_card"}
    assert restricted["listing_bytes"] == _compact_listing_bytes(hand)
    assert restricted["listing_bytes"] < unrestricted["listing_bytes"]
    assert restricted["listing_tokens_estimate"] == round(restricted["listing_bytes"] / 4)
    assert restricted["annotated_tools"] == restricted["tool_count"]


# -- get_server_info toolsets payload (MCP #2, card 176b4503) -----------------


@pytest.mark.anyio
async def test_get_server_info_reports_the_default_toolset_under_unset_env(
    mock_client, monkeypatch
):
    from tests.conftest import make_ctx
    from valaris_mcp.allowlist import listed_tools
    from valaris_mcp.hand import load_hand
    from valaris_mcp.server import mcp
    from valaris_mcp.tools.server_info import get_server_info
    from valaris_mcp.toolsets import (
        DEFAULT_TOOLSET_IDS,
        default_hand,
        toolset_ids,
        tools_in_toolset,
    )

    monkeypatch.delenv("VALARIS_MCP_TOOLSETS", raising=False)
    monkeypatch.delenv("VALARIS_MCP_ALLOWLIST", raising=False)
    mock_client.get.return_value = {"status": "ok"}
    result = json.loads(await get_server_info(ctx=make_ctx(mock_client, hand=load_hand())))

    toolsets = result["toolsets"]
    assert toolsets["loaded"] == ["default"]
    assert toolsets["resolved_tool_count"] == len(default_hand())
    assert toolsets["default"] == list(DEFAULT_TOOLSET_IDS)

    available = toolsets["available"]
    assert isinstance(available, list)
    assert [entry["id"] for entry in available] == toolset_ids()
    for entry in available:
        assert set(entry) == {"id", "kind", "group", "tool_count"}, entry
        assert entry["kind"] in ("group", "category")
        assert entry["tool_count"] == len(tools_in_toolset(entry["id"]))

    assert isinstance(toolsets["hint"], str) and toolsets["hint"]
    assert "VALARIS_MCP_TOOLSETS" in toolsets["hint"]

    # No allowlist, yet the hand is the default toolset — and `tools` still
    # means the whole surface.
    assert result["allowlist"] is None
    assert "allowlist_outside_toolsets" not in result
    assert result["enabled_tools"] == sorted(default_hand())
    assert result["tool_count"] == len(result["tools"]) > len(result["enabled_tools"])
    hand = listed_tools(await mcp.list_tools(), default_hand())
    assert result["listing_bytes"] == _compact_listing_bytes(hand)


@pytest.mark.anyio
async def test_get_server_info_toolsets_all_enables_the_full_surface(
    mock_client, ctx, monkeypatch
):
    from valaris_mcp.server import mcp
    from valaris_mcp.tools.server_info import get_server_info

    monkeypatch.setenv("VALARIS_MCP_TOOLSETS", "all")
    monkeypatch.delenv("VALARIS_MCP_ALLOWLIST", raising=False)
    mock_client.get.return_value = {"status": "ok"}
    result = json.loads(await get_server_info(ctx=ctx))

    assert result["toolsets"]["loaded"] == ["all"]
    assert result["enabled_tools"] == result["tools"]
    assert result["toolsets"]["resolved_tool_count"] == result["tool_count"]
    assert result["listing_bytes"] == _compact_listing_bytes(await mcp.list_tools())


@pytest.mark.anyio
async def test_get_server_info_toolset_and_allowlist_intersect(mock_client, monkeypatch):
    from tests.conftest import make_ctx
    from valaris_mcp.hand import load_hand
    from valaris_mcp.tools.server_info import get_server_info
    from valaris_mcp.toolsets import resolve_hand, tools_in_toolset

    mock_client.get.return_value = {"status": "ok"}

    monkeypatch.delenv("VALARIS_MCP_TOOLSETS", raising=False)
    monkeypatch.delenv("VALARIS_MCP_ALLOWLIST", raising=False)
    default_view = json.loads(await get_server_info(ctx=make_ctx(mock_client, hand=load_hand())))

    allowlisted = {"get_card", "create_note", "list_agents"}
    monkeypatch.setenv("VALARIS_MCP_TOOLSETS", "cards")
    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", ",".join(sorted(allowlisted)))
    narrowed = json.loads(await get_server_info(ctx=make_ctx(mock_client, hand=load_hand())))

    cards = tools_in_toolset("cards")
    hand = resolve_hand(["cards"])  # cards plus the always-present server-info tools
    assert "create_note" not in hand and "list_agents" not in hand  # guard the premise
    assert narrowed["enabled_tools"] == sorted(hand & allowlisted) == ["get_card"]
    assert narrowed["toolsets"]["loaded"] == ["cards"]
    # resolved_tool_count is the toolset size BEFORE the allowlist intersection.
    assert narrowed["toolsets"]["resolved_tool_count"] == len(hand) > len(cards)
    assert narrowed["allowlist"] == sorted(allowlisted)
    # Every allowlisted name is registered: nothing to report as unknown; the
    # two outside the loaded toolset are reported as clipped instead.
    assert "allowlist_unknown" not in narrowed
    assert narrowed["allowlist_outside_toolsets"] == ["create_note", "list_agents"]
    assert narrowed["tool_count"] == default_view["tool_count"]
    assert narrowed["listing_bytes"] < default_view["listing_bytes"]


@pytest.mark.anyio
async def test_get_server_info_allowlist_without_toolsets_loads_every_toolset(
    mock_client, monkeypatch
):
    # Runner compatibility (MCP #2 review): an allowlist with no toolsets env
    # is the runner's launch shape; the allowlist is the whole hand.
    from tests.conftest import make_ctx
    from valaris_mcp.hand import load_hand
    from valaris_mcp.tools.server_info import get_server_info

    mock_client.get.return_value = {"status": "ok"}
    monkeypatch.delenv("VALARIS_MCP_TOOLSETS", raising=False)
    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", "get_card,delete_workspace")
    result = json.loads(await get_server_info(ctx=make_ctx(mock_client, hand=load_hand())))

    assert result["toolsets"]["loaded"] == ["all"]
    assert result["toolsets"]["resolved_tool_count"] == result["tool_count"]
    assert result["enabled_tools"] == ["delete_workspace", "get_card"]
    assert "allowlist_outside_toolsets" not in result
    assert "allowlist_unknown" not in result
    assert "VALARIS_MCP_ALLOWLIST" in result["toolsets"]["hint"]
    assert "VALARIS_MCP_TOOLSETS" in result["toolsets"]["hint"]


@pytest.mark.anyio
async def test_get_server_info_reports_allowlist_entries_clipped_by_the_toolsets(
    mock_client, monkeypatch
):
    from tests.conftest import make_ctx
    from valaris_mcp.hand import load_hand
    from valaris_mcp.tools.server_info import get_server_info

    mock_client.get.return_value = {"status": "ok"}
    monkeypatch.setenv("VALARIS_MCP_TOOLSETS", "cards")
    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", "get_card,delete_workspace,nonexistent_tool")
    result = json.loads(await get_server_info(ctx=make_ctx(mock_client, hand=load_hand())))

    assert result["enabled_tools"] == ["get_card"]
    # Registered but outside the loaded toolsets; unknown names stay under
    # allowlist_unknown and never double-report here.
    assert result["allowlist_outside_toolsets"] == ["delete_workspace"]
    assert result["allowlist_unknown"] == ["nonexistent_tool"]


@pytest.mark.anyio
async def test_get_server_info_loaded_dedupes_repeated_toolset_ids(mock_client, monkeypatch):
    from tests.conftest import make_ctx
    from valaris_mcp.hand import load_hand
    from valaris_mcp.tools.server_info import get_server_info
    from valaris_mcp.toolsets import default_hand

    mock_client.get.return_value = {"status": "ok"}
    monkeypatch.setenv("VALARIS_MCP_TOOLSETS", "default,default")
    monkeypatch.delenv("VALARIS_MCP_ALLOWLIST", raising=False)
    result = json.loads(await get_server_info(ctx=make_ctx(mock_client, hand=load_hand())))

    assert result["toolsets"]["loaded"] == ["default"]
    assert result["enabled_tools"] == sorted(default_hand())


# -- get_note + list_notes ergonomics (P1-3) ----------------------------------


@pytest.mark.anyio
async def test_get_note_workspace_scoped(mock_client, ctx):
    from valaris_mcp.tools.notes import get_note

    mock_client.get.return_value = {"id": NOTE_UUID, "title": "T", "content": "{}"}
    result = json.loads(await get_note("test", NOTE_UUID, ctx=ctx))
    mock_client.get.assert_called_once_with(f"/workspaces/test/notes/{NOTE_UUID}")
    assert result["id"] == NOTE_UUID


@pytest.mark.anyio
async def test_get_note_board_scoped(mock_client, ctx):
    from valaris_mcp.tools.notes import get_note

    mock_client.get.return_value = {"id": NOTE_UUID, "title": "T"}
    await get_note("test", NOTE_UUID, board_id="b1", ctx=ctx)
    mock_client.get.assert_called_once_with(
        f"/workspaces/test/boards/b1/notes/{NOTE_UUID}"
    )


@pytest.mark.anyio
async def test_get_note_markdown_format(mock_client, ctx):
    from valaris_mcp.tools.notes import get_note

    mock_client.get.return_value = {"id": NOTE_UUID, "title": "T", "content": "# T\n\nbody"}
    await get_note("test", NOTE_UUID, format="markdown", ctx=ctx)
    # format rides the querystring so the backend runs the PM→markdown serializer.
    mock_client.get.assert_called_once_with(
        f"/workspaces/test/notes/{NOTE_UUID}?format=markdown"
    )


@pytest.mark.anyio
async def test_list_notes_summary_only(mock_client, ctx):
    from valaris_mcp.tools.notes import list_notes

    mock_client.request_raw.return_value = httpx.Response(200, json=[{"id": "n1", "title": "T"}], headers={"X-Total-Count": "1"})
    await list_notes("test", summary_only=True, ctx=ctx)
    mock_client.request_raw.assert_called_once_with("GET", "/workspaces/test/notes", params={"summary_only": "true", "limit": 25, "offset": 0})


@pytest.mark.anyio
async def test_list_notes_board_card_and_summary(mock_client, ctx):
    from valaris_mcp.tools.notes import list_notes

    mock_client.request_raw.return_value = httpx.Response(200, json=[], headers={"X-Total-Count": "0"})
    await list_notes("test", board_id="b1", card_id="c1", summary_only=True, ctx=ctx)
    mock_client.request_raw.assert_called_once_with("GET", "/workspaces/test/boards/b1/notes", params={"summary_only": "true", "limit": 25, "offset": 0, "card_id": "c1"})


# -- get_card by prefix (P2-5) ------------------------------------------------


@pytest.mark.anyio
async def test_get_card_full_uuid_direct(mock_client, ctx):
    from valaris_mcp.tools.cards import get_card

    full = "b9d4e5ed-0000-4000-8000-000000000000"  # 36 chars
    mock_client.get.return_value = {"id": full, "title": "Card"}
    await get_card("test", "b1", full, ctx=ctx)
    # A full UUID hits the strict GET directly — no resolve round-trip.
    # format=markdown so agents read faithful markdown descriptions (P0-3).
    mock_client.get.assert_called_once_with(
        f"/workspaces/test/boards/b1/cards/{full}?format=markdown"
    )


@pytest.mark.anyio
async def test_get_card_prefix_resolves(mock_client, ctx):
    from valaris_mcp.tools.cards import get_card

    mock_client.get.return_value = {"id": "b9d4e5ed-0000-4000-8000-000000000000", "title": "Card"}
    result = json.loads(await get_card("test", "b1", "b9d4e5ed", ctx=ctx))
    # A short prefix goes to the resolve endpoint instead of the strict GET.
    mock_client.get.assert_called_once_with(
        "/workspaces/test/boards/b1/cards/resolve?prefix=b9d4e5ed"
    )
    assert result["title"] == "Card"


# --- set_board_loop full config editing (card 32e8927b) ----------------------


@pytest.mark.anyio
async def test_set_board_loop_config_only_puts_without_state_patch(mock_client, ctx):
    """Prompt tuning is one tool call: config fields go to PUT /loop (server
    merge rule: omitted = unchanged) and the state PATCH is NOT touched."""
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {
        "enabled": True,
        "loop_prompt": "new prompt",
        "version": 6,
    }
    result = json.loads(
        await set_board_loop(
            "test", "b1", loop_prompt="new prompt", budget_usd=15.0, ctx=ctx
        )
    )
    mock_client.put.assert_called_once_with(
        "/workspaces/test/boards/b1/loop",
        {"loop_prompt": "new prompt", "budget_usd": 15.0},
    )
    mock_client.patch.assert_not_called()
    assert result["loop_prompt"] == "new prompt"
    assert "_hint" in result


@pytest.mark.anyio
async def test_set_board_loop_config_omits_unmentioned_fields(mock_client, ctx):
    """The PUT body carries ONLY the provided fields — tools, caps, prompts
    not mentioned must not appear (the server keeps their stored values)."""
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 2}
    await set_board_loop("test", "b1", starvation_policy="always_run", ctx=ctx)
    sent = mock_client.put.call_args[0][1]
    assert sent == {"starvation_policy": "always_run"}


@pytest.mark.anyio
async def test_set_board_loop_tools_list_passes_through(mock_client, ctx):
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 2}
    await set_board_loop(
        "test", "b1",
        tools=["mcp__valaris__get_card", "mcp__valaris__set_board_loop"],
        ctx=ctx,
    )
    sent = mock_client.put.call_args[0][1]
    assert sent["tools"] == [
        "mcp__valaris__get_card",
        "mcp__valaris__set_board_loop",
    ]


@pytest.mark.anyio
async def test_set_board_loop_combined_config_then_state(mock_client, ctx):
    """Config + state in one call: PUT the config fields first, then flip the
    state through PATCH /state so the toggle stays on the rail-safe idempotent
    path."""
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 3}
    mock_client.patch.return_value = {"enabled": True, "version": 4}
    result = json.loads(
        await set_board_loop(
            "test", "b1", enabled=True, loop_prompt="go", ctx=ctx
        )
    )
    mock_client.put.assert_called_once_with(
        "/workspaces/test/boards/b1/loop", {"loop_prompt": "go"}
    )
    mock_client.patch.assert_called_once_with(
        "/workspaces/test/boards/b1/loop/state", {"enabled": True, "reason": ""}
    )
    assert result["enabled"] is True


@pytest.mark.anyio
async def test_set_board_loop_state_only_never_puts(mock_client, ctx):
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.patch.return_value = {"enabled": False, "version": 9}
    await set_board_loop("test", "b1", enabled=False, reason="done", ctx=ctx)
    mock_client.put.assert_not_called()
    mock_client.patch.assert_called_once()


@pytest.mark.anyio
async def test_set_board_loop_merge_gate_passes_through(mock_client, ctx):
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 2}
    await set_board_loop("test", "b1", merge_gate="none", ctx=ctx)
    mock_client.put.assert_called_once_with(
        "/workspaces/test/boards/b1/loop", {"merge_gate": "none"}
    )
    mock_client.patch.assert_not_called()


@pytest.mark.anyio
async def test_set_board_loop_merge_gate_omitted_stays_out_of_payload(
    mock_client, ctx
):
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 2}
    await set_board_loop("test", "b1", loop_prompt="x", ctx=ctx)
    sent = mock_client.put.call_args[0][1]
    assert "merge_gate" not in sent


@pytest.mark.anyio
async def test_set_board_loop_no_fields_is_an_error(mock_client, ctx):
    from valaris_mcp.tools.boards import set_board_loop

    raw = await set_board_loop("test", "b1", ctx=ctx)
    assert "error" in raw.lower() or "nothing to change" in raw.lower()
    mock_client.put.assert_not_called()
    mock_client.patch.assert_not_called()


# ---------------------------------------------------------------------------
# Card titles are plain text. The MCP layer must forward markup characters
# verbatim in the request body AND hand the backend's response back unchanged:
# a title returned as `He said &quot;ship it&quot;` is corruption an agent will
# faithfully propagate into notes, standups, and search results.
# ---------------------------------------------------------------------------

MARKUP_TITLE = 'He said "ship it" & left <tag> — 5 < 6 > 4'


@pytest.mark.anyio
async def test_create_card_forwards_markup_characters_verbatim(mock_client, ctx):
    from valaris_mcp.tools.cards import create_card

    mock_client.post.return_value = {"id": "c1", "title": MARKUP_TITLE}
    raw = await create_card("test", "b1", "col1", MARKUP_TITLE, ctx=ctx)

    assert mock_client.post.call_args[0][1]["title"] == MARKUP_TITLE
    assert json.loads(raw)["title"] == MARKUP_TITLE
    assert "&quot;" not in raw
    assert "&amp;" not in raw
    assert "&lt;" not in raw


@pytest.mark.anyio
async def test_update_card_forwards_markup_characters_verbatim(mock_client, ctx):
    from valaris_mcp.tools.cards import update_card

    mock_client.patch.return_value = {"id": CARD_UUID, "title": MARKUP_TITLE}
    raw = await update_card("test", "b1", CARD_UUID, title=MARKUP_TITLE, ctx=ctx)

    assert mock_client.patch.call_args[0][1]["title"] == MARKUP_TITLE
    assert json.loads(raw)["title"] == MARKUP_TITLE
    assert "&quot;" not in raw


@pytest.mark.anyio
async def test_get_card_returns_markup_characters_verbatim(mock_client, ctx):
    from valaris_mcp.tools.cards import get_card

    mock_client.get.return_value = {"id": CARD_UUID, "title": MARKUP_TITLE}
    raw = await get_card("test", "b1", CARD_UUID, ctx=ctx)

    assert json.loads(raw)["title"] == MARKUP_TITLE
    assert "&quot;" not in raw


# Card 102dc48e — max_blocked_on_human is a config knob, so the two-layer
# surface rule applies: it must be settable from MCP, not only the Loop dialog.


@pytest.mark.anyio
async def test_set_board_loop_max_blocked_on_human_passes_through(mock_client, ctx):
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 2}
    await set_board_loop("test", "b1", max_blocked_on_human=5, ctx=ctx)
    sent = mock_client.put.call_args[0][1]
    assert sent == {"max_blocked_on_human": 5}


@pytest.mark.anyio
async def test_set_board_loop_max_blocked_on_human_zero_is_sent_not_dropped(
    mock_client, ctx
):
    """0 is the documented opt-out, not an absent value — the omitted-means-
    unchanged filter must key off None, never falsiness."""
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 2}
    await set_board_loop("test", "b1", max_blocked_on_human=0, ctx=ctx)
    sent = mock_client.put.call_args[0][1]
    assert sent == {"max_blocked_on_human": 0}


# Card d223a0ec — completion_query is the run's termination condition, so the
# two-layer rule bites hardest here: an operator who can only set it in the UI
# cannot script a run, and an agent that cannot read it cannot explain a stop.


@pytest.mark.anyio
async def test_set_board_loop_completion_query_passes_through(mock_client, ctx):
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 2}
    query = {"label": "loop-3", "exclude_column_type": "done"}
    await set_board_loop("test", "b1", completion_query=query, ctx=ctx)
    sent = mock_client.put.call_args[0][1]
    assert sent == {"completion_query": query}


@pytest.mark.anyio
async def test_set_board_loop_empty_completion_query_is_sent_not_dropped(
    mock_client, ctx
):
    """`{}` is the CLEAR lever — the omitted-means-unchanged filter keys off
    None, so an empty dict must survive it and reach the backend."""
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 2}
    await set_board_loop("test", "b1", completion_query={}, ctx=ctx)
    sent = mock_client.put.call_args[0][1]
    assert sent == {"completion_query": {}}


# --- set_board_loop template binding (card 144e9724) -------------------------


@pytest.mark.anyio
async def test_set_board_loop_binds_a_template(mock_client, ctx):
    """The bind lever: template_ref/source/version/slot_values collapse into
    the ONE `template` object PUT /loop understands."""
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 3}
    await set_board_loop(
        "test",
        "b1",
        template_ref="coding-loop",
        template_source="system",
        template_version=2,
        slot_values={"RUN_LABEL": "loop-8"},
        ctx=ctx,
    )
    sent = mock_client.put.call_args[0][1]
    assert sent == {
        "template": {
            "source": "system",
            "ref": "coding-loop",
            "version": 2,
            "slot_values": {"RUN_LABEL": "loop-8"},
        }
    }


@pytest.mark.anyio
async def test_set_board_loop_bind_defaults_source_to_system(mock_client, ctx):
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 3}
    await set_board_loop("test", "b1", template_ref="coding-loop", ctx=ctx)
    sent = mock_client.put.call_args[0][1]
    assert sent["template"]["source"] == "system"
    assert "version" not in sent["template"]
    assert "slot_values" not in sent["template"]


@pytest.mark.anyio
async def test_set_board_loop_rerenders_slot_values_without_a_ref(mock_client, ctx):
    """Re-render on a bound board: slot_values alone is a legitimate edit, and
    the backend resolves the ref from the stored binding."""
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 4}
    await set_board_loop("test", "b1", slot_values={"RUN_LABEL": "loop-9"}, ctx=ctx)
    sent = mock_client.put.call_args[0][1]
    assert sent == {"template": {"slot_values": {"RUN_LABEL": "loop-9"}}}


@pytest.mark.anyio
async def test_set_board_loop_detach_sends_empty_template(mock_client, ctx):
    """Detach is `template: {}` — the same three-state convention as
    completion_query. An empty dict must survive; a falsy-check would drop it."""
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 5}
    await set_board_loop("test", "b1", detach_template=True, ctx=ctx)
    sent = mock_client.put.call_args[0][1]
    assert sent == {"template": {}}


@pytest.mark.anyio
async def test_set_board_loop_detach_wins_over_bind_args(mock_client, ctx):
    """Contradictory intent resolves to the destructive-but-explicit lever
    rather than silently binding what the caller asked to detach."""
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 5}
    await set_board_loop(
        "test", "b1", template_ref="coding-loop", detach_template=True, ctx=ctx
    )
    sent = mock_client.put.call_args[0][1]
    assert sent == {"template": {}}


@pytest.mark.anyio
async def test_set_board_loop_expected_version_is_the_optimistic_lock(mock_client, ctx):
    from valaris_mcp.tools.boards import set_board_loop

    mock_client.put.return_value = {"enabled": False, "version": 6}
    await set_board_loop("test", "b1", loop_prompt="x", expected_version=5, ctx=ctx)
    sent = mock_client.put.call_args[0][1]
    assert sent == {"loop_prompt": "x", "expected_version": 5}


@pytest.mark.anyio
async def test_set_board_loop_expected_version_alone_is_not_an_edit(mock_client, ctx):
    """A lock with nothing to lock is a caller mistake: a bare precondition
    would PUT an empty merge and bump the version for nothing."""
    from valaris_mcp.tools.boards import set_board_loop

    result = json.loads(await set_board_loop("test", "b1", expected_version=5, ctx=ctx))
    assert "error" in result
    mock_client.put.assert_not_called()


@pytest.mark.anyio
async def test_set_board_loop_template_conflict_relays_409(mock_client, ctx):
    """Hand-writing prompts on a bound board is the backend's 409; the tool
    must surface it, since that is what tells the caller to detach first."""
    import httpx

    from valaris_mcp.tools.boards import set_board_loop

    request = httpx.Request("PUT", "https://example.test/api")
    mock_client.put.side_effect = httpx.HTTPStatusError(
        "boom",
        request=request,
        response=httpx.Response(
            409,
            json={"detail": "detach first", "error_code": "board_bound_to_template"},
            request=request,
        ),
    )
    result = json.loads(await set_board_loop("test", "b1", loop_prompt="raw", ctx=ctx))
    assert result["status"] == 409
    assert result["error_code"] == "board_bound_to_template"


def test_set_board_loop_docstring_documents_the_template_levers():
    from valaris_mcp.tools.boards import set_board_loop

    doc = set_board_loop.__doc__ or ""
    assert "template_ref" in doc
    assert "detach_template" in doc
