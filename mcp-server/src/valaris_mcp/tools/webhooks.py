# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import httpx
from mcp.server.fastmcp import Context

from valaris_mcp.deprecation import deprecated_tool
from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


@mcp.tool()
@handle_api_errors
async def create_webhook(
    workspace_slug: str,
    url: str,
    events: list[str],
    secret: str,
    ctx: Context = None,
) -> str:
    """Create a webhook delivering workspace events to a URL, HMAC-SHA256 signed with the secret.

    Args:
        workspace_slug: Workspace slug.
        url: Delivery URL (https-only outside development).
        events: Event names; see ENUMS in the server instructions.
        secret: HMAC signing secret.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.post(
        f"{client.ws(workspace_slug)}/webhooks",
        {"url": url, "events": events, "secret": secret},
    )
    result["_hint"] = (
        "Webhook created. Events will be delivered to the URL with an HMAC-SHA256 "
        "signature in the X-Webhook-Signature-256 header as sha256=<hex>. "
        "Verify using the secret you provided. Change it later with update_webhook "
        "(is_active=false pauses deliveries, delete=true removes it)."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def list_webhooks(
    workspace_slug: str,
    is_active: bool | None = None,
    ctx: Context = None,
) -> str:
    """List a workspace's webhooks.

    Args:
        workspace_slug: Workspace slug.
        is_active: true = active only, false = inactive only.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    params = {}
    if is_active is not None:
        params["is_active"] = str(is_active).lower()
    result = await client.get(f"{client.ws(workspace_slug)}/webhooks", **params)
    return json.dumps(
        {
            "webhooks": result,
            "count": len(result),
            "_hint": (
                "Use create_webhook to add subscriptions and update_webhook to change "
                "one (delete=true removes it)."
            ),
        },
        indent=2,
        default=str,
    )


@mcp.tool()
@handle_api_errors
async def get_webhook(
    workspace_slug: str,
    webhook_id: str,
    ctx: Context = None,
) -> str:
    """Read one webhook's URL, events, active state, and delivery health;
    not-found under another workspace's slug.

    Args:
        workspace_slug: Workspace slug.
        webhook_id: Webhook UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{client.ws(workspace_slug)}/webhooks/{webhook_id}")
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def update_webhook(
    workspace_slug: str,
    webhook_id: str,
    url: str | None = None,
    events: list[str] | None = None,
    secret: str | None = None,
    is_active: bool | None = None,
    delete: bool = False,
    ctx: Context = None,
) -> str:
    """Update a webhook; only passed fields change. is_active=false pauses deliveries reversibly; delete=true removes the registration for good (deliveries stop at once; an already-deleted webhook reports so) and accepts no other field.

    Args:
        workspace_slug: Workspace slug.
        webhook_id: Webhook UUID.
        url: New delivery URL.
        events: REPLACES the whole subscription list.
        secret: New HMAC secret; update the receiver too.
        is_active: false pauses deliveries, true resumes.
        delete: True permanently removes the webhook (no undo); alone, with no other field. Prefer is_active=false to pause.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        key: value
        for key, value in {
            "url": url,
            "events": events,
            "secret": secret,
            "is_active": is_active,
        }.items()
        if value is not None
    }
    if delete:
        if body:
            return json.dumps(
                {
                    "error": True,
                    "message": "delete=True removes the webhook and accepts no other field; "
                    f"drop {sorted(body)} or use is_active=false to pause it",
                },
                indent=2,
            )
        return json.dumps(await _delete_webhook(client, workspace_slug, webhook_id), indent=2)
    path = f"{client.ws(workspace_slug)}/webhooks/{webhook_id}"
    result = await client.patch(path, body)
    return json.dumps(result, indent=2, default=str)


async def _delete_webhook(client, workspace_slug: str, webhook_id: str) -> dict:
    path = f"{client.ws(workspace_slug)}/webhooks/{webhook_id}"
    try:
        await client.delete(path)
    except httpx.HTTPStatusError as e:
        # Idempotency: the second call of a retried delete must converge, not
        # error. Every other status still falls through to handle_api_errors.
        if e.response.status_code != 404:
            raise
        return {
            "deleted": True,
            "webhook_id": webhook_id,
            "_hint": "Webhook not found — already deleted, nothing to do.",
        }
    return {"deleted": True, "webhook_id": webhook_id, "_hint": "Webhook deleted; deliveries stopped."}


@deprecated_tool()
@handle_api_errors
async def delete_webhook(workspace_slug: str, webhook_id: str, ctx: Context = None) -> str:
    """Permanently remove a webhook; an already-deleted one reports so.

    Args:
        workspace_slug: Workspace slug.
        webhook_id: Webhook UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await _delete_webhook(app.client, workspace_slug, webhook_id)
    if "not found" in result["_hint"]:
        return f"Webhook {webhook_id} not found (or already deleted) — nothing to do."
    return f"Webhook {webhook_id} deleted."
