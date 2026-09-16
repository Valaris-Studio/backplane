# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json

import pytest

from valaris_mcp.tools.boards import set_board_loop


@pytest.mark.anyio
@pytest.mark.parametrize("stored_reason", [None, "Earlier operator stop"])
async def test_same_state_disabled_receipt_does_not_claim_new_reason_saved(
    mock_client, ctx, stored_reason
):
    mock_client.patch.return_value = {
        "enabled": False,
        "disabled_reason": stored_reason,
        "version": 2,
    }
    result = json.loads(
        await set_board_loop("test", "b1", enabled=False, reason="New requested stop", ctx=ctx)
    )
    mock_client.put.assert_not_called()
    assert result["disabled_reason"] == stored_reason
    assert "the reason is stored" not in result["_hint"]
    assert "not stored" in result["_hint"]
