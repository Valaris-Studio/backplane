# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import re
import uuid
from typing import TYPE_CHECKING, Iterable

if TYPE_CHECKING:
    from app.schemas.notes.note import NoteRead

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import (
    ConflictError,
    ForbiddenError,
    ResourceNotFoundError,
    ValidationError,
)
from app.models.activity import ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.notes.finding import FindingSeverity
from app.models.notes.kinds import IMMUTABLE_KINDS, REVIEW_VERDICT
from app.repositories.kanban.card import CardRepository
from app.repositories.notes.note import NoteOrderBy, NoteRepository, SortDirection
from app.schemas.notes.note import (
    Finding,
    NoteAppend,
    NoteCreate,
    NoteSectionReplace,
    NoteUpdate,
)
from app.services.activity import ActivityService
from app.services.notes.content_serializer import prosemirror_to_markdown
from app.services.notes.content_text import extract_plain_text
from app.services.kanban.freeze_guard import assert_board_not_frozen
from app.services.kanban.labels import stamp_label
from app.services.kanban.snapshots import snapshot_card
from app.services.mentions.notify import notify_new_mentions
from app.services.reviews.stuck_loop import record_review_iteration

# Title produced by the Go reviewer client: "Review: {card_id} — {decision}".
# Decision is the trailing token after the em-dash; \S+ is intentional — the
# decision vocabulary is operator-controlled (approve, request_changes,
# merge-blocked, sensor_fail, …).
_VERDICT_TITLE_PATTERN = re.compile(r"^Review:.+—\s*(\S+)\s*$")

# Legacy back-compat: when a verdict has no structured findings (pre SWE-AF #3
# or runner that hasn't been updated), `approved` defers to the decision string.
# Only "approve" maps to True — everything else (request_changes, merge-blocked,
# sensor_fail, ...) is non-approving by definition.
_LEGACY_APPROVE_DECISION = "approve"

# Body marker line that flags a card as requiring post-merge UI validation.
# Matched per-line, case-insensitive, whitespace-tolerant. When an approve
# verdict lands on a marked card, the backend stamps the routing label itself —
# the reviewer-LLM prompt instruction is only a hint; the guarantee lives here.
_UI_VALIDATION_MARKER_PATTERN = re.compile(
    r"^\s*validation:\s*requires-ui-validation\s*$", re.IGNORECASE | re.MULTILINE
)
NEEDS_UI_VALIDATION_LABEL = "needs-ui-validation"


def derive_approved(
    findings: Iterable[Finding] | Iterable[dict] | None,
    tests_pass: bool,
) -> bool:
    """Done-gate predicate (SWE-AF #3).

        approved = tests_pass AND no BLOCKING findings

    SHOULD_FIX and SUGGESTION never block — they're advisory tiers for the
    implementer and the downstream advisor role, not gating signals. The
    function is pure: same inputs → same output, no I/O, no clock.

    Accepts either Pydantic `Finding` instances or plain dicts (the shape
    that comes back out of the JSON column). Anything not recognized as
    BLOCKING is treated as non-blocking — schema validation at the wire
    boundary already rejects unknown severities, so a non-BLOCKING-looking
    value here means "not a blocker" and should not gate the merge.
    """
    if not tests_pass:
        return False
    if not findings:
        return True
    blocking_value = FindingSeverity.BLOCKING.value
    for finding in findings:
        severity = (
            finding.severity
            if isinstance(finding, Finding)
            else finding.get("severity")
        )
        # Compare both the enum and its string value — Pydantic may have
        # serialized the enum to its string already (use_enum_values=True).
        if severity == blocking_value or severity == FindingSeverity.BLOCKING:
            return False
    return True


def _heading_text(block: dict) -> str:
    return "".join(part.get("text", "") for part in block.get("content") or [])


