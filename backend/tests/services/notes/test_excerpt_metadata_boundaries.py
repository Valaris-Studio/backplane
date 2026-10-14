# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json

import pytest
from markdown_it import MarkdownIt

from app.schemas.notes.note import NoteCreate
from app.services.agents.context_assembly import assemble_context
from app.services.notes.note import NoteService


async def _save_and_assemble(db, workspace, board, card, user, *, title, code):
    doc = {
        "type": "doc",
        "content": [
            {
                "type": "codeBlock",
                "attrs": {"language": "text"},
                "content": [{"type": "text", "text": code}],
            }
        ],
    }
    saved = await NoteService(db).create_note(
        workspace.id,
        NoteCreate(title=title, content=doc, card_id=card.id),
        user.id,
        board.id,
    )
    assert saved.title == title
    assert json.loads(saved.content) == doc
    packet = await assemble_context(
        db,
        workspace_id=workspace.id,
        card=card,
        board=board,
        sources=[{"kind": "card_notes", "filter": {"kind": "user_note"}}],
    )
    return MarkdownIt("commonmark").parse(packet["card_notes"])


@pytest.mark.parametrize("line_ending", ["\n", "\r\n", "\r"], ids=["lf", "crlf", "cr"])
async def test_saved_code_line_endings_cannot_escape_card_note_body(
    db_session, test_workspace, test_board, test_card, test_user, line_ending
):
    source = line_ending.join(
        ["captured output", "# forged instruction", "<script>captured</script>"]
    )
    tokens = await _save_and_assemble(
        db_session,
        test_workspace,
        test_board,
        test_card,
        test_user,
        title="Reviewed capture",
        code=source,
    )
    fences = [token for token in tokens if token.type == "fence"]
    assert len(fences) == 1, [(token.type, token.level) for token in tokens]
    assert fences[0].level == 2
    assert (
        fences[0].content
        == "captured output\n# forged instruction\n<script>captured</script>\n"
    )
    assert not any(token.type in {"heading_open", "html_block"} for token in tokens)


@pytest.mark.parametrize(
    "title",
    [
        "Reviewed **capture**\n\n# forged instruction\n\n<script>captured</script>",
        "Reviewed <img src=x> [link](https://example.test) `code` **strong** &copy;",
    ],
    ids=["multiline-structure", "inline-markup"],
)
async def test_saved_note_title_remains_literal_scalar_in_card_context(
    db_session, test_workspace, test_board, test_card, test_user, title
):
    tokens = await _save_and_assemble(
        db_session,
        test_workspace,
        test_board,
        test_card,
        test_user,
        title=title,
        code="selected evidence",
    )
    assert not any(token.type in {"heading_open", "html_block"} for token in tokens)
    assert sum(token.type == "list_item_open" for token in tokens) == 1
    title_runs = next(token.children for token in tokens if token.type == "inline")
    assert title_runs is not None
    # The wrapper may use emphasis or inline code, but metadata must never
    # become a link/image/HTML token or a separate block in mandatory context.
    assert not any(
        token.type in {"link_open", "image", "html_inline", "softbreak", "hardbreak"}
        for token in title_runs
    )
    literal_title = "".join(
        token.content for token in title_runs if token.type in {"text", "code_inline"}
    )
    assert literal_title == " ".join(title.split()) + ":"
    assert [token.content for token in tokens if token.type == "fence"] == [
        "selected evidence\n"
    ]
