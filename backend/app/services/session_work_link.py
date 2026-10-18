# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.call_correlation import (
    CORRELATED_HARNESSES,
    CORRELATION_WINDOW,
    invocation_signatures,
)
from app.core.harness import harness_family
from app.core.time import as_utc
from app.models.agent_session import AgentSession
from app.models.mcp_invocation import MCPInvocation
from app.repositories.session_work_link import SessionWorkLinkRepository
from app.services.session_events import (
    LINKS_CHANGED,
    Invalidation,
    owner_links_changed,
    session_updated,
)

logger = logging.getLogger(__name__)

Refreshes = frozenset[Invalidation]
NO_REFRESHES: Refreshes = frozenset()

# Harness clocks and the MCP server's clock disagree a little, and an MCP
# receipt may describe a call that straddles the first or last captured event.
MATCH_WINDOW = timedelta(minutes=5)
# Not a native call id (app/core/harness.py NATIVE_ID_PATTERN), so this lock
# never collides with an exact match's; all of an owner's correlation runs
# one at a time. It sorts before every native id, and locks are taken sorted,
# so any transaction that holds both took this one first.
CORRELATION_LOCK = "*correlation*"


def _lock_keys(harnesses: set[str], native_call_ids: set[str]) -> set[str]:
    """Call-id locks, plus the correlation lock whenever a correlated harness
    is involved: an exact claim may evict a correlated guess on the same call."""
    if any(harness_family(harness) in CORRELATED_HARNESSES for harness in harnesses):
        return native_call_ids | {CORRELATION_LOCK}
    return native_call_ids


def _within_window(session: AgentSession, invocation: MCPInvocation) -> bool:
    called_at = as_utc(invocation.started_at)
    return (
        as_utc(session.started_at) - MATCH_WINDOW
        <= called_at
        <= as_utc(session.last_event_at) + MATCH_WINDOW
    )


def _correlatable(invocation: MCPInvocation) -> bool:
    return (
        invocation.agent_id is None
        and not invocation.native_call_id
        and bool(invocation.arguments_fingerprint)
        and harness_family(invocation.harness or "") in CORRELATED_HARNESSES
    )


def _signatures(invocation: MCPInvocation) -> set[str]:
    return invocation_signatures(
        invocation.tool_name, invocation.client_name, invocation.arguments_fingerprint
    )


