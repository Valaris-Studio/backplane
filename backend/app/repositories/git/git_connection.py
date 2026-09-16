# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pure data-access for git_connections.

LAYER: integrations (provider-agnostic, OAuth, multi-provider).
The legacy single-token path lives in app/services/github_client.py — used by
hot paths (Done-gate, card service) that haven't been migrated yet.

No encryption/decryption here — that's the service layer's concern. This
repo just shuttles bytes in and out of Postgres.
"""

import uuid

from sqlalchemy import select

from app.models.git.git_connection import GitConnection
from app.repositories.base import BaseRepository


class GitConnectionRepository(BaseRepository[GitConnection]):
    model = GitConnection

    async def list_by_workspace(
        self, workspace_id: uuid.UUID
    ) -> list[GitConnection]:
        result = await self.db.execute(
            select(GitConnection)
            .where(GitConnection.workspace_id == workspace_id)
            .order_by(GitConnection.created_at.desc())
        )
        return list(result.scalars().all())

    async def get_by_workspace_provider_login(
        self, workspace_id: uuid.UUID, provider: str, account_login: str
    ) -> GitConnection | None:
        result = await self.db.execute(
            select(GitConnection).where(
                GitConnection.workspace_id == workspace_id,
                GitConnection.provider == provider,
                GitConnection.account_login == account_login,
            )
        )
        return result.scalar_one_or_none()
