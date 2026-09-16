# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Serialize canonical ProseMirror JSON back into CommonMark markdown.

This is the REVERSE of `content_normalizer.normalize_note_content`: the
normalizer turns markdown/HTML/plain-text into a canonical ProseMirror doc for
storage; this module turns that stored doc back into markdown for the
`?format=markdown` note read and any markdown export path.

The frontend twin exports the same doc through `@tiptap/markdown`
(`frontend/src/lib/markdown-extensions.ts`); the shared corpus
`tests/services/notes/fixtures/pm_markdown_corpus.json` is the contract both
must match byte for byte. Body-only — the stored `content` carries no title, so
no leading `# {title}` is emitted here.

The node/mark vocabulary is a CLOSED set that mirrors the editor's supported
set exactly (StarterKit + Link + our mention/image/file-attachment nodes):
  Nodes: doc, paragraph, heading(1-3), bulletList, orderedList(attrs.start),
         listItem, codeBlock(attrs.language), blockquote, horizontalRule,
         hardBreak, text, table, tableRow, tableHeader, tableCell,
         mention(@label), image(![alt](src) — block in our schema, also
         serializable inline), fileAttachment([filename](src)).
  Marks: bold(**), italic(*), strike(~~), code(`), link([text](href)).

Anything that isn't a valid PM doc (legacy HTML or plain text stored before the
normalizer landed) degrades to stripped plain text — raw HTML is NEVER emitted.
"""
from __future__ import annotations

import json
import re
from typing import Any


def prosemirror_to_markdown(content: str | dict) -> str:
    """Return markdown for a stored note `content` value.

    Accepts the stored JSON string OR an already-parsed PM doc dict. Non-PM
    inputs (legacy HTML, plain text, malformed JSON) degrade to stripped text.
    """
    doc: dict[str, Any] | None = None
    if isinstance(content, dict):
        if content.get("type") == "doc":
            doc = content
    elif isinstance(content, str):
        try:
            parsed = json.loads(content)
        except (json.JSONDecodeError, ValueError):
            parsed = None
        if isinstance(parsed, dict) and parsed.get("type") == "doc":
            doc = parsed

    if doc is None:
        # Legacy HTML or plain text — never emit raw HTML into markdown.
        return _strip_html_tags(content if isinstance(content, str) else "")

    return _doc_to_markdown(doc)


def project_pm_to_text(text: str) -> str:
    """Text projection for line/regex scanners over card descriptions.

    A canonical PM-JSON string is serialized back to markdown so line-based
    scans (`Branch:` blocks, PR-url regexes) see real lines again instead of
    one giant JSON line. Anything else — legacy raw markdown/plain-text
    descriptions — passes through UNCHANGED: scanners must keep seeing the
    exact legacy string, so no HTML-stripping degradation here (unlike
    `prosemirror_to_markdown`).
    """
    if not text or not text.lstrip().startswith("{"):
        return text
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return text
    if isinstance(parsed, dict) and parsed.get("type") == "doc":
        return _doc_to_markdown(parsed)
    return text


def _doc_to_markdown(doc: dict[str, Any]) -> str:
    blocks = [_serialize_block(node) for node in doc.get("content", [])]
    return "\n\n".join(b for b in blocks if b)


# --- Block-level ------------------------------------------------------------


def _serialize_block(node: dict[str, Any]) -> str:
    node_type = node.get("type")

    if node_type == "paragraph":
        return _serialize_inline(node.get("content"))

    if node_type == "heading":
        level = max(1, min(6, int((node.get("attrs") or {}).get("level", 1))))
        return f"{'#' * level} {_serialize_inline(node.get('content'))}"

    if node_type == "bulletList":
        return "\n".join(
            _serialize_list_item(li, "- ") for li in node.get("content", [])
        )

    if node_type == "orderedList":
        start = int((node.get("attrs") or {}).get("start", 1))
        return "\n".join(
            _serialize_list_item(li, f"{start + i}. ")
            for i, li in enumerate(node.get("content", []))
        )

    if node_type == "blockquote":
        inner = "\n\n".join(
            _serialize_block(child) for child in node.get("content", [])
        )
        # Prefix every line (including blank continuation lines) with '> '.
        return "\n".join(
            f"> {line}".rstrip() for line in inner.split("\n")
        )

    if node_type == "codeBlock":
        lang = (node.get("attrs") or {}).get("language") or ""
        code = "".join(c.get("text", "") for c in node.get("content", []))
        # markdown-it's fence content carries a single trailing newline; strip
        # ONE so we don't emit a blank line before the closing fence (which
        # would re-normalize to code text with a doubled trailing '\n').
        if code.endswith("\n"):
            code = code[:-1]
        return f"```{lang}\n{code}\n```"

    if node_type == "horizontalRule":
        return "---"

    if node_type == "table":
        return _serialize_table(node)

    if node_type == "fileAttachment":
        attrs = node.get("attrs") or {}
        name = attrs.get("filename") or "attachment"
        src = attrs.get("src") or ""
        return f"[{name}]({src})" if src else name

    if node_type == "image":
        return _serialize_inline_node(node)

    # Unknown block (or a bare inline run) — best-effort inline serialization.
    return _serialize_inline(node.get("content")) or node.get("text", "")


_NESTED_LIST_TYPES = ("bulletList", "orderedList")


def _join_list_item_blocks(children: list[dict[str, Any]]) -> str:
    """Join a list item's blocks, tightening a nested list against its lead-in.

    A nested list directly following a paragraph is one logical item, so the
    blank line between them is dropped (`- parent\\n  - child`). Sibling
    paragraphs still take `\\n\\n` — they are separate blocks and a markdown
    parser needs the break to keep them apart.
    """
    out = ""
    for index, child in enumerate(children):
        block = _serialize_block(child)
        if index == 0:
            out = block
            continue
        tight = (
            child.get("type") in _NESTED_LIST_TYPES
            and children[index - 1].get("type") == "paragraph"
        )
        out += ("\n" if tight else "\n\n") + block
    return out


def _serialize_list_item(item: dict[str, Any], marker: str) -> str:
    inner = _join_list_item_blocks(item.get("content", [])).strip()
    indent = " " * len(marker)
    lines = inner.split("\n")
    # First line gets the marker; continuation lines align under the text.
    return "\n".join(
        f"{marker}{line}" if i == 0 else f"{indent}{line}"
        for i, line in enumerate(lines)
    )


def _serialize_table(node: dict[str, Any]) -> str:
    rows = node.get("content", [])
    if not rows:
        return ""
    # GFM requires a header: row one is always the header regardless of cell
    # types, and the separator is sized to its cell count.
    lines = [_serialize_table_row(rows[0])]
    separator_cells = ["---"] * len(rows[0].get("content", []))
    lines.append(f"| {' | '.join(separator_cells)} |")
    lines.extend(_serialize_table_row(row) for row in rows[1:])
    return "\n".join(lines)


def _serialize_table_row(row: dict[str, Any]) -> str:
    cells = [_serialize_table_cell(cell) for cell in row.get("content", [])]
    return f"| {' | '.join(cells)} |"


def _serialize_table_cell(cell: dict[str, Any]) -> str:
    # GFM cells are single-line: multi-block content joins with a space, and a
    # literal '|' must be escaped or it would split the cell.
    text = " ".join(
        block
        for block in (_serialize_block(child) for child in cell.get("content", []))
        if block
    )
    return text.replace("|", "\\|")


# --- Inline-level -----------------------------------------------------------


def _serialize_inline(nodes: list[dict[str, Any]] | None) -> str:
    """Serialize an inline run, coalescing marks that span sibling nodes.

    Emitting each node independently closes and immediately reopens any mark
    the neighbours share: `**text **` + ``**`code`**`` + `** text**`. Those
    adjacent `****` pairs re-parse as literal asterisks, so a bold run broken
    by a code node does not survive a round trip. Instead we track the open
    mark stack across the run and only emit a delimiter where the mark set
    actually changes.
    """
    if not nodes:
        return ""

    out: list[str] = []
    open_marks: list[dict[str, Any]] = []

    for node in nodes:
        # Atoms and hard breaks carry no marks and terminate every open run.
        if node.get("type") in ("hardBreak", "mention", "image"):
            out.extend(_close_marks(open_marks, len(open_marks)))
            open_marks = []
            out.append(_serialize_inline_node(node))
            continue

        marks = _sorted_marks(node.get("marks", []))
        shared = _shared_prefix_length(open_marks, marks)
        out.extend(_close_marks(open_marks, len(open_marks) - shared))
        del open_marks[shared:]
        for mark in marks[shared:]:
            out.append(_mark_opening(mark))
            open_marks.append(mark)
        out.append(node.get("text", ""))

    out.extend(_close_marks(open_marks, len(open_marks)))
    return "".join(out)


def _sorted_marks(marks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(marks, key=lambda m: _MARK_APPLY_ORDER.get(m.get("type"), 99))


def _shared_prefix_length(
    open_marks: list[dict[str, Any]], marks: list[dict[str, Any]]
) -> int:
    """How many outer marks the previous node and this one have in common.

    Only a PREFIX can stay open: markdown delimiters nest, so keeping an outer
    mark open while a different inner one changes is exactly what nesting
    allows, but reordering is not expressible.
    """
    shared = 0
    for previous, current in zip(open_marks, marks):
        if previous != current:
            break
        shared += 1
    return shared


def _close_marks(open_marks: list[dict[str, Any]], count: int) -> list[str]:
    # Innermost first — the stack unwinds in reverse.
    return [_mark_closing(mark) for mark in reversed(open_marks[len(open_marks) - count :])]


_MARK_DELIMITERS = {"bold": "**", "italic": "*", "strike": "~~", "code": "`"}


def _mark_opening(mark: dict[str, Any]) -> str:
    if mark.get("type") == "link":
        return "["
    return _MARK_DELIMITERS.get(mark.get("type"), "")


def _mark_closing(mark: dict[str, Any]) -> str:
    if mark.get("type") == "link":
        href = (mark.get("attrs") or {}).get("href", "")
        return f"]({href})"
    return _MARK_DELIMITERS.get(mark.get("type"), "")


# Marks are opened OUTERMOST-first, so `code` sorts LAST — its backticks sit
# INSIDE emphasis (`v` + [bold, code] → ``**`v`**``). The reverse does not round
# trip: `` `**v**` `` re-parses as a code span whose content is the literal six
# characters `**v**`, losing the bold mark entirely. Sorting also makes the
# emission independent of the order the marks happen to appear in the PM node,
# and gives adjacent nodes a comparable prefix so shared marks can stay open
# across a run (see `_shared_prefix_length`).
_MARK_APPLY_ORDER = {"link": 0, "bold": 1, "italic": 2, "strike": 3, "code": 4}


def _serialize_inline_node(node: dict[str, Any]) -> str:
    node_type = node.get("type")
    if node_type == "hardBreak":
        return "  \n"
    # Inline atoms with no text child — carry their display label.
    if node_type == "mention":
        return f"@{(node.get('attrs') or {}).get('label') or ''}"
    if node_type == "image":
        attrs = node.get("attrs") or {}
        return f"![{attrs.get('alt') or ''}]({attrs.get('src') or ''})"

    value = node.get("text", "")
    marks = sorted(
        node.get("marks", []),
        key=lambda m: _MARK_APPLY_ORDER.get(m.get("type"), 99),
    )
    for mark in marks:
        value = _apply_mark(value, mark)
    return value


def _apply_mark(value: str, mark: dict[str, Any]) -> str:
    mark_type = mark.get("type")
    if mark_type == "bold":
        return f"**{value}**"
    if mark_type == "italic":
        return f"*{value}*"
    if mark_type == "strike":
        return f"~~{value}~~"
    if mark_type == "code":
        return f"`{value}`"
    if mark_type == "link":
        href = (mark.get("attrs") or {}).get("href", "")
        return f"[{value}]({href})"
    return value


# --- Degradation ------------------------------------------------------------

_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
_BLOCK_CLOSE_RE = re.compile(r"</(p|div|li|h[1-6])>", re.IGNORECASE)
_ANY_TAG_RE = re.compile(r"<[^>]*>")
_MULTI_BLANK_RE = re.compile(r"\n{3,}")


def _strip_html_tags(html: str) -> str:
    if not html:
        return ""
    out = _BR_RE.sub("\n", html)
    out = _BLOCK_CLOSE_RE.sub("\n", out)
    out = _ANY_TAG_RE.sub("", out)
    out = _MULTI_BLANK_RE.sub("\n\n", out)
    return out.strip()
