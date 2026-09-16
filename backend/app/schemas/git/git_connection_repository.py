# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Outbound schemas for the per-connection repo picker.

Subset of `app.integrations.git.models.Repository` — the picker UI needs
identity + clonability + private/default-branch metadata; provider_data
stays inside the integrations layer.
"""

from __future__ import annotations

from datetime import datetime

from app.core.json_response import UTCModel


class RepositoryRead(UTCModel):
    provider: str
    id: str
    full_name: str
    default_branch: str
    private: bool
    clone_url_https: str
    updated_at: datetime


class RepositoryPage(UTCModel):
    items: list[RepositoryRead]
    next_cursor: str | None = None
