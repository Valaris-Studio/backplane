# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json

import httpx
import pytest

from valaris_mcp.tools.notes import list_notes


def page(mock_client, notes, total):
    mock_client.request_raw.return_value = httpx.Response(
        200, json=notes, headers={"X-Total-Count": str(total)}
    )


@pytest.mark.anyio
async def test_default_page_is_bounded_summary_with_continuation(mock_client, ctx):
    page(mock_client, [{"id": str(i)} for i in range(25)], 633)
    result = json.loads(await list_notes("ws", board_id="b1", ctx=ctx))
    mock_client.request_raw.assert_awaited_once_with(
        "GET",
        "/workspaces/ws/boards/b1/notes",
        params={"summary_only": "true", "limit": 25, "offset": 0},
    )
    assert len(result["notes"]) == 25
    assert result["total"] == 633
    assert result["next_offset"] == 25
    assert result["has_more"] is True


@pytest.mark.anyio
async def test_filters_are_encoded_as_params_and_compose(mock_client, ctx):
    page(mock_client, [{"id": "last"}], 26)
    result = json.loads(
        await list_notes(
            "ws",
            board_id="b1",
            card_id="c1",
            q="PT03 & café?",
            pinned_only=True,
            kinds=["plan", "review_verdict"],
            limit=25,
            offset=25,
            summary_only=False,
            ctx=ctx,
        )
    )
    params = mock_client.request_raw.call_args.kwargs["params"]
    assert params == {
        "summary_only": "false",
        "limit": 25,
        "offset": 25,
        "card_id": "c1",
        "q": "PT03 & café?",
        "pinned_only": "true",
        "kinds": ["plan", "review_verdict"],
    }
    assert result["next_offset"] is None
    assert result["has_more"] is False


@pytest.mark.anyio
@pytest.mark.parametrize(
    "kwargs", [{"limit": 0}, {"limit": 101}, {"offset": -1}, {"card_id": "c1"}]
)
async def test_invalid_paging_or_scope_does_not_fetch(mock_client, ctx, kwargs):
    result = json.loads(await list_notes("ws", ctx=ctx, **kwargs))
    assert result["error"] is True
    mock_client.request_raw.assert_not_awaited()
    mock_client.get.assert_not_awaited()


@pytest.mark.anyio
async def test_missing_count_never_claims_complete_inventory(mock_client, ctx):
    mock_client.request_raw.return_value = httpx.Response(200, json=[{"id": "n1"}])
    result = json.loads(await list_notes("ws", ctx=ctx))
    assert result["error"] is True
    assert "pagination" in result["message"].lower()


@pytest.mark.anyio
async def test_empty_page_reports_no_continuation(mock_client, ctx):
    page(mock_client, [], 0)
    result = json.loads(await list_notes("ws", ctx=ctx))
    assert result["notes"] == []
    assert result["total"] == 0
    assert result["next_offset"] is None


@pytest.mark.anyio
@pytest.mark.parametrize(
    "notes,total,offset", [([{"id": "n1"}], 0, 0), ([{"id": "n1"}], 1, 25), ([], 1, 0)]
)
async def test_inconsistent_live_page_does_not_claim_completion(
    mock_client, ctx, notes, total, offset
):
    page(mock_client, notes, total)
    result = json.loads(await list_notes("ws", offset=offset, ctx=ctx))
    assert result["error"] is True
