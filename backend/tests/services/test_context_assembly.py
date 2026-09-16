# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""CTX-1: Backend-rendered context_sources for /next-assignment.

Each starter kind has a server-side fetcher that returns a string keyed by
the source's `as` alias (defaulting to `kind` when omitted). Empty results
still produce the alias key with an empty string — the runner gets a
deterministic dict shape it can template against without conditionals.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.definitions.definition import Definition
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardDependency
from app.models.kanban.column import Column, ColumnType
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.notes.note import NoteCreate
from app.services.agents.context_assembly import assemble_context
from app.services.notes.note import NoteService


@pytest.mark.asyncio
async def test_assemble_context_returns_empty_dict_when_no_sources(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[],
    )

    assert rendered == {}


@pytest.mark.asyncio
async def test_assemble_context_card_notes_renders_user_notes(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    db_session.add_all([
        Note(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            card_id=test_card.id,
            title="Spec clarification",
            content="Use kebab-case slugs.",
            kind="user_note",
            created_by=test_user.id,
        ),
        Note(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            card_id=test_card.id,
            title="Verdict",
            content="approve",
            kind="review_verdict",
            created_by=test_user.id,
        ),
    ])
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[
            {"kind": "card_notes", "filter": {"kind": "user_note"}, "as": "notes"},
        ],
    )

    assert "notes" in rendered
    assert "Spec clarification" in rendered["notes"]
    assert "kebab-case" in rendered["notes"]
    assert "Verdict" not in rendered["notes"]


@pytest.mark.asyncio
async def test_assemble_context_card_notes_alias_defaults_to_kind(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    db_session.add(Note(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        card_id=test_card.id,
        title="Hint",
        content="Don't forget i18n.",
        kind="user_note",
        created_by=test_user.id,
    ))
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[
            {"kind": "card_notes", "filter": {"kind": "user_note"}},
        ],
    )

    assert "card_notes" in rendered
    assert "Hint" in rendered["card_notes"]


@pytest.mark.asyncio
async def test_assemble_context_card_notes_empty_returns_empty_string(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[
            {"kind": "card_notes", "filter": {"kind": "user_note"}, "as": "notes"},
        ],
    )

    assert rendered == {"notes": ""}


@pytest.mark.asyncio
async def test_assemble_context_board_definition_renders_directives(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    db_session.add(Definition(
        board_id=test_board.id,
        workspace_id=test_workspace.id,
        scope="Build the MVP",
        content={"coding_standards": "Use type hints everywhere."},
        updated_by=test_user.id,
    ))
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "board_definition"}],
    )

    assert "board_definition" in rendered
    assert "type hints" in rendered["board_definition"]
    assert "CODING STANDARDS" in rendered["board_definition"]


@pytest.mark.asyncio
async def test_assemble_context_board_definition_includes_board_pinned_notes(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    db_session.add(Definition(
        board_id=test_board.id,
        workspace_id=test_workspace.id,
        scope="Build the MVP",
        content={"coding_standards": "Use type hints."},
        updated_by=test_user.id,
    ))
    db_session.add(Note(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        title="House Style",
        content="kebab-case slugs.",
        pinned=True,
        kind="user_note",
        created_by=test_user.id,
    ))
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "board_definition"}],
    )

    assert "CODING STANDARDS" in rendered["board_definition"]
    assert "House Style" in rendered["board_definition"]
    assert "kebab-case slugs." in rendered["board_definition"]


@pytest.mark.asyncio
async def test_assemble_context_board_definition_excludes_workspace_pinned_notes(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    # Workspace-level pinned notes belong to the `pinned_notes` kind, not
    # `board_definition`. Mirrors what the Go runner sees today via
    # GET /boards/{id}/notes (board-scoped only).
    db_session.add(Note(
        workspace_id=test_workspace.id,
        board_id=None,
        title="Workspace Wide",
        content="should not appear in board_definition.",
        pinned=True,
        kind="user_note",
        created_by=test_user.id,
    ))
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "board_definition"}],
    )

    assert rendered == {"board_definition": ""}


@pytest.mark.asyncio
async def test_assemble_context_board_definition_empty_when_unset(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "board_definition"}],
    )

    assert rendered == {"board_definition": ""}


@pytest.mark.asyncio
async def test_board_definition_renders_mandatory_tier_fields(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    db_session.add(Definition(
        board_id=test_board.id,
        workspace_id=test_workspace.id,
        scope="Ship the billing service.",
        content={
            "objectives": [
                {"text": "Support recurring invoices", "priority": "high"},
                {"text": "PCI compliant card vault"},
            ],
            "constraints": ["No third-party payment SDKs", "PostgreSQL only"],
            "exclusions": ["No crypto payments", "No manual invoicing UI"],
            "coding_standards": "Type hints everywhere. 100% test coverage.",
        },
        updated_by=test_user.id,
    ))
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "board_definition"}],
    )

    out = rendered["board_definition"]
    # Scope at top.
    assert out.startswith("PROJECT SCOPE")
    assert "Ship the billing service." in out
    # Mandatory tier present with header.
    assert "MANDATORY" in out
    assert "Support recurring invoices" in out
    assert "high" in out
    assert "PCI compliant card vault" in out
    assert "No third-party payment SDKs" in out
    assert "No crypto payments" in out
    assert "CODING STANDARDS" in out
    assert "Type hints everywhere." in out


