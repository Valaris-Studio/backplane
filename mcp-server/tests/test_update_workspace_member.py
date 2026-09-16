# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import pytest


@pytest.mark.anyio
async def test_update_workspace_member_patches_the_member_role(mock_client, ctx):
    from valaris_mcp.tools.workspaces import update_workspace_member

    mock_client.patch.return_value = {
        "user_id": "u1",
        "email": "member@valaris.dev",
        "name": "Member User",
        "role": "admin",
        "joined_at": "2026-08-01T00:00:00",
    }
    result = await update_workspace_member("test", "u1", role="admin", ctx=ctx)

    mock_client.patch.assert_called_once_with(
        "/workspaces/test/members/u1", {"role": "admin"}
    )
    assert json.loads(result) == mock_client.patch.return_value


def test_update_workspace_member_is_importable():
    """Red until the tool exists — the endpoint's MCP surface is part of the
    card's DoD, not an afterthought."""
    from valaris_mcp.tools.workspaces import update_workspace_member

    assert callable(update_workspace_member)


def test_add_workspace_member_docstring_disclaims_role_changes():
    """add_workspace_member is idempotent on duplicate membership: the role
    argument is IGNORED for an existing member. The docstring must say so and
    route the caller to update_workspace_member, or an agent will 'change' a
    role with a POST and trust the silent no-op."""
    from valaris_mcp.tools.workspaces import add_workspace_member

    doc = add_workspace_member.__doc__ or ""
    assert "update_workspace_member" in doc
    assert "ignored" in doc.lower()
