# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Normalize note content into canonical ProseMirror JSON.

The frontend's TipTap renderer expects ProseMirror JSON. Historically the
backend stored whatever string the API received — so markdown sent by MCP
agents (the common case) rendered as a flat blob with literal `# ` chars.

This module is the single source of truth for the wire-format contract:
every value the API accepts as `content` is converted here, and the result
is stored verbatim. The set of supported nodes/marks matches the StarterKit
+ Link + Table extensions configured in `RichTextRenderer.tsx` (tables emit
the canonical TipTap shape: table → tableRow → tableHeader/tableCell).
"""
from __future__ import annotations

import html as html_module
import json
import re
from typing import Any

from markdown_it import MarkdownIt
from markdown_it.token import Token


class InvalidContentError(ValueError):
    """Raised when content cannot be coerced into ProseMirror JSON."""


_EMPTY_DOC: dict[str, Any] = {"type": "doc", "content": []}

# Block-tag → ProseMirror node mapping for raw HTML inputs. We only support
# what TipTap's StarterKit renders; everything else falls through to a
# paragraph wrapping the inner text.
_HTML_BLOCK_RE = re.compile(
    r"<(h[1-3]|p|ul|ol|li|pre|code|blockquote)[^>]*>(.*?)</\1>",
    re.IGNORECASE | re.DOTALL,
)


def _is_html_document(content: str) -> bool:
    """The single dispatch predicate: HTML path only for real HTML documents.

    A body qualifies only when it carries a supported BLOCK element — the same
    elements `_html_to_doc` can actually turn into nodes. Matching any
    tag-shaped substring instead (the old rule) sent whole markdown documents
    down the HTML path, where the absence of block structure collapsed them to
    one paragraph of literal source and silently dropped the fragment that
    triggered it: `runner-<name>.yaml`, a generic `<T>`, a shell redirect.
    """
    return _HTML_BLOCK_RE.search(content) is not None


def normalize_note_content(content: Any) -> str:
    """Return canonical ProseMirror JSON string for any accepted input.

    Accepts:
        - None or "" → empty doc
        - dict with type=="doc" → re-serialized
        - JSON string of a PM doc → re-serialized
        - HTML string (carries a supported block element) → parsed into PM nodes
        - Markdown string → parsed via markdown-it → PM nodes
        - Plain text → single paragraph

    Raises:
        InvalidContentError: input is neither a string nor a doc-shaped dict,
            or is a dict that isn't a ProseMirror doc.
    """
    if content is None or content == "":
        return json.dumps(_EMPTY_DOC)

    if isinstance(content, dict):
        if content.get("type") != "doc":
            raise InvalidContentError(
                "dict content must be a ProseMirror doc (type=='doc')"
            )
        return json.dumps(content)

    if not isinstance(content, str):
        raise InvalidContentError(
            f"content must be str or dict, got {type(content).__name__}"
        )

    stripped = content.lstrip()
    if stripped.startswith("{"):
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict) and parsed.get("type") == "doc":
            return json.dumps(parsed)

    if _is_html_document(content):
        return json.dumps(_html_to_doc(content))

    return json.dumps(_markdown_to_doc(content))


# --- Markdown → ProseMirror -------------------------------------------------

# The commonmark preset does not tokenize tables — enable GFM tables explicitly.
_md = MarkdownIt("commonmark", {"html": False, "linkify": False}).enable("table")


def _markdown_to_doc(text: str) -> dict[str, Any]:
    tokens = _md.parse(text)
    children = _consume_blocks(tokens, 0, len(tokens))[0]
    if not children:
        # Pure whitespace/empty — preserve as a single paragraph so the
        # plain-text contract is honored.
        children = [{"type": "paragraph", "content": _text_runs(text)}]
    return {"type": "doc", "content": children}


def _consume_blocks(
    tokens: list[Token], start: int, end: int
) -> tuple[list[dict[str, Any]], int]:
    nodes: list[dict[str, Any]] = []
    i = start
    while i < end:
        tok = tokens[i]
        t = tok.type

        if t == "heading_open":
            level = int(tok.tag[1])  # h1 → 1
            inline = tokens[i + 1]
            nodes.append({
                "type": "heading",
                "attrs": {"level": min(level, 3)},
                "content": _inline_to_runs(inline),
            })
            i += 3  # heading_open + inline + heading_close

        elif t == "paragraph_open":
            inline = tokens[i + 1]
            runs = _inline_to_runs(inline)
            if runs:
                nodes.append({"type": "paragraph", "content": runs})
            else:
                nodes.append({"type": "paragraph"})
            i += 3

        elif t == "bullet_list_open":
            close_idx = _find_close(tokens, i, "bullet_list_close")
            items = _consume_list_items(tokens, i + 1, close_idx)
            nodes.append({"type": "bulletList", "content": items})
            i = close_idx + 1

        elif t == "ordered_list_open":
            close_idx = _find_close(tokens, i, "ordered_list_close")
            items = _consume_list_items(tokens, i + 1, close_idx)
            ordered: dict[str, Any] = {"type": "orderedList", "content": items}
            start_attr = tok.attrGet("start")
            if start_attr is not None:
                ordered["attrs"] = {"start": int(start_attr)}
            nodes.append(ordered)
            i = close_idx + 1

        elif t == "fence" or t == "code_block":
            code_block: dict[str, Any] = {
                "type": "codeBlock",
                "content": [{"type": "text", "text": tok.content}],
            }
            if tok.info:
                code_block["attrs"] = {"language": tok.info.strip().split()[0]}
            nodes.append(code_block)
            i += 1

        elif t == "blockquote_open":
            close_idx = _find_close(tokens, i, "blockquote_close")
            inner = _consume_blocks(tokens, i + 1, close_idx)[0]
            nodes.append({"type": "blockquote", "content": inner})
            i = close_idx + 1

        elif t == "table_open":
            close_idx = _find_close(tokens, i, "table_close")
            nodes.append(_consume_table(tokens, i + 1, close_idx))
            i = close_idx + 1

        elif t == "hr":
            nodes.append({"type": "horizontalRule"})
            i += 1

        else:
            # Unknown block — skip its open/close pair if present, else advance.
            i += 1

    return nodes, i


def _consume_table(
    tokens: list[Token], start: int, end: int
) -> dict[str, Any]:
    """Flatten markdown-it's thead/tbody wrappers into the TipTap table shape.

    ProseMirror tables have no thead/tbody level — rows are direct children of
    the table; header-ness lives on the cell type (tableHeader vs tableCell).
    Column alignment styles on th/td are intentionally dropped: the canonical
    tiptap shape carries no alignment attr.
    """
    rows: list[dict[str, Any]] = []
    in_header = False
    i = start
    while i < end:
        t = tokens[i].type
        if t == "thead_open":
            in_header = True
        elif t == "thead_close":
            in_header = False
        elif t == "tr_open":
            row_close = _find_close(tokens, i, "tr_close")
            cell_kind = "tableHeader" if in_header else "tableCell"
            cells = []
            j = i + 1
            while j < row_close:
                if tokens[j].type in ("th_open", "td_open"):
                    runs = _inline_to_runs(tokens[j + 1])
                    paragraph: dict[str, Any] = {"type": "paragraph"}
                    if runs:
                        paragraph["content"] = runs
                    cells.append({
                        "type": cell_kind,
                        "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None},
                        "content": [paragraph],
                    })
                    j += 3  # th/td_open + inline + th/td_close
                else:
                    j += 1
            rows.append({"type": "tableRow", "content": cells})
            i = row_close + 1
            continue
        i += 1
    return {"type": "table", "content": rows}


def _consume_list_items(
    tokens: list[Token], start: int, end: int
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    i = start
    while i < end:
        if tokens[i].type != "list_item_open":
            i += 1
            continue
        close_idx = _find_close(tokens, i, "list_item_close")
        inner = _consume_blocks(tokens, i + 1, close_idx)[0]
        items.append({"type": "listItem", "content": inner or [{"type": "paragraph"}]})
        i = close_idx + 1
    return items


def _find_close(tokens: list[Token], open_idx: int, close_type: str) -> int:
    depth = 0
    open_type = tokens[open_idx].type
    for j in range(open_idx, len(tokens)):
        if tokens[j].type == open_type:
            depth += 1
        elif tokens[j].type == close_type:
            depth -= 1
            if depth == 0:
                return j
    return len(tokens) - 1


def _inline_to_runs(inline: Token) -> list[dict[str, Any]]:
    if inline.type != "inline" or not inline.children:
        return []

    runs: list[dict[str, Any]] = []
    marks: list[dict[str, Any]] = []
    for child in inline.children:
        ct = child.type
        if ct == "text":
            if child.content:
                runs.append(_text_run(child.content, marks))
        elif ct == "softbreak":
            runs.append(_text_run("\n", marks))
        elif ct == "hardbreak":
            runs.append({"type": "hardBreak"})
        elif ct == "code_inline":
            runs.append(_text_run(child.content, marks + [{"type": "code"}]))
        elif ct == "strong_open":
            marks.append({"type": "bold"})
        elif ct == "strong_close":
            _pop_mark(marks, "bold")
        elif ct == "em_open":
            marks.append({"type": "italic"})
        elif ct == "em_close":
            _pop_mark(marks, "italic")
        elif ct == "s_open":
            marks.append({"type": "strike"})
        elif ct == "s_close":
            _pop_mark(marks, "strike")
        elif ct == "link_open":
            href = child.attrGet("href") or ""
            marks.append({"type": "link", "attrs": {"href": href}})
        elif ct == "link_close":
            _pop_mark(marks, "link")
        # image, html_inline, etc. are intentionally dropped — out of scope
        # for the StarterKit set.

    return runs


def _text_run(text: str, marks: list[dict[str, Any]]) -> dict[str, Any]:
    node: dict[str, Any] = {"type": "text", "text": text}
    if marks:
        # Copy so later mutations to the active stack don't leak in.
        node["marks"] = [dict(m) for m in marks]
    return node


def _pop_mark(marks: list[dict[str, Any]], mark_type: str) -> None:
    for k in range(len(marks) - 1, -1, -1):
        if marks[k]["type"] == mark_type:
            marks.pop(k)
            return


def _text_runs(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": text}] if text else []


# --- HTML → ProseMirror -----------------------------------------------------
#
# We don't need a full HTML parser; the only writers of HTML strings into
# notes today are (a) the legacy frontend (which sends PM JSON anyway) and
# (b) any external client that decides to send HTML. A regex-based extractor
# covers the StarterKit-supported tags and treats anything else as text.


def _html_to_doc(html: str) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = []
    pos = 0
    for match in _HTML_BLOCK_RE.finditer(html):
        if match.start() > pos:
            leading = _inline_html_runs(html[pos : match.start()])
            if leading:
                nodes.append({"type": "paragraph", "content": leading})
        tag = match.group(1).lower()
        inner = match.group(2)
        nodes.append(_html_block_node(tag, inner))
        pos = match.end()

    trailing = _inline_html_runs(html[pos:])
    if trailing:
        nodes.append({"type": "paragraph", "content": trailing})

    if not nodes:
        nodes.append({"type": "paragraph"})
    return {"type": "doc", "content": nodes}


def _html_block_node(tag: str, inner: str) -> dict[str, Any]:
    if tag in {"h1", "h2", "h3"}:
        return {
            "type": "heading",
            "attrs": {"level": int(tag[1])},
            "content": _inline_html_runs(inner),
        }
    if tag == "p":
        runs = _inline_html_runs(inner)
        if not runs:
            return {"type": "paragraph"}
        return {"type": "paragraph", "content": runs}
    if tag in {"ul", "ol"}:
        items = []
        for li in re.finditer(r"<li[^>]*>(.*?)</li>", inner, re.IGNORECASE | re.DOTALL):
            runs = _inline_html_runs(li.group(1))
            items.append({
                "type": "listItem",
                "content": [
                    {"type": "paragraph", "content": runs}
                    if runs
                    else {"type": "paragraph"}
                ],
            })
        return {
            "type": "bulletList" if tag == "ul" else "orderedList",
            "content": items or [{"type": "listItem", "content": [{"type": "paragraph"}]}],
        }
    if tag == "pre" or tag == "code":
        # PM codeBlock content is plain text — marks are not allowed inside it.
        return {
            "type": "codeBlock",
            "content": [{"type": "text", "text": _strip_tags(inner)}],
        }
    if tag == "blockquote":
        runs = _inline_html_runs(inner)
        return {
            "type": "blockquote",
            "content": [
                {"type": "paragraph", "content": runs}
                if runs
                else {"type": "paragraph"}
            ],
        }
    runs = _inline_html_runs(inner)
    return {"type": "paragraph", "content": runs} if runs else {"type": "paragraph"}


# Inline tags carrying a StarterKit/Link mark. Everything else is unwrapped:
# its tag disappears but the text it contains is kept.
_INLINE_MARK_TAGS: dict[str, str] = {
    "a": "link",
    "strong": "bold",
    "b": "bold",
    "em": "italic",
    "i": "italic",
    "s": "strike",
    "del": "strike",
    "strike": "strike",
    "code": "code",
}

_INLINE_TAG_RE = re.compile(r"<(/?)([a-z][a-z0-9]*)((?:\s[^>]*)?)/?>", re.IGNORECASE)
_HREF_RE = re.compile(r"""href\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))""", re.IGNORECASE)


def _inline_html_runs(fragment: str) -> list[dict[str, Any]]:
    """Extract PM text runs from an HTML fragment, preserving inline marks.

    Text is unescaped exactly once here, at run construction — no other branch
    of the HTML path may unescape, or `&amp;amp;` would collapse twice.
    """
    runs: list[dict[str, Any]] = []
    marks: list[dict[str, Any]] = []
    pos = 0

    def emit(raw_text: str) -> None:
        if raw_text:
            runs.append(_text_run(_unescape(raw_text), marks))

    for tag_match in _INLINE_TAG_RE.finditer(fragment):
        emit(fragment[pos : tag_match.start()])
        pos = tag_match.end()

        is_close = tag_match.group(1) == "/"
        tag = tag_match.group(2).lower()
        mark_type = _INLINE_MARK_TAGS.get(tag)
        if mark_type is None:
            continue

        if is_close:
            _pop_mark(marks, mark_type)
        elif mark_type == "link":
            marks.append({
                "type": "link",
                "attrs": {"href": _href_from_attrs(tag_match.group(3))},
            })
        else:
            marks.append({"type": mark_type})

    emit(fragment[pos:])
    return _trim_edge_whitespace(runs)


def _href_from_attrs(attrs: str) -> str:
    match = _HREF_RE.search(attrs or "")
    if not match:
        return ""
    raw = match.group(2) or match.group(3) or match.group(4) or ""
    return _unescape(raw)


def _unescape(text: str) -> str:
    return html_module.unescape(text)


def _trim_edge_whitespace(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Strip leading/trailing whitespace across the run sequence.

    Block-level HTML is routinely indented; the old text-only extractor called
    `.strip()` on the flattened string, and dropping that would leave stray
    newlines inside every heading and list item.
    """
    trimmed = [dict(run) for run in runs]
    while trimmed and not trimmed[0]["text"].strip():
        trimmed.pop(0)
    if trimmed:
        trimmed[0]["text"] = trimmed[0]["text"].lstrip()
    while trimmed and not trimmed[-1]["text"].strip():
        trimmed.pop()
    if trimmed:
        trimmed[-1]["text"] = trimmed[-1]["text"].rstrip()
    return trimmed


def _strip_tags(html: str) -> str:
    return _unescape(re.sub(r"<[^>]+>", "", html))
