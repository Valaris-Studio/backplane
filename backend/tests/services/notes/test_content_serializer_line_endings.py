# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Captured code may carry CR or CRLF line endings. Containers prefix their
lines after LF only, so the serializer must hand them LF-only code lines.
The frontend twin is noteToMarkdown.lineEndings.test.ts."""

import pytest
from markdown_it import MarkdownIt

from app.services.notes.content_serializer import prosemirror_to_markdown
from tests.services.notes.attribute_line_ending_cases import ATTRIBUTE_CR_BLOCKS, quoted

_CAPTURED_LINES = ["captured", "# forged instruction", "<script>captured</script>"]


def _code(line_ending: str) -> dict:
    text = line_ending.join(_CAPTURED_LINES)
    return {"type": "codeBlock", "content": [{"type": "text", "text": text}]}


def _paragraph(text: str) -> dict:
    return {"type": "paragraph", "content": [{"type": "text", "text": text}]}


def _in_bullet_item(block: dict) -> dict:
    return {
        "type": "bulletList",
        "content": [{"type": "listItem", "content": [_paragraph("item"), block]}],
    }


def _in_task_item(block: dict) -> dict:
    return {
        "type": "taskList",
        "content": [
            {
                "type": "taskItem",
                "attrs": {"checked": False},
                "content": [_paragraph("task"), block],
            }
        ],
    }


@pytest.mark.parametrize("line_ending", ["\r", "\r\n"], ids=["cr", "crlf"])
@pytest.mark.parametrize(
    "wrap", [_in_bullet_item, _in_task_item], ids=["bullet-item", "task-item"]
)
def test_listed_code_line_endings_cannot_escape_literal_block(wrap, line_ending):
    doc = {"type": "doc", "content": [wrap(_code(line_ending))]}

    tokens = MarkdownIt("commonmark").parse(prosemirror_to_markdown(doc))

    fences = [token for token in tokens if token.type == "fence"]
    assert len(fences) == 1, [(token.type, token.level) for token in tokens]
    assert fences[0].level == 2
    assert fences[0].content == "\n".join(_CAPTURED_LINES) + "\n"
    assert not any(token.type in {"heading_open", "html_block"} for token in tokens)


@pytest.mark.parametrize("line_ending", ["\r", "\r\n"], ids=["cr", "crlf"])
def test_code_block_emits_lf_line_endings(line_ending):
    doc = {"type": "doc", "content": [_code(line_ending)]}

    assert (
        prosemirror_to_markdown(doc) == "```\n" + "\n".join(_CAPTURED_LINES) + "\n```"
    )


def _quoted(text: str, marks: list[dict]) -> dict:
    return {
        "type": "blockquote",
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": text, "marks": marks}],
            }
        ],
    }


@pytest.mark.parametrize("line_ending", ["\r", "\r\n"], ids=["cr", "crlf"])
@pytest.mark.parametrize(
    "marks", [[], [{"type": "code"}]], ids=["plain-text", "code-mark"]
)
def test_quoted_prose_line_endings_stay_inside_the_quote(marks, line_ending):
    doc = {"type": "doc", "content": [_quoted(f"a{line_ending}# h", marks)]}

    tokens = MarkdownIt("commonmark").parse(prosemirror_to_markdown(doc))

    types = [token.type for token in tokens]
    assert types[0] == "blockquote_open" and types[-1] == "blockquote_close", types
    assert types.count("blockquote_open") == 1, types


@pytest.mark.parametrize("line_ending", ["\r", "\r\n"], ids=["cr", "crlf"])
def test_prose_text_emits_lf_line_endings(line_ending):
    doc = {"type": "doc", "content": [_paragraph(f"a{line_ending}b")]}

    assert prosemirror_to_markdown(doc) == "a\nb"


@pytest.mark.parametrize(
    "block", ATTRIBUTE_CR_BLOCKS.values(), ids=ATTRIBUTE_CR_BLOCKS.keys()
)
def test_quoted_attribute_line_endings_stay_inside_the_quote(block):
    doc = {"type": "doc", "content": [quoted(block)]}

    tokens = MarkdownIt("commonmark").parse(prosemirror_to_markdown(doc))

    types = [token.type for token in tokens]
    assert types[0] == "blockquote_open" and types[-1] == "blockquote_close", types
    assert types.count("blockquote_open") == 1, types