@pytest.mark.asyncio
async def test_board_definition_renders_project_context_tier_fields(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    db_session.add(Definition(
        board_id=test_board.id,
        workspace_id=test_workspace.id,
        scope="",
        content={
            "tech_stack": ["FastAPI", "PostgreSQL", "React"],
            "decisions": [
                {"decision": "Use UUID PKs", "rationale": "Avoid id-guessing"},
                {"decision": "Async everywhere"},
            ],
            "milestones": [
                {"title": "MVP", "date": "2026-06-01", "type": "release"},
            ],
            "stakeholders": [
                {"name": "Seba", "role": "Owner"},
            ],
            "references": [
                {"label": "Design doc", "url": "https://example.com/doc"},
                {"url": "https://example.com/bare"},
            ],
            "custom_fields": [
                {"key": "Budget", "value": "$10k"},
            ],
        },
        updated_by=test_user.id,
    ))
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "board_definition"}],
    )

    out = rendered["board_definition"]
    assert "PROJECT CONTEXT" in out
    assert "FastAPI" in out
    assert "Use UUID PKs" in out
    assert "Avoid id-guessing" in out
    assert "MVP" in out
    assert "2026-06-01" in out
    assert "Seba" in out
    assert "Owner" in out
    assert "Design doc" in out
    assert "https://example.com/doc" in out
    assert "https://example.com/bare" in out
    assert "Budget" in out
    assert "$10k" in out


@pytest.mark.asyncio
async def test_board_definition_omits_empty_sections(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    # Only objectives set → no dangling MANDATORY sub-headers, no PROJECT CONTEXT
    # block, no CODING STANDARDS / CONSTRAINTS / EXCLUSIONS headers.
    db_session.add(Definition(
        board_id=test_board.id,
        workspace_id=test_workspace.id,
        scope="",
        content={"objectives": [{"text": "Just one goal"}]},
        updated_by=test_user.id,
    ))
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "board_definition"}],
    )

    out = rendered["board_definition"]
    assert "Just one goal" in out
    assert "CONSTRAINTS" not in out
    assert "EXCLUSIONS" not in out
    assert "CODING STANDARDS" not in out
    assert "PROJECT CONTEXT" not in out
    # No leading scope header when scope is blank.
    assert "PROJECT SCOPE" not in out


@pytest.mark.asyncio
async def test_board_definition_coding_standards_only_regression(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    # The original behavior: coding_standards-only must still produce a
    # CODING STANDARDS line with the standards text.
    db_session.add(Definition(
        board_id=test_board.id,
        workspace_id=test_workspace.id,
        scope="",
        content={"coding_standards": "Use type hints everywhere."},
        updated_by=test_user.id,
    ))
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "board_definition"}],
    )

    out = rendered["board_definition"]
    assert "CODING STANDARDS" in out
    assert "Use type hints everywhere." in out
    assert "PROJECT CONTEXT" not in out


@pytest.mark.asyncio
async def test_board_definition_legacy_bare_string_objective(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    # Agent-authored definitions may store objectives as bare strings; the
    # DefinitionContent coercion must keep the renderer from crashing.
    db_session.add(Definition(
        board_id=test_board.id,
        workspace_id=test_workspace.id,
        scope="",
        content={"objectives": ["Ship it fast"]},
        updated_by=test_user.id,
    ))
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "board_definition"}],
    )

    assert "Ship it fast" in rendered["board_definition"]


@pytest.mark.asyncio
async def test_board_definition_scope_at_top_with_pinned_notes_tail(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    db_session.add(Definition(
        board_id=test_board.id,
        workspace_id=test_workspace.id,
        scope="The mission statement.",
        content={"coding_standards": "Be terse."},
        updated_by=test_user.id,
    ))
    db_session.add(Note(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        title="Pinned Board Note",
        content="Remember to update the changelog.",
        pinned=True,
        kind="user_note",
        created_by=test_user.id,
    ))
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "board_definition"}],
    )

    out = rendered["board_definition"]
    # Scope first, pinned note last.
    assert out.index("The mission statement.") < out.index("Be terse.")
    assert out.index("Be terse.") < out.index("Pinned Board Note")
    assert "Remember to update the changelog." in out


@pytest.mark.asyncio
async def test_assemble_context_pinned_notes_filters_to_pinned_workspace_notes(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    db_session.add_all([
        Note(
            workspace_id=test_workspace.id,
            board_id=None,
            title="Naming Convention",
            content="kebab-case for slugs.",
            pinned=True,
            kind="user_note",
            created_by=test_user.id,
        ),
        Note(
            workspace_id=test_workspace.id,
            board_id=None,
            title="Drafty Idea",
            content="Maybe ship X.",
            pinned=False,
            kind="user_note",
            created_by=test_user.id,
        ),
    ])
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "pinned_notes"}],
    )

    assert "pinned_notes" in rendered
    assert "Naming Convention" in rendered["pinned_notes"]
    assert "kebab-case" in rendered["pinned_notes"]
    assert "Drafty Idea" not in rendered["pinned_notes"]


