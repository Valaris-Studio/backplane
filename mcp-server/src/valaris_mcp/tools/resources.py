# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import httpx
from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp
from valaris_mcp.uploads import UploadRefused, embed_markdown, load_payload

OBJECT_NOT_UPLOADED = "object_not_uploaded"


def _stable_content_path(slug: str, resource_id: str) -> str:
    # Board-scoped resources are served by the workspace-level route too.
    return f"/api/workspaces/{slug}/resources/{resource_id}/content"


def _json_or_none(response: httpx.Response):
    try:
        return response.json()
    except ValueError:
        return None


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
    """Create a file or folder resource; for uploads PUT first, then pass gcs_path (type and size come from the stored object). See docs.

    Args:
        name: Resource name.
        resource_type: file|folder.
        parent_id: Parent folder UUID.
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
    try:
        result = await client.post(_resources_path(client, workspace_slug, board_id), body)
    except httpx.HTTPStatusError as e:
        error_body = _json_or_none(e.response)
        if not isinstance(error_body, dict) or error_body.get("error_code") != OBJECT_NOT_UPLOADED:
            raise
        return json.dumps(
            {
                "error": True,
                "status": e.response.status_code,
                "message": error_body.get("detail"),
                "error_code": OBJECT_NOT_UPLOADED,
                "_hint": (
                    "Nothing is stored at gcs_path yet. PUT the file bytes to the upload_url "
                    "from get_upload_url (same Content-Type), then retry create_resource "
                    "with the same gcs_path."
                ),
            },
            indent=2,
        )
    if gcs_path is not None and isinstance(result, dict) and result.get("id"):
        result["content_url"] = _stable_content_path(workspace_slug, str(result["id"]))
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
        resource_id: Resource UUID.
        metadata: Shallow-merged; only tags survive, replacing the whole list.
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
        filename: File name.
        content_type: MIME type.
        board_id: Board UUID if board-scoped.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"{_resources_path(client, workspace_slug, board_id)}/upload-url"
    result = await client.post(path, {"filename": filename, "content_type": content_type})
    result["_hint"] = (
        "PUT the file to upload_url now (it expires; never store it), then call create_resource "
        "with gcs_path. Its content_url is the stable link to embed in notes."
    )
    return json.dumps(result, indent=2, default=str)


def _refusal(
    message: str, error_code: str, status: int | None = None, hint: str | None = None
) -> str:
    payload: dict = {"error": True, "message": message, "error_code": error_code}
    if status is not None:
        payload["status"] = status
    if hint:
        payload["_hint"] = hint
    return json.dumps(payload, indent=2)


def _with_embed(slug: str, resource: dict) -> dict:
    content_url = _stable_content_path(slug, str(resource["id"]))
    resource["content_url"] = content_url
    resource["embed_markdown"] = embed_markdown(
        resource.get("name") or "file",
        content_url,
        resource.get("mime_type"),
        resource.get("size_bytes"),
    )
    return resource


@mcp.tool()
@handle_api_errors
async def upload_resource(
    workspace_slug: str,
    path: str | None = None,
    content_base64: str | None = None,
    filename: str | None = None,
    content_type: str | None = None,
    board_id: str | None = None,
    parent_id: str | None = None,
    description: str | None = None,
    ctx: Context = None,
) -> str:
    """Upload a file the user asked for as a resource; returns content_url and embed_markdown for notes. See docs.

    Args:
        path: Local file; stdio only, 25 MiB cap.
        content_base64: Base64 bytes; 5 MiB cap.
        filename: Required with content_base64.
        content_type: MIME type; default sniffed.
        board_id: Board UUID if board-scoped.
        parent_id: Folder UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    try:
        payload = load_payload(path, content_base64, filename, content_type)
    except UploadRefused as refused:
        return _refusal(str(refused), refused.error_code)

    scope_path = _resources_path(client, workspace_slug, board_id)
    receipt_key = (workspace_slug, board_id, parent_id, payload.filename, payload.sha256)
    if (earlier_id := app.uploaded_resources.get(receipt_key)) is not None:
        try:
            existing = await client.get(f"{scope_path}/{earlier_id}")
        except httpx.HTTPStatusError as e:
            if e.response.status_code != 404:
                raise
            del app.uploaded_resources[receipt_key]
        else:
            result = _with_embed(workspace_slug, existing)
            result["already_uploaded"] = True
            result["_hint"] = (
                "Same bytes, name and scope were uploaded earlier in this session; nothing re-uploaded."
            )
            return json.dumps(result, indent=2, default=str)

    target = await client.post(
        f"{scope_path}/upload-url",
        {"filename": payload.filename, "content_type": payload.content_type},
    )
    try:
        await client.put_bytes(target["upload_url"], payload.data, payload.content_type)
    except httpx.HTTPStatusError as e:
        # The signed URL is a credential: report the status, never the URL or the storage body.
        return _refusal(
            f"Uploading to storage failed with HTTP {e.response.status_code}.",
            "upload_failed",
            status=e.response.status_code,
            hint="Retry upload_resource; it asks for a fresh upload URL.",
        )
    except (httpx.HTTPError, ValueError) as e:
        return _refusal(
            f"Uploading to storage failed ({type(e).__name__}).",
            "upload_failed",
            hint="Retry upload_resource; it asks for a fresh upload URL.",
        )

    body = {"name": payload.filename, "resource_type": "file", "gcs_path": target["gcs_path"]}
    if parent_id is not None:
        body["parent_id"] = parent_id
    if description is not None:
        body["description"] = description
    try:
        created = await client.post(scope_path, body)
    except httpx.HTTPStatusError as e:
        error_body = _json_or_none(e.response)
        if not isinstance(error_body, dict) or error_body.get("error_code") != OBJECT_NOT_UPLOADED:
            raise
        return _refusal(
            str(error_body.get("detail")),
            OBJECT_NOT_UPLOADED,
            status=e.response.status_code,
            hint="Storage did not keep the bytes. Retry upload_resource; it uploads again.",
        )
    app.uploaded_resources[receipt_key] = str(created["id"])
    result = _with_embed(workspace_slug, created)
    result["_hint"] = (
        "Paste embed_markdown into a note (alone on its line for an attachment); "
        "content_url is the stable link."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_download_url(
    workspace_slug: str,
    resource_id: str,
    board_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Get a short-lived download_url to fetch now and the stable content_url to embed in notes. See docs.

    Args:
        resource_id: Resource UUID.
        board_id: Board UUID if board-scoped.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"{_resources_path(client, workspace_slug, board_id)}/{resource_id}/download-url"
    result = await client.get(path)
    if result.get("content_url"):
        result["_hint"] = (
            "Embed content_url in notes and links: it is stable and needs app auth. "
            "download_url expires; fetch with it now, never store it."
        )
    else:
        result["_hint"] = "download_url expires; fetch with it now, never store it in notes."
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
        resource_id: Resource UUID.
        board_id: Board UUID if board-scoped.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"{_resources_path(client, workspace_slug, board_id)}/{resource_id}"
    await client.delete(path)
    return f"Resource {resource_id} deleted."
