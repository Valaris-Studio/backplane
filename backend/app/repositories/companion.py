# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.companion import CompanionInstallation, CompanionProjectMapping
from app.models.git.git_repo import GitRepo
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember
from app.repositories.dialect_insert import conflict_aware_insert

REPO_CATALOG_LIMIT = 1000


class CompanionRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def insert_installation(self, **values) -> bool:
        inserted = await self.db.scalar(
            conflict_aware_insert(self.db, CompanionInstallation)
            .values(**values)
            .on_conflict_do_nothing(index_elements=["id"])
            .returning(CompanionInstallation.id)
        )
        return inserted is not None

    async def get_installation(
        self, installation_id: uuid.UUID
    ) -> CompanionInstallation | None:
        return await self.db.get(
            CompanionInstallation, installation_id, populate_existing=True
        )

    async def list_installations(self, owner_id: uuid.UUID):
        result = await self.db.scalars(
            select(CompanionInstallation)
            .where(CompanionInstallation.owner_id == owner_id)
            .order_by(CompanionInstallation.created_at, CompanionInstallation.id)
        )
        return list(result)

    async def installation_by_token_hash(
        self, token_hash: str
    ) -> CompanionInstallation | None:
        return await self.db.scalar(
            select(CompanionInstallation)
            .where(CompanionInstallation.token_hash == token_hash)
            .execution_options(populate_existing=True)
        )

    async def get_mapping(
        self, installation_id: uuid.UUID, mapping_id: uuid.UUID
    ) -> CompanionProjectMapping | None:
        return await self.db.scalar(
            select(CompanionProjectMapping).where(
                CompanionProjectMapping.installation_id == installation_id,
                CompanionProjectMapping.id == mapping_id,
            )
        )

    async def get_mappings(
        self, installation_id: uuid.UUID, mapping_ids: set[uuid.UUID]
    ) -> dict[uuid.UUID, CompanionProjectMapping]:
        if not mapping_ids:
            return {}
        result = await self.db.scalars(
            select(CompanionProjectMapping).where(
                CompanionProjectMapping.installation_id == installation_id,
                CompanionProjectMapping.id.in_(mapping_ids),
            )
        )
        return {mapping.id: mapping for mapping in result}

    async def mapping_by_root(
        self, installation_id: uuid.UUID, root_path: str
    ) -> CompanionProjectMapping | None:
        return await self.db.scalar(
            select(CompanionProjectMapping).where(
                CompanionProjectMapping.installation_id == installation_id,
                CompanionProjectMapping.root_path == root_path,
            )
        )

    async def auto_mapping(
        self, installation_id: uuid.UUID, repo_url_normalized: str
    ) -> CompanionProjectMapping | None:
        return await self.db.scalar(
            select(CompanionProjectMapping).where(
                CompanionProjectMapping.installation_id == installation_id,
                CompanionProjectMapping.origin == "auto_repo",
                CompanionProjectMapping.repo_url_normalized == repo_url_normalized,
            )
        )

    async def owner_repo_mappings(
        self,
        owner_id: uuid.UUID,
        workspace_id: uuid.UUID,
        repo_url_normalized: str,
        exclude_installation_id: uuid.UUID,
    ) -> list[tuple[CompanionProjectMapping, datetime | None]]:
        """The owner's mappings of one repository into one workspace on their
        other installations, revoked ones included, each with its
        installation's revoked_at."""
        result = await self.db.execute(
            select(CompanionProjectMapping, CompanionInstallation.revoked_at)
            .join(
                CompanionInstallation,
                CompanionProjectMapping.installation_id == CompanionInstallation.id,
            )
            .where(
                CompanionInstallation.owner_id == owner_id,
                CompanionInstallation.id != exclude_installation_id,
                CompanionProjectMapping.workspace_id == workspace_id,
                CompanionProjectMapping.repo_url_normalized == repo_url_normalized,
            )
        )
        return [(mapping, revoked_at) for mapping, revoked_at in result.all()]

    async def list_mappings(self, installation_id: uuid.UUID):
        result = await self.db.scalars(
            select(CompanionProjectMapping)
            .where(CompanionProjectMapping.installation_id == installation_id)
            .order_by(
                CompanionProjectMapping.root_path,
                CompanionProjectMapping.repo_url_normalized,
            )
        )
        return list(result)

    async def insert_mapping(self, **values) -> bool:
        inserted = await self.db.scalar(
            conflict_aware_insert(self.db, CompanionProjectMapping)
            .values(**values)
            .on_conflict_do_nothing(index_elements=["installation_id", "root_path"])
            .returning(CompanionProjectMapping.id)
        )
        return inserted is not None

    async def insert_auto_mapping(self, **values) -> bool:
        inserted = await self.db.scalar(
            conflict_aware_insert(self.db, CompanionProjectMapping)
            .values(origin="auto_repo", **values)
            .on_conflict_do_nothing(
                index_elements=["installation_id", "repo_url_normalized"],
                index_where=CompanionProjectMapping.origin == "auto_repo",
            )
            .returning(CompanionProjectMapping.id)
        )
        return inserted is not None

    async def membership(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID
    ) -> WorkspaceMember | None:
        # A cached role from the request's WorkspaceDep must not outlive a
        # membership removal that committed while the body was uploading.
        return await self.db.scalar(
            select(WorkspaceMember)
            .where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.user_id == user_id,
            )
            .execution_options(populate_existing=True)
        )

    async def member_workspace_ids_of(self, user_id: uuid.UUID) -> list[uuid.UUID]:
        result = await self.db.scalars(
            select(WorkspaceMember.workspace_id).where(
                WorkspaceMember.user_id == user_id
            )
        )
        return list(result)

    async def member_workspace_ids(
        self, user_id: uuid.UUID, workspace_ids: set[uuid.UUID]
    ) -> set[uuid.UUID]:
        if not workspace_ids:
            return set()
        result = await self.db.scalars(
            select(WorkspaceMember.workspace_id).where(
                WorkspaceMember.user_id == user_id,
                WorkspaceMember.workspace_id.in_(workspace_ids),
            )
        )
        return set(result)

    async def board_in_workspace(
        self, workspace_id: uuid.UUID, board_id: uuid.UUID
    ) -> bool:
        found = await self.db.scalar(
            select(Board.id).where(
                Board.id == board_id, Board.workspace_id == workspace_id
            )
        )
        return found is not None

    async def get_user(self, user_id: uuid.UUID) -> User | None:
        return await self.db.get(User, user_id)

    async def reachable_boards(self, user_id: uuid.UUID):
        """(workspace, board) rows for every workspace `user_id` currently
        belongs to; the board is None for a workspace without boards."""
        result = await self.db.execute(
            select(Workspace, Board)
            .join(
                WorkspaceMember,
                (WorkspaceMember.workspace_id == Workspace.id)
                & (WorkspaceMember.user_id == user_id),
            )
            .outerjoin(Board, Board.workspace_id == Workspace.id)
            .order_by(Workspace.name, Workspace.id, Board.name, Board.id)
        )
        return result.all()

    async def repo_catalog(self, user_id: uuid.UUID):
        """Git repos on boards in every workspace `user_id` currently belongs to."""
        result = await self.db.execute(
            select(
                Workspace.slug,
                Workspace.id,
                Workspace.name,
                Board.id,
                Board.name,
                GitRepo.url,
            )
            .join(Board, GitRepo.board_id == Board.id)
            .join(Workspace, Board.workspace_id == Workspace.id)
            .join(
                WorkspaceMember,
                (WorkspaceMember.workspace_id == Workspace.id)
                & (WorkspaceMember.user_id == user_id),
            )
            .order_by(Workspace.slug, Board.name, GitRepo.id)
            .limit(REPO_CATALOG_LIMIT)
        )
        return result.all()
