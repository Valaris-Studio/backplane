# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Notification generation (Phase 2).

`generate_for_event` runs synchronously INSIDE the triggering service's
transaction (INV-1): a notification row can never exist without its event. It
must therefore load every bit of recipient context via eager (`selectinload`)
repos and never touch a `lazy="raise"` relationship or call another service —
mirroring `ActivityService.build_board_baseline`'s greenlet discipline.

Flow (contract §"Generation flow"):
    recipients = resolve_recipients(...)   # relevance brain, eager-loaded
    recipients -= {actor_id}               # INV-3 never notify the actor
    for user in recipients:
        eff = resolve_prefs(user)          # muted -> override -> default
        for channel where is_enabled_for(category):
            upsert_notification(dedupe_key) # INV-6 idempotent, in-txn
            await channel.deliver(...)
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import ActivityAction, ActivityEntityType
from app.repositories.agents.agent import AgentRepository
from app.repositories.kanban.board import BoardRepository
from app.repositories.kanban.card import CardRepository
from app.repositories.notifications.notification import NotificationRepository
from app.repositories.notifications.preference import NotificationPreferenceRepository
from app.repositories.user import UserRepository
from app.repositories.workspace import WorkspaceMemberRepository, WorkspaceRepository
from app.services.notifications.channels import CHANNEL_REGISTRY
from app.services.notifications.live_push import promote_staged, reset_staged
from app.services.notifications.preferences import PreferenceResolver

logger = logging.getLogger(__name__)

# Workspace roles that decide approvals — the recipients of approval_requested.
_APPROVAL_DECIDER_ROLES = {"owner", "admin"}

# (entity_type, action) -> stable category key. Unmapped pairs return None and
# generation becomes a safe no-op (Group G sentinel). card.created intentionally
# maps to a default-OFF category so the volume is gated by prefs, not by absence.
_ACTIVITY_CATEGORY_MAP: dict[tuple[ActivityEntityType, ActivityAction], str] = {
    (ActivityEntityType.card, ActivityAction.moved): "card_participant_changed",
    (ActivityEntityType.card, ActivityAction.updated): "card_participant_changed",
    (ActivityEntityType.card, ActivityAction.created): "card_created",
    (ActivityEntityType.card, ActivityAction.dependency_added): "dependency_blocking",
    (
        ActivityEntityType.card,
        ActivityAction.dependencies_replaced,
    ): "dependency_blocking",
    (ActivityEntityType.member, ActivityAction.added_member): "workspace_member",
    (ActivityEntityType.member, ActivityAction.removed_member): "workspace_member",
    # member/updated covers role_changed AND temporary_password_set — both now
    # notify the affected member (deliberate; recipients come from
    # changes["affected_user_id"] either way).
    (ActivityEntityType.member, ActivityAction.updated): "workspace_member",
    # note.created maps to card_comment only when the activity carries a card_id
    # in its changes; the hook resolves that and only then routes the category.
    (ActivityEntityType.note, ActivityAction.created): "card_comment",
}


def category_for_activity(
    entity_type: ActivityEntityType, action: ActivityAction
) -> str | None:
    """Map a raw activity event to a notification category, or None when the
    event has no notification meaning (safe no-op)."""
    return _ACTIVITY_CATEGORY_MAP.get((entity_type, action))


