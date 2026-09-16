# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Markdown → normalize → serialize must be a fixed point for combined marks.

The normalizer and the serializer are inverses over the closed node/mark
vocabulary, so any markdown the normalizer accepts must serialize back to
itself. Text carrying BOTH `code` and an emphasis mark is where that broke:
emitting `` `**v**` `` (code outermost) re-parses as a code span whose literal
content is the six characters `**v**`, silently destroying the bold mark. The
fixed point only exists with `code` INNERMOST — `` **`v`** `` — which is also
what `@tiptap/markdown` emits, so both engines agree.
"""
from __future__ import annotations

import pytest

from app.services.notes.content_normalizer import normalize_note_content
from app.services.notes.content_serializer import prosemirror_to_markdown


@pytest.mark.parametrize(
    "markdown",
    [
        pytest.param("**`v`**", id="bold-wrapping-a-code-span"),
        pytest.param("*`v`*", id="italic-wrapping-a-code-span"),
        pytest.param("~~`v`~~", id="strike-wrapping-a-code-span"),
        pytest.param("**text `code` text**", id="bold-run-spanning-a-code-node"),
        pytest.param("`plain code`", id="code-alone-is-unaffected"),
        pytest.param("**bold**", id="bold-alone-is-unaffected"),
    ],
)
def test_markdown_survives_a_normalize_serialize_round_trip(markdown: str) -> None:
    assert prosemirror_to_markdown(normalize_note_content(markdown)) == markdown


def test_code_mark_is_applied_inside_emphasis_not_outside() -> None:
    """The mark ORDER in the stored doc must not change the emission.

    A doc can carry the marks in either order; the serializer sorts them, so
    both spellings must produce the same `code`-innermost markdown.
    """
    code_first = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": "v",
                        "marks": [{"type": "code"}, {"type": "bold"}],
                    }
                ],
            }
        ],
    }
    bold_first = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": "v",
                        "marks": [{"type": "bold"}, {"type": "code"}],
                    }
                ],
            }
        ],
    }
    assert prosemirror_to_markdown(code_first) == "**`v`**"
    assert prosemirror_to_markdown(bold_first) == "**`v`**"
