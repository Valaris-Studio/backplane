# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import Row, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notes.save_receipt import NoteSaveReceipt
from app.repositories.dialect_insert import conflict_aware_insert


class NoteSaveReceiptRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def claim(
        self,
        *,
        user_id: uuid.UUID,
        client_request_id: uuid.UUID,
        workspace_id: uuid.UUID,
        board_id: uuid.UUID,
        card_id: uuid.UUID | None,
        fingerprint: str,
    ) -> uuid.UUID | None:
        """The new receipt's id, or None when this request id is already taken.

        On PostgreSQL a concurrent claim of the same key waits here until the
        holder's transaction ends, so None means a committed receipt exists
        (or the holder rolled back and this claim won instead)."""
        return await self.db.scalar(
            conflict_aware_insert(self.db, NoteSaveReceipt)
            .values(
                id=uuid.uuid4(),
                user_id=user_id,
                client_request_id=client_request_id,
                workspace_id=workspace_id,
                board_id=board_id,
                card_id=card_id,
                fingerprint=fingerprint,
            )
            .on_conflict_do_nothing(index_elements=["user_id", "client_request_id"])
            .returning(NoteSaveReceipt.id)
        )

    async def get(
        self, user_id: uuid.UUID, client_request_id: uuid.UUID
    ) -> NoteSaveReceipt | None:
        return await self.db.scalar(
            select(NoteSaveReceipt)
            .where(
                NoteSaveReceipt.user_id == user_id,
                NoteSaveReceipt.client_request_id == client_request_id,
            )
            .execution_options(populate_existing=True)
        )

    async def complete(
        self,
        receipt_id: uuid.UUID,
        note_id: uuid.UUID,
        *,
        published_note_revision_sha256: str,
        published_note_revision_version: int,
    ) -> None:
        await self.db.execute(
            update(NoteSaveReceipt)
            .where(NoteSaveReceipt.id == receipt_id)
            .values(
                note_id=note_id,
                published_note_revision_sha256=published_note_revision_sha256,
                published_note_revision_version=published_note_revision_version,
            )
        )

    async def get_publication_recorded_at(
        self, user_id: uuid.UUID, note_id: uuid.UUID
    ) -> datetime | None:
        return await self.db.scalar(
            select(NoteSaveReceipt.created_at).where(
                NoteSaveReceipt.user_id == user_id,
                NoteSaveReceipt.note_id == note_id,
            )
        )

    async def get_publication(
        self, user_id: uuid.UUID, note_id: uuid.UUID
    ) -> Row | None:
        """When and as what revision this person published the note; never the
        request id, fingerprint or destination."""
        return (
            await self.db.execute(
                select(
                    NoteSaveReceipt.created_at,
                    NoteSaveReceipt.published_note_revision_sha256,
                    NoteSaveReceipt.published_note_revision_version,
                ).where(
                    NoteSaveReceipt.user_id == user_id,
                    NoteSaveReceipt.note_id == note_id,
                )
            )
        ).first()
