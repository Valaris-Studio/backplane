# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import and_, case, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.harness import harnesses_in_family
from app.models.activity import Activity
from app.models.agent_session import (
    AgentSession,
    AgentSessionCapture,
    AgentSessionEvent,
    AgentSessionInvocation,
    SessionWorkLink,
)
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.mcp_invocation import MCPConsultation, MCPInvocation
from app.models.notes.note import Note
from app.repositories.dialect_insert import conflict_aware_insert

# Only human (non-agent) invocations are linked, and their Activity rows and
# consultations carry the empty principal key.
HUMAN_PRINCIPAL = ""


class SessionWorkLinkRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def serialize_call_matching(
        self, owner_id: uuid.UUID, native_call_ids: set[str]
    ) -> None:
        """Hold a transaction-scoped lock per (owner, native call id).

        Ingest and invocation recording each insert their own row, then take
        this lock, then look for the other side. Whichever takes it second is
        guaranteed to see the first side committed, so two concurrent arrivals
        can never both miss each other. Sorted to avoid lock-order deadlocks.
        SQLite serializes writers already.
        """
        if self.db.get_bind().dialect.name != "postgresql":
            return
        for call_id in sorted(native_call_ids):
            await self.db.execute(
                select(
                    func.pg_advisory_xact_lock(
                        func.hashtextextended(f"session-call:{owner_id}:{call_id}", 0)
                    )
                )
            )

    async def human_invocations_for_calls(
        self, owner_id: uuid.UUID, harness: str, native_call_ids: set[str]
    ) -> list[MCPInvocation]:
        result = await self.db.scalars(
            select(MCPInvocation).where(
                MCPInvocation.owner_id == owner_id,
                MCPInvocation.agent_id.is_(None),
                MCPInvocation.harness.in_(harnesses_in_family(harness)),
                MCPInvocation.native_call_id.in_(native_call_ids),
            )
        )
        return list(result)

    async def sessions_with_call(
        self, owner_id: uuid.UUID, harness: str, native_call_id: str
    ) -> list[AgentSession]:
        result = await self.db.scalars(
            select(AgentSession)
            .where(
                AgentSession.owner_id == owner_id,
                AgentSession.harness.in_(harnesses_in_family(harness)),
                AgentSession.id.in_(
                    select(AgentSessionEvent.session_id).where(
                        AgentSessionEvent.native_tool_call_id == native_call_id
                    )
                ),
            )
            .execution_options(populate_existing=True)
        )
        return list(result)

    async def signed_calls(
        self,
        owner_id: uuid.UUID,
        harness: str,
        signatures: set[str],
        captured_from: datetime,
        captured_until: datetime,
    ) -> list[tuple[uuid.UUID, str, str, datetime]]:
        """(session id, call id, signature, captured at) of the owner's tool
        events with one
        of these signatures captured in [captured_from, captured_until], except
        calls some invocation of the owner names by native id: those are for
        exact matching only."""
        claimed_exactly = (
            select(MCPInvocation.id)
            .where(
                MCPInvocation.owner_id == owner_id,
                MCPInvocation.native_call_id == AgentSessionEvent.native_tool_call_id,
            )
            .exists()
        )
        result = await self.db.execute(
            select(
                AgentSession.id,
                AgentSessionEvent.native_tool_call_id,
                AgentSessionEvent.tool_call_signature,
                AgentSessionCapture.captured_at,
            )
            .join(AgentSessionEvent, AgentSessionEvent.session_id == AgentSession.id)
            .join(
                AgentSessionCapture,
                and_(
                    AgentSessionCapture.installation_id == AgentSession.installation_id,
                    AgentSessionCapture.capture_id == AgentSessionEvent.capture_id,
                ),
            )
            .where(
                AgentSession.owner_id == owner_id,
                AgentSession.harness.in_(harnesses_in_family(harness)),
                AgentSessionEvent.tool_call_signature.in_(signatures),
                AgentSessionEvent.native_tool_call_id.is_not(None),
                AgentSessionCapture.captured_at.between(captured_from, captured_until),
                ~claimed_exactly,
            )
        )
        return list(result.tuples())

    async def correlatable_invocations(
        self,
        owner_id: uuid.UUID,
        harness: str,
        started_by: datetime,
        completed_from: datetime,
    ) -> list[MCPInvocation]:
        """The owner's human invocations without a native call id that ran
        within [completed_from, started_by]."""
        result = await self.db.scalars(
            select(MCPInvocation).where(
                MCPInvocation.owner_id == owner_id,
                MCPInvocation.agent_id.is_(None),
                MCPInvocation.harness.in_(harnesses_in_family(harness)),
                MCPInvocation.native_call_id.is_(None),
                MCPInvocation.arguments_fingerprint.is_not(None),
                MCPInvocation.started_at <= started_by,
                MCPInvocation.completed_at >= completed_from,
            )
        )
        return list(result)

    async def session(self, session_id: uuid.UUID) -> AgentSession | None:
        return await self.db.get(AgentSession, session_id, populate_existing=True)

    async def correlated_match(
        self, invocation_id: uuid.UUID
    ) -> tuple[uuid.UUID, str | None] | None:
        row = (
            await self.db.execute(
                select(
                    AgentSessionInvocation.session_id,
                    AgentSessionInvocation.matched_call_id,
                ).where(
                    AgentSessionInvocation.invocation_id == invocation_id,
                    AgentSessionInvocation.provenance == "correlated",
                )
            )
        ).first()
        return (row.session_id, row.matched_call_id) if row else None

    async def correlated_claims_on(
        self, session_id: uuid.UUID, call_id: str
    ) -> list[MCPInvocation]:
        result = await self.db.scalars(
            select(MCPInvocation).where(
                MCPInvocation.id.in_(
                    select(AgentSessionInvocation.invocation_id).where(
                        AgentSessionInvocation.session_id == session_id,
                        AgentSessionInvocation.matched_call_id == call_id,
                        AgentSessionInvocation.provenance == "correlated",
                    )
                )
            )
        )
        return list(result)

    async def claim_match(
        self,
        session_id: uuid.UUID,
        invocation_id: uuid.UUID,
        matched_at: datetime,
        *,
        provenance: str,
        call_id: str | None,
    ) -> bool:
        claimed = await self.db.scalar(
            conflict_aware_insert(self.db, AgentSessionInvocation)
            .values(
                session_id=session_id,
                invocation_id=invocation_id,
                matched_at=matched_at,
                provenance=provenance,
                matched_call_id=call_id,
            )
            .on_conflict_do_nothing()
            .returning(AgentSessionInvocation.session_id)
        )
        return claimed is not None

    async def release_matches(
        self, invocation_id: uuid.UUID
    ) -> list[tuple[uuid.UUID, str]]:
        """Forget every session this invocation matched; returns (session id,
        provenance) of each."""
        released = await self.db.execute(
            delete(AgentSessionInvocation)
            .where(AgentSessionInvocation.invocation_id == invocation_id)
            .returning(
                AgentSessionInvocation.session_id, AgentSessionInvocation.provenance
            )
        )
        return list(released.tuples())

    async def discount_link(
        self,
        *,
        session_id: uuid.UUID,
        entity_type: str,
        entity_id: uuid.UUID,
        relation: str,
        correlated: bool,
    ) -> None:
        """Take one invocation off a link; drop the link when none remain."""
        identity = (
            SessionWorkLink.session_id == session_id,
            SessionWorkLink.entity_type == entity_type,
            SessionWorkLink.entity_id == entity_id,
            SessionWorkLink.relation == relation,
        )
        await self.db.execute(
            update(SessionWorkLink)
            .where(*identity)
            .values(
                invocation_count=SessionWorkLink.invocation_count - 1,
                correlated_count=SessionWorkLink.correlated_count - int(correlated),
            )
            .execution_options(synchronize_session=False)
        )
        await self.db.execute(
            delete(SessionWorkLink)
            .where(*identity, SessionWorkLink.invocation_count <= 0)
            .execution_options(synchronize_session=False)
        )

    async def changed_entities(self, invocation: MCPInvocation):
        result = await self.db.execute(
            select(Activity.workspace_id, Activity.entity_type, Activity.entity_id)
            .where(
                Activity.mcp_invocation_id == invocation.id,
                Activity.actor_id == invocation.owner_id,
                Activity.principal_key == HUMAN_PRINCIPAL,
                Activity.entity_type.in_(["card", "note"]),
            )
            .distinct()
        )
        return [
            (workspace_id, str(getattr(entity_type, "value", entity_type)), entity_id)
            for workspace_id, entity_type, entity_id in result
        ]

    async def consulted_entities(self, invocation: MCPInvocation):
        result = await self.db.execute(
            select(
                MCPConsultation.workspace_id,
                MCPConsultation.entity_type,
                MCPConsultation.entity_id,
            ).where(
                MCPConsultation.invocation_id == invocation.id,
                MCPConsultation.actor_id == invocation.owner_id,
                MCPConsultation.principal_key == HUMAN_PRINCIPAL,
            )
        )
        return list(result.tuples())

    async def entity_board(
        self, workspace_id: uuid.UUID, entity_type: str, entity_id: uuid.UUID
    ) -> tuple[bool, uuid.UUID | None]:
        """(exists in workspace, board id) for a card or note."""
        if entity_type == "card":
            board_id = await self.db.scalar(
                select(Card.board_id)
                .join(Board, Card.board_id == Board.id)
                .where(Card.id == entity_id, Board.workspace_id == workspace_id)
            )
            return board_id is not None, board_id
        row = (
            await self.db.execute(
                select(Note.id, Note.board_id).where(
                    Note.id == entity_id, Note.workspace_id == workspace_id
                )
            )
        ).first()
        return row is not None, row.board_id if row else None

    async def upsert_link(
        self,
        *,
        session_id: uuid.UUID,
        workspace_id: uuid.UUID,
        entity_type: str,
        entity_id: uuid.UUID,
        board_id: uuid.UUID | None,
        relation: str,
        seen_at: datetime,
        correlated: bool,
    ) -> None:
        insert = conflict_aware_insert(self.db, SessionWorkLink).values(
            id=uuid.uuid4(),
            session_id=session_id,
            workspace_id=workspace_id,
            entity_type=entity_type,
            entity_id=entity_id,
            board_id=board_id,
            relation=relation,
            first_seen_at=seen_at,
            last_seen_at=seen_at,
            invocation_count=1,
            correlated_count=int(correlated),
        )
        await self.db.execute(
            insert.on_conflict_do_update(
                index_elements=["session_id", "entity_type", "entity_id", "relation"],
                set_={
                    "invocation_count": SessionWorkLink.invocation_count + 1,
                    "correlated_count": SessionWorkLink.correlated_count
                    + int(correlated),
                    "board_id": insert.excluded.board_id,
                    "first_seen_at": case(
                        (
                            insert.excluded.first_seen_at
                            < SessionWorkLink.first_seen_at,
                            insert.excluded.first_seen_at,
                        ),
                        else_=SessionWorkLink.first_seen_at,
                    ),
                    "last_seen_at": case(
                        (
                            insert.excluded.last_seen_at > SessionWorkLink.last_seen_at,
                            insert.excluded.last_seen_at,
                        ),
                        else_=SessionWorkLink.last_seen_at,
                    ),
                },
            )
        )