@pytest.mark.asyncio
async def test_assemble_context_pinned_notes_empty_when_none_pinned(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "pinned_notes"}],
    )

    assert rendered == {"pinned_notes": ""}


@pytest.mark.asyncio
async def test_assemble_context_combines_multiple_sources(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    db_session.add_all([
        Note(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            card_id=test_card.id,
            title="Note A",
            content="alpha",
            kind="user_note",
            created_by=test_user.id,
        ),
        Note(
            workspace_id=test_workspace.id,
            board_id=None,
            title="Pinned",
            content="omega",
            pinned=True,
            kind="user_note",
            created_by=test_user.id,
        ),
        Definition(
            board_id=test_board.id,
            workspace_id=test_workspace.id,
            scope="Build the MVP",
            content={"coding_standards": "be terse"},
            updated_by=test_user.id,
        ),
    ])
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[
            {"kind": "card_notes", "filter": {"kind": "user_note"}, "as": "notes"},
            {"kind": "board_definition"},
            {"kind": "pinned_notes"},
        ],
    )

    assert set(rendered.keys()) == {"notes", "board_definition", "pinned_notes"}
    assert "alpha" in rendered["notes"]
    assert "be terse" in rendered["board_definition"]
    assert "omega" in rendered["pinned_notes"]


# ---------------------------------------------------------------------------
# Kind-less card_notes (the planner's CardNotes handoff, card d5e97b40)
# ---------------------------------------------------------------------------


def _card_note(test_workspace, test_board, test_card, test_user, **fields) -> Note:
    return Note(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        card_id=test_card.id,
        created_by=test_user.id,
        **fields,
    )


@pytest.mark.asyncio
async def test_assemble_context_card_notes_renders_stored_note_as_markdown_not_json(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """Every note written through NoteService is stored as canonical ProseMirror
    JSON, so rendering `n.content` hands the agent one giant JSON line. The
    fetcher must project it back through `prosemirror_to_markdown` (structure
    survives for the model; `content_text` is the search projection and
    collapses headings/lists into one whitespace run)."""
    await NoteService(db_session).create_note(
        test_workspace.id,
        NoteCreate(
            title="Research findings",
            content="## Findings\n\nUse **kebab-case** slugs.",
            card_id=test_card.id,
            kind="user_note",
        ),
        test_user.id,
        test_board.id,
    )

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "card_notes", "as": "CardNotes"}],
    )

    text = rendered["CardNotes"]
    assert "Research findings" in text
    assert "Findings" in text and "kebab-case" in text
    assert '"type"' not in text and '"doc"' not in text, (
        f"card_notes must render note prose, not the stored ProseMirror JSON: {text!r}"
    )


@pytest.mark.asyncio
async def test_assemble_context_card_notes_kindless_marks_each_note_with_its_kind(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """A kind-less source mixes research, plans and verdicts in one block; the
    agent needs each note's kind as a bracketed marker before the title to
    tell a prior plan from a human hint."""
    db_session.add_all([
        _card_note(test_workspace, test_board, test_card, test_user,
                   title="Plan v1", content="do X then Y", kind="plan"),
        _card_note(test_workspace, test_board, test_card, test_user,
                   title="Spec clarification", content="slugs are kebab-case", kind="user_note"),
    ])
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "card_notes", "as": "CardNotes"}],
    )

    text = rendered["CardNotes"]
    for marker, title in (("[plan]", "Plan v1"), ("[user_note]", "Spec clarification")):
        assert marker in text, f"kind-less card_notes must mark each note with its kind: {text!r}"
        assert text.index(marker) < text.index(title), (
            f"the {marker} marker must precede the title {title!r}: {text!r}"
        )


@pytest.mark.asyncio
async def test_assemble_context_card_notes_honours_filter_limit_newest_first(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """`filter.limit` goes through the shared `_clamp_limit` convention the
    other fetchers use, and the repository orders newest first, so the notes
    that survive the cap are the most recent ones."""
    epoch = datetime(2026, 1, 1, 12, 0, 0)
    db_session.add_all([
        _card_note(test_workspace, test_board, test_card, test_user,
                   title=title, content=f"{title} body", kind="user_note",
                   created_at=epoch + timedelta(days=age))
        for title, age in (("Oldest", 0), ("Middle", 1), ("Newest", 2))
    ])
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "card_notes", "as": "CardNotes", "filter": {"limit": 2}}],
    )

    text = rendered["CardNotes"]
    assert text.count("Newest body") == 1 and text.count("Middle body") == 1, text
    assert "Oldest body" not in text, f"limit=2 must drop the oldest note: {text!r}"
    assert text.index("Newest") < text.index("Middle"), f"newest first: {text!r}"


# ---------------------------------------------------------------------------
# CTX-5: sibling_cards / board_snapshot / review_history
# ---------------------------------------------------------------------------


