# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import json
import re
import uuid
from typing import TYPE_CHECKING, Iterable

if TYPE_CHECKING:
    from app.schemas.notes.note import NoteRead

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import current_agent_id, current_api_key_installation_id
from app.exceptions import (
    ConflictError,
    ForbiddenError,
    GoneError,
    PayloadTooLargeError,
    ResourceNotFoundError,
    ValidationError,
)
from app.models.activity import ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.notes.finding import FindingSeverity
from app.models.notes.kinds import IMMUTABLE_KINDS, REVIEW_VERDICT
from app.models.notes.note import Note
from app.models.workspace import WorkspaceRole
from app.repositories.kanban.card import CardRepository
from app.repositories.notes.note import NoteOrderBy, NoteRepository, SortDirection
from app.repositories.notes.save_receipt import NoteSaveReceiptRepository
from app.repositories.workspace import WorkspaceMemberRepository
from app.schemas.notes.note import (
    EXCERPT_SOURCE_BYTES_LIMIT,
    REVIEWED_DOCUMENT_BYTES_LIMIT,
    ExcerptSource,
    Finding,
    NoteAppend,
    NoteCreate,
    NoteEdit,
    NotePublicationPresenceRead,
    NotePublicationRevisionRead,
    NoteSectionReplace,
    NoteUpdate,
)
from app.services.activity import ActivityService
from app.services.agents.context_manifest import note_revision
from app.services.notes.content_serializer import prosemirror_to_markdown
from app.services.notes.content_text import extract_plain_text
from app.services.kanban.freeze_guard import assert_board_not_frozen
from app.services.kanban.labels import stamp_label
from app.services.media.canonicalize import MediaLinkCanonicalizer
from app.services.kanban.snapshots import snapshot_card
from app.services.mentions.notify import notify_new_mentions
from app.services.reviews.stuck_loop import record_review_iteration
from app.services.session_content import AgentSessionContentService
from app.services.work_consultation import WorkConsultationService
from app.core.mcp_invocation import current_mcp_invocation_id
from app.models.notes.history import NoteMutationReceipt
from app.repositories.notes.history import NoteHistoryRepository
from app.services.notes.history_access import NoteHistoryAccess
from app.services.notes.history_content import NoteHistoryContent, snapshot, revision_digest

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

# The note_revision algorithm a receipt's digest was made with: v1 is the one
# its digest domain names. A digest of any other version is never compared
# with today's algorithm.
PUBLISHED_NOTE_REVISION_VERSION = 1
# A lowercase hex sha256, as note_revision writes it. CHAR(64) space-pads
# anything shorter, which then fails this too.
_SHA256_HEX_PATTERN = re.compile(r"[0-9a-f]{64}")


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


