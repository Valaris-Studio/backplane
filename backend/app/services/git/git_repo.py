# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from sqlalchemy import select

from app.exceptions import ConflictError, ResourceNotFoundError, ValidationError
from app.models.activity import ActivityAction, ActivityEntityType
from app.models.git.git_connection import GitConnection
from app.models.git.git_repo import GitProvider, GitRepo
from app.repositories.git.git_repo import GitRepoRepository
from app.schemas.git.git_repo import GitRepoCreate, GitRepoUpdate
from app.services.activity import ActivityService
from app.services.kanban.freeze_guard import assert_board_not_frozen
from app.utils import slugify


class GitRepoService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = GitRepoRepository(db)

    async def _validate_connection(
        self,
        connection_id: uuid.UUID,
        workspace_id: uuid.UUID,
        provider: GitProvider,
    ) -> None:
        """A binding is only usable if the credential can actually serve the repo.

        Rejecting a cross-provider or cross-workspace binding here means
        CredentialResolver never has to treat one as a runtime surprise — the
        row cannot exist in the first place.
        """
        connection = (
            await self.db.execute(
                select(GitConnection).where(
                    GitConnection.id == connection_id,
                    GitConnection.workspace_id == workspace_id,
                )
            )
        ).scalar_one_or_none()
        if connection is None:
            raise ValidationError(
                f"Git connection {connection_id} not found in this workspace."
            )
        conn_provider = connection.provider
        if isinstance(conn_provider, GitProvider):
            conn_provider = conn_provider.value
        repo_provider = provider.value if isinstance(provider, GitProvider) else provider
        if conn_provider != repo_provider:
            raise ValidationError(
                f"Connection '{connection.account_login}' is a {conn_provider} "
                f"credential and cannot authenticate against a {repo_provider} "
                "repository. Pick a connection for the repository's provider."
            )

    async def _resolve_unique_slug(
        self, board_id: uuid.UUID, base: str
    ) -> str:
        candidate = base
        suffix = 2
        while await self.repo.slug_exists(board_id, candidate):
            candidate = f"{base}-{suffix}"
            suffix += 1
        return candidate

    async def create_git_repo(
        self,
        board_id: uuid.UUID,
        workspace_id: uuid.UUID,
        data: GitRepoCreate,
        user_id: uuid.UUID,
    ) -> tuple[GitRepo, bool]:
        """Create a repo; idempotent on user-supplied slug collision.

        Returns (repo, created). When `created` is False, the caller should
        respond 200 with the pre-existing repo instead of 201.
        """
        await assert_board_not_frozen(self.db, board_id)
        if data.connection_id is not None:
            await self._validate_connection(
                data.connection_id, workspace_id, data.provider
            )
        if data.slug:
            existing = await self.repo.get_by_slug(board_id, data.slug)
            if existing:
                return existing, False
            slug = data.slug
        else:
            slug = await self._resolve_unique_slug(board_id, slugify(data.name, fallback="repo"))

        git_repo = await self.repo.create(
            board_id=board_id,
            workspace_id=workspace_id,
            name=data.name,
            slug=slug,
            url=data.url,
            provider=data.provider,
            default_branch=data.default_branch,
            description=data.description,
            require_branch_protection=data.require_branch_protection,
            connection_id=data.connection_id,
            added_by=user_id,
        )
        activity = ActivityService(self.db)
        await activity.record(
            workspace_id=workspace_id,
            actor_id=user_id,
            board_id=board_id,
            entity_type=ActivityEntityType.git_repo,
            entity_id=git_repo.id,
            action=ActivityAction.created,
            summary=f"linked git repo '{data.name}'",
            message_key="activity.git_repo.linked",
            message_params={"git_repo_name": data.name},
        )
        return git_repo, True

    async def list_git_repos(self, board_id: uuid.UUID):
        return await self.repo.list_by_board(board_id)

    async def get_git_repo(self, repo_id: uuid.UUID, board_id: uuid.UUID) -> GitRepo:
        git_repo = await self.repo.get_by_id(repo_id)
        if not git_repo or git_repo.board_id != board_id:
            raise ResourceNotFoundError("Git repo not found")
        return git_repo

    async def get_git_repo_by_identifier(
        self, identifier: str, board_id: uuid.UUID
    ) -> GitRepo:
        """Resolve a repo by UUID string or slug, scoped to `board_id`."""
        try:
            repo_uuid = uuid.UUID(identifier)
        except ValueError:
            repo_uuid = None

        git_repo: GitRepo | None = None
        if repo_uuid is not None:
            git_repo = await self.repo.get_by_id(repo_uuid)
            if git_repo and git_repo.board_id != board_id:
                git_repo = None
        if git_repo is None:
            git_repo = await self.repo.get_by_slug(board_id, identifier)
        if not git_repo:
            raise ResourceNotFoundError("Git repo not found")
        return git_repo

    async def update_git_repo(
        self,
        repo_id: uuid.UUID,
        board_id: uuid.UUID,
        data: GitRepoUpdate,
        workspace_id: uuid.UUID | None = None,
        actor_id: uuid.UUID | None = None,
    ):
        await assert_board_not_frozen(self.db, board_id)
        from app.services.completion_policy import CompletionPolicyService
        board = await CompletionPolicyService(self.db).lock_board_for_completion(board_id, workspace_id)
        git_repo = await self.repo.get_by_id(repo_id)
        if not git_repo or git_repo.board_id != board_id:
            raise ResourceNotFoundError("Git repo not found")
        patch = data.model_dump(exclude_unset=True)
        if patch.get("connection_id") is not None:
            # Validate against the provider this repo will HAVE after the patch,
            # not the one it has now — a single request may change both.
            await self._validate_connection(
                patch["connection_id"],
                git_repo.workspace_id,
                patch.get("provider") or git_repo.provider,
            )
        if "slug" in patch and patch["slug"] and patch["slug"] != git_repo.slug:
            if await self.repo.slug_exists(board_id, patch["slug"], exclude_id=git_repo.id):
                raise ConflictError(
                    f"slug '{patch['slug']}' already exists on this board"
                )
        changed_fields = list(patch.keys())
        contract_fields = {"url", "provider", "slug", "default_branch", "integration_branch", "connection_id"}
        if any(key in contract_fields and getattr(git_repo, key) != value for key, value in patch.items()):
            from app.services.completion import CompletionService
            await CompletionService(self.db).invalidate_board(board, "Repository completion configuration changed")
        updated = await self.repo.update(git_repo, **patch)
        if actor_id and workspace_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                board_id=board_id,
                entity_type=ActivityEntityType.git_repo,
                entity_id=repo_id,
                action=ActivityAction.updated,
                summary=f"updated git repo '{updated.name}'",
                message_key="activity.git_repo.updated",
                message_params={
                    "git_repo_name": updated.name,
                    "fields": changed_fields,
                },
                changes={"fields": changed_fields},
            )
        return updated

    async def delete_git_repo(
        self,
        repo_id: uuid.UUID,
        board_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
        actor_id: uuid.UUID | None = None,
    ):
        await assert_board_not_frozen(self.db, board_id)
        from app.services.completion import CompletionService
        from app.services.completion_policy import CompletionPolicyService

        board = await CompletionPolicyService(self.db).lock_board_for_completion(board_id, workspace_id)
        git_repo = await self.repo.get_by_id(repo_id)
        if not git_repo or git_repo.board_id != board_id:
            raise ResourceNotFoundError("Git repo not found")
        await CompletionService(self.db).invalidate_board(board, "Repository was unlinked")
        if actor_id and workspace_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                board_id=git_repo.board_id,
                entity_type=ActivityEntityType.git_repo,
                entity_id=repo_id,
                action=ActivityAction.deleted,
                summary=f"unlinked git repo '{git_repo.name}'",
                message_key="activity.git_repo.unlinked",
                message_params={"git_repo_name": git_repo.name},
            )
        await self.repo.delete(git_repo)