async def _make_column(
    db_session: AsyncSession,
    *,
    board: Board,
    name: str,
    position: float,
    column_type: ColumnType | None = None,
) -> Column:
    column = Column(
        board_id=board.id,
        name=name,
        position=position,
        column_type=column_type,
    )
    db_session.add(column)
    await db_session.flush()
    return column


async def _make_card(
    db_session: AsyncSession,
    *,
    board: Board,
    column: Column,
    user: User,
    title: str,
    position: float,
    status: str | None = None,
    priority: str = "none",
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        description="",
        position=position,
        created_by=user.id,
        status=status,
        priority=priority,
    )
    db_session.add(card)
    await db_session.flush()
    return card


@pytest.mark.asyncio
async def test_sibling_cards_returns_filtered_list_by_column_type(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    review_col = await _make_column(
        db_session, board=test_board, name="Review", position=2048.0,
        column_type=ColumnType.review,
    )
    active_col = await _make_column(
        db_session, board=test_board, name="Active", position=3072.0,
        column_type=ColumnType.active,
    )
    sibling_in_review = await _make_card(
        db_session, board=test_board, column=review_col, user=test_user,
        title="Review Sibling", position=1.0, status="reviewing",
    )
    await _make_card(
        db_session, board=test_board, column=active_col, user=test_user,
        title="Active Sibling", position=2.0, status="working",
    )

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[
            {"kind": "sibling_cards", "filter": {"column_type": "review"}},
        ],
    )

    out = rendered["sibling_cards"]
    assert "Review Sibling" in out
    assert "Active Sibling" not in out
    # Self-card MUST be excluded.
    assert test_card.title not in out
    # CARD-XXXX prefix uses first 8 chars of UUID.
    assert f"CARD-{str(sibling_in_review.id)[:8]}" in out


@pytest.mark.asyncio
async def test_sibling_cards_excludes_self(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "sibling_cards"}],
    )
    assert test_card.title not in rendered["sibling_cards"]


@pytest.mark.asyncio
async def test_sibling_cards_respects_limit(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    for i in range(30):
        await _make_card(
            db_session, board=test_board, column=test_column, user=test_user,
            title=f"Sibling {i}", position=float(100 + i),
        )

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "sibling_cards", "filter": {"limit": 5}}],
    )

    lines = [line for line in rendered["sibling_cards"].splitlines() if line.startswith("- ")]
    assert len(lines) == 5


@pytest.mark.asyncio
async def test_sibling_cards_empty_returns_empty_string(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "sibling_cards", "filter": {"column_type": "done"}}],
    )
    assert rendered == {"sibling_cards": ""}


@pytest.mark.asyncio
async def test_sibling_cards_renders_actual_column_name_not_filter_value(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    # Two distinct review-typed columns — operator must see WHICH one each
    # sibling sits in, not just an echo of the filter value "review".
    review_col = await _make_column(
        db_session, board=test_board, name="Review", position=2048.0,
        column_type=ColumnType.review,
    )
    qa_col = await _make_column(
        db_session, board=test_board, name="QA", position=2560.0,
        column_type=ColumnType.review,
    )
    sib_review = await _make_card(
        db_session, board=test_board, column=review_col, user=test_user,
        title="Review Sibling", position=1.0, status="reviewing",
    )
    sib_qa = await _make_card(
        db_session, board=test_board, column=qa_col, user=test_user,
        title="QA Sibling", position=2.0, status="qa-pending",
    )

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "sibling_cards", "filter": {"column_type": "review"}}],
    )

    out = rendered["sibling_cards"]
    review_line = next(
        ln for ln in out.splitlines() if f"CARD-{str(sib_review.id)[:8]}" in ln
    )
    qa_line = next(
        ln for ln in out.splitlines() if f"CARD-{str(sib_qa.id)[:8]}" in ln
    )
    assert "(Review, reviewing)" in review_line
    assert "(QA, qa-pending)" in qa_line


@pytest.mark.asyncio
async def test_sibling_cards_renders_column_name_with_no_filter(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
    test_column: Column,
):
    # No filter set → siblings can be anywhere; each row must show its own
    # column name, not "no column".
    other_col = await _make_column(
        db_session, board=test_board, name="In Progress", position=3072.0,
    )
    sib_todo = await _make_card(
        db_session, board=test_board, column=test_column, user=test_user,
        title="Todo Sibling", position=10.0, status="ready",
    )
    sib_progress = await _make_card(
        db_session, board=test_board, column=other_col, user=test_user,
        title="Progress Sibling", position=11.0, status="working",
    )

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "sibling_cards"}],
    )

    out = rendered["sibling_cards"]
    todo_line = next(
        ln for ln in out.splitlines() if f"CARD-{str(sib_todo.id)[:8]}" in ln
    )
    progress_line = next(
        ln for ln in out.splitlines() if f"CARD-{str(sib_progress.id)[:8]}" in ln
    )
    assert "(To Do, ready)" in todo_line
    assert "(In Progress, working)" in progress_line
    assert "no column" not in out