def compact_json(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def excerpt_fingerprint(
    workspace_id: uuid.UUID,
    board_id: uuid.UUID,
    data: NoteCreate,
    source: ExcerptSource,
    reviewed: dict,
) -> str:
    """Same save, same fingerprint, whatever the JSON key order; items keep
    their order, which is the order the owner reviewed them in."""
    canonical = {
        "workspace_id": str(workspace_id),
        "board_id": str(board_id),
        "card_id": str(data.card_id) if data.card_id else None,
        "title": data.title,
        "content": reviewed,
        "excerpt_source": source.model_dump(mode="json"),
    }
    return hashlib.sha256(
        json.dumps(
            canonical, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode()
    ).hexdigest()


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
        note, _ = await self.save_note(workspace_id, data, user_id, board_id)
        return note

    async def save_note(
        self,
        workspace_id: uuid.UUID,
        data: NoteCreate,
        user_id: uuid.UUID,
        board_id: uuid.UUID | None = None,
    ) -> tuple[Note, bool]:
        """(note, created): False when an excerpt save replays its receipt."""
        if data.excerpt_source is not None or data.client_request_id is not None:
            await self._authorize_excerpt_publisher(workspace_id, user_id)
        await NoteHistoryAccess(self.db).authorize(workspace_id, user_id, write=True)
        await self._check_destination(workspace_id, board_id, data.card_id)
        if data.excerpt_source is None or data.client_request_id is None:
            return await self._insert_note(workspace_id, data, user_id, board_id), True
        return await self._save_excerpt(
            workspace_id,
            data,
            user_id,
            board_id,
            data.excerpt_source,
            data.client_request_id,
        )

    async def _authorize_excerpt_publisher(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID
    ) -> None:
        """Before any receipt can answer: only the person themselves, still a
        writing member of the destination, publishes or replays an excerpt."""
        # Both keys resolve to the owner, so a receipt keyed by user alone
        # would hand them the owner's saved excerpt.
        if (
            current_agent_id.get() is not None
            or current_api_key_installation_id.get() is not None
        ):
            raise ForbiddenError("Only the session's owner can publish its content")
        membership = await WorkspaceMemberRepository(self.db).get_membership(
            workspace_id, user_id
        )
        if membership is None:
            raise ForbiddenError("Not a member of this workspace")
        if membership.role == WorkspaceRole.viewer:
            raise ForbiddenError("Insufficient permissions")

    async def _check_destination(
        self,
        workspace_id: uuid.UUID,
        board_id: uuid.UUID | None,
        card_id: uuid.UUID | None,
    ) -> None:
        if board_id is not None:
            board_workspace = await self.db.scalar(
                select(Board.workspace_id).where(Board.id == board_id)
            )
            if board_workspace != workspace_id:
                raise ResourceNotFoundError("Board not found")
        await assert_board_not_frozen(self.db, board_id)
        if card_id:
            await self._validate_card_link(workspace_id, board_id, card_id)

    async def _save_excerpt(
        self,
        workspace_id: uuid.UUID,
        data: NoteCreate,
        user_id: uuid.UUID,
        board_id: uuid.UUID | None,
        source: ExcerptSource,
        client_request_id: uuid.UUID,
    ) -> tuple[Note, bool]:
        """Publish an owner-reviewed excerpt of their captured session once
        per client_request_id. The publisher and destination are already
        checked."""
        if board_id is None:
            raise ValidationError("An excerpt note needs a board")
        reviewed = json.loads(data.content)
        if len(compact_json(reviewed)) > REVIEWED_DOCUMENT_BYTES_LIMIT:
            raise PayloadTooLargeError(
                f"The reviewed document exceeds {REVIEWED_DOCUMENT_BYTES_LIMIT} bytes"
            )
        receipts = NoteSaveReceiptRepository(self.db)
        fingerprint = excerpt_fingerprint(
            workspace_id, board_id, data, source, reviewed
        )
        receipt_id = await receipts.claim(
            user_id=user_id,
            client_request_id=client_request_id,
            workspace_id=workspace_id,
            board_id=board_id,
            card_id=data.card_id,
            fingerprint=fingerprint,
        )
        if receipt_id is None:
            replayed = await self._replay(
                receipts, user_id, client_request_id, fingerprint
            )
            return replayed, False
        await AgentSessionContentService(self.db).verify_excerpt_source(
            source.workspace_id,
            user_id,
            source.session_id,
            {item.content_id: item.sha256 for item in source.items},
            max_total_bytes=EXCERPT_SOURCE_BYTES_LIMIT,
        )
        note = await self._insert_note(workspace_id, data, user_id, board_id)
        await receipts.complete(
            receipt_id,
            note.id,
            published_note_revision_sha256=note_revision(note),
            published_note_revision_version=PUBLISHED_NOTE_REVISION_VERSION,
        )
        return note, True

    async def _replay(
        self,
        receipts: NoteSaveReceiptRepository,
        user_id: uuid.UUID,
        client_request_id: uuid.UUID,
        fingerprint: str,
    ) -> Note:
        receipt = await receipts.get(user_id, client_request_id)
        if receipt is None or receipt.fingerprint != fingerprint:
            raise ConflictError(
                "This client_request_id was already used for a different save",
                error_code="client_request_conflict",
            )
        note = (
            await self.note_repo.get_by_id(receipt.note_id)
            if receipt.note_id is not None
            else None
        )
        if note is None:
            raise GoneError("The note saved by this request was deleted")
        note.revision_digest = revision_digest(snapshot(note))
        return note

    async def _insert_note(
        self,
        workspace_id: uuid.UUID,
        data: NoteCreate,
        user_id: uuid.UUID,
        board_id: uuid.UUID | None,
    ) -> Note:
        content = await MediaLinkCanonicalizer(self.db).rich_text(workspace_id, data.content)
        create_kwargs = dict(
            history_revision=1,
            workspace_id=workspace_id,
            board_id=board_id,
            title=data.title,
            content=content,
            content_text=extract_plain_text(content),
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
        actor = await NoteHistoryAccess(self.db).authorize(workspace_id, user_id, write=True)
        note.history_revision = 1
        await NoteHistoryContent(self.db).record(
            note_id=note.id, revision=1, snapshot=snapshot(note),
            capture_kind="creation", operation="create", changed_fields=list(snapshot(note)),
            actor=actor, invocation_id=current_mcp_invocation_id.get(),
        )
        note.revision_digest = revision_digest(snapshot(note))
        await self.db.flush()
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
            publish_after_commit=True,
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
        matches[0].revision_digest = revision_digest(snapshot(matches[0]))
        return matches[0]

    async def get_note(self, note_id: uuid.UUID, workspace_id: uuid.UUID):
        note = await self.note_repo.get_current(note_id)
        if not note or note.workspace_id != workspace_id:
            raise ResourceNotFoundError("Note not found")
        note.revision_digest = revision_digest(snapshot(note))
        return note

    async def get_note_read(
        self,
        note_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        as_markdown: bool = False,
        reader_id: uuid.UUID | None = None,
    ) -> "NoteRead":
        """Return the note as a NoteRead schema, optionally with `content`
        serialized to markdown (the reverse of the stored PM JSON).

        Keeps the format decision in the service so the router stays thin: the
        markdown transform is a pure projection of stored content, produced via
        the closed-vocabulary serializer.
        """
        from app.schemas.notes.note import NoteRead

        note = await self.get_note(note_id, workspace_id)
        if reader_id is not None:
            await WorkConsultationService(self.db).record(
                workspace_id, reader_id, "note", note.id
            )
        read = NoteRead.model_validate(note)
        if as_markdown:
            read = read.model_copy(
                update={"content": prosemirror_to_markdown(note.content)}
            )
        return read

    async def get_note_publication_presence(
        self,
        *,
        workspace_id: uuid.UUID,
        board_id: uuid.UUID,
        note_id: uuid.UUID,
        user_id: uuid.UUID,
    ) -> NotePublicationPresenceRead:
        await self._authorize_publication_reader(workspace_id, user_id)
        # Read only the receipt timestamp, then verify the note still exists.
        # Ordinary opens must never load a body or calculate a fingerprint.
        recorded_at = await NoteSaveReceiptRepository(self.db).get_publication_recorded_at(
            user_id, note_id
        )
        await self._require_publication_note_scope(workspace_id, board_id, note_id, user_id)
        return NotePublicationPresenceRead(
            has_record=recorded_at is not None, recorded_at=recorded_at
        )

    async def _require_publication_note_scope(
        self, workspace_id: uuid.UUID, board_id: uuid.UUID,
        note_id: uuid.UUID, user_id: uuid.UUID,
    ) -> None:
        scope = await self.note_repo.get_scope(note_id)
        # Other authors' notes are indistinguishable from missing notes.
        if (
            scope is None
            or scope.workspace_id != workspace_id
            or scope.board_id != board_id
            or scope.created_by != user_id
        ):
            raise ResourceNotFoundError("Note not found")

    async def get_note_publication_revision(
        self,
        *,
        workspace_id: uuid.UUID,
        board_id: uuid.UUID,
        note_id: uuid.UUID,
        user_id: uuid.UUID,
    ) -> NotePublicationRevisionRead:
        """Compare the saved note with the revision its publisher saved, for
        that publisher alone. Reads no captured source, so the source's
        deletion or a lost source membership changes nothing here."""
        await self._authorize_publication_reader(workspace_id, user_id)
        # The receipt before the note: a delete between the two reads then
        # answers 404, never a no_record for a note that had one.
        publication = await NoteSaveReceiptRepository(self.db).get_publication(
            user_id, note_id
        )
        await self._require_publication_note_scope(workspace_id, board_id, note_id, user_id)
        if publication is None:
            return NotePublicationRevisionRead(status="no_record")
        recorded_at = publication.created_at
        published_sha256 = publication.published_note_revision_sha256
        version = publication.published_note_revision_version
        if version is None:
            return NotePublicationRevisionRead(
                status="revision_not_recorded", recorded_at=recorded_at
            )
        # Before the digest check: what a digest of another version looks
        # like, or whether it has one at all, is that version's to define.
        if version != PUBLISHED_NOTE_REVISION_VERSION:
            return NotePublicationRevisionRead(
                status="unsupported_version",
                recorded_at=recorded_at,
                revision_version=version,
            )
        if published_sha256 is None or not _SHA256_HEX_PATTERN.fullmatch(
            published_sha256
        ):
            return NotePublicationRevisionRead(
                status="revision_not_recorded", recorded_at=recorded_at
            )

        recorded = {
            "status": "recorded",
            "recorded_at": recorded_at,
            "revision_version": version,
            "published_revision_sha256": published_sha256,
        }
        current = await self.note_repo.get_revision_fields(
            note_id, content_byte_limit=REVIEWED_DOCUMENT_BYTES_LIMIT
        )
        if current is None:
            raise ResourceNotFoundError("Note not found")
        if current.content is None:
            # Never a digest of a prefix: a partial body would compare as differs.
            return NotePublicationRevisionRead(
                **recorded,
                comparison="unavailable",
                comparison_reason="current_note_too_large",
            )
        current_sha256 = note_revision(current)
        return NotePublicationRevisionRead(
            **recorded,
            current_revision_sha256=current_sha256,
            comparison="matches" if current_sha256 == published_sha256 else "differs",
        )

    async def _authorize_publication_reader(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID
    ) -> None:
        """The person themselves, still a member of the destination. Unlike
        publishing, a viewer role or a frozen board still reads, as it does
        the note itself."""
        # Both keys resolve to the publisher, so their user id alone would
        # pass for the publisher's.
        if (
            current_agent_id.get() is not None
            or current_api_key_installation_id.get() is not None
        ):
            raise ForbiddenError(
                "Only the note's publisher can inspect its publication"
            )
        membership = await WorkspaceMemberRepository(self.db).get_membership(
            workspace_id, user_id
        )
        if membership is None:
            raise ForbiddenError("Not a member of this workspace")

    async def update_note(self, note_id, workspace_id, data: NoteUpdate,
                          actor_id=None, board_id=None):
        return await self.edit_note(note_id, workspace_id,
            NoteEdit(mode="replace", **data.model_dump(exclude_unset=True)), actor_id)

    async def append_note(self, note_id, workspace_id, data: NoteAppend,
                          actor_id=None, board_id=None):
        return await self.edit_note(note_id, workspace_id,
            NoteEdit(mode="append", content=data.content), actor_id)

    async def replace_note_section(self, note_id, workspace_id, data: NoteSectionReplace,
                                   actor_id=None, board_id=None):
        return await self.edit_note(note_id, workspace_id,
            NoteEdit(mode="section", **data.model_dump()), actor_id)

    async def edit_note(self, note_id, workspace_id, data: NoteEdit,
                        actor_id=None, *, board_id=None):
        access = NoteHistoryAccess(self.db)
        await access.note_scope(note_id, workspace_id, actor_id, board_id=board_id, write=True)
        # Populate existing is essential: a waiter may already have loaded the
        # old document into this session before the prior writer commits.
        note = await self.note_repo.get_current(note_id, lock=True)
        if note is None or note.workspace_id != workspace_id or (board_id is not None and note.board_id != board_id):
            raise ResourceNotFoundError("Note not found")
        actor = await access.authorize(workspace_id, actor_id, write=True)
        if note.kind in IMMUTABLE_KINDS:
            raise ForbiddenError(f"Cannot modify a {note.kind} note")
        await assert_board_not_frozen(self.db, note.board_id)
        repo = NoteHistoryRepository(self.db)
        principal = access.principal_key(actor_id)
        intent = data.model_dump(mode="json", exclude_unset=True, exclude={"client_request_id"})
        intent["mode"] = data.mode
        fingerprint = hashlib.sha256(json.dumps(intent, sort_keys=True, ensure_ascii=False,
                                               separators=(",", ":")).encode()).hexdigest()
        if data.client_request_id is not None:
            receipt = await repo.get_receipt(note_id, principal, data.client_request_id)
            if receipt is not None:
                if receipt.fingerprint != fingerprint:
                    raise ConflictError("Request identity already used for another edit", error_code="client_request_conflict")
                await access.authorize(workspace_id, actor_id, write=True)
                note.revision_digest = revision_digest(snapshot(note))
                note.applied_revision, note.changed, note.replayed = receipt.applied_revision, receipt.changed, True
                return note
        before = snapshot(note)
        digest = revision_digest(before)
        if ((data.expected_revision is not None and data.expected_revision != note.history_revision)
                or (data.expected_digest is not None and data.expected_digest != digest)):
            raise ConflictError("Note has changed", error_code="note_revision_conflict")
        update_fields = data.model_dump(exclude_unset=True, include={"title", "content", "pinned", "card_id"})
        if update_fields.get("card_id") is not None:
            await self._validate_card_link(workspace_id, note.board_id, update_fields["card_id"])
        if data.mode != "replace":
            existing = json.loads(note.content) if note.content else {"type": "doc", "content": []}
            blocks = existing.get("content") or []
            incoming = json.loads(data.content).get("content") or []
            if data.mode == "append":
                merged = blocks + incoming
            else:
                anchor, end = _locate_section(blocks, data.anchor_heading)
                merged = blocks[:anchor + 1] + incoming + blocks[end:]
            update_fields["content"] = json.dumps({**existing, "content": merged})
        if "content" in update_fields:
            update_fields["content"] = await MediaLinkCanonicalizer(self.db).rich_text(workspace_id, update_fields["content"])
        # Exact final persisted state defines a change, not the submitted keys.
        changed_fields = [key for key, value in update_fields.items() if before[key] != (str(value) if isinstance(value, uuid.UUID) else value)]
        actor = await access.authorize(workspace_id, actor_id, write=True)
        applied_revision = None
        if changed_fields:
            history = NoteHistoryContent(self.db)
            latest = await repo.latest(note_id)
            if latest is None or latest.revision_digest != digest:
                note.history_revision += 1
                latest = await history.record(note_id=note_id, revision=note.history_revision,
                    snapshot=before, capture_kind="baseline" if latest is None else "gap_baseline",
                    operation="capture", changed_fields=[], actor=None)
            for key in changed_fields:
                setattr(note, key, update_fields[key])
            if "content" in changed_fields:
                note.content_text = extract_plain_text(note.content)
            note.history_revision += 1
            applied_revision = note.history_revision
            await history.record(note_id=note_id, revision=applied_revision,
                snapshot=snapshot(note), capture_kind="edit", operation=data.mode,
                changed_fields=changed_fields, actor=actor,
                invocation_id=current_mcp_invocation_id.get(),
                previous=latest, previous_content=before["content"])
            await self.db.flush()
            await self.db.refresh(note)
            if actor_id is not None:
                summary = f"updated note '{note.title}'"
                if data.mode == "append":
                    summary = f"appended to note '{note.title}'"
                if data.mode == "section":
                    summary = f"replaced section '{data.anchor_heading.strip()}' in note '{note.title}'"
                changes = {"fields": changed_fields}
                if data.mode != "replace":
                    changes["mode"] = "replace_section" if data.mode == "section" else "append"
                if data.mode == "section":
                    changes["anchor_heading"] = data.anchor_heading.strip()
                activity = ActivityService(self.db)
                activity_context = {
                    "workspace_id": workspace_id,
                    "actor_id": actor_id,
                    "entity_type": ActivityEntityType.note,
                    "entity_id": note_id,
                    "action": ActivityAction.updated,
                    "board_id": note.board_id,
                    "changes": changes,
                    "publish_after_commit": True,
                }
                # Literal mode-specific contracts stay visible to the shared
                # activity audit while mutation/history ownership stays unified.
                if data.mode == "replace":
                    await activity.record(
                        **activity_context, summary=summary,
                        message_key="activity.note.updated",
                        message_params={"note_title": note.title, "fields": changed_fields},
                    )
                elif data.mode == "append":
                    await activity.record(
                        **activity_context, summary=summary,
                        message_key="activity.note.appended",
                        message_params={"note_title": note.title},
                    )
                else:
                    await activity.record(
                        **activity_context, summary=summary,
                        message_key="activity.note.section_replaced",
                        message_params={
                            "section_heading": data.anchor_heading.strip(),
                            "note_title": note.title,
                        },
                    )
                await notify_new_mentions(self.db, workspace_id=workspace_id,
                    board_id=note.board_id, actor_id=actor_id, entity_type="note",
                    entity_id=note_id, card_id=note.card_id,
                    before_content=before["content"], after_content=note.content)
        if data.client_request_id is not None:
            await repo.add_receipt(NoteMutationReceipt(note_id=note_id, principal_key=principal,
                client_request_id=data.client_request_id, fingerprint=fingerprint,
                applied_revision=applied_revision, changed=bool(changed_fields)))
        await access.authorize(workspace_id, actor_id, write=True)
        note.revision_digest = revision_digest(snapshot(note))
        note.applied_revision, note.changed, note.replayed = applied_revision, bool(changed_fields), False
        return note

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
                board_id=note.board_id,
                summary=f"deleted note '{note.title}'",
                message_key="activity.note.deleted",
                message_params={"note_title": note.title},
                publish_after_commit=True,
            )
        await self.note_repo.delete(note)
