# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


@mcp.tool()
@handle_api_errors
async def list_channels(
    workspace_slug: str,
    ctx: Context = None,
) -> str:
    """List a workspace's contact channels.

    Args:
        workspace_slug: Workspace slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{client.ws(workspace_slug)}/channels")
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def create_channel(
    workspace_slug: str,
    name: str,
    channel_type: str,
    contact_value: str,
    description: str = "",
    metadata_json: dict | None = None,
    ctx: Context = None,
) -> str:
    """Create a contact channel in a workspace.

    Args:
        workspace_slug: Workspace slug.
        name: Display name.
        channel_type: email|slack|whatsapp|phone|website|other.
        contact_value: Address or identifier (email, phone number, URL).
        description: Description.
        metadata_json: Extra metadata dict.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        "name": name,
        "channel_type": channel_type,
        "contact_value": contact_value,
        "description": description,
    }
    if metadata_json is not None:
        body["metadata_json"] = metadata_json
    result = await client.post(f"{client.ws(workspace_slug)}/channels", body)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def update_channel(
    workspace_slug: str,
    channel_id: str,
    name: str | None = None,
    channel_type: str | None = None,
    contact_value: str | None = None,
    description: str | None = None,
    metadata_json: dict | None = None,
    ctx: Context = None,
) -> str:
    """Update a channel; only provided fields change.

    Args:
        workspace_slug: Workspace slug.
        channel_id: Channel UUID.
        name: New display name.
        channel_type: email|slack|whatsapp|phone|website|other.
        contact_value: New address or identifier.
        description: New description.
        metadata_json: Shallow-merged per key; set a key to null to remove it.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        k: v
        for k, v in {
            "name": name,
            "channel_type": channel_type,
            "contact_value": contact_value,
            "description": description,
            "metadata_json": metadata_json,
        }.items()
        if v is not None
    }
    path = f"{client.ws(workspace_slug)}/channels/{channel_id}"
    result = await client.put(path, body)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def delete_channel(
    workspace_slug: str,
    channel_id: str,
    ctx: Context = None,
) -> str:
    """Delete a channel permanently.

    Args:
        workspace_slug: Workspace slug.
        channel_id: Channel UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"{client.ws(workspace_slug)}/channels/{channel_id}"
    await client.delete(path)
    return f"Channel {channel_id} deleted."