@pytest.mark.asyncio
async def test_board_snapshot_groups_by_column(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    review_col = await _make_column(
        db_session, board=test_board, name="Review", position=2048.0,
        column_type=ColumnType.review,
    )
    await _make_card(
        db_session, board=test_board, column=review_col, user=test_user,
        title="In Review", position=1.0,
    )

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "board_snapshot"}],
    )

    snap = rendered["board_snapshot"]
    # Default test_card lives in `test_column` ("To Do"); review column has 1 card.
    assert "## To Do (1)" in snap
    assert "## Review (1)" in snap
    assert test_card.title in snap
    assert "In Review" in snap


@pytest.mark.asyncio
async def test_board_snapshot_skips_done_when_include_done_false(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    done_col = await _make_column(
        db_session, board=test_board, name="Done", position=4096.0,
        column_type=ColumnType.done,
    )
    await _make_card(
        db_session, board=test_board, column=done_col, user=test_user,
        title="Shipped", position=1.0,
    )

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "board_snapshot"}],
    )
    assert "## Done" not in rendered["board_snapshot"]
    assert "Shipped" not in rendered["board_snapshot"]


@pytest.mark.asyncio
async def test_board_snapshot_includes_done_when_flag_true(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    done_col = await _make_column(
        db_session, board=test_board, name="Done", position=4096.0,
        column_type=ColumnType.done,
    )
    await _make_card(
        db_session, board=test_board, column=done_col, user=test_user,
        title="Shipped", position=1.0,
    )

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "board_snapshot", "filter": {"include_done": True}}],
    )
    assert "## Done (1)" in rendered["board_snapshot"]
    assert "Shipped" in rendered["board_snapshot"]


@pytest.mark.asyncio
async def test_board_snapshot_truncates_to_max_cards(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    # test_column already holds test_card (1) — add 29 more to reach 30 total.
    for i in range(29):
        await _make_card(
            db_session, board=test_board, column=test_column, user=test_user,
            title=f"Extra {i}", position=float(100 + i),
        )

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "board_snapshot", "filter": {"max_cards_per_column": 10}}],
    )

    snap = rendered["board_snapshot"]
    # Header counts the full column membership, not the truncated render.
    assert "## To Do (30)" in snap
    # 10 card lines + a "more" suffix line.
    card_lines = [
        ln for ln in snap.splitlines()
        if ln.startswith("- [CARD-")
    ]
    assert len(card_lines) == 10
    assert "_...20 more_" in snap


@pytest.mark.asyncio
async def test_board_snapshot_empty_board_returns_empty_string(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # Build a fresh board with no columns.
    bare_board = Board(
        workspace_id=test_workspace.id,
        slug="bare",
        name="Bare",
        description="",
        created_by=test_user.id,
    )
    db_session.add(bare_board)
    await db_session.flush()

    placeholder_card = Card(
        board_id=bare_board.id,
        column_id=bare_board.id,  # nonsensical but unused — fetcher walks columns.
        title="x",
        description="",
        position=0.0,
        created_by=test_user.id,
    )
    # Don't insert the placeholder; we just need a non-DB Card stand-in.
    placeholder_card.id = bare_board.id

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=placeholder_card,
        board=bare_board,
        sources=[{"kind": "board_snapshot"}],
    )
    assert rendered == {"board_snapshot": ""}


@pytest.mark.asyncio
async def test_review_history_format_parity_with_runner(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """Byte-for-byte parity with runner/internal/workloop/loop.go:1477.

    Format per note: `--- {Title} (created {CreatedAt}) ---\\n{Content}`.
    Joined with `\\n\\n`. Notes returned newest-first by the repository.
    """
    from app.repositories.notes.note import NoteRepository

    note_a = Note(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        card_id=test_card.id,
        title="Round 1",
        content="please rework the migration",
        kind="review_verdict",
        created_by=test_user.id,
    )
    db_session.add(note_a)
    await db_session.flush()
    await db_session.refresh(note_a)

    note_b = Note(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        card_id=test_card.id,
        title="Round 2",
        content="approve",
        kind="review_verdict",
        created_by=test_user.id,
    )
    db_session.add(note_b)
    await db_session.flush()
    await db_session.refresh(note_b)

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "review_history"}],
    )

    # Match the repository's ordering exactly so the parity assertion is
    # independent of insert-time clock resolution (SQLite ties two inserts on
    # the same millisecond, in which case ORDER BY created_at DESC returns
    # rows in insertion order).
    repo = NoteRepository(db_session)
    notes_in_repo_order = await repo.list_card_notes_by_kind(
        card_id=test_card.id, workspace_id=test_workspace.id, kind="review_verdict"
    )
    expected = "\n\n".join(
        f"--- {n.title} (created {n.created_at.isoformat()}) ---\n{n.content}"
        for n in notes_in_repo_order
    )
    assert rendered["review_history"] == expected
    # Sanity-check the format byte-for-byte against a known excerpt.
    assert "--- Round " in rendered["review_history"]
    assert ") ---\n" in rendered["review_history"]


