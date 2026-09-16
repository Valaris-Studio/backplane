# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Platform-level metadata endpoints.

These return non-sensitive, workspace-agnostic data the frontend uses to
drive editors and validators. Auth is the standard `get_current_user`
dependency — the values are public to any signed-in user.
"""

from fastapi import APIRouter, Depends

from app.core.auth import get_current_user
from app.models.user import User
from app.services.agents.lifecycle_kinds import KIND_DOCS, LIFECYCLE_KINDS

router = APIRouter(prefix="/api/config", tags=["config"])


@router.get("/lifecycle-kinds")
async def list_lifecycle_kinds(
    _current_user: User = Depends(get_current_user),
):
    """Return the closed registry of lifecycle step kinds plus operator docs.

    `kinds` drives the step editor and client-side validation (schema + flags).
    `docs` carries the human-facing explanation of each kind — sibling map, keyed
    by the same names, so the editor can teach what a step does. Backend remains
    authoritative on both.
    """
    return {"kinds": LIFECYCLE_KINDS, "docs": KIND_DOCS}
