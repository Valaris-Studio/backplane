# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError
from app.models.activity import ActivityAction, ActivityEntityType
from app.repositories.definitions.definition import DefinitionRepository
from app.schemas.definitions.definition import DefinitionUpsert
from app.services.activity import ActivityService
from app.services.kanban.freeze_guard import assert_board_not_frozen
from app.utils import shallow_merge_dicts


class DefinitionService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = DefinitionRepository(db)

    async def get_definition(self, board_id: uuid.UUID, workspace_id: uuid.UUID):
        definition = await self.repo.get_by_board(board_id)
        if not definition or definition.workspace_id != workspace_id:
            raise ResourceNotFoundError("Definition not found")
        return definition

    async def export_definition(
        self,
        board_id: uuid.UUID,
        workspace_id: uuid.UUID,
        workspace_slug: str,
        board_slug: str,
    ) -> dict:
        from app.services.export.envelope import build_envelope

        definition = await self.get_definition(board_id, workspace_id)
        return build_envelope(
            entity_type="definition",
            source_workspace_slug=workspace_slug,
            source_board_slug=board_slug,
            data={
                "scope": definition.scope,
                "content": definition.content,
            },
        )

    async def upsert_definition(
        self,
        board_id: uuid.UUID,
        workspace_id: uuid.UUID,
        data: DefinitionUpsert,
        user_id: uuid.UUID,
    ):
        await assert_board_not_frozen(self.db, board_id)
        existing = await self.repo.get_by_board(board_id)

        if existing:
            update_data = data.model_dump(exclude_unset=True)
            if "content" in update_data and existing.content:
                update_data["content"] = shallow_merge_dicts(
                    existing.content, update_data["content"]
                )
            definition = await self.repo.update(
                existing,
                updated_by=user_id,
                **update_data,
            )
            action = ActivityAction.updated
            summary = "updated board definition"
        else:
            definition = await self.repo.create(
                board_id=board_id,
                workspace_id=workspace_id,
                updated_by=user_id,
                **data.model_dump(exclude_unset=True),
            )
            action = ActivityAction.created
            summary = "created board definition"

        activity = ActivityService(self.db)
        await activity.record(
            workspace_id=workspace_id,
            actor_id=user_id,
            entity_type=ActivityEntityType.definition,
            entity_id=definition.id,
            action=action,
            board_id=board_id,
            summary=summary,
            message_key=(
                "activity.definition.updated"
                if action == ActivityAction.updated
                else "activity.definition.created"
            ),
            message_params={},
        )

        return definition