@pytest.mark.asyncio
async def test_review_history_empty_returns_empty_string(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "review_history"}],
    )
    assert rendered == {"review_history": ""}


@pytest.mark.asyncio
async def test_review_history_ignores_non_verdict_notes(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    db_session.add_all([
        Note(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            card_id=test_card.id,
            title="Spec",
            content="non-verdict",
            kind="user_note",
            created_by=test_user.id,
        ),
        Note(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            card_id=test_card.id,
            title="Verdict",
            content="approve",
            kind="review_verdict",
            created_by=test_user.id,
        ),
    ])
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "review_history"}],
    )

    assert "Verdict" in rendered["review_history"]
    assert "non-verdict" not in rendered["review_history"]
    assert "Spec" not in rendered["review_history"]


# ---------------------------------------------------------------------------
# dependency_health
# ---------------------------------------------------------------------------


async def _make_dependency(
    db_session: AsyncSession,
    *,
    card: Card,
    depends_on: Card,
    user: User,
) -> None:
    db_session.add(
        CardDependency(
            card_id=card.id,
            depends_on_card_id=depends_on.id,
            created_by=user.id,
        )
    )
    await db_session.flush()


@pytest.mark.asyncio
async def test_dependency_health_reports_cycle(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    a = await _make_card(
        db_session, board=test_board, column=test_column, user=test_user,
        title="Cycle Alpha", position=10.0,
    )
    b = await _make_card(
        db_session, board=test_board, column=test_column, user=test_user,
        title="Cycle Beta", position=11.0,
    )
    await _make_dependency(db_session, card=a, depends_on=b, user=test_user)
    await _make_dependency(db_session, card=b, depends_on=a, user=test_user)

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "dependency_health"}],
    )

    out = rendered["dependency_health"]
    assert "DEPENDENCY HEALTH" in out
    assert "Cycle Alpha" in out
    assert "Cycle Beta" in out


@pytest.mark.asyncio
async def test_dependency_health_reports_done_conflict(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    done_col = await _make_column(
        db_session, board=test_board, name="Done", position=4096.0,
        column_type=ColumnType.done,
    )
    finished = await _make_card(
        db_session, board=test_board, column=done_col, user=test_user,
        title="Done Card", position=1.0,
    )
    unfinished = await _make_card(
        db_session, board=test_board, column=test_column, user=test_user,
        title="Unfinished Prereq", position=2.0,
    )
    await _make_dependency(
        db_session, card=finished, depends_on=unfinished, user=test_user
    )

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "dependency_health"}],
    )

    out = rendered["dependency_health"]
    assert "DEPENDENCY HEALTH" in out
    assert "Done Card" in out
    assert "Unfinished Prereq" in out


@pytest.mark.asyncio
async def test_dependency_health_clean_board_returns_empty_string(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    a = await _make_card(
        db_session, board=test_board, column=test_column, user=test_user,
        title="A", position=10.0,
    )
    b = await _make_card(
        db_session, board=test_board, column=test_column, user=test_user,
        title="B", position=11.0,
    )
    await _make_dependency(db_session, card=a, depends_on=b, user=test_user)

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "dependency_health"}],
    )
    assert rendered == {"dependency_health": ""}


# ---------------------------------------------------------------------------
# CTX-7: linked_cards — the current card's own dependency edges with status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_linked_cards_renders_depends_on_and_blocks(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    done_col = await _make_column(
        db_session, board=test_board, name="Done", position=4096.0,
        column_type=ColumnType.done,
    )
    prereq_done = await _make_card(
        db_session, board=test_board, column=done_col, user=test_user,
        title="Finished Prereq", position=1.0, status="shipped",
    )
    prereq_open = await _make_card(
        db_session, board=test_board, column=test_column, user=test_user,
        title="Open Prereq", position=2.0, status="working",
    )
    dependent = await _make_card(
        db_session, board=test_board, column=test_column, user=test_user,
        title="Downstream Card", position=3.0,
    )
    # test_card depends on both prereqs; dependent depends on test_card.
    await _make_dependency(db_session, card=test_card, depends_on=prereq_done, user=test_user)
    await _make_dependency(db_session, card=test_card, depends_on=prereq_open, user=test_user)
    await _make_dependency(db_session, card=dependent, depends_on=test_card, user=test_user)

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "linked_cards"}],
    )

    out = rendered["linked_cards"]
    # Prerequisites section names both, with done-state annotation.
    assert "DEPENDS ON" in out
    assert "Finished Prereq" in out
    assert "Open Prereq" in out
    # The done prereq is flagged satisfied, the open one not.
    finished_line = next(ln for ln in out.splitlines() if "Finished Prereq" in ln)
    open_line = next(ln for ln in out.splitlines() if "Open Prereq" in ln)
    assert "done" in finished_line.lower()
    assert "not done" in open_line.lower() or "pending" in open_line.lower()
    # Blocks section names the downstream card.
    assert "BLOCKS" in out
    assert "Downstream Card" in out
    assert f"CARD-{str(prereq_done.id)[:8]}" in out


