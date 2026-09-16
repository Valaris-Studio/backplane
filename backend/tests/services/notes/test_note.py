# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.notes.note import NoteCreate, NoteUpdate
from app.services.notes.note import NoteService


async def test_create_note(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    import json

    service = NoteService(db_session)
    data = NoteCreate(title="My Note", content="Some content")

    note = await service.create_note(test_workspace.id, data, test_user.id, test_board.id)

    assert note.title == "My Note"
    # Content is normalized to canonical ProseMirror JSON on write.
    stored = json.loads(note.content)
    assert stored["type"] == "doc"
    assert stored["content"][0]["content"][0]["text"] == "Some content"
    assert note.pinned is False
    assert note.workspace_id == test_workspace.id
    assert note.board_id == test_board.id
    assert note.created_by == test_user.id


async def test_list_board_notes(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id, NoteCreate(title="Note 1"), test_user.id, test_board.id
    )
    await service.create_note(
        test_workspace.id, NoteCreate(title="Note 2"), test_user.id, test_board.id
    )

    notes = await service.list_board_notes(test_board.id)

    assert len(notes) == 2
    titles = [n.title for n in notes]
    assert "Note 1" in titles
    assert "Note 2" in titles


async def test_list_workspace_notes(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = NoteService(db_session)
    # Workspace-level note (no board_id)
    await service.create_note(
        test_workspace.id, NoteCreate(title="WS Note"), test_user.id
    )
    # Board-level note (should NOT appear)
    await service.create_note(
        test_workspace.id, NoteCreate(title="Board Note"), test_user.id, test_board.id
    )

    notes = await service.list_workspace_notes(test_workspace.id)

    assert len(notes) == 1
    assert notes[0].title == "WS Note"
    assert notes[0].board_id is None


async def test_get_note(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = NoteService(db_session)
    created = await service.create_note(
        test_workspace.id, NoteCreate(title="Get Me"), test_user.id
    )

    note = await service.get_note(created.id, test_workspace.id)

    assert note.id == created.id
    assert note.title == "Get Me"


async def test_get_note_not_found(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = NoteService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.get_note(uuid.uuid4(), test_workspace.id)


async def test_update_note(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = NoteService(db_session)
    created = await service.create_note(
        test_workspace.id, NoteCreate(title="Original"), test_user.id
    )

    updated = await service.update_note(
        created.id, test_workspace.id, NoteUpdate(title="Updated")
    )

    assert updated.title == "Updated"
    assert updated.id == created.id


async def test_delete_note(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = NoteService(db_session)
    created = await service.create_note(
        test_workspace.id, NoteCreate(title="Delete Me"), test_user.id
    )

    await service.delete_note(created.id, test_workspace.id)

    with pytest.raises(ResourceNotFoundError):
        await service.get_note(created.id, test_workspace.id)


async def test_pinned_notes_first(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id, NoteCreate(title="Unpinned"), test_user.id, test_board.id
    )
    await service.create_note(
        test_workspace.id, NoteCreate(title="Pinned", pinned=True), test_user.id, test_board.id
    )

    notes = await service.list_board_notes(test_board.id)

    assert notes[0].title == "Pinned"
    assert notes[0].pinned is True
    assert notes[1].title == "Unpinned"
    assert notes[1].pinned is False


# --- Tests for activity recording ---


async def test_create_note_records_activity(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType
    from sqlalchemy import select

    service = NoteService(db_session)
    data = NoteCreate(title="Activity Note")

    note = await service.create_note(test_workspace.id, data, test_user.id, test_board.id)

    result = await db_session.execute(select(Activity))
    activities = list(result.scalars().all())
    assert len(activities) == 1
    a = activities[0]
    assert a.entity_type == ActivityEntityType.note
    assert a.action == ActivityAction.created
    assert a.entity_id == note.id
    assert a.workspace_id == test_workspace.id
    assert a.board_id == test_board.id
    assert a.actor_id == test_user.id
    assert "created note" in a.summary
    assert "Activity Note" in a.summary


async def test_update_note_records_activity(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType
    from sqlalchemy import select

    service = NoteService(db_session)
    note = await service.create_note(
        test_workspace.id, NoteCreate(title="Original"), test_user.id, test_board.id
    )

    await service.update_note(
        note.id, test_workspace.id, NoteUpdate(title="Updated"),
        actor_id=test_user.id, board_id=test_board.id,
    )

    result = await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.updated)
    )
    activities = list(result.scalars().all())
    assert len(activities) == 1
    a = activities[0]
    assert a.entity_type == ActivityEntityType.note
    assert a.entity_id == note.id
    assert "updated note" in a.summary


async def test_delete_note_records_activity(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType
    from sqlalchemy import select

    service = NoteService(db_session)
    note = await service.create_note(
        test_workspace.id, NoteCreate(title="Delete Me"), test_user.id, test_board.id
    )

    await service.delete_note(
        note.id, test_workspace.id,
        actor_id=test_user.id, board_id=test_board.id,
    )

    result = await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.deleted)
    )
    activities = list(result.scalars().all())
    assert len(activities) == 1
    a = activities[0]
    assert a.entity_type == ActivityEntityType.note
    assert a.entity_id == note.id
    assert "deleted note" in a.summary
    assert "Delete Me" in a.summary


# --- Tests for card_id support ---


async def test_create_note_with_card_id(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    service = NoteService(db_session)
    data = NoteCreate(title="Card Note", card_id=test_card.id)

    note = await service.create_note(test_workspace.id, data, test_user.id, test_board.id)

    assert note.card_id == test_card.id
    assert note.board_id == test_board.id
    assert note.title == "Card Note"


async def test_list_card_notes(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id,
        NoteCreate(title="Card Note 1", card_id=test_card.id),
        test_user.id,
        test_board.id,
    )
    await service.create_note(
        test_workspace.id,
        NoteCreate(title="Card Note 2", card_id=test_card.id),
        test_user.id,
        test_board.id,
    )
    # Unlinked note on the same board should not appear
    await service.create_note(
        test_workspace.id,
        NoteCreate(title="Board Only"),
        test_user.id,
        test_board.id,
    )

    notes = await service.list_card_notes(test_card.id, test_workspace.id)

    assert len(notes) == 2
    titles = [n.title for n in notes]
    assert "Card Note 1" in titles
    assert "Card Note 2" in titles


async def test_create_note_without_card_id_leaves_null(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    service = NoteService(db_session)
    data = NoteCreate(title="No Card")

    note = await service.create_note(test_workspace.id, data, test_user.id, test_board.id)

    assert note.card_id is None


# --- Tests for note.kind + verdict immutability (511c20ca / cb652017) ---


async def test_create_note_default_kind_is_user_note(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    service = NoteService(db_session)
    note = await service.create_note(
        test_workspace.id, NoteCreate(title="No kind specified"), test_user.id, test_board.id
    )
    assert note.kind == "user_note"


async def test_create_review_verdict_note(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    service = NoteService(db_session)
    data = NoteCreate(
        title=f"Review: {test_card.id} — approve",
        content="LGTM",
        kind="review_verdict",
        card_id=test_card.id,
    )
    note = await service.create_note(test_workspace.id, data, test_user.id, test_board.id)
    assert note.kind == "review_verdict"


async def test_delete_review_verdict_note_forbidden(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    from app.exceptions import ForbiddenError

    service = NoteService(db_session)
    note = await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — approve",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )

    with pytest.raises(ForbiddenError):
        await service.delete_note(note.id, test_workspace.id, actor_id=test_user.id)

    persisted = await service.get_note(note.id, test_workspace.id)
    assert persisted.id == note.id


async def test_update_review_verdict_note_forbidden(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    from app.exceptions import ForbiddenError

    service = NoteService(db_session)
    note = await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — approve",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )

    with pytest.raises(ForbiddenError):
        await service.update_note(
            note.id,
            test_workspace.id,
            NoteUpdate(content="rewriting verdict"),
            actor_id=test_user.id,
        )


async def test_delete_user_note_still_works(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    service = NoteService(db_session)
    note = await service.create_note(
        test_workspace.id,
        NoteCreate(title="regular note"),
        test_user.id,
        test_board.id,
    )

    await service.delete_note(note.id, test_workspace.id, actor_id=test_user.id)

    with pytest.raises(ResourceNotFoundError):
        await service.get_note(note.id, test_workspace.id)


# --- Tests for verdict-of-record query helper ---


async def test_get_card_verdict_returns_latest_immutable(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    from datetime import datetime, timedelta

    service = NoteService(db_session)
    earlier = await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — request_changes",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )
    latest = await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — approve",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )
    # SQLite CURRENT_TIMESTAMP is 1s-resolution; force distinct created_at
    # values so the ORDER BY ... DESC sort is deterministic in tests.
    earlier.created_at = datetime.utcnow() - timedelta(minutes=5)
    latest.created_at = datetime.utcnow()
    await db_session.flush()

    verdict = await service.get_card_verdict(test_card.id, test_workspace.id)

    assert verdict is not None
    assert verdict["decision"] == "approve"
    assert verdict["note_id"] == latest.id


async def test_get_card_verdict_returns_none_when_missing(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_card: Card,
):
    service = NoteService(db_session)
    verdict = await service.get_card_verdict(test_card.id, test_workspace.id)
    assert verdict is None


async def test_get_card_verdict_ignores_user_notes(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    service = NoteService(db_session)
    # User note matching the title pattern but wrong kind.
    await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — approve",
            kind="user_note",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )

    verdict = await service.get_card_verdict(test_card.id, test_workspace.id)
    assert verdict is None


# --- Tests for verdict failure_class (SWE-AF #5) ---


def test_review_failure_class_enum_has_five_canonical_values():
    """The advisor's routing keys are this enum. Adding or removing a value is
    a platform-contract change — keep this assertion strict."""
    from app.models.notes.failure_class import ReviewFailureClass

    assert {c.value for c in ReviewFailureClass} == {
        "ENVIRONMENT",
        "LOGIC",
        "DEPENDENCY",
        "APPROACH",
        "TRANSIENT",
    }


async def test_create_review_verdict_note_persists_failure_class(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    service = NoteService(db_session)
    note = await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — request_changes",
            kind="review_verdict",
            card_id=test_card.id,
            failure_class="LOGIC",
        ),
        test_user.id,
        test_board.id,
    )
    assert note.failure_class == "LOGIC"


async def test_create_review_verdict_note_failure_class_defaults_null(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """Approving verdicts carry no failure_class — the field stays NULL."""
    service = NoteService(db_session)
    note = await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — approve",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )
    assert note.failure_class is None


@pytest.mark.parametrize(
    "value",
    ["ENVIRONMENT", "LOGIC", "DEPENDENCY", "APPROACH", "TRANSIENT"],
)
async def test_create_review_verdict_note_accepts_each_failure_class(
    value: str,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    service = NoteService(db_session)
    note = await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — request_changes",
            kind="review_verdict",
            card_id=test_card.id,
            failure_class=value,
        ),
        test_user.id,
        test_board.id,
    )
    assert note.failure_class == value


def test_note_create_rejects_unknown_failure_class(
    test_card: Card,
):
    """Field shape is `str | None` on the wire but values are enum-validated."""
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        NoteCreate(
            title=f"Review: {test_card.id} — request_changes",
            kind="review_verdict",
            card_id=test_card.id,
            failure_class="OTHER",
        )


async def test_get_card_verdict_includes_failure_class(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — request_changes",
            kind="review_verdict",
            card_id=test_card.id,
            failure_class="DEPENDENCY",
        ),
        test_user.id,
        test_board.id,
    )

    verdict = await service.get_card_verdict(test_card.id, test_workspace.id)

    assert verdict is not None
    assert verdict["decision"] == "request_changes"
    assert verdict["failure_class"] == "DEPENDENCY"


async def test_get_card_verdict_failure_class_null_when_approved(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — approve",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )

    verdict = await service.get_card_verdict(test_card.id, test_workspace.id)

    assert verdict is not None
    assert verdict["decision"] == "approve"
    assert verdict["failure_class"] is None


def test_reviewer_prompt_seed_mentions_failure_class_enum():
    """Reviewer prompt seed must instruct the runner on classification.
    Backend-authoritative: prompt content lives in the DB seed, not the Go
    runner. The five enum values must appear by name + the rule that
    failure_class is required when not approving."""
    from app.services.agents.prompt_defaults import PROMPT_STAGE_REGISTRY

    review_default = next(
        d for d in PROMPT_STAGE_REGISTRY if d.role == "reviewer" and d.stage == "review"
    )
    content = review_default.default_content
    assert "failure_class" in content
    for value in ("ENVIRONMENT", "LOGIC", "DEPENDENCY", "APPROACH", "TRANSIENT"):
        assert value in content, f"reviewer prompt missing {value} in failure_class guidance"


# --- Tests for severity-tiered findings rubric (SWE-AF #3) ---


def test_finding_severity_enum_has_three_canonical_values():
    """Closed set of severity tiers. The done-gate predicate
    (approved = tests_pass AND no BLOCKING) depends on exactly these names —
    adding or removing a tier is a platform-contract change."""
    from app.models.notes.finding import FindingSeverity

    assert {s.value for s in FindingSeverity} == {
        "BLOCKING",
        "SHOULD_FIX",
        "SUGGESTION",
    }


def test_finding_severity_enum_order_preserved():
    """Enum order is intentional — BLOCKING first so UIs that iterate the enum
    render most-severe-first by default."""
    from app.models.notes.finding import FindingSeverity

    assert [s.value for s in FindingSeverity] == ["BLOCKING", "SHOULD_FIX", "SUGGESTION"]


def test_derive_approved_blocking_finding_blocks_even_with_tests_passing():
    from app.models.notes.finding import FindingSeverity
    from app.schemas.notes.note import Finding
    from app.services.notes.note import derive_approved

    findings = [Finding(severity=FindingSeverity.BLOCKING, message="SQL injection in login")]

    assert derive_approved(findings, tests_pass=True) is False


def test_derive_approved_suggestion_only_passes():
    from app.models.notes.finding import FindingSeverity
    from app.schemas.notes.note import Finding
    from app.services.notes.note import derive_approved

    findings = [Finding(severity=FindingSeverity.SUGGESTION, message="rename foo to bar")]

    assert derive_approved(findings, tests_pass=True) is True


def test_derive_approved_should_fix_only_passes():
    """SHOULD_FIX is strong-but-non-blocking by definition — verify the rule."""
    from app.models.notes.finding import FindingSeverity
    from app.schemas.notes.note import Finding
    from app.services.notes.note import derive_approved

    findings = [
        Finding(severity=FindingSeverity.SHOULD_FIX, message="missing edge-case test"),
        Finding(severity=FindingSeverity.SUGGESTION, message="prefer f-string"),
    ]

    assert derive_approved(findings, tests_pass=True) is True


def test_derive_approved_failing_tests_blocks_regardless_of_findings():
    from app.services.notes.note import derive_approved

    assert derive_approved([], tests_pass=False) is False
    assert derive_approved(None, tests_pass=False) is False


def test_derive_approved_empty_findings_and_tests_pass_approves():
    from app.services.notes.note import derive_approved

    assert derive_approved([], tests_pass=True) is True
    assert derive_approved(None, tests_pass=True) is True


def test_derive_approved_mixed_findings_blocking_wins():
    from app.models.notes.finding import FindingSeverity
    from app.schemas.notes.note import Finding
    from app.services.notes.note import derive_approved

    findings = [
        Finding(severity=FindingSeverity.SUGGESTION, message="nit"),
        Finding(severity=FindingSeverity.BLOCKING, message="auth bypass"),
        Finding(severity=FindingSeverity.SHOULD_FIX, message="add test"),
    ]

    assert derive_approved(findings, tests_pass=True) is False


def test_derive_approved_is_deterministic():
    """Same input → same output, no hidden state."""
    from app.models.notes.finding import FindingSeverity
    from app.schemas.notes.note import Finding
    from app.services.notes.note import derive_approved

    findings = [Finding(severity=FindingSeverity.SHOULD_FIX, message="x")]
    first = derive_approved(findings, tests_pass=True)
    second = derive_approved(findings, tests_pass=True)
    assert first == second is True


async def test_create_review_verdict_note_persists_findings(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    service = NoteService(db_session)
    note = await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — request_changes",
            kind="review_verdict",
            card_id=test_card.id,
            failure_class="LOGIC",
            findings=[
                {
                    "severity": "BLOCKING",
                    "file": "app/foo.py",
                    "function": "do_thing",
                    "message": "off-by-one",
                },
                {"severity": "SUGGESTION", "message": "rename"},
            ],
        ),
        test_user.id,
        test_board.id,
    )
    assert note.findings is not None
    assert len(note.findings) == 2
    assert note.findings[0]["severity"] == "BLOCKING"
    assert note.findings[0]["file"] == "app/foo.py"
    assert note.findings[1]["severity"] == "SUGGESTION"


async def test_create_review_verdict_note_findings_default_null(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """Old code that doesn't know about `findings` keeps working — NULL means
    'no structured findings recorded'."""
    service = NoteService(db_session)
    note = await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — approve",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )
    assert note.findings is None


def test_note_create_rejects_unknown_finding_severity(test_card: Card):
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        NoteCreate(
            title=f"Review: {test_card.id} — request_changes",
            kind="review_verdict",
            card_id=test_card.id,
            findings=[{"severity": "CRITICAL", "message": "x"}],
        )


def test_note_read_roundtrips_findings_as_structured_list(test_card: Card):
    """NoteRead must surface findings as a list of Finding dicts, not raw JSON
    or prose. The frontend (and the advisor in a follow-up) reads the list
    directly."""
    from app.schemas.notes.note import NoteRead

    now = datetime.now()
    payload = {
        "id": uuid.uuid4(),
        "workspace_id": uuid.uuid4(),
        "board_id": None,
        "card_id": test_card.id,
        "title": f"Review: {test_card.id} — request_changes",
        "content": "",
        "pinned": False,
        "kind": "review_verdict",
        "failure_class": "LOGIC",
        "findings": [
            {"severity": "BLOCKING", "message": "broken", "file": None, "function": None},
        ],
        "created_by": uuid.uuid4(),
        "created_at": now,
        "updated_at": now,
    }
    read = NoteRead(**payload)
    assert read.findings is not None
    assert read.findings[0].severity == "BLOCKING"


async def test_get_card_verdict_includes_findings_and_approved(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """Done-gate hand-off: verdict payload exposes derived `approved` so the
    gate (and frontend) don't re-implement the predicate."""
    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — request_changes",
            kind="review_verdict",
            card_id=test_card.id,
            failure_class="LOGIC",
            findings=[{"severity": "BLOCKING", "message": "fails contract"}],
        ),
        test_user.id,
        test_board.id,
    )

    verdict = await service.get_card_verdict(test_card.id, test_workspace.id)

    assert verdict is not None
    assert verdict["decision"] == "request_changes"
    assert verdict["findings"] is not None
    assert verdict["findings"][0]["severity"] == "BLOCKING"
    # A BLOCKING finding never approves regardless of tests_pass.
    assert verdict["approved"] is False


async def test_get_card_verdict_no_findings_falls_back_to_decision_string(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """Old-path back-compat: a verdict note created before SWE-AF #3 has
    NULL findings. The verdict payload still returns — `approved` defers to
    the legacy decision string ('approve' → True)."""
    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — approve",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )

    verdict = await service.get_card_verdict(test_card.id, test_workspace.id)

    assert verdict is not None
    assert verdict["decision"] == "approve"
    assert verdict["findings"] is None
    # NULL findings → fall back to the decision string for back-compat.
    assert verdict["approved"] is True


def test_reviewer_prompt_seed_mentions_severity_tiers_and_approval_rule():
    """Reviewer prompt seed must teach the LLM the three severity tiers and
    the deterministic approval rule. Backend-authoritative: the prompt lives
    in the DB seed, not the runner."""
    from app.services.agents.prompt_defaults import PROMPT_STAGE_REGISTRY

    review_default = next(
        d for d in PROMPT_STAGE_REGISTRY if d.role == "reviewer" and d.stage == "review"
    )
    content = review_default.default_content
    for tier in ("BLOCKING", "SHOULD_FIX", "SUGGESTION"):
        assert tier in content, f"reviewer prompt missing severity tier {tier}"
    # The rule must be explicit, not implied.
    assert "findings" in content
    # The approval rule's two clauses must both appear.
    assert "tests_pass" in content
    # The seed must spell out that SUGGESTION (and SHOULD_FIX) never blocks,
    # so the LLM doesn't park a real blocker under SUGGESTION.
    assert "never block" in content.lower() or "does not block" in content.lower()


# --- Tests for deterministic ui-validation routing on approve (run-B FIX #2) ---
#
# The reviewer-LLM prompt asks it to apply `needs-ui-validation` on approve when
# the card body carries the `Validation: requires-ui-validation` marker — but a
# routing label that gates a REQUIRED stage must not be LLM-discretionary. The
# guarantee lives server-side: the verdict-note write path stamps the label
# deterministically, with no LLM/tool call involved.


async def test_approve_verdict_stamps_ui_validation_label_when_marker_present(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    test_card.description = (
        "Build the settings page.\n\nValidation: requires-ui-validation\n"
    )
    await db_session.flush()

    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — approve",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )

    assert "needs-ui-validation" in (test_card.labels or [])


async def test_request_changes_verdict_does_not_stamp_ui_validation_label(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    test_card.description = "Fix the modal.\n\nValidation: requires-ui-validation\n"
    await db_session.flush()

    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — request_changes",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )

    assert "needs-ui-validation" not in (test_card.labels or [])


async def test_approve_verdict_without_marker_does_not_stamp_ui_validation_label(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    # test_card.description is "A test card" — no marker.
    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — approve",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )

    assert "needs-ui-validation" not in (test_card.labels or [])


async def test_approve_verdict_ui_validation_stamp_is_idempotent(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    test_card.description = "Polish the page.\n\nValidation: requires-ui-validation"
    test_card.labels = ["needs-ui-validation", "frontend"]
    await db_session.flush()

    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — approve",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )

    assert test_card.labels.count("needs-ui-validation") == 1


async def test_approve_verdict_marker_match_tolerates_case_and_whitespace(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    test_card.description = (
        "Ship the dashboard.\n   vAlIdAtIoN:   REQUIRES-UI-VALIDATION   \nMore text."
    )
    await db_session.flush()

    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — approve",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )

    assert "needs-ui-validation" in (test_card.labels or [])


async def test_approve_verdict_stamp_records_card_updated_activity(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """M5: the deterministic stamp must be observable — a card-updated activity
    row (actor = the verdict note's author) so board history shows what applied
    the routing label, and the activity fan-out live-updates kanban views."""
    from sqlalchemy import select

    from app.models.activity import Activity, ActivityAction, ActivityEntityType

    test_card.description = "Build the page.\n\nValidation: requires-ui-validation"
    await db_session.flush()

    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — approve",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )

    activity = (
        await db_session.execute(
            select(Activity).where(
                Activity.entity_type == ActivityEntityType.card,
                Activity.entity_id == test_card.id,
                Activity.action == ActivityAction.updated,
            )
        )
    ).scalar_one_or_none()

    assert activity is not None, "label stamp must record a card-updated activity"
    assert activity.actor_id == test_user.id
    assert activity.workspace_id == test_workspace.id
    assert activity.board_id == test_card.board_id
    assert "labels" in activity.changes["fields"]
    assert "needs-ui-validation" in activity.summary


async def test_approve_verdict_noop_stamp_records_no_card_activity(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """Idempotent no-op (label already present) must NOT spam board history."""
    from sqlalchemy import select

    from app.models.activity import Activity, ActivityAction, ActivityEntityType

    test_card.description = "Polish.\n\nValidation: requires-ui-validation"
    test_card.labels = ["needs-ui-validation"]
    await db_session.flush()

    service = NoteService(db_session)
    await service.create_note(
        test_workspace.id,
        NoteCreate(
            title=f"Review: {test_card.id} — approve",
            kind="review_verdict",
            card_id=test_card.id,
        ),
        test_user.id,
        test_board.id,
    )

    card_activities = (
        await db_session.execute(
            select(Activity).where(
                Activity.entity_type == ActivityEntityType.card,
                Activity.entity_id == test_card.id,
                Activity.action == ActivityAction.updated,
            )
        )
    ).scalars().all()

    assert card_activities == []
