# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""One logical MCP note edit must reach one capable backend transaction."""

from __future__ import annotations

import json
from unittest.mock import call

import httpx
import pytest

from valaris_mcp.client import current_invocation_id
from valaris_mcp.tools.notes import append_note, replace_note_section, update_note

pytestmark = pytest.mark.anyio

NOTE_ID = "10000000-0000-4000-8000-000000000001"
REQUEST_ID = "20000000-0000-4000-8000-000000000002"
CARD_ID = "30000000-0000-4000-8000-000000000003"
DIGEST = "a" * 64
STORED_BODY = json.dumps({"type": "doc", "content": [{"type": "paragraph"}]})


@pytest.fixture(autouse=True)
def note_response(mock_client):
    response = {
        "id": NOTE_ID,
        "title": "Current title",
        "content": STORED_BODY,
        "history_revision": 7,
        "revision_digest": DIGEST,
        "applied_revision": 3,
        "changed": True,
        "replayed": True,
    }
    mock_client.post.return_value = response
    mock_client.put.return_value = response


def note_path(board_id):
    scope = f"/boards/{board_id}" if board_id else ""
    return f"/workspaces/test{scope}/notes/{NOTE_ID}"


@pytest.mark.parametrize("board_id", [None, "board-1"])
@pytest.mark.parametrize("mode", ["replace", "append", "section"])
async def test_combined_edit_uses_one_capable_transaction(mode, board_id, mock_client, ctx):
    fields = {"title": "New title", "pinned": True, "card_id": CARD_ID, "content": "New body"}
    if mode == "section":
        fields["anchor_heading"] = "Existing heading"
    result = json.loads(await update_note("test", NOTE_ID, mode=mode, board_id=board_id, ctx=ctx, **fields))

    assert result["id"] == NOTE_ID  # The existing write succeeds before its split routing is examined.
    assert mock_client.method_calls == [call.post(note_path(board_id) + "/edit", {"mode": mode, **fields})]


@pytest.mark.parametrize(
    ("kwargs", "body"),
    [
        ({"title": "Rename"}, {"title": "Rename"}),
        ({"title": "Rename", "card_id": None}, {"title": "Rename"}),
        ({"pinned": False, "content": ""}, {"pinned": False, "content": ""}),
        ({"card_id": CARD_ID, "detach_card": True}, {"card_id": None}),
    ],
)
async def test_metadata_omission_clear_and_detach_preserve_intent(kwargs, body, mock_client, ctx):
    result = json.loads(await update_note("test", NOTE_ID, ctx=ctx, **kwargs))
    assert not result.get("error"), result
    assert mock_client.method_calls == [call.post(note_path(None) + "/edit", {"mode": "replace", **body})]


async def test_section_omitted_body_explicitly_clears_only_named_section(mock_client, ctx):
    result = json.loads(await update_note("test", NOTE_ID, mode="section", anchor_heading="Existing", ctx=ctx))
    assert result["id"] == NOTE_ID
    assert mock_client.method_calls == [call.post(note_path(None) + "/edit", {"mode": "section", "anchor_heading": "Existing", "content": ""})]


@pytest.mark.parametrize("expected_revision", [0, 7])
async def test_explicit_preconditions_and_retry_id_are_forwarded_once(expected_revision, mock_client, ctx):
    result = json.loads(await update_note(
        "test", NOTE_ID, mode="append", content="Next entry", title="Log",
        expected_revision=expected_revision, expected_digest=DIGEST,
        client_request_id=REQUEST_ID, ctx=ctx,
    ))
    assert not result.get("error"), result
    assert mock_client.method_calls == [call.post(note_path(None) + "/edit", {
        "mode": "append", "content": "Next entry", "title": "Log",
        "expected_revision": expected_revision, "expected_digest": DIGEST,
        "client_request_id": REQUEST_ID,
    })]


async def test_invocation_correlation_does_not_invent_retry_or_precondition_fields(mock_client, ctx):
    token = current_invocation_id.set(REQUEST_ID)
    try:
        result = json.loads(await update_note("test", NOTE_ID, content="Next", mode="append", ctx=ctx))
    finally:
        current_invocation_id.reset(token)
    assert result["id"] == NOTE_ID
    assert mock_client.post.call_args.args[1] == {"mode": "append", "content": "Next"}


@pytest.mark.parametrize("mode", ["append", "section"])
async def test_missing_edit_route_fails_closed_without_legacy_writes(mode, mock_client, ctx):
    def response(path, body):
        if path.endswith("/edit"):
            request = httpx.Request("POST", "http://fixture" + path)
            reply = httpx.Response(404, json={"detail": "Not Found"}, request=request)
            raise httpx.HTTPStatusError("old backend", request=request, response=reply)
        return {"id": NOTE_ID, "content": STORED_BODY}

    mock_client.post.side_effect = response
    fields = {"mode": mode, "content": "Next", "title": "Must stay unchanged"}
    if mode == "section":
        fields["anchor_heading"] = "Existing"
    result = json.loads(await update_note("test", NOTE_ID, ctx=ctx, **fields))
    assert result.get("error") is True and result.get("status") == 404, result
    assert mock_client.method_calls == [call.post(note_path(None) + "/edit", fields)]


@pytest.mark.parametrize("return_content", [False, True])
async def test_receipt_is_bounded_and_keeps_current_head_separate_from_replayed_operation(return_content, mock_client, ctx):
    result = json.loads(await update_note("test", NOTE_ID, title="Current title", return_content=return_content, ctx=ctx))
    assert result["history_revision"] == 7
    assert result["applied_revision"] == 3
    assert result["revision_digest"] == DIGEST
    assert result["replayed"] is True and result["changed"] is True
    assert result["content_chars"] == len(STORED_BODY)
    if return_content:
        assert result["content"] == STORED_BODY
        assert result["_content_format"] == "prosemirror"
    else:
        assert "content" not in result
    assert mock_client.get.call_count == 0


@pytest.mark.parametrize("kwargs", [
    {"mode": "unknown", "content": "Text"},
    {"mode": "append", "content": "  ", "title": "Not written"},
    {"mode": "section", "content": "Text", "title": "Not written"},
    {"mode": "replace", "anchor_heading": "Unexpected", "title": "Not written"},
])
async def test_invalid_modes_or_missing_inputs_make_no_request(kwargs, mock_client, ctx):
    result = json.loads(await update_note("test", NOTE_ID, ctx=ctx, **kwargs))
    assert result["error"] is True
    assert mock_client.method_calls == []


@pytest.mark.parametrize("alias", ["append", "section"])
async def test_deprecated_body_only_aliases_still_work_and_keep_receipts_bounded(alias, mock_client, ctx):
    if alias == "append":
        result = json.loads(await append_note("test", NOTE_ID, "Next", ctx=ctx))
    else:
        result = json.loads(await replace_note_section("test", NOTE_ID, "Existing", "Next", ctx=ctx))
    assert result["id"] == NOTE_ID
    assert result["content_chars"] == len(STORED_BODY)
    assert "content" not in result and "update_note" in result["_deprecated"]
    assert mock_client.post.call_count == 1
    mock_client.put.assert_not_called()