class SessionWorkLinkService:
    """Joins a captured session to the MCP invocations its tool calls made.

    Either side may arrive first, so both ingest and invocation recording call
    in here. A match needs the same owner and harness family (see
    app/core/harness.py), the harness's own
    tool-call id on both sides, the call inside the session's time window, and
    exactly one such session: when two sessions (say, two machines) claim one
    invocation, it links to neither, and a link made before the second one
    arrived is retracted. The work the call did comes only from server-recorded
    Activity (changed) and consultations (consulted), never from the client.

    A harness that cannot send its call id (Pi, see app/core/call_correlation.py)
    is correlated instead: the one captured tool call of the owner with the same
    tool and arguments within CORRELATION_WINDOW, provided no other such
    invocation competes for it and no invocation claims it by native id. These
    matches are `correlated`; an exact claim on the same call evicts them, and
    any ambiguity links nothing.

    Each entry point returns the refreshes its changes call for: every session
    whose matches it claimed or released, including older sessions it
    retracted, and every other workspace whose cards and notes list them. The
    caller queues them with its own transaction.
    """

    def __init__(self, db: AsyncSession):
        self.repo = SessionWorkLinkRepository(db)

    async def serialize_call_matching(
        self, owner_id: uuid.UUID, native_call_ids: set[str], harnesses: set[str]
    ) -> None:
        await self.repo.serialize_call_matching(
            owner_id, _lock_keys(harnesses, native_call_ids)
        )

    async def link_session_calls(
        self, session: AgentSession, native_call_ids: set[str]
    ) -> Refreshes:
        if not native_call_ids:
            return NO_REFRESHES
        await self.repo.serialize_call_matching(
            session.owner_id, _lock_keys({session.harness}, native_call_ids)
        )
        refreshes = set()
        for invocation in await self.repo.human_invocations_for_calls(
            session.owner_id, session.harness, native_call_ids
        ):
            refreshes |= await self._reconcile(invocation)
        return frozenset(refreshes)

    async def link_invocation(self, invocation: MCPInvocation) -> Refreshes:
        if _correlatable(invocation):
            await self.repo.serialize_call_matching(
                invocation.owner_id, {CORRELATION_LOCK}
            )
            return await self._correlate(invocation)
        if (
            invocation.agent_id is not None
            or not invocation.harness
            or not invocation.native_call_id
        ):
            return NO_REFRESHES
        await self.repo.serialize_call_matching(
            invocation.owner_id,
            _lock_keys({invocation.harness}, {invocation.native_call_id}),
        )
        return await self._reconcile(invocation)

    async def correlate_session_calls(
        self, session: AgentSession, signatures: set[str], captured_at: datetime
    ) -> Refreshes:
        """Newly captured calls may be the one match of an invocation already
        recorded, or a second candidate that makes an earlier match ambiguous."""
        if (
            not signatures
            or harness_family(session.harness) not in CORRELATED_HARNESSES
        ):
            return NO_REFRESHES
        await self.repo.serialize_call_matching(session.owner_id, {CORRELATION_LOCK})
        captured_at = as_utc(captured_at)
        refreshes = set()
        for invocation in await self.repo.correlatable_invocations(
            session.owner_id,
            session.harness,
            started_by=captured_at + CORRELATION_WINDOW,
            completed_from=captured_at - CORRELATION_WINDOW,
        ):
            if _signatures(invocation) & signatures:
                refreshes |= await self._correlate(invocation)
        return frozenset(refreshes)

    async def _correlate(self, invocation: MCPInvocation) -> Refreshes:
        signatures = _signatures(invocation)
        calls = {
            (session_id, call_id): (signature, captured_at)
            for session_id, call_id, signature, captured_at in await self.repo.signed_calls(
                invocation.owner_id,
                invocation.harness,
                signatures,
                as_utc(invocation.started_at) - CORRELATION_WINDOW,
                as_utc(invocation.completed_at) + CORRELATION_WINDOW,
            )
        }
        previous = await self.repo.correlated_match(invocation.id)
        if len(calls) != 1:
            if len(calls) > 1:
                logger.warning(
                    "ambiguous correlated call match invocation=%s calls=%d",
                    invocation.id,
                    len(calls),
                )
            if previous is not None:
                return await self._retract(invocation)
            return NO_REFRESHES
        [((session_id, call_id), (signature, captured_at))] = calls.items()
        rivals = [
            other
            for other in await self.repo.correlatable_invocations(
                invocation.owner_id,
                invocation.harness,
                started_by=as_utc(captured_at) + CORRELATION_WINDOW,
                completed_from=as_utc(captured_at) - CORRELATION_WINDOW,
            )
            if other.id != invocation.id and signature in _signatures(other)
        ]
        if rivals:
            logger.warning(
                "ambiguous correlated call match invocation=%s rivals=%d",
                invocation.id,
                len(rivals),
            )
            refreshes = set()
            for contender in [invocation, *rivals]:
                if await self.repo.correlated_match(contender.id) is not None:
                    refreshes |= await self._retract(contender)
            return frozenset(refreshes)
        refreshes = set()
        if previous is not None and previous != (session_id, call_id):
            refreshes |= await self._retract(invocation)
        session = await self.repo.session(session_id)
        if session is not None:
            refreshes |= await self._materialize(
                session, invocation, correlated_call=call_id
            )
        return frozenset(refreshes)

    async def _reconcile(self, invocation: MCPInvocation) -> Refreshes:
        candidates = [
            session
            for session in await self.repo.sessions_with_call(
                invocation.owner_id, invocation.harness, invocation.native_call_id
            )
            if _within_window(session, invocation)
        ]
        if len(candidates) == 1:
            return await self._materialize(candidates[0], invocation)
        if len(candidates) > 1:
            logger.warning(
                "ambiguous native call match invocation=%s sessions=%d",
                invocation.id,
                len(candidates),
            )
            return await self._retract(invocation)
        return NO_REFRESHES

    async def _relations(self, invocation: MCPInvocation):
        return [
            (*entity, "changed")
            for entity in await self.repo.changed_entities(invocation)
        ] + [
            (*entity, "consulted")
            for entity in await self.repo.consulted_entities(invocation)
        ]

    async def _refreshes(self, session: AgentSession, relations) -> Refreshes:
        """The session's own views, and each other workspace where the owner
        can still see one of the call's targets: its cards and notes list the
        owner's sessions from every workspace."""
        refreshes = {session_updated(session, LINKS_CHANGED)}
        for workspace_id, entity_type, entity_id, _ in relations:
            if workspace_id == session.workspace_id:
                continue
            target_refresh = owner_links_changed(session.owner_id, workspace_id)
            if target_refresh in refreshes:
                continue
            if await self.repo.target_visible_to(
                session.owner_id, workspace_id, entity_type, entity_id
            ):
                refreshes.add(target_refresh)
        return frozenset(refreshes)

    async def _materialize(
        self,
        session: AgentSession,
        invocation: MCPInvocation,
        *,
        correlated_call: str | None = None,
    ) -> Refreshes:
        correlated = correlated_call is not None
        call_id = correlated_call if correlated else invocation.native_call_id
        if not await self.repo.claim_match(
            session.id,
            invocation.id,
            datetime.now(timezone.utc),
            provenance="correlated" if correlated else "exact",
            call_id=call_id,
        ):
            return NO_REFRESHES
        relations = await self._relations(invocation)
        for workspace_id, entity_type, entity_id, relation in relations:
            exists, board_id = await self.repo.entity_board(
                workspace_id, entity_type, entity_id
            )
            if not exists:
                continue
            await self.repo.upsert_link(
                session_id=session.id,
                workspace_id=workspace_id,
                entity_type=entity_type,
                entity_id=entity_id,
                board_id=board_id,
                relation=relation,
                seen_at=as_utc(invocation.started_at),
                correlated=correlated,
            )
        # Even when no target survives to link: the match alone changes what
        # the session's calls show.
        refreshes = set(await self._refreshes(session, relations))
        if not correlated:
            # The call is now claimed by its own id; whatever was correlated
            # to it re-evaluates, and no longer sees it as a candidate.
            if harness_family(session.harness) not in CORRELATED_HARNESSES:
                return frozenset(refreshes)
            # Callers already hold it; taken again (re-entrant) so no path
            # can read the guesses without it.
            await self.repo.serialize_call_matching(
                invocation.owner_id, {CORRELATION_LOCK}
            )
            for guess in await self.repo.correlated_claims_on(session.id, call_id):
                refreshes |= await self._correlate(guess)
        return frozenset(refreshes)

    # Known read-only edges of withdrawal, accepted as they are: it re-reads the
    # invocation's Activity and consultations at withdrawal time rather than
    # what was linked, and a later event that widens a session's time window
    # does not re-evaluate candidates that were outside it before.
    async def _retract(self, invocation: MCPInvocation) -> Refreshes:
        released = await self.repo.release_matches(invocation.id)
        if not released:
            return NO_REFRESHES
        relations = await self._relations(invocation)
        refreshes = set()
        for session_id, provenance in released:
            session = await self.repo.session(session_id)
            if session is not None:
                refreshes |= await self._refreshes(session, relations)
            for _, entity_type, entity_id, relation in relations:
                await self.repo.discount_link(
                    session_id=session_id,
                    entity_type=entity_type,
                    entity_id=entity_id,
                    relation=relation,
                    correlated=provenance == "correlated",
                )
        return frozenset(refreshes)
