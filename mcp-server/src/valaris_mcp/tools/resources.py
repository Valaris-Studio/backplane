# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


def _resources_path(client, slug: str, board_id: str | None) -> str:
    if board_id:
        return f"{client.board(slug, board_id)}/resources"
    return f"{client.ws(slug)}/resources"


@mcp.tool()
@handle_api_errors
async def list_resources(
    workspace_slug: str,
    board_id: str | None = None,
    parent_id: str | None = None,
    search: str | None = None,
    resource_type: str | None = None,
    tag: str | None = None,
    ctx: Context = None,
) -> str:
    """List resources in a workspace or board, with optional filters.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID if board-scoped.
        parent_id: Parent folder UUID.
        search: Name search.
        resource_type: file|folder.
        tag: Tag filter.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    params = {}
    if parent_id is not None:
        params["parent_id"] = parent_id
    if search is not None:
        params["q"] = search
    if resource_type is not None:
        params["resource_type"] = resource_type
    if tag is not None:
        params["tag"] = tag
    result = await client.get(_resources_path(client, workspace_slug, board_id), **params)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_resource(
    workspace_slug: str,
    resource_id: str,
    board_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Get a resource by id.

    Args:
        workspace_slug: Workspace slug.
        resource_id: Resource UUID.
        board_id: Board UUID if board-scoped.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"{_resources_path(client, workspace_slug, board_id)}/{resource_id}"
    result = await client.get(path)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def create_resource(
    workspace_slug: str,
    name: str,
    resource_type: str = "file",
    parent_id: str | None = None,
    description: str | None = None,
    metadata: dict | None = None,
    gcs_path: str | None = None,
    board_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Create a file or folder resource. For uploads: get_upload_url, PUT the file, then pass its gcs_path here.

    Args:
        workspace_slug: Workspace slug.
        name: Resource name.
        resource_type: file|folder.
        parent_id: Parent folder UUID.
        description: Description.
        metadata: Metadata dict.
        gcs_path: Storage path from get_upload_url (uploaded files).
        board_id: Board UUID if board-scoped.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {"name": name, "resource_type": resource_type}
    if parent_id is not None:
        body["parent_id"] = parent_id
    if description is not None:
        body["description"] = description
    if metadata is not None:
        body["metadata"] = metadata
    if gcs_path is not None:
        body["gcs_path"] = gcs_path
    result = await client.post(_resources_path(client, workspace_slug, board_id), body)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def update_resource(
    workspace_slug: str,
    resource_id: str,
    name: str | None = None,
    description: str | None = None,
    metadata: dict | None = None,
    parent_id: str | None = None,
    board_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Update a resource; only provided fields change.

    Args:
        workspace_slug: Workspace slug.
        resource_id: Resource UUID.
        name: New name.
        description: New description.
        metadata: Shallow-merged per key; only `tags` survives validation, and a tags array replaces the whole list.
        parent_id: New parent folder UUID (moves it).
        board_id: Board UUID if board-scoped.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        k: v
        for k, v in {
            "name": name,
            "description": description,
            "metadata": metadata,
            "parent_id": parent_id,
        }.items()
        if v is not None
    }
    path = f"{_resources_path(client, workspace_slug, board_id)}/{resource_id}"
    result = await client.put(path, body)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_upload_url(
    workspace_slug: str,
    filename: str,
    content_type: str,
    board_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Get a signed URL to PUT a file to, then register it with create_resource.

    Args:
        workspace_slug: Workspace slug.
        filename: File name.
        content_type: MIME type.
        board_id: Board UUID if board-scoped.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"{_resources_path(client, workspace_slug, board_id)}/upload-url"
    result = await client.post(path, {"filename": filename, "content_type": content_type})
    result["_hint"] = "Upload your file to upload_url via HTTP PUT, then call create_resource with the gcs_path to register it."
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_download_url(
    workspace_slug: str,
    resource_id: str,
    board_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Get a signed download URL (valid 1 hour) for a resource's file; errors if it has no file.

    Args:
        workspace_slug: Workspace slug.
        resource_id: Resource UUID.
        board_id: Board UUID if board-scoped.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"{_resources_path(client, workspace_slug, board_id)}/{resource_id}/download-url"
    result = await client.get(path)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def delete_resource(
    workspace_slug: str,
    resource_id: str,
    board_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Delete a resource permanently.

    Args:
        workspace_slug: Workspace slug.
        resource_id: Resource UUID.
        board_id: Board UUID if board-scoped.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"{_resources_path(client, workspace_slug, board_id)}/{resource_id}"
    await client.delete(path)
    return f"Resource {resource_id} deleted."