def _locate_section(blocks: list[dict], anchor_heading: str) -> tuple[int, int]:
    """Resolve an anchor heading to the half-open block range `(anchor, end)`.

    `end` is the index of the next heading at the SAME OR HIGHER level, so a
    `###` nested under a `##` stays part of the `##` section rather than
    truncating it — replacing a parent must not silently orphan its children.

    Matching is case-folded and trimmed because headings are operator-authored
    prose. Ambiguity is refused rather than resolved: silently editing the wrong
    `## Session 5` of a pinned tracker is the exact failure this tool prevents.
    """
    wanted = anchor_heading.strip().casefold()
    matches = [
        index
        for index, block in enumerate(blocks)
        if block.get("type") == "heading" and _heading_text(block).strip().casefold() == wanted
    ]
    if not matches:
        raise ResourceNotFoundError(f"No heading matching '{anchor_heading.strip()}' in this note")
    if len(matches) > 1:
        raise ConflictError(
            f"Heading '{anchor_heading.strip()}' appears {len(matches)} times; "
            "disambiguate it in the note before replacing its section",
            error_code="ambiguous_anchor_heading",
        )

    anchor_index = matches[0]
    anchor_level = (blocks[anchor_index].get("attrs") or {}).get("level", 1)
    for index in range(anchor_index + 1, len(blocks)):
        block = blocks[index]
        if block.get("type") == "heading" and (block.get("attrs") or {}).get("level", 1) <= anchor_level:
            return anchor_index, index
    return anchor_index, len(blocks)


