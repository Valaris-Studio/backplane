# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
from pathlib import Path

from markdown_it import MarkdownIt

from app.schemas.notes.note import NoteCreate
from app.services.agents.context_assembly import assemble_context
from app.services.notes.note import NoteService


async def test_saved_captured_code_stays_literal_in_card_notes_context(
    db_session, test_workspace, test_board, test_card, test_user
):
    corpus = json.loads(
        (Path(__file__).parent / "fixtures" / "pm_markdown_corpus.json").read_text()
    )
    captured = next(
        entry
        for entry in corpus
        if entry["name"] == "code-block-captured-hostile-fences"
    )
    reviewed_document = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": "Curated captured evidence; not a complete transcript.",
                    }
                ],
            },
            *captured["doc"]["content"],
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": "End of selected evidence."}],
            },
        ],
    }
    notes = NoteService(db_session)
    saved = await notes.create_note(
        test_workspace.id,
        NoteCreate(
            title="Reviewed handoff", content=reviewed_document, card_id=test_card.id
        ),
        test_user.id,
        test_board.id,
    )
    reread = await notes.get_note(saved.id, test_workspace.id)
    assert json.loads(reread.content) == reviewed_document

    packet = await assemble_context(
        db_session,
        workspace_id=test_workspace.id,
        card=test_card,
        board=test_board,
        sources=[{"kind": "card_notes", "filter": {"kind": "user_note"}}],
    )
    tokens = MarkdownIt("commonmark").parse(packet["card_notes"])
    fences = [token for token in tokens if token.type == "fence"]
    assert len(fences) == 1
    assert fences[0].content == captured["literal_code"]["text"]
    assert all(token.type not in ("heading_open", "html_block") for token in tokens)
    assert "End of selected evidence." in packet["card_notes"]
