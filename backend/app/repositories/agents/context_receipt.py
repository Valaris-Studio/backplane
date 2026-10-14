# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

from app.models.agents.context_receipt import (
    ExecutionContextBinding,
    ExecutionContextReceipt,
)
from app.repositories.dialect_insert import conflict_aware_insert


class ExecutionContextBindingRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def claim(self, **values) -> uuid.UUID | None:
        """The new binding's id, or None when the hold was already promoted.

        On PostgreSQL a concurrent promotion of the same hold waits here until
        the holder's transaction ends, so None means a committed binding exists
        (or the holder rolled back and this claim won instead)."""
        return await self.db.scalar(
            conflict_aware_insert(self.db, ExecutionContextBinding)
            .values(id=uuid.uuid4(), **values)
            .on_conflict_do_nothing(index_elements=["reservation_id"])
            .returning(ExecutionContextBinding.id)
        )

    async def get_by_reservation(
        self, reservation_id: uuid.UUID
    ) -> ExecutionContextBinding | None:
        return await self.db.scalar(
            select(ExecutionContextBinding)
            .where(ExecutionContextBinding.reservation_id == reservation_id)
            .execution_options(populate_existing=True)
        )

    async def get_by_execution(
        self, execution_id: uuid.UUID
    ) -> ExecutionContextBinding | None:
        return await self.db.scalar(
            select(ExecutionContextBinding).where(
                ExecutionContextBinding.execution_id == execution_id
            )
        )

    async def by_execution_ids(
        self, execution_ids: set[uuid.UUID]
    ) -> dict[uuid.UUID, ExecutionContextBinding]:
        if not execution_ids:
            return {}
        result = await self.db.execute(
            select(ExecutionContextBinding).where(
                ExecutionContextBinding.execution_id.in_(execution_ids)
            )
        )
        return {binding.execution_id: binding for binding in result.scalars()}


_SUMMARY_COLUMNS = (
    ExecutionContextReceipt.id,
    ExecutionContextReceipt.execution_id,
    ExecutionContextReceipt.ordinal,
    ExecutionContextReceipt.client_request_id,
    ExecutionContextReceipt.context_revision,
    ExecutionContextReceipt.prompt_sha256,
    ExecutionContextReceipt.prompt_bytes,
    ExecutionContextReceipt.system_prompt_sha256,
    ExecutionContextReceipt.system_prompt_bytes,
    ExecutionContextReceipt.provider,
    ExecutionContextReceipt.model,
    ExecutionContextReceipt.status,
    ExecutionContextReceipt.use_verification,
    ExecutionContextReceipt.created_at,
    # The small written-once summary, never the `dispatch` detail with spans.
    ExecutionContextReceipt.dispatch_summary,
)


class ExecutionContextReceiptRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def insert(self, **values) -> uuid.UUID | None:
        """The new receipt's id, or None when this request key already exists
        for the execution (committed by a concurrent or earlier attempt)."""
        return await self.db.scalar(
            conflict_aware_insert(self.db, ExecutionContextReceipt)
            .values(id=uuid.uuid4(), **values)
            .on_conflict_do_nothing(index_elements=["execution_id", "client_request_id"])
            .returning(ExecutionContextReceipt.id)
        )

    async def get_by_request(
        self, execution_id: uuid.UUID, client_request_id: str
    ) -> ExecutionContextReceipt | None:
        return await self.db.scalar(
            select(ExecutionContextReceipt)
            .where(
                ExecutionContextReceipt.execution_id == execution_id,
                ExecutionContextReceipt.client_request_id == client_request_id,
            )
            .execution_options(populate_existing=True)
        )

    async def get(
        self, execution_id: uuid.UUID, receipt_id: uuid.UUID
    ) -> ExecutionContextReceipt | None:
        return await self.db.scalar(
            select(ExecutionContextReceipt).where(
                ExecutionContextReceipt.id == receipt_id,
                ExecutionContextReceipt.execution_id == execution_id,
            )
        )

    async def next_ordinal(self, execution_id: uuid.UUID) -> int:
        highest = await self.db.scalar(
            select(func.max(ExecutionContextReceipt.ordinal)).where(
                ExecutionContextReceipt.execution_id == execution_id
            )
        )
        return (highest or 0) + 1

    async def count(self, execution_id: uuid.UUID) -> int:
        return await self.db.scalar(
            select(func.count()).where(
                ExecutionContextReceipt.execution_id == execution_id
            )
        ) or 0

    async def list_page(
        self, execution_id: uuid.UUID, *, limit: int, offset: int
    ) -> list[ExecutionContextReceipt]:
        """Summary rows only: prompt bodies and the manifest stay in the
        database, and touching them on these rows raises instead of loading."""
        result = await self.db.execute(
            select(ExecutionContextReceipt)
            .options(load_only(*_SUMMARY_COLUMNS, raiseload=True))
            .where(ExecutionContextReceipt.execution_id == execution_id)
            .order_by(ExecutionContextReceipt.ordinal.desc())
            .limit(limit)
            .offset(offset)
        )
        return list(result.scalars().all())
