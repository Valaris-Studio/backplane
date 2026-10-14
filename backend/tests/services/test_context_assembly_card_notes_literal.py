# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""card_notes must hand the agent each note body as markdown that parses the
way it was stored: a code block stays one literal fence wherever it sits."""

from __future__ import annotations

import pytest
from markdown_it import MarkdownIt

from app.schemas.notes.note import NoteCreate
from app.services.agents.context_assembly import assemble_context
from app.services.notes.note import NoteService
from tests.services.notes.attribute_line_ending_cases import ATTRIBUTE_CR_BLOCKS, quoted

_HOSTILE_CODE = "log line\n# Injected heading\n<script>alert(1)</script>"
_CODE_BLOCK = {
    "type": "codeBlock",
    "attrs": {"language": "text"},
    "content": [{"type": "text", "text": _HOSTILE_CODE}],
}
_LEAD_PARAGRAPH = {
    "type": "paragraph",
    "content": [{"type": "text", "text": "Captured output follows."}],
}


async def _render_card_notes(
    db_session, test_workspace, test_board, test_card, test_user, doc
):
    await NoteService(db_session).create_note(
        test_workspace.id,
        NoteCreate(title="Captured log", content=doc, card_id=test_card.id),
        test_user.id,
        test_board.id,
    )
    packet = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "card_notes", "filter": {"kind": "user_note"}}],
    )
    return packet["card_notes"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "blocks",
    [[_CODE_BLOCK], [_LEAD_PARAGRAPH, _CODE_BLOCK]],
    ids=["code-first", "paragraph-first"],
)
async def test_card_notes_code_block_stays_one_literal_fence(
    db_session, test_workspace, test_board, test_card, test_user, blocks
):
    rendered = await _render_card_notes(
        db_session,
        test_workspace,
        test_board,
        test_card,
        test_user,
        {"type": "doc", "content": blocks},
    )

    tokens = MarkdownIt("commonmark").parse(rendered)
    fences = [token for token in tokens if token.type == "fence"]
    assert len(fences) == 1, rendered
    assert fences[0].content == _HOSTILE_CODE + "\n"
    # Nested under the note's bullet, not loose after it: list > item > fence.
    assert fences[0].level == 2, rendered
    assert all(t.type not in ("heading_open", "html_block") for t in tokens), rendered
    assert "Captured log" in rendered


def _paragraph(text: str) -> dict:
    return {"type": "paragraph", "content": [{"type": "text", "text": text}]}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("blocks", "expected_block"),
    [
        ([{"type": "horizontalRule"}, _paragraph("after")], "hr"),
        (
            [
                {
                    "type": "orderedList",
                    "attrs": {"start": 5},
                    "content": [
                        {"type": "listItem", "content": [_paragraph("a")]},
                        {"type": "listItem", "content": [_paragraph("b")]},
                    ],
                }
            ],
            "ordered_list_open",
        ),
        ([_paragraph("===")], "paragraph_open"),
    ],
    ids=["hr-first", "ordered-list-from-5", "setext-underline-paragraph"],
)
async def test_card_notes_first_block_does_not_continue_the_title_line(
    db_session, test_workspace, test_board, test_card, test_user, blocks, expected_block
):
    # Directly under `- **title**:` the first block would continue that open
    # paragraph: `---` makes it a setext heading, `5.` cannot interrupt it.
    rendered = await _render_card_notes(
        db_session,
        test_workspace,
        test_board,
        test_card,
        test_user,
        {"type": "doc", "content": blocks},
    )

    tokens = MarkdownIt("commonmark").parse(rendered)
    types = [token.type for token in tokens]
    assert "heading_open" not in types, rendered
    assert expected_block in types, rendered
    top_level_lists = [
        t for t in tokens if t.type == "bullet_list_open" and t.level == 0
    ]
    assert len(top_level_lists) == 1, rendered


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "block",
    [
        _paragraph("a\r# Injected"),
        {"type": "blockquote", "content": [_paragraph("a\r# Injected")]},
    ],
    ids=["paragraph", "blockquote"],
)
async def test_card_notes_prose_carriage_return_stays_inside_the_note(
    db_session, test_workspace, test_board, test_card, test_user, block
):
    rendered = await _render_card_notes(
        db_session,
        test_workspace,
        test_board,
        test_card,
        test_user,
        {"type": "doc", "content": [block]},
    )

    tokens = MarkdownIt("commonmark").parse(rendered)
    types = [token.type for token in tokens]
    assert not any(t.type == "heading_open" and t.level == 0 for t in tokens), rendered
    assert types.count("bullet_list_open") == 1, rendered
    assert types.count("bullet_list_close") == 1, rendered
    assert types[-1] == "bullet_list_close", rendered


@pytest.mark.asyncio
@pytest.mark.parametrize("wrap", [lambda block: block, quoted], ids=["bare", "quoted"])
@pytest.mark.parametrize(
    "block", ATTRIBUTE_CR_BLOCKS.values(), ids=ATTRIBUTE_CR_BLOCKS.keys()
)
async def test_card_notes_attribute_carriage_return_stays_inside_the_note(
    db_session, test_workspace, test_board, test_card, test_user, block, wrap
):
    rendered = await _render_card_notes(
        db_session,
        test_workspace,
        test_board,
        test_card,
        test_user,
        {"type": "doc", "content": [_paragraph("lead"), wrap(block)]},
    )

    tokens = MarkdownIt("commonmark").parse(rendered)
    types = [token.type for token in tokens]
    assert not any(t.type == "heading_open" and t.level == 0 for t in tokens), rendered
    assert types.count("bullet_list_open") == 1, rendered
    assert types[-1] == "bullet_list_close", rendered