class NotificationService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.notif_repo = NotificationRepository(db)
        self.pref_repo = NotificationPreferenceRepository(db)
        self.card_repo = CardRepository(db)
        self.member_repo = WorkspaceMemberRepository(db)
        self.agent_repo = AgentRepository(db)
        self.user_repo = UserRepository(db)
        self.board_repo = BoardRepository(db)
        self.workspace_repo = WorkspaceRepository(db)
        self.resolver = PreferenceResolver()

    async def generate_for_event(
        self,
        db: AsyncSession | None = None,
        *,
        workspace_id: uuid.UUID,
        board_id: uuid.UUID | None,
        category: str,
        actor_id: uuid.UUID | None,
        is_agent_actor: bool,
        entity_type: str,
        entity_id: uuid.UUID | None,
        dedupe_seed: str,
        params: dict,
        link: dict | None,
    ) -> None:
        # Load the subject card ONCE for card-based categories: its participants
        # drive recipient resolution AND its title feeds params["card"]. Sharing
        # the single eager load avoids a duplicate fetch per event.
        subject_card = None
        if category in self._CARD_PARTICIPANT_CATEGORIES and entity_id is not None:
            subject_card = await self.card_repo.get_by_id(entity_id)

        recipients = await self._resolve_recipients(
            category=category,
            workspace_id=workspace_id,
            entity_id=entity_id,
            params=params,
            actor_id=actor_id,
            subject_card=subject_card,
        )
        recipients.discard(actor_id)  # INV-3: never notify the actor
        if not recipients:
            return

        # Enrich params with the DISPLAY values the FE i18n copy interpolates
        # ({{card}}, {{board}}, {{actor}}, …). Resolved ONCE here — before the
        # recipient loop — because every recipient of one event shares identical
        # params (INV-5: structured DATA, never UI sentences). All lookups are
        # eager (explicit selects), never lazy, so this stays greenlet-safe deep
        # inside the triggering txn.
        params = await self._build_display_params(
            category=category,
            workspace_id=workspace_id,
            board_id=board_id,
            actor_id=actor_id,
            entity_id=entity_id,
            params=params,
            subject_card=subject_card,
        )

        # Producers only know their own local ids, so they emit PARTIAL links
        # ({"kind": "card", "card_id": ...}). The FE resolver needs board_id for
        # kind "card" and a workspace slug for every kind, or it returns null and
        # the inbox hides the CTA — the "which card?" dead end. Enrich here, the
        # one choke point every producer funnels through.
        link = await self._resolvable_link(
            link, workspace_id=workspace_id, board_id=board_id
        )

        # dedupe_key per (recipient) — entity_id + dedupe_seed make it
        # deterministic so re-running generation for the same event is a no-op.
        dedupe_key = f"{category}:{entity_id}:{dedupe_seed}"

        # Batch-load all recipients' prefs in ONE query (no per-recipient N+1).
        # A recipient with no row is absent → resolve(None) = defaults.
        pref_by_user = await self.pref_repo.get_for_users(recipients, workspace_id)

        # Live-push ordering (INV-1): channels STAGE their push intents here while
        # we sit inside the triggering txn's begin_nested savepoint. Reset staging
        # first so a prior partial generation never bleeds in, then promote to the
        # pending buffer ONLY after the loop exits cleanly — so a savepoint that
        # rolls back (an exception below) never reaches promotion and emits NO
        # push for a row that won't survive (the phantom-push guard).
        reset_staged(self.db)
        for recipient_id in recipients:
            pref_row = pref_by_user.get(recipient_id)
            eff = self.resolver.resolve(pref_row)
            if eff.muted:
                continue
            for channel in CHANNEL_REGISTRY.values():
                if not channel.is_enabled_for(eff, category):
                    continue
                notification = await self.notif_repo.create(
                    recipient_user_id=recipient_id,
                    workspace_id=workspace_id,
                    board_id=board_id,
                    category=category,
                    actor_id=actor_id,
                    is_agent_actor=is_agent_actor,
                    entity_type=entity_type,
                    entity_id=entity_id,
                    params=params,
                    link=link,
                    dedupe_key=dedupe_key,
                )
                await channel.deliver(notification, recipient_id, self.db)
        promote_staged(self.db)

    # Link kinds the FE resolves to a board-scoped route, so a missing board_id
    # makes them unresolvable. "note" is deliberately absent: a workspace-scoped
    # note carries board_id=None BY DESIGN and routes to /{slug}/notes — filling
    # it from the event would misroute the link to a board the note isn't on.
    _BOARD_SCOPED_LINK_KINDS = frozenset({"card", "board"})

    async def _resolvable_link(
        self,
        link: dict | None,
        *,
        workspace_id: uuid.UUID,
        board_id: uuid.UUID | None,
    ) -> dict | None:
        """Fill the ids the FE resolver needs, never relocating a stated target.

        Producer-supplied keys always win — a producer that named a board knows
        the target better than the triggering event does. A `None` a producer set
        explicitly is a statement of scope, not a gap, so only ABSENT keys are
        filled.

        A `None` link becomes a workspace link: there is no per-entity
        destination for events like workspace_member, and the workspace itself
        beats a dead end. Every notification ends up with SOME link.
        """
        enriched = dict(link) if link else {"kind": "workspace"}

        if (
            enriched.get("kind") in self._BOARD_SCOPED_LINK_KINDS
            and "board_id" not in enriched
            and board_id is not None
        ):
            enriched["board_id"] = str(board_id)

        if "workspace_slug" not in enriched:
            workspace = await self.workspace_repo.get_by_id(workspace_id)
            if workspace is not None:
                enriched["workspace_slug"] = workspace.slug

        return enriched

    # Categories whose recipients are the subject card's participants AND whose
    # copy needs that card's title — so one eager card load serves both. For
    # these the entity_id IS the card (card_comment re-routes entity_id to the
    # commented card in the activity hook; dependency_blocking's entity_id is the
    # blocked card).
    _CARD_PARTICIPANT_CATEGORIES = frozenset(
        {
            "card_assigned",
            "card_participant_changed",
            "card_comment",
            "dependency_blocking",
            "card_created",
        }
    )
    # Categories whose copy needs an actor display label (actor_name/actor_email).
    _ACTOR_CATEGORIES = frozenset(
        {
            "card_assigned",
            "card_participant_changed",
            "card_comment",
            "card_created",
            "workspace_member",
            "approval_requested",
            "mention",
            "resource_note_shared",
            "board_run_finished",
        }
    )
    # Categories whose copy renders the board name in params["board"].
    _BOARD_NAME_CATEGORIES = frozenset({"card_created", "board_run_finished"})

    async def _build_display_params(
        self,
        *,
        category: str,
        workspace_id: uuid.UUID,
        board_id: uuid.UUID | None,
        actor_id: uuid.UUID | None,
        entity_id: uuid.UUID | None,
        params: dict,
        subject_card=None,
    ) -> dict:
        """Resolve the FE's interpolation values ONCE per event and fold them
        into a fresh params dict (the raw `changes` keys are preserved — harmless
        and useful for debugging). Only the keys a category's copy reads are
        populated. Every lookup is a single eager SELECT; none is per-recipient.

        Per-category populated keys (mirrors notifications.category.* i18n):
          card_*            : card (title), actor_name/email
          card_created      : + board (name)
          dependency_blocking: card (blocked title), blocker (blocking title)
          workspace_member  : workspace (name), actor_name/email
          approval_requested: actor_name/email, card (board/card context)
          approval_decided  : decision (already in changes), card (context)
          resource_note_shared: actor_name/email, workspace, entity
        """
        enriched = dict(params)

        # Subject card title: reuse the card already loaded for recipient
        # resolution (no second fetch). subject_card is None for non-card
        # categories or when the card was deleted between event and generation.
        if subject_card is not None and subject_card.title:
            enriched.setdefault("card", subject_card.title)

        if category in self._ACTOR_CATEGORIES and actor_id is not None:
            actor = await self.user_repo.get_by_id(actor_id)
            if actor is not None:
                if actor.name:
                    enriched.setdefault("actor_name", actor.name)
                if actor.email:
                    enriched.setdefault("actor_email", actor.email)

        if category in self._BOARD_NAME_CATEGORIES and board_id is not None:
            board = await self.board_repo.get_by_id(board_id)
            if board is not None:
                enriched.setdefault("board", board.name)

        if category == "dependency_blocking":
            blocker_id = self._blocker_card_id(params)
            if blocker_id is not None:
                blocker_title = await self._card_title(blocker_id)
                if blocker_title is not None:
                    enriched.setdefault("blocker", blocker_title)

        if category == "workspace_member":
            workspace = await self.workspace_repo.get_by_id(workspace_id)
            if workspace is not None:
                enriched.setdefault("workspace", workspace.name)

        if category in {"approval_requested", "approval_decided"}:
            # The approval has no subject card/title of its own; its display
            # context is the board it runs on (the FE renders {{card}} for the
            # "decision needed on …" line). Board name is the cheapest stable
            # context; absent board → leave {{card}} to the FE's fallback.
            if board_id is not None:
                board = await self.board_repo.get_by_id(board_id)
                if board is not None:
                    enriched.setdefault("card", board.name)
            # actor for approval_requested is the agent's owning human (the one
            # "needing a decision") — resolve via the owner id the hook passed.
            if category == "approval_requested":
                owner_id = params.get("agent_owner_id")
                if owner_id is not None:
                    owner = await self.user_repo.get_by_id(_as_uuid(owner_id))
                    if owner is not None:
                        if owner.name:
                            enriched.setdefault("actor_name", owner.name)
                        if owner.email:
                            enriched.setdefault("actor_email", owner.email)

        return enriched

    async def _card_title(self, card_id: uuid.UUID) -> str | None:
        card = await self.card_repo.get_by_id(card_id)
        return card.title if card is not None else None

    @staticmethod
    def _blocker_card_id(params: dict) -> uuid.UUID | None:
        """The blocking card id from a dependency activity's changes. `add` emits
        depends_on_card_id; `bulk_set` emits depends_on_card_ids (use the first)."""
        single = params.get("depends_on_card_id")
        if single is not None:
            return _as_uuid(single)
        many = params.get("depends_on_card_ids")
        if isinstance(many, list) and many:
            return _as_uuid(many[0])
        return None

    async def _resolve_recipients(
        self,
        *,
        category: str,
        workspace_id: uuid.UUID,
        entity_id: uuid.UUID | None,
        params: dict,
        actor_id: uuid.UUID | None,
        subject_card=None,
    ) -> set[uuid.UUID]:
        """The relevance brain. Each category resolves the set of involved users
        (watching = relevant-to-me) via eager-loaded repos — no lazy loads.
        `subject_card` is the pre-loaded card for card categories (loaded once by
        the caller and reused for both recipients and the card-title param)."""
        # A mention's recipient is the EXPLICITLY-mentioned user (params), never
        # the subject card's participants. This branch sits before the
        # card-participant fallback so a card mention does not fan out to
        # everyone on the card (MEN-1: id is identity).
        if category == "mention":
            raw = params.get("mentioned_user_id")
            return {_as_uuid(raw)} if raw else set()
        if category in self._CARD_PARTICIPANT_CATEGORIES:
            return self._card_participant_ids(subject_card)
        if category == "approval_requested":
            return await self._approval_decider_ids(workspace_id, params)
        if category == "approval_decided":
            return await self._agent_owner_ids(params)
        if category == "workspace_member":
            return self._affected_user_ids(params)
        return set()

    @staticmethod
    def _card_participant_ids(card) -> set[uuid.UUID]:
        if card is None:
            return set()
        return {p.user_id for p in card.participants}

    async def _approval_decider_ids(
        self, workspace_id: uuid.UUID, params: dict
    ) -> set[uuid.UUID]:
        recipients = {
            member.user_id
            for member in await self.member_repo.list_members(workspace_id)
            if member.role.value in _APPROVAL_DECIDER_ROLES
        }
        owner_id = params.get("agent_owner_id")
        if owner_id is not None:
            recipients.add(_as_uuid(owner_id))
        return recipients

    async def _agent_owner_ids(self, params: dict) -> set[uuid.UUID]:
        owner_id = params.get("agent_owner_id")
        if owner_id is None:
            agent_id = params.get("agent_id")
            if agent_id is None:
                return set()
            agent = await self.agent_repo.get_by_id(_as_uuid(agent_id))
            if agent is None:
                return set()
            owner_id = agent.created_by_id
        return {_as_uuid(owner_id)}

    def _affected_user_ids(self, params: dict) -> set[uuid.UUID]:
        affected = params.get("affected_user_id")
        return {_as_uuid(affected)} if affected is not None else set()


def _as_uuid(value: uuid.UUID | str) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
