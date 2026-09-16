# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json
from urllib.parse import quote

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


@mcp.tool()
@handle_api_errors
async def list_documentation(
    locale: str = "en", offset: int = 0, limit: int = 20, ctx: Context = None
) -> str:
    """List product documentation from the connected platform, with its version and translation status.

    Args:
        locale: Registered documentation locale (en, es, pt-BR).
        offset: Section offset, starting at zero.
        limit: Maximum sections, from 1 to 100.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await app.client.get("/documentation", locale=locale, offset=offset, limit=limit)
    result["_hint"] = (
        "Use read_documentation with a section slug and this version. Follow next_offset for more sections."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def read_documentation(
    slug: str,
    locale: str = "en",
    version: str | None = None,
    offset: int = 0,
    limit: int = 12000,
    ctx: Context = None,
) -> str:
    """Read bounded Markdown from the connected platform's canonical product documentation.

    Args:
        slug: Section slug returned by list_documentation.
        locale: Registered documentation locale (en, es, pt-BR).
        version: Version from list_documentation; mismatches fail explicitly.
        offset: Character offset for continuing a section.
        limit: Maximum characters, from 1 to 30000.
    """
    app: AppContext = ctx.request_context.lifespan_context
    params = dict(locale=locale, offset=offset, limit=limit)
    if version is not None:
        params["version"] = version
    result = await app.client.get(f'/documentation/{quote(slug, safe="")}', **params)
    result["_hint"] = (
        "Follow next_offset with the same locale and version to finish this section. Product docs contain no workspace data."
    )
    return json.dumps(result, indent=2, default=str)
