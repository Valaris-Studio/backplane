# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The server owns authorization, preconditions and receipts for empty edits."""

from __future__ import annotations

import json
from unittest.mock import call

import httpx
import pytest

from valaris_mcp.tools.notes import update_note

pytestmark = pytest.mark.anyio

NOTE_ID = "10000000-0000-4000-8000-000000000011"
REQUEST_ID = "20000000-0000-4000-8000-000000000012"
DIGEST = "b" * 64
EDIT_PATH = f"/workspaces/test/notes/{NOTE_ID}/edit"
STORED_BODY = json.dumps({"type": "doc", "content": [{"type": "paragraph"}]})
GUARDS = {
    "expected_revision": 0,
    "expected_digest": DIGEST,
    "client_request_id": REQUEST_ID,
}


def receipt(*, replayed=False, changed=False, history_revision=0, applied_revision=None):
    return {
        "id": NOTE_ID,
        "title": "Current title",
        "content": STORED_BODY,
        "history_revision": history_revision,
        "revision_digest": DIGEST,
        "applied_revision": applied_revision,
        "changed": changed,
        "replayed": replayed,
    }


@pytest.mark.parametrize("replayed", [False, True])
async def test_guard_only_replace_reaches_server_and_preserves_noop_receipt(replayed, mock_client, ctx):
    # A replay may return a newer current head; it still applied no revision.
    current_revision = 7 if replayed else 0
    mock_client.post.return_value = receipt(replayed=replayed, history_revision=current_revision)

    result = json.loads(await update_note("test", NOTE_ID, ctx=ctx, **GUARDS))

    assert mock_client.method_calls == [call.post(EDIT_PATH, {"mode": "replace", **GUARDS})]
    assert not result.get("error"), result
    assert result["changed"] is False
    assert result["applied_revision"] is None
    assert result["replayed"] is replayed
    assert result["history_revision"] == current_revision
    assert result["revision_digest"] == DIGEST
    assert result["content_chars"] == len(STORED_BODY)
    assert "content" not in result


async def test_bare_empty_replace_is_a_server_authorized_noop(mock_client, ctx):
    mock_client.post.return_value = receipt()

    result = json.loads(await update_note("test", NOTE_ID, ctx=ctx))

    assert mock_client.method_calls == [call.post(EDIT_PATH, {"mode": "replace"})]
    assert not result.get("error"), result
    assert result["changed"] is False
    assert result["applied_revision"] is None
    assert result["replayed"] is False
    assert result["history_revision"] == 0


async def test_actual_field_edit_still_uses_one_atomic_request(mock_client, ctx):
    mock_client.post.return_value = receipt(changed=True, history_revision=2, applied_revision=2)

    result = json.loads(await update_note("test", NOTE_ID, title="Rename", ctx=ctx, **GUARDS))

    assert mock_client.method_calls == [call.post(EDIT_PATH, {"mode": "replace", "title": "Rename", **GUARDS})]
    assert not result.get("error"), result
    assert result["changed"] is True
    assert result["applied_revision"] == 2
    assert result["replayed"] is False


@pytest.mark.parametrize(
    ("status", "error_code", "detail"),
    [
        (403, "forbidden", "Current note access denied"),
        (409, "revision_conflict", "The note no longer matches the edit precondition"),
    ],
)
async def test_guard_only_replace_preserves_server_denial_or_conflict(status, error_code, detail, mock_client, ctx):
    request = httpx.Request("POST", "http://fixture" + EDIT_PATH)
    response = httpx.Response(status, json={"detail": detail, "error_code": error_code}, request=request)
    mock_client.post.side_effect = httpx.HTTPStatusError("Edit rejected", request=request, response=response)

    result = json.loads(await update_note("test", NOTE_ID, ctx=ctx, **GUARDS))

    assert mock_client.method_calls == [call.post(EDIT_PATH, {"mode": "replace", **GUARDS})]
    assert result == {"error": True, "status": status, "message": detail, "error_code": error_code}
