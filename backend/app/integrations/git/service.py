# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Provider-agnostic GitService Protocol — Sprint 1 read-only surface.

LAYER: integrations (provider-agnostic, OAuth, multi-provider).
The legacy single-token path lives in app/services/github_client.py — used by
hot paths (Done-gate, card service) that haven't been migrated yet.

Adapters (GitHubAdapter, GitLabAdapter, BitbucketAdapter) implement this
Protocol and translate between provider SDKs and our normalized models.
NO write methods here — Sprint 2 adds open_pull_request, comment_on_pr,
etc. once OAuth is in place.

Rules:
  1. Adapters never leak provider-specific types — always return our
     Pydantic domain models (app.integrations.git.models).
  2. `repo_id` is opaque from our side. GitHub uses "owner/name"; GitLab
     uses a numeric project id. Clients treat it as a blob.
  3. `raw()` is the escape hatch for the 5% of features that only make
     sense on one provider. Document every call site.
"""

from typing import AsyncIterator, Protocol

from app.integrations.git.models import Branch, Repository
from app.integrations.git.models import User as GitUser


class GitService(Protocol):
    provider: str

    async def get_authenticated_user(self) -> GitUser: ...

    async def list_repositories(
        self, *, cursor: str | None = None
    ) -> tuple[list[Repository], str | None]: ...

    async def get_repository(self, repo_id: str) -> Repository: ...

    async def list_branches(self, repo_id: str) -> AsyncIterator[Branch]: ...

    async def get_authenticated_clone_url(self, repo_id: str) -> str: ...

    async def raw(self) -> object: ...
