# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ConflictError, ForbiddenError, ResourceNotFoundError
from app.models.activity import ActivityAction, ActivityEntityType
from app.models.kanban.column import ColumnType
from app.models.user import User
from app.models.workspace import WorkspaceRole
from app.repositories.activity import ActivityRepository
from app.repositories.channels.channel import ChannelRepository
from app.repositories.kanban.board import BoardRepository
from app.repositories.notes.note import NoteRepository
from app.repositories.user import UserRepository
from app.repositories.workspace import WorkspaceMemberRepository, WorkspaceRepository
from app.schemas.workspace import WorkspaceCreate, WorkspaceRead, WorkspaceUpdate
from app.services.activity import ActivityService
from app.utils import utcnow


_DISTRIBUTION_BUCKETS = [column_type.value for column_type in ColumnType] + ["untyped"]

# The summary always carries the 30-day trend; the dashboard's 7-day view is a
# tail slice of it, so switching ranges costs no extra request.
_ACTIVITY_TREND_DAYS = 30


class WorkspaceService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.workspace_repo = WorkspaceRepository(db)
        self.member_repo = WorkspaceMemberRepository(db)
        self.user_repo = UserRepository(db)

    async def list_workspaces(self, user: User) -> list[WorkspaceRead]:
        rows = await self.workspace_repo.list_for_user_with_counts(user.id)
        return [
            WorkspaceRead.model_validate(ws).model_copy(
                update={
                    "board_count": board_count,
                    "card_count": card_count,
                    "last_activity_at": last_activity_at,
                }
            )
            for ws, board_count, card_count, last_activity_at in rows
        ]

    async def create_workspace(self, data: WorkspaceCreate, user: User):
        # Idempotent on slug collision only for MEMBERS of the colliding
        # workspace (LLM-retry resilience — the creator is always owner, so
        # retries keep working). A stranger gets an opaque 409: returning the
        # workspace would hand any authed caller its metadata by slug probe,
        # so the message carries no name/id/anything.
        existing = await self.workspace_repo.get_by_slug(data.slug)
        if existing:
            membership = await self.member_repo.get_membership(existing.id, user.id)
            if membership is not None:
                return existing
            raise ConflictError(f"Workspace slug '{data.slug}' is already taken")

        workspace = await self.workspace_repo.create(
            name=data.name, slug=data.slug, created_by=user.id
        )
        await self.member_repo.add_member(workspace.id, user.id, WorkspaceRole.owner)
        activity = ActivityService(self.db)
        await activity.record(
            workspace_id=workspace.id,
            actor_id=user.id,
            entity_type=ActivityEntityType.workspace,
            entity_id=workspace.id,
            action=ActivityAction.created,
            summary=f"created workspace '{data.name}'",
            message_key="activity.workspace.created",
            message_params={"workspace_name": data.name},
        )
        return workspace

    async def update_workspace(
        self,
        workspace_id: uuid.UUID,
        data: WorkspaceUpdate,
        actor_id: uuid.UUID | None = None,
    ):
        workspace = await self.workspace_repo.get_by_id(workspace_id)
        if not workspace:
            raise ResourceNotFoundError("Workspace not found")
        changed_fields = list(data.model_dump(exclude_unset=True).keys())
        updated = await self.workspace_repo.update(
            workspace, **data.model_dump(exclude_unset=True)
        )
        if actor_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.workspace,
                entity_id=workspace_id,
                action=ActivityAction.updated,
                summary=f"updated workspace '{updated.name}'",
                message_key="activity.workspace.updated",
                message_params={
                    "workspace_name": updated.name,
                    "fields": changed_fields,
                },
                changes={"fields": changed_fields},
            )
        return updated

    async def delete_workspace(self, workspace_id: uuid.UUID):
        workspace = await self.workspace_repo.get_by_id(workspace_id)
        if not workspace:
            raise ResourceNotFoundError("Workspace not found")
        await self.workspace_repo.delete_by_id(workspace.id)

    async def add_member(
        self,
        workspace_id: uuid.UUID,
        email: str,
        role: WorkspaceRole,
        actor_id: uuid.UUID | None = None,
        initial_password: str | None = None,
    ):
        from app.core.auth import normalize_email

        # Canonical before the domain gate and user resolution, so an invite in
        # any casing lands on the one identity row.
        email = normalize_email(email)
        # Only an owner may mint/assign the owner role — an admin passing the
        # get_workspace_admin gate must not be able to escalate itself or others.
        if role == WorkspaceRole.owner:
            await self._require_owner(workspace_id, actor_id)

        if initial_password is not None:
            # Membership alone is never domain-gated (an explicit invite is a
            # deliberate act), but a LOGIN-CAPABLE credential honors the same
            # allowlist as first-run setup.
            from app.core.auth import email_domain_allowed

            if not email_domain_allowed(email):
                raise ForbiddenError(
                    "Email domain not allowed",
                    error_code="email_domain_not_allowed",
                )
        user = await self.user_repo.get_or_create(email)
        password_granted = False
        if initial_password is not None:
            # No-op for accounts that already hold a credential (L8): "add
            # member" must never be a password-overwrite side channel, and
            # retries stay idempotent.
            from app.services.auth.local_auth import LocalAuthService

            password_granted = await LocalAuthService(self.db).grant_initial_password(
                user, initial_password
            )
        # Idempotent on duplicate membership (LLM-retry resilience).
        existing = await self.member_repo.get_membership(workspace_id, user.id)
        if existing:
            return existing
        result = await self.member_repo.add_member(workspace_id, user.id, role)
        if actor_id:
            activity = ActivityService(self.db)
            summary = f"added {email} as {role.value}"
            if password_granted:
                summary += " with an initial password"
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.member,
                entity_id=user.id,
                action=ActivityAction.added_member,
                summary=summary,
                message_key=(
                    "activity.member.added_with_initial_password"
                    if password_granted
                    else "activity.member.added"
                ),
                message_params={"member_email": email, "role": role.value},
                # workspace_member generation resolves recipients from
                # params["affected_user_id"]; carry it so the added user is
                # actually notified (entity_id alone isn't read by generation).
                changes={"affected_user_id": str(user.id)},
            )
        return result

    async def update_member_role(
        self,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
        new_role: WorkspaceRole,
        actor_id: uuid.UUID | None = None,
    ):
        target = await self.member_repo.get_membership_with_user(workspace_id, user_id)
        if target is None:
            raise ResourceNotFoundError("User is not a member of this workspace")

        owner_involved = (
            new_role == WorkspaceRole.owner or target.role == WorkspaceRole.owner
        )
        if owner_involved:
            # Granting or demoting an owner is consent only a human can give.
            # An agent key carries its creating user's role, so without this
            # gate an agent bound to an owner could mint or strip owners on
            # that human's behalf. Lazy import as in kanban/board.py:
            # core.auth and the service layer load each other lazily.
            from app.core.auth import current_agent_id

            if current_agent_id.get() is not None:
                raise ForbiddenError(
                    "Owner-role changes are a human act — an agent key may "
                    "not grant or demote owners",
                    error_code="human_required",
                )
            # Symmetric with add_member/remove_member: touching the owner
            # role in either direction is owner-only.
            await self._require_owner(workspace_id, actor_id)
            if target.role == WorkspaceRole.owner and new_role != WorkspaceRole.owner:
                await self.member_repo.lock_owner_memberships(workspace_id)
                if await self.member_repo.count_owners(workspace_id) <= 1:
                    raise ForbiddenError(
                        "Cannot demote the last owner of a workspace",
                        error_code="last_owner",
                    )

        if target.role == new_role:
            # Idempotent no-op — retries must not spam the activity timeline.
            return target

        previous_role = target.role.value
        updated = await self.member_repo.set_role(target, new_role)
        if actor_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.member,
                entity_id=user_id,
                action=ActivityAction.updated,
                summary=(
                    f"changed {target.user.email}'s role from "
                    f"{previous_role} to {new_role.value}"
                ),
                message_key="activity.member.role_changed",
                message_params={
                    "member_email": target.user.email,
                    "role": new_role.value,
                    "previous_role": previous_role,
                },
                changes={"affected_user_id": str(user_id)},
            )
        return updated

    async def set_member_temporary_password(
        self,
        workspace_id: uuid.UUID,
        target_user_id: uuid.UUID,
        actor_id: uuid.UUID,
        password: str | None = None,
    ) -> str:
        """The L6 lockout/forgotten-password escape hatch — no SMTP, ever.

        Authorization is the L8 rule: managing a workspace's members implies
        managing their credentials. Checked here (not only at the router) so
        every entry point shares one gate.
        """
        await self._require_admin_or_owner(workspace_id, actor_id)
        target = await self.member_repo.get_membership(workspace_id, target_user_id)
        if target is None:
            raise ResourceNotFoundError("User is not a member of this workspace")
        user = await self.user_repo.get_by_id(target_user_id)
        if user is None:
            raise ResourceNotFoundError("User not found")

        import secrets

        from app.services.auth.local_auth import LocalAuthService

        # token_urlsafe(12) -> 16 chars, comfortably past MIN_PASSWORD_LENGTH.
        temporary_password = password or secrets.token_urlsafe(12)
        await LocalAuthService(self.db).set_temporary_password(user, temporary_password)
        activity = ActivityService(self.db)
        await activity.record(
            workspace_id=workspace_id,
            actor_id=actor_id,
            entity_type=ActivityEntityType.member,
            entity_id=user.id,
            action=ActivityAction.updated,
            summary=f"set a temporary password for {user.email}",
            message_key="activity.member.temporary_password_set",
            message_params={"member_email": user.email},
            changes={"affected_user_id": str(user.id)},
        )
        return temporary_password

    async def _require_admin_or_owner(
        self, workspace_id: uuid.UUID, actor_id: uuid.UUID | None
    ) -> None:
        if actor_id is None:
            raise ForbiddenError("Only a workspace admin may manage credentials")
        actor = await self.member_repo.get_membership(workspace_id, actor_id)
        if actor is None or actor.role not in (
            WorkspaceRole.owner,
            WorkspaceRole.admin,
        ):
            raise ForbiddenError("Only a workspace admin may manage credentials")

    async def remove_member(
        self,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
        actor_id: uuid.UUID | None = None,
    ):
        target = await self.member_repo.get_membership(workspace_id, user_id)
        if target and target.role == WorkspaceRole.owner:
            # Removing an owner is owner-only, and never allowed to strip the
            # workspace of its last owner (would orphan it with no one able to
            # manage members).
            await self._require_owner(workspace_id, actor_id)
            await self.member_repo.lock_owner_memberships(workspace_id)
            if await self.member_repo.count_owners(workspace_id) <= 1:
                raise ForbiddenError(
                    "Cannot remove the last owner of a workspace",
                    error_code="last_owner",
                )

        if actor_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.member,
                entity_id=user_id,
                action=ActivityAction.removed_member,
                summary="removed member from workspace",
                message_key="activity.member.removed",
                message_params={},
                changes={"affected_user_id": str(user_id)},
            )
        await self.member_repo.remove_member(workspace_id, user_id)

    async def _require_owner(
        self, workspace_id: uuid.UUID, actor_id: uuid.UUID | None
    ) -> None:
        """Guard for owner-only operations. A missing actor_id means an
        unattributed/system caller and is not trusted with owner escalation."""
        if actor_id is None:
            raise ForbiddenError(
                "Only an owner may manage the owner role",
                error_code="owner_role_owner_only",
            )
        actor = await self.member_repo.get_membership(workspace_id, actor_id)
        if actor is None or actor.role != WorkspaceRole.owner:
            raise ForbiddenError(
                "Only an owner may manage the owner role",
                error_code="owner_role_owner_only",
            )

    async def list_members(self, workspace_id: uuid.UUID):
        return await self.member_repo.list_members(workspace_id)

    # Autocomplete needs a SHORT list; clamp the caller's limit (contract §6).
    _MEMBER_SEARCH_DEFAULT_LIMIT = 10
    _MEMBER_SEARCH_MAX_LIMIT = 20

    async def search_members(
        self,
        workspace_id: uuid.UUID,
        q: str,
        limit: int | None = None,
    ):
        effective_limit = limit or self._MEMBER_SEARCH_DEFAULT_LIMIT
        effective_limit = max(1, min(effective_limit, self._MEMBER_SEARCH_MAX_LIMIT))
        return await self.member_repo.search_members(workspace_id, q, effective_limit)

    async def get_summary(self, workspace_id: uuid.UUID) -> dict:
        board_repo = BoardRepository(self.db)
        note_repo = NoteRepository(self.db)
        channel_repo = ChannelRepository(self.db)
        activity_repo = ActivityRepository(self.db)

        board_count = await board_repo.count_by_workspace(workspace_id)
        card_count = await board_repo.count_cards_by_workspace(workspace_id)
        note_count = await note_repo.count_workspace_notes(workspace_id)
        channel_count = await channel_repo.count_by_workspace(workspace_id)
        recent_activity = await activity_repo.list_by_workspace(workspace_id, limit=5)
        board_stats = await self._build_board_stats(board_repo, workspace_id)
        # UTC, not date.today(): activity created_at is stamped in UTC by
        # ActivityRepository.record and bucketed in UTC by the query below, so a
        # local-timezone anchor on a non-UTC host shifts the window off the data
        # and the newest day's activity falls outside it entirely.
        trend_rows = await activity_repo.daily_counts_by_workspace(
            workspace_id, utcnow().date(), days=_ACTIVITY_TREND_DAYS
        )

        return {
            "board_count": board_count,
            "card_count": card_count,
            "note_count": note_count,
            "channel_count": channel_count,
            "recent_activity": recent_activity,
            "board_stats": board_stats,
            "activity_trend": [
                {"day": day, "count": count} for day, count in trend_rows
            ],
        }

    async def _build_board_stats(
        self, board_repo: BoardRepository, workspace_id: uuid.UUID
    ) -> list[dict]:
        """Merge the grouped card aggregation onto the board list so boards with
        no cards still appear with zeroed buckets — the aggregation only yields
        rows for boards that have cards."""
        boards = await board_repo.list_by_workspace(workspace_id)
        distribution_rows = await board_repo.card_distribution_by_workspace(
            workspace_id, date.today()
        )

        stats_by_board: dict[uuid.UUID, dict] = {
            board.id: {
                "board_id": board.id,
                "name": board.name,
                "slug": board.slug,
                "card_count": 0,
                "overdue_count": 0,
                "distribution": {bucket: 0 for bucket in _DISTRIBUTION_BUCKETS},
            }
            for board in boards
        }

        for board_id, column_type, card_count, overdue_count in distribution_rows:
            stats = stats_by_board.get(board_id)
            if stats is None:
                continue
            bucket = column_type.value if column_type is not None else "untyped"
            stats["distribution"][bucket] += card_count
            stats["card_count"] += card_count
            stats["overdue_count"] += overdue_count

        return [stats_by_board[board.id] for board in boards]
