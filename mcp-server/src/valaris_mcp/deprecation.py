# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Registration path for deprecated tool aliases.

A retired or renamed tool is re-registered through `deprecated_tool()` for one
minor version (see `catalog.DEPRECATION_REMOVAL_VERSION`). The alias keeps its
old name and behaviour, logs one warning per call, and stamps the result with
the replacement so a model that still calls it learns the new name in-band.
The catalog seam hides aliases from every toolset and count; the backend
frontend-catalog drift test collects `@mcp.tool()` only, so aliases never reach
the pipeline builder's tool picker.
"""
from __future__ import annotations

import functools
import json
import logging
from typing import Any, Awaitable, Callable

from valaris_mcp.catalog import TOOL_META, deprecation_line
from valaris_mcp.server import mcp

logger = logging.getLogger(__name__)

# Attribute stamped on the registered function so the catalog can prove the
# table and the registration path agree.
DEPRECATED_MARKER = "__deprecated_alias__"


def with_deprecation_notice(name: str, result: str) -> str:
    """Add the notice to a tool result: a `_deprecated` key on a JSON object,
    a leading line on anything else (plain text, JSON arrays)."""
    notice = deprecation_line(name, TOOL_META[name])
    try:
        payload = json.loads(result)
    except (TypeError, ValueError):
        payload = None
    if isinstance(payload, dict):
        payload["_deprecated"] = notice
        return json.dumps(payload, indent=2, default=str)
    return f"{notice}\n{result}"


def deprecated_tool() -> Callable[[Callable[..., Awaitable[str]]], Callable[..., Awaitable[str]]]:
    """Register `fn` under its own name as a deprecated alias.

    The replacement prose comes from `TOOL_META[fn.__name__].deprecated_for`
    (looked up at call time so the table stays the single source).
    """

    def decorate(fn: Callable[..., Awaitable[str]]) -> Callable[..., Awaitable[str]]:
        name = fn.__name__

        @functools.wraps(fn)
        async def alias(*args: Any, **kwargs: Any) -> str:
            logger.warning(
                "deprecated tool called: %s — %s", name, deprecation_line(name, TOOL_META[name])
            )
            return with_deprecation_notice(name, await fn(*args, **kwargs))

        setattr(alias, DEPRECATED_MARKER, True)
        mcp.tool()(alias)
        return alias

    return decorate
