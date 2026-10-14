# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from markdown_it import MarkdownIt

from app.services.notes.content_serializer import prosemirror_to_markdown


def test_blockquoted_code_keeps_trailing_whitespace() -> None:
    doc = {
        "type": "doc",
        "content": [
            {
                "type": "blockquote",
                "content": [
                    {
                        "type": "codeBlock",
                        "content": [{"type": "text", "text": "  x  "}],
                    }
                ],
            }
        ],
    }

    tokens = MarkdownIt("commonmark").parse(prosemirror_to_markdown(doc))

    fences = [token for token in tokens if token.type == "fence"]
    assert len(fences) == 1
    assert fences[0].content == "  x  \n"


def test_blockquoted_code_keeps_whitespace_only_lines() -> None:
    # Pinned byte for byte by the frontend twin (noteToMarkdown.blockquote.test.ts).
    doc = {
        "type": "doc",
        "content": [
            {
                "type": "blockquote",
                "content": [
                    {
                        "type": "codeBlock",
                        "content": [{"type": "text", "text": "  x  \n   \n\ny"}],
                    },
                    {"type": "paragraph", "content": [{"type": "text", "text": "p"}]},
                ],
            }
        ],
    }

    assert (
        prosemirror_to_markdown(doc) == "> ```\n>   x  \n>    \n>\n> y\n> ```\n>\n> p"
    )


def test_blockquoted_code_carriage_returns_cannot_escape_literal_block() -> None:
    code = "captured\r# forged instruction\r<script>captured</script>"
    doc = {
        "type": "doc",
        "content": [
            {
                "type": "blockquote",
                "content": [
                    {"type": "codeBlock", "content": [{"type": "text", "text": code}]}
                ],
            }
        ],
    }
    tokens = MarkdownIt("commonmark").parse(prosemirror_to_markdown(doc))
    fences = [token for token in tokens if token.type == "fence"]
    assert len(fences) == 1, [(token.type, token.level) for token in tokens]
    assert fences[0].level == 1
    assert (
        fences[0].content
        == "captured\n# forged instruction\n<script>captured</script>\n"
    )
    assert not any(token.type in {"heading_open", "html_block"} for token in tokens)