@pytest.mark.asyncio
async def test_linked_cards_direction_filter_depends_on_only(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    prereq = await _make_card(
        db_session, board=test_board, column=test_column, user=test_user,
        title="Upstream", position=1.0,
    )
    dependent = await _make_card(
        db_session, board=test_board, column=test_column, user=test_user,
        title="Downstream", position=2.0,
    )
    await _make_dependency(db_session, card=test_card, depends_on=prereq, user=test_user)
    await _make_dependency(db_session, card=dependent, depends_on=test_card, user=test_user)

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "linked_cards", "filter": {"direction": "depends_on"}}],
    )

    out = rendered["linked_cards"]
    assert "Upstream" in out
    assert "Downstream" not in out
    assert "BLOCKS" not in out


@pytest.mark.asyncio
async def test_linked_cards_empty_returns_empty_string(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "linked_cards"}],
    )
    assert rendered == {"linked_cards": ""}


# ---------------------------------------------------------------------------
# CTX-7: execution_history — prior agent runs that touched this card
# ---------------------------------------------------------------------------


async def _make_execution(
    db_session: AsyncSession,
    *,
    workspace: Workspace,
    board: Board,
    agent_id,
    card: Card,
    action: str,
    status: str,
    output_summary: str | None = None,
    error_message: str | None = None,
    role: str | None = None,
    model: str | None = None,
):
    from app.models.agents.execution import AgentExecution, ExecutionStatus

    execution = AgentExecution(
        agent_id=agent_id,
        workspace_id=workspace.id,
        board_id=board.id,
        action=action,
        status=ExecutionStatus(status),
        cards_affected=[str(card.id)],
        output_summary=output_summary,
        error_message=error_message,
        role=role,
        model=model,
    )
    db_session.add(execution)
    await db_session.flush()
    return execution


@pytest.mark.asyncio
async def test_execution_history_renders_past_runs_for_card(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_agent,
):
    await _make_execution(
        db_session, workspace=test_workspace, board=test_board,
        agent_id=test_agent.id, card=test_card,
        action="implement_card", status="completed",
        output_summary="Opened PR #42", role="implementer", model="opus",
    )
    await _make_execution(
        db_session, workspace=test_workspace, board=test_board,
        agent_id=test_agent.id, card=test_card,
        action="review_card", status="failed",
        error_message="tests red", role="reviewer", model="sonnet",
    )

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "execution_history"}],
    )

    out = rendered["execution_history"]
    assert "implement_card" in out
    assert "Opened PR #42" in out
    assert "review_card" in out
    assert "tests red" in out
    assert "completed" in out
    assert "failed" in out


@pytest.mark.asyncio
async def test_execution_history_excludes_other_cards(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
    test_agent,
):
    other = await _make_card(
        db_session, board=test_board, column=test_column, user=test_user,
        title="Other Card", position=99.0,
    )
    await _make_execution(
        db_session, workspace=test_workspace, board=test_board,
        agent_id=test_agent.id, card=other,
        action="implement_card", status="completed",
        output_summary="unrelated work",
    )

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "execution_history"}],
    )
    assert rendered == {"execution_history": ""}


@pytest.mark.asyncio
async def test_execution_history_status_filter(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_agent,
):
    await _make_execution(
        db_session, workspace=test_workspace, board=test_board,
        agent_id=test_agent.id, card=test_card,
        action="implement_card", status="completed", output_summary="ok",
    )
    await _make_execution(
        db_session, workspace=test_workspace, board=test_board,
        agent_id=test_agent.id, card=test_card,
        action="review_card", status="failed", error_message="boom",
    )

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "execution_history", "filter": {"status": "failed"}}],
    )

    out = rendered["execution_history"]
    assert "review_card" in out
    assert "implement_card" not in out


# ---------------------------------------------------------------------------
# CTX-7: card_activity — the card's own activity timeline
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_card_activity_renders_card_timeline(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType

    db_session.add_all([
        Activity(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            entity_type=ActivityEntityType.card,
            entity_id=test_card.id,
            action=ActivityAction.moved,
            summary="moved To Do -> Active",
            actor_id=test_user.id,
        ),
        Activity(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            entity_type=ActivityEntityType.card,
            entity_id=test_card.id,
            action=ActivityAction.dependency_added,
            summary="added dependency on card abc",
            actor_id=test_user.id,
        ),
    ])
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "card_activity"}],
    )

    out = rendered["card_activity"]
    assert "moved To Do -> Active" in out
    assert "added dependency on card abc" in out


@pytest.mark.asyncio
async def test_card_activity_excludes_other_entities(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType

    other = await _make_card(
        db_session, board=test_board, column=test_column, user=test_user,
        title="Other", position=88.0,
    )
    db_session.add(Activity(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        entity_type=ActivityEntityType.card,
        entity_id=other.id,
        action=ActivityAction.moved,
        summary="other card moved",
        actor_id=test_user.id,
    ))
    await db_session.flush()

    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "card_activity"}],
    )
    assert rendered == {"card_activity": ""}