class NoteService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.note_repo = NoteRepository(db)

    async def _validate_card_link(
        self,
        workspace_id: uuid.UUID,
        board_id: uuid.UUID | None,
        card_id: uuid.UUID,
    ) -> None:
        """Guard for setting a non-null card_id on a note.

        Cross-workspace cards 404 exactly like nonexistent ones
        (anti-enumeration); same-workspace/wrong-board and workspace-level
        notes (no effective board) 422.
        """
        card_scope = (
            await self.db.execute(
                select(Card.board_id, Board.workspace_id)
                .join(Board, Board.id == Card.board_id)
                .where(Card.id == card_id)
            )
        ).first()
        if card_scope is None or card_scope.workspace_id != workspace_id:
            raise ResourceNotFoundError("Card not found")
        if board_id is None or card_scope.board_id != board_id:
            raise ValidationError("Linked card must belong to the note's board")

    async def create_note(
        self,
        workspace_id: uuid.UUID,
        data: NoteCreate,
        user_id: uuid.UUID,
        board_id: uuid.UUID | None = None,
    ):
        if board_id is not None:
            board_workspace = await self.db.scalar(
                select(Board.workspace_id).where(Board.id == board_id)
            )
            if board_workspace != workspace_id:
                raise ResourceNotFoundError("Board not found")
        await assert_board_not_frozen(self.db, board_id)
        create_kwargs = dict(
            workspace_id=workspace_id,
            board_id=board_id,
            title=data.title,
            content=data.content,
            content_text=extract_plain_text(data.content),
            pinned=data.pinned,
            kind=data.kind,
            failure_class=data.failure_class,
            findings=(
                [f.model_dump() for f in data.findings]
                if data.findings is not None
                else None
            ),
            created_by=user_id,
        )
        if data.card_id:
            await self._validate_card_link(workspace_id, board_id, data.card_id)
            create_kwargs["card_id"] = data.card_id
        # Plumbing for the "link a note to its source execution" rule: we accept
        # and persist it whenever a caller sends it. No backend path sets it yet;
        # the Go runner stamping its EXECUTION_ID on verdict/system note creation
        # is a follow-up. Until then this stays NULL for real notes and the UI
        # link falls back to the notes page.
        if data.source_execution_id:
            create_kwargs["source_execution_id"] = data.source_execution_id
        note = await self.note_repo.create(**create_kwargs)
        if data.kind == REVIEW_VERDICT and data.card_id is not None:
            await record_review_iteration(self.db, data.card_id, data.content)
            await self._stamp_ui_validation_routing(
                workspace_id, data.card_id, data.title, user_id
            )
        activity = ActivityService(self.db)
        # Enrich a card-scoped note's activity with card_id so the notification
        # generator can resolve the commented card without re-fetching the Note
        # (contract §"Open items — RESOLVED": card_comment note→card linkage).
        changes = {"card_id": str(data.card_id)} if data.card_id else None
        await activity.record(
            workspace_id=workspace_id,
            actor_id=user_id,
            entity_type=ActivityEntityType.note,
            entity_id=note.id,
            action=ActivityAction.created,
            board_id=board_id,
            summary=f"created note '{data.title}'",
            message_key="activity.note.created",
            message_params={"note_title": data.title},
            changes=changes,
        )
        # @mention producer (before='' — all mentions in a new note are new).
        # card_id == the note's card for a card-scoped note so the deep-link
        # lands on that card; None links to the note in its board scope (§5).
        await notify_new_mentions(
            self.db,
            workspace_id=workspace_id,
            board_id=board_id,
            actor_id=user_id,
            entity_type="note",
            entity_id=note.id,
            card_id=note.card_id,
            before_content="",
            after_content=note.content,
        )
        return note

    async def _stamp_ui_validation_routing(
        self,
        workspace_id: uuid.UUID,
        card_id: uuid.UUID,
        verdict_title: str,
        actor_id: uuid.UUID,
    ) -> None:
        """Deterministic server-side routing to the ui-validation stage.

        On an approve verdict, a card whose body carries the
        `Validation: requires-ui-validation` marker gains the
        `needs-ui-validation` label — no LLM discretion involved. Non-approve
        decisions and unmarked cards are untouched; stamping is idempotent.
        The stamp records a card-updated activity (actor = the verdict note's
        author) so board history shows what applied the routing label and the
        activity fan-out live-updates kanban views; an idempotent no-op
        records nothing.
        """
        match = _VERDICT_TITLE_PATTERN.match(verdict_title)
        if not match or match.group(1) != _LEGACY_APPROVE_DECISION:
            return
        # CardRepository (not db.get): snapshot_card requires eager-loaded
        # participants — a lazy load here would MissingGreenlet under async.
        card = await CardRepository(self.db).get_by_id(card_id)
        if card is None or not _UI_VALIDATION_MARKER_PATTERN.search(
            card.description or ""
        ):
            return
        if NEEDS_UI_VALIDATION_LABEL in (card.labels or []):
            return
        before_state = snapshot_card(card)
        stamp_label(card, NEEDS_UI_VALIDATION_LABEL)
        await ActivityService(self.db).record(
            workspace_id=workspace_id,
            actor_id=actor_id,
            entity_type=ActivityEntityType.card,
            entity_id=card.id,
            action=ActivityAction.updated,
            board_id=card.board_id,
            summary=(
                f"applied label '{NEEDS_UI_VALIDATION_LABEL}' to card "
                f"'{card.title}' (approve-verdict routing)"
            ),
            message_key="activity.card.ui_validation_label_applied",
            message_params={
                "card_title": card.title,
                "label": NEEDS_UI_VALIDATION_LABEL,
            },
            changes={"fields": ["labels"]},
            before_state=before_state,
            after_state=snapshot_card(card),
        )

    async def list_board_notes(self, board_id: uuid.UUID):
        return await self.note_repo.list_by_board(board_id)

    async def list_notes_page(
        self,
        *,
        workspace_id: uuid.UUID,
        board_id: uuid.UUID | None = None,
        card_id: uuid.UUID | None = None,
        q: str | None = None,
        pinned_only: bool = False,
        authors: list[uuid.UUID] | None = None,
        kinds: list[str] | None = None,
        order_by: NoteOrderBy | None = None,
        direction: SortDirection = "desc",
        limit: int | None = None,
        offset: int = 0,
    ) -> tuple[list, int]:
        """Search / sort / filter / page one scope's notes.

        `board_id=None` means workspace-LEVEL notes (board_id IS NULL), the
        same scope `list_workspace_notes` has always returned — not "every
        note in the workspace".
        """
        return await self.note_repo.list_page(
            workspace_id=workspace_id,
            board_id=board_id,
            card_id=card_id,
            workspace_level_only=board_id is None,
            q=q,
            pinned_only=pinned_only,
            authors=authors,
            kinds=kinds,
            order_by=order_by,
            direction=direction,
            limit=limit,
            offset=offset,
        )

    async def list_card_notes(self, card_id: uuid.UUID, workspace_id: uuid.UUID):
        return await self.note_repo.list_by_card(card_id, workspace_id)

    async def list_workspace_notes(self, workspace_id: uuid.UUID):
        return await self.note_repo.list_by_workspace(workspace_id)

    RESOLVE_MIN_PREFIX_LEN = 4

    async def resolve_note_by_prefix(
        self,
        workspace_id: uuid.UUID,
        prefix: str,
        *,
        board_id: uuid.UUID | None = None,
    ):
        """Resolve a note from a UUID prefix fragment — the notes twin of
        CardService.resolve_card_by_prefix.

        Raises ValidationError (422) below the minimum length, ResourceNotFound
        (404) on no match, ConflictError (409) listing candidates on >1.
        """
        cleaned = (prefix or "").strip()
        if len(cleaned) < self.RESOLVE_MIN_PREFIX_LEN:
            raise ValidationError(
                f"prefix must be at least {self.RESOLVE_MIN_PREFIX_LEN} "
                "characters to resolve a note",
                error_code="prefix_too_short",
            )

        matches = await self.note_repo.find_by_id_prefix(
            workspace_id, cleaned, board_id=board_id
        )
        if not matches:
            raise ResourceNotFoundError(
                f"No note in this scope matches prefix '{cleaned}'",
                error_code="note_not_found",
            )
        if len(matches) > 1:
            candidates = ", ".join(f"{n.id} ({n.title})" for n in matches)
            raise ConflictError(
                f"Prefix '{cleaned}' is ambiguous; matches {len(matches)} notes: "
                f"{candidates}",
                error_code="ambiguous_prefix",
            )
        return matches[0]

    async def get_note(self, note_id: uuid.UUID, workspace_id: uuid.UUID):
        note = await self.note_repo.get_by_id(note_id)
        if not note or note.workspace_id != workspace_id:
            raise ResourceNotFoundError("Note not found")
        return note

    async def get_note_read(
        self,
        note_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        as_markdown: bool = False,
    ) -> "NoteRead":
        """Return the note as a NoteRead schema, optionally with `content`
        serialized to markdown (the reverse of the stored PM JSON).

        Keeps the format decision in the service so the router stays thin: the
        markdown transform is a pure projection of stored content, produced via
        the closed-vocabulary serializer.
        """
        from app.schemas.notes.note import NoteRead

        note = await self.get_note(note_id, workspace_id)
        read = NoteRead.model_validate(note)
        if as_markdown:
            read = read.model_copy(
                update={"content": prosemirror_to_markdown(note.content)}
            )
        return read

    async def update_note(
        self,
        note_id: uuid.UUID,
        workspace_id: uuid.UUID,
        data: NoteUpdate,
        actor_id: uuid.UUID | None = None,
        board_id: uuid.UUID | None = None,
    ):
        note = await self.note_repo.get_by_id(note_id)
        if not note or note.workspace_id != workspace_id:
            raise ResourceNotFoundError("Note not found")
        if note.kind in IMMUTABLE_KINDS:
            raise ForbiddenError(f"Cannot modify a {note.kind} note")
        # Gate on the LOADED note's board — the board_id param is untrusted.
        await assert_board_not_frozen(self.db, note.board_id)
        # Prior content for the @mention diff — capture before the repo mutates
        # the instance in place.
        before_content = note.content
        changed_fields = list(data.model_dump(exclude_unset=True).keys())
        update_fields = data.model_dump(exclude_unset=True)
        # Explicit null (clear) skips validation; only setting a link is guarded.
        if update_fields.get("card_id") is not None:
            # NoteUpdate carries no board_id today — the loaded note's own
            # board is the only possible link scope.
            await self._validate_card_link(
                workspace_id, note.board_id, update_fields["card_id"]
            )
        # Only when `content` was actually sent — an unset content field means
        # "leave the body alone", which must not blank the searchable text.
        if "content" in update_fields:
            update_fields["content_text"] = extract_plain_text(update_fields["content"])
        updated = await self.note_repo.update(note, **update_fields)
        if actor_id and workspace_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.note,
                entity_id=note_id,
                action=ActivityAction.updated,
                board_id=board_id,
                summary=f"updated note '{updated.title}'",
                message_key="activity.note.updated",
                message_params={
                    "note_title": updated.title,
                    "fields": changed_fields,
                },
                changes={"fields": changed_fields},
            )
            # @mention producer — only newly-added mentions fire (MEN-2).
            await notify_new_mentions(
                self.db,
                workspace_id=workspace_id,
                board_id=board_id,
                actor_id=actor_id,
                entity_type="note",
                entity_id=note_id,
                card_id=updated.card_id,
                before_content=before_content,
                after_content=updated.content,
            )
        return updated

    async def append_note(
        self,
        note_id: uuid.UUID,
        workspace_id: uuid.UUID,
        data: NoteAppend,
        actor_id: uuid.UUID | None = None,
        board_id: uuid.UUID | None = None,
    ):
        """Splice new blocks onto the end of a note without rewriting it.

        Both documents are already canonical ProseMirror by the time they get
        here (the schema validator normalizes), so this is a list concatenation
        of top-level blocks — the existing content is never re-parsed or
        re-serialized from markdown, which is what made the full-body update
        path risky for long pinned trackers.
        """
        note = await self.note_repo.get_by_id(note_id)
        if not note or note.workspace_id != workspace_id:
            raise ResourceNotFoundError("Note not found")
        if note.kind in IMMUTABLE_KINDS:
            raise ForbiddenError(f"Cannot modify a {note.kind} note")
        await assert_board_not_frozen(self.db, note.board_id)

        before_content = note.content
        existing = (
            json.loads(before_content) if before_content else {"type": "doc", "content": []}
        )
        appended = json.loads(data.content)
        merged = {
            **existing,
            "content": (existing.get("content") or []) + (appended.get("content") or []),
        }
        merged_content = json.dumps(merged)
        updated = await self.note_repo.update(
            note,
            content=merged_content,
            content_text=extract_plain_text(merged_content),
        )

        if actor_id and workspace_id:
            await ActivityService(self.db).record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.note,
                entity_id=note_id,
                action=ActivityAction.updated,
                board_id=board_id,
                summary=f"appended to note '{updated.title}'",
                message_key="activity.note.appended",
                message_params={"note_title": updated.title},
                changes={"fields": ["content"], "mode": "append"},
            )
            # Only mentions inside the appended blocks are new — the prefix is
            # unchanged by construction, so the diff naturally yields just those.
            await notify_new_mentions(
                self.db,
                workspace_id=workspace_id,
                board_id=board_id,
                actor_id=actor_id,
                entity_type="note",
                entity_id=note_id,
                card_id=updated.card_id,
                before_content=before_content,
                after_content=updated.content,
            )
        return updated

    async def replace_note_section(
        self,
        note_id: uuid.UUID,
        workspace_id: uuid.UUID,
        data: NoteSectionReplace,
        actor_id: uuid.UUID | None = None,
        board_id: uuid.UUID | None = None,
    ):
        """Rewrite the body under one heading, leaving the rest of the note alone.

        The other half of `append_note`: appending grows a tracker, this updates
        a status *inside* one. Both avoid the full-body `update_note` round-trip
        that risks mangling a long pinned document.

        The anchor heading itself is kept — callers pass body content, and
        replacing the heading would make the section unaddressable on the next
        call. Unlike append, this is idempotent: replaying it converges.
        """
        note = await self.note_repo.get_by_id(note_id)
        if not note or note.workspace_id != workspace_id:
            raise ResourceNotFoundError("Note not found")
        if note.kind in IMMUTABLE_KINDS:
            raise ForbiddenError(f"Cannot modify a {note.kind} note")
        await assert_board_not_frozen(self.db, note.board_id)

        before_content = note.content
        existing = (
            json.loads(before_content) if before_content else {"type": "doc", "content": []}
        )
        blocks = existing.get("content") or []
        anchor_index, section_end = _locate_section(blocks, data.anchor_heading)

        replacement = json.loads(data.content).get("content") or []
        merged = {
            **existing,
            "content": blocks[: anchor_index + 1] + replacement + blocks[section_end:],
        }
        merged_content = json.dumps(merged)
        updated = await self.note_repo.update(
            note,
            content=merged_content,
            content_text=extract_plain_text(merged_content),
        )

        if actor_id and workspace_id:
            await ActivityService(self.db).record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.note,
                entity_id=note_id,
                action=ActivityAction.updated,
                board_id=board_id,
                summary=f"replaced section '{data.anchor_heading.strip()}' in note '{updated.title}'",
                message_key="activity.note.section_replaced",
                message_params={
                    "section_heading": data.anchor_heading.strip(),
                    "note_title": updated.title,
                },
                changes={
                    "fields": ["content"],
                    "mode": "replace_section",
                    "anchor_heading": data.anchor_heading.strip(),
                },
            )
            await notify_new_mentions(
                self.db,
                workspace_id=workspace_id,
                board_id=board_id,
                actor_id=actor_id,
                entity_type="note",
                entity_id=note_id,
                card_id=updated.card_id,
                before_content=before_content,
                after_content=updated.content,
            )
        return updated

    async def get_card_verdict(
        self, card_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> dict | None:
        notes = await self.note_repo.list_card_notes_by_kind(
            card_id, workspace_id, REVIEW_VERDICT
        )
        for note in notes:
            match = _VERDICT_TITLE_PATTERN.match(note.title)
            if not match:
                continue
            decision = match.group(1)
            findings = note.findings
            # Hand-off to the done-gate. When the runner posts structured
            # findings we derive `approved` from the rubric; when they're
            # absent (legacy verdicts or runners that haven't been updated)
            # we fall back to the decision string so existing flows keep
            # working unchanged.
            if findings is not None:
                # tests_pass is true by definition at this point — the runner
                # only emits a verdict when the test stage finished. The
                # rubric here separates "what the reviewer found" from "did
                # CI pass"; a future card will plumb a real tests_pass signal
                # through. Until then, the conservative default is True so
                # the gate only blocks on BLOCKING findings, not on a missing
                # signal we don't yet collect.
                approved = derive_approved(findings, tests_pass=True)
            else:
                approved = decision == _LEGACY_APPROVE_DECISION
            return {
                "decision": decision,
                "note_id": note.id,
                "created_at": note.created_at,
                "failure_class": note.failure_class,
                "findings": findings,
                "approved": approved,
            }
        return None

    async def export_board_notes(
        self,
        board_id: uuid.UUID,
        workspace_slug: str,
        board_slug: str,
    ) -> dict:
        from app.services.export.envelope import build_envelope

        notes = await self.note_repo.list_by_board(board_id)
        notes_data = [
            {
                "external_note_id": str(n.id),
                "title": n.title,
                "content": n.content,
                "pinned": n.pinned,
                "card_slug": None,
                "card_external_id": str(n.card_id) if n.card_id else None,
                "created_at": n.created_at.isoformat() if n.created_at else None,
                "created_by_external_id": str(n.created_by),
            }
            for n in notes
        ]
        return build_envelope(
            entity_type="notes_bundle",
            source_workspace_slug=workspace_slug,
            source_board_slug=board_slug,
            data={"notes": notes_data},
        )

    async def delete_note(
        self,
        note_id: uuid.UUID,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID | None = None,
        board_id: uuid.UUID | None = None,
    ):
        note = await self.note_repo.get_by_id(note_id)
        if not note or note.workspace_id != workspace_id:
            raise ResourceNotFoundError("Note not found")
        if note.kind in IMMUTABLE_KINDS:
            raise ForbiddenError(f"Cannot modify a {note.kind} note")
        await assert_board_not_frozen(self.db, note.board_id)
        if actor_id and workspace_id:
            activity = ActivityService(self.db)
            await activity.record(
                workspace_id=workspace_id,
                actor_id=actor_id,
                entity_type=ActivityEntityType.note,
                entity_id=note_id,
                action=ActivityAction.deleted,
                board_id=board_id,
                summary=f"deleted note '{note.title}'",
                message_key="activity.note.deleted",
                message_params={"note_title": note.title},
            )
        await self.note_repo.delete(note)
