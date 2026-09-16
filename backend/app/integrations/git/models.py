# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Provider-agnostic Pydantic domain models.

LAYER: integrations (provider-agnostic, OAuth, multi-provider).
The legacy single-token path lives in app/services/github_client.py — used by
hot paths (Done-gate, card service) that haven't been migrated yet.

Flat by design — each adapter normalizes its provider-specific shape into
these models on the way out. `provider_data` is the escape hatch for fields
we haven't normalized yet (e.g. GitLab approval rules); it lives on
Repository + PullRequest only.
"""

from datetime import datetime

from pydantic import BaseModel


class User(BaseModel):
    provider: str
    id: str
    username: str
    email: str | None = None
    avatar_url: str | None = None


class Repository(BaseModel):
    provider: str
    id: str
    full_name: str
    default_branch: str
    private: bool
    clone_url_https: str
    updated_at: datetime
    provider_data: dict = {}


class Branch(BaseModel):
    provider: str
    name: str
    sha: str


class PullRequest(BaseModel):
    provider: str
    id: str
    number: int
    title: str
    body: str | None = None
    state: str
    source_branch: str
    target_branch: str
    author: User
    created_at: datetime
    updated_at: datetime
    url: str
    provider_data: dict = {}