# ---------------------------------------------------------------------------
# pipeline_expectations: render the role's own stage config (current_role,
# default) or the whole-pipeline map (all_roles). Pure config-render — no DB.
# ---------------------------------------------------------------------------

# A minimal reviewer-style stage with a decision LLM step whose branches point
# at downstream lifecycle steps. Mirrors DEFAULT_PIPELINE_CONFIG's reviewer
# shape without coupling the tests to it.
_REVIEWER_STAGE = {
    "role": "reviewer",
    "discover": {
        "strategy": "column_scan",
        "column_type": "review",
        "filters": {"require_pipeline_role": "implementer"},
    },
    "llm": {
        "enabled": True,
        "stage": "review",
        "post_process_kind": "produces_decision",
        "tools": ["mcp__valaris__get_card", "mcp__valaris__get_card_verdict"],
    },
    "lifecycle": [
        {
            "name": "review_diff",
            "kind": "llm",
            "params": {"stage": "review", "post_process_kind": "produces_decision"},
            "branches": {
                "approve": "approve_move_done",
                "request_changes": "rc_apply_label",
            },
        },
        {
            "name": "approve_move_done",
            "kind": "move_card",
            "params": {"to_column_type": "done"},
        },
        {
            "name": "rc_apply_label",
            "kind": "apply_label",
            "params": {"label": "needs-rework"},
            "next": "rc_move_back",
        },
        {
            "name": "rc_move_back",
            "kind": "move_card",
            "params": {"to_column_type": "active"},
        },
    ],
}

_PLANNER_STAGE = {
    "role": "planner",
    "discover": {
        "strategy": "column_scan",
        "column_type": "backlog",
        "filters": {"require_git_repo": True, "exclude_label": "planned"},
    },
    "llm": {
        "enabled": True,
        "stage": "plan",
        "post_process_kind": "produces_note",
        "tools": ["mcp__valaris__get_card"],
    },
    "lifecycle": [
        {
            "name": "plan_it",
            "kind": "llm",
            "params": {"stage": "plan", "post_process_kind": "produces_note"},
            "next": "apply_planned",
        },
        {
            "name": "apply_planned",
            "kind": "apply_label",
            "params": {"label": "planned"},
            "next": "move_active",
        },
        {
            "name": "move_active",
            "kind": "move_card",
            "params": {"to_column_type": "active"},
        },
    ],
}


@pytest.mark.asyncio
async def test_pipeline_expectations_current_role_renders_decision_vocab(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "pipeline_expectations"}],
        stage=_REVIEWER_STAGE,
    )

    out = rendered["pipeline_expectations"]
    assert "reviewer" in out
    assert "produces_decision" in out
    # Both decision tokens surface with their downstream effect.
    assert "approve" in out
    assert "request_changes" in out
    # Effects resolved from each branch's destination step.
    assert "done" in out  # approve -> move_card(done)
    assert "needs-rework" in out  # request_changes -> apply_label
    # Allowed tools listed (short names, not the mcp__valaris__ prefix noise).
    assert "get_card_verdict" in out


@pytest.mark.asyncio
async def test_pipeline_expectations_current_role_non_decision_stage(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "pipeline_expectations"}],
        stage=_PLANNER_STAGE,
    )

    out = rendered["pipeline_expectations"]
    assert "planner" in out
    assert "produces_note" in out
    # A non-decision stage has no decision vocabulary — must not invent one.
    assert "approve" not in out
    assert "request_changes" not in out


@pytest.mark.asyncio
async def test_pipeline_expectations_empty_when_no_stage(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    # No stage threaded through (e.g. legacy call site) -> empty string, never
    # a crash. Mirrors every other fetcher's empty-string convention.
    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "pipeline_expectations"}],
    )
    assert rendered == {"pipeline_expectations": ""}


@pytest.mark.asyncio
async def test_pipeline_expectations_all_roles_renders_every_role(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[
            {"kind": "pipeline_expectations", "filter": {"scope": "all_roles"}},
        ],
        stage=_PLANNER_STAGE,
        pipeline_stages=[_PLANNER_STAGE, _REVIEWER_STAGE],
    )

    out = rendered["pipeline_expectations"]
    # Every configured role appears, regardless of which one is current.
    assert "planner" in out
    assert "reviewer" in out
    # Discover predicates surface so a plumber can match cards to roles.
    assert "backlog" in out
    assert "review" in out
    assert "exclude_label" in out or "planned" in out
    # The set of labels the pipeline moves cards by — the plumber's cross-ref.
    assert "needs-rework" in out
    # Decision edges still render in the overview.
    assert "approve" in out


@pytest.mark.asyncio
async def test_pipeline_expectations_all_roles_without_stages_uses_current(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    # scope=all_roles but no pipeline_stages threaded -> degrade to the current
    # stage rather than rendering nothing (defensive: a plumber misconfig
    # shouldn't blank the prompt).
    rendered = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[
            {"kind": "pipeline_expectations", "filter": {"scope": "all_roles"}},
        ],
        stage=_REVIEWER_STAGE,
    )
    out = rendered["pipeline_expectations"]
    assert "reviewer" in out
