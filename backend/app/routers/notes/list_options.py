# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Shared query-option assembly for the two notes list endpoints.

Both routers (workspace-level and board-level) expose the identical param set
against the identical service call, so the translation lives here rather than
being written twice and drifting.
"""
from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import Request


def build_list_options(
    request: Request,
    q: str | None,
    order_by: Literal["updated_at", "created_at", "title", "author"],
    direction: Literal["asc", "desc"],
    pinned_only: bool,
    authors: list[uuid.UUID] | None,
    kinds: list[str] | None,
    limit: int | None,
    offset: int,
) -> dict[str, Any]:
    """Translate the wire params into `NoteService.list_notes_page` kwargs.

    The one non-mechanical part is `order_by`. Its documented default is
    `updated_at`, but the LEGACY list order — the one a param-less call has
    always returned, and the one MCP's `list_notes` and every existing client
    parse — is pinned-first-then-newest-created. Those are different orders, so
    the default can't simply be applied: we pass `order_by=None` (meaning "keep
    the legacy order") unless the caller actually put the param on the URL.
    Reading the raw query string is what distinguishes "didn't ask" from
    "asked for the value that happens to be the default".
    """
    explicitly_ordered = "order_by" in request.query_params
    return {
        "q": q,
        "order_by": order_by if explicitly_ordered else None,
        "direction": direction,
        "pinned_only": pinned_only,
        "authors": authors,
        "kinds": kinds,
        "limit": limit,
        "offset": offset,
    }
