# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError, ValidationError
from app.models.activity import ActivityAction, ActivityEntityType
from app.repositories.kanban.column import ColumnRepository
from app.schemas.kanban.column import ColumnCreate, ColumnUpdate
from app.services.activity import ActivityService
from app.services.completion_policy import CompletionPolicyService
from app.models.kanban.column import ColumnType
from app.services.kanban.freeze_guard import assert_board_not_frozen
from app.services.kanban.snapshots import snapshot_column


class ColumnService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.column_repo = ColumnRepository(db)

    async def create_column(
        self, board_id: uuid.UUID, data: ColumnCreate,
        workspace_id: uuid.UUID | None = None, actor_id: uuid.UUID | None = None,
    ):
        await assert_board_not_frozen(self.db, board_id)
        max_pos = await self.column_repo.get_max_position(board_id)
        column = await self.column_repo.create(
            board_id=board_id,
            name=data.name,
            color=data.color,
            column_type=data.column_type,
            position=max_pos + 1024.0,
        )
        if actor_id and workspace_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id, actor_id=actor_id,
                entity_type=ActivityEntityType.column, entity_id=column.id,
                action=ActivityAction.created, board_id=board_id,
                summary=f"created column '{data.name}'",
                message_key="activity.column.created",
                message_params={"column_name": data.name},
                after_state=snapshot_column(column),
            )
        return column

    async def update_column(
        self, column_id: uuid.UUID, board_id: uuid.UUID, data: ColumnUpdate,
        workspace_id: uuid.UUID | None = None, actor_id: uuid.UUID | None = None,
    ):
        await assert_board_not_frozen(self.db, board_id)
        column = await self.column_repo.get_by_id(column_id)
        if not column or column.board_id != board_id:
            raise ResourceNotFoundError("Column not found")
        if data.column_type == ColumnType.done:
            completion = CompletionPolicyService(self.db)
            board = await completion.lock_board_for_completion(board_id, workspace_id)
            for card in await completion.repo.column_cards(column_id):
                await completion.assert_card_complete(board, card)
        before_state = snapshot_column(column)
        changed_fields = list(data.model_dump(exclude_unset=True).keys())
        updated = await self.column_repo.update(column, **data.model_dump(exclude_unset=True))
        if actor_id and workspace_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id, actor_id=actor_id,
                entity_type=ActivityEntityType.column, entity_id=column_id,
                action=ActivityAction.updated, board_id=board_id,
                summary=f"updated column '{updated.name}': changed {', '.join(changed_fields)}",
                message_key="activity.column.updated",
                message_params={
                    "column_name": updated.name,
                    "fields": changed_fields,
                },
                changes={"fields": changed_fields},
                before_state=before_state,
                after_state=snapshot_column(updated),
            )
        return updated

    async def delete_column(
        self, column_id: uuid.UUID, board_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None, actor_id: uuid.UUID | None = None,
    ):
        await assert_board_not_frozen(self.db, board_id)
        column = await self.column_repo.get_by_id(column_id)
        if not column or column.board_id != board_id:
            raise ResourceNotFoundError("Column not found")
        if actor_id and workspace_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id, actor_id=actor_id,
                entity_type=ActivityEntityType.column, entity_id=column_id,
                action=ActivityAction.deleted, board_id=board_id,
                summary=f"deleted column '{column.name}'",
                message_key="activity.column.deleted",
                message_params={"column_name": column.name},
                before_state=snapshot_column(column),
            )
        await self.column_repo.delete(column)

    async def reorder_columns(
        self, board_id: uuid.UUID, column_ids: list[uuid.UUID],
        *, workspace_id: uuid.UUID | None = None, actor_id: uuid.UUID | None = None,
    ):
        await assert_board_not_frozen(self.db, board_id)
        # Reject ids outside this board BEFORE any write — batch_update_positions
        # selects purely by id, so an unvalidated foreign UUID would reposition
        # another board's (or tenant's) column. Same guard as bulk_create_cards.
        valid_column_ids = await self.column_repo.get_ids_for_board(
            board_id, set(column_ids)
        )
        invalid_ids = set(column_ids) - valid_column_ids
        if invalid_ids:
            raise ValidationError(
                f"Column(s) not found in this board: {', '.join(str(i) for i in invalid_ids)}"
            )

        # Capture pre-reorder positions so the timeline can fold each move. A
        # reorder is modeled as one `updated` column activity per column whose
        # position actually changed — the contract's "moved(reorder) -> upsert
        # column from after_state" so the FE reconstruction has per-column data.
        before_by_id = {}
        if actor_id and workspace_id:
            for col_id in column_ids:
                col = await self.column_repo.get_by_id(col_id)
                if col is not None:
                    before_by_id[col_id] = snapshot_column(col)

        await self.column_repo.batch_update_positions(column_ids)

        if not (actor_id and workspace_id):
            return

        activity = ActivityService(self.db)
        for col_id in column_ids:
            before = before_by_id.get(col_id)
            if before is None:
                continue
            col = await self.column_repo.get_by_id(col_id)
            if col is None:
                continue
            after = snapshot_column(col)
            if after["position"] == before["position"]:
                continue  # unchanged slot -> no event (avoid reorder noise)
            await activity.record(
                workspace_id=workspace_id, actor_id=actor_id,
                entity_type=ActivityEntityType.column, entity_id=col_id,
                action=ActivityAction.updated, board_id=board_id,
                summary=f"reordered column '{col.name}'",
                message_key="activity.column.reordered",
                message_params={"column_name": col.name},
                changes={"position": {"old": before["position"], "new": after["position"]}},
                before_state=before,
                after_state=after,
            )
