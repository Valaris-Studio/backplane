# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import undefer

from app.models.notes.history import (
    NoteMutationReceipt,
    NoteRevision,
    NoteRevisionChunk,
    NoteRevisionManifest,
)
from app.repositories.dialect_insert import conflict_aware_insert

CHUNK_QUERY_BATCH_SIZE = 500
INSERT_BATCH_SIZE = 128


class NoteHistoryRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get(
        self, note_id: uuid.UUID, revision: int, *, with_snapshot: bool = False
    ) -> NoteRevision | None:
        statement = select(NoteRevision).where(
            NoteRevision.note_id == note_id, NoteRevision.revision == revision
        )
        if with_snapshot:
            statement = statement.options(undefer(NoteRevision.findings))
        return (
            await self.db.execute(statement.execution_options(populate_existing=True))
        ).scalar_one_or_none()

    async def list(
        self, note_id: uuid.UUID, limit: int, before_revision: int | None = None
    ) -> list[NoteRevision]:
        statement = select(NoteRevision).where(NoteRevision.note_id == note_id)
        if before_revision is not None:
            statement = statement.where(NoteRevision.revision < before_revision)
        result = await self.db.execute(
            statement.order_by(NoteRevision.revision.desc())
            .limit(limit)
            .execution_options(populate_existing=True)
        )
        return list(result.scalars().all())

    async def first(self, note_id: uuid.UUID) -> NoteRevision | None:
        return (
            await self.db.execute(
                select(NoteRevision)
                .where(NoteRevision.note_id == note_id)
                .order_by(NoteRevision.revision)
                .limit(1)
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()

    async def latest(self, note_id: uuid.UUID) -> NoteRevision | None:
        rows = await self.list(note_id, 1)
        return rows[0] if rows else None

    async def add_revision(self, revision: NoteRevision) -> NoteRevision:
        self.db.add(revision)
        await self.db.flush()
        return revision

    async def get_manifest(
        self, note_id: uuid.UUID, revision: int
    ) -> list[NoteRevisionManifest]:
        result = await self.db.execute(
            select(NoteRevisionManifest)
            .where(
                NoteRevisionManifest.note_id == note_id,
                NoteRevisionManifest.revision == revision,
            )
            .order_by(NoteRevisionManifest.position)
            .execution_options(populate_existing=True)
        )
        return list(result.scalars().all())

    async def get_chunks(
        self, note_id: uuid.UUID, digests: Sequence[str]
    ) -> dict[str, NoteRevisionChunk]:
        chunks = {}
        unique_digests = list(dict.fromkeys(digests))
        for start in range(0, len(unique_digests), CHUNK_QUERY_BATCH_SIZE):
            result = await self.db.execute(
                select(NoteRevisionChunk)
                .where(
                    NoteRevisionChunk.note_id == note_id,
                    NoteRevisionChunk.sha256.in_(
                        unique_digests[start:start + CHUNK_QUERY_BATCH_SIZE]
                    ),
                )
                .execution_options(populate_existing=True)
            )
            chunks.update((chunk.sha256, chunk) for chunk in result.scalars())
        return chunks

    async def get_manifest_metadata(
        self, note_id: uuid.UUID, revision: int
    ) -> list[tuple[int, str, int | None]]:
        result = await self.db.execute(
            select(
                NoteRevisionManifest.position,
                NoteRevisionManifest.sha256,
                NoteRevisionChunk.content_bytes,
            )
            .outerjoin(NoteRevisionChunk, (
                (NoteRevisionChunk.note_id == NoteRevisionManifest.note_id)
                & (NoteRevisionChunk.sha256 == NoteRevisionManifest.sha256)
            ))
            .where(
                NoteRevisionManifest.note_id == note_id,
                NoteRevisionManifest.revision == revision,
            )
            .order_by(NoteRevisionManifest.position)
        )
        return [(position, digest, size) for position, digest, size in result]

    async def add_chunks(self, note_id: uuid.UUID, chunks: dict[str, bytes]) -> None:
        known_digests = set()
        digests = list(chunks)
        for start in range(0, len(digests), CHUNK_QUERY_BATCH_SIZE):
            result = await self.db.execute(
                select(NoteRevisionChunk.sha256).where(
                    NoteRevisionChunk.note_id == note_id,
                    NoteRevisionChunk.sha256.in_(digests[start:start + CHUNK_QUERY_BATCH_SIZE]),
                )
            )
            known_digests.update(result.scalars())
        rows = [
            {"note_id": note_id, "sha256": digest, "payload": payload,
             "content_bytes": len(payload)}
            for digest, payload in chunks.items()
            if digest not in known_digests
        ]
        for start in range(0, len(rows), INSERT_BATCH_SIZE):
            await self.db.execute(
                conflict_aware_insert(self.db, NoteRevisionChunk)
                .values(rows[start:start + INSERT_BATCH_SIZE])
                .on_conflict_do_nothing(index_elements=["note_id", "sha256"])
            )

    async def add_manifest(
        self, note_id: uuid.UUID, revision: int, digests: Sequence[str]
    ) -> None:
        rows = [
            {"note_id": note_id, "revision": revision, "position": position,
             "sha256": digest}
            for position, digest in enumerate(digests)
        ]
        for start in range(0, len(rows), INSERT_BATCH_SIZE):
            await self.db.execute(
                insert(NoteRevisionManifest), rows[start:start + INSERT_BATCH_SIZE]
            )

    async def get_receipt(
        self, note_id: uuid.UUID, principal_key: str, client_request_id: uuid.UUID
    ) -> NoteMutationReceipt | None:
        return (
            await self.db.execute(
                select(NoteMutationReceipt)
                .where(
                    NoteMutationReceipt.note_id == note_id,
                    NoteMutationReceipt.principal_key == principal_key,
                    NoteMutationReceipt.client_request_id == client_request_id,
                )
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()

    async def add_receipt(self, receipt: NoteMutationReceipt) -> NoteMutationReceipt:
        self.db.add(receipt)
        await self.db.flush()
        return receipt
