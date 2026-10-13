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
the canonical TipTap shape: table → tableRow → tableHeader/tableCell), the
taskList/taskItem checklist nodes (`- [ ]` / `- [x]`), plus the image and
fileAttachment nodes in the markdown form `media_markdown`
defines — so a note read as markdown can be written back without loss.
"""
from __future__ import annotations

import copy
import html as html_module
import json
import re
from typing import Any

from markdown_it import MarkdownIt
from markdown_it.token import Token

from app.services.notes.media_markdown import (
    attachment_node,
    image_node,
    parse_attachment_title,
    strip_unsafe_media,
)


class InvalidContentError(ValueError):
    """Raised when content cannot be coerced into ProseMirror JSON."""


_EMPTY_DOC: dict[str, Any] = {"type": "doc", "content": []}

# Block-tag → ProseMirror node mapping for raw HTML inputs. We only support
# what TipTap's StarterKit renders; everything else falls through to a
# paragraph wrapping the inner text.
_HTML_BLOCK_RE = re.compile(
    r"<(h[1-3]|p|ul|ol|li|pre|code|blockquote)([^>]*)>(.*?)</\1>",
    re.IGNORECASE | re.DOTALL,
)
_HTML_IMG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)


def _is_html_document(content: str) -> bool:
    """The single dispatch predicate: HTML path only for real HTML documents.

    A body qualifies only when it carries a supported BLOCK element — the same
    elements `_html_to_doc` can actually turn into nodes. Matching any
    tag-shaped substring instead (the old rule) sent whole markdown documents
    down the HTML path, where the absence of block structure collapsed them to
    one paragraph of literal source and silently dropped the fragment that
    triggered it: `runner-<name>.yaml`, a generic `<T>`, a shell redirect.
    """
    if _HTML_BLOCK_RE.search(content) is not None:
        return True
    # An `<img>` only makes a bare-image HTML body when it LEADS; anywhere else
    # it is a markdown document talking about the tag (same trap as above).
    return _HTML_IMG_RE.match(content.lstrip()) is not None


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
        return json.dumps(_coerce_task_checked(strip_unsafe_media(copy.deepcopy(content))))

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
            return json.dumps(_coerce_task_checked(strip_unsafe_media(parsed)))

    if _is_html_document(content):
        return json.dumps(_html_to_doc(content))

    return json.dumps(_markdown_to_doc(content))


def _coerce_task_checked(node: Any) -> Any:
    """A taskItem is done only when `checked` is literally true. The editor reads
    the attr by truthiness, so a JSON writer's `"false"` would render ticked."""
    if isinstance(node, dict):
        if node.get("type") == "taskItem":
            attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
            node["attrs"] = {**attrs, "checked": attrs.get("checked") is True}
        content = node.get("content")
        if isinstance(content, list):
            for child in content:
                _coerce_task_checked(child)
    return node


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
            runs = _inline_to_runs(tokens[i + 1])
            nodes.append({
                "type": "heading",
                "attrs": {"level": min(level, 3)},
                "content": [run for run in runs if run["type"] != "image"],
            })
            # A heading cannot hold a block image; keep it right after instead.
            nodes.extend(run for run in runs if run["type"] == "image")
            i += 3  # heading_open + inline + heading_close

        elif t == "paragraph_open":
            inline = tokens[i + 1]
            attachment = _attachment_from_inline(inline)
            if attachment is not None:
                nodes.append(attachment)
            else:
                nodes.extend(_split_out_images(_inline_to_runs(inline)))
            i += 3

        elif t == "bullet_list_open":
            close_idx = _find_close(tokens, i, "bullet_list_close")
            nodes.append(_bullet_or_task_list(tokens, i + 1, close_idx))
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
                    cells.append({
                        "type": cell_kind,
                        "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None},
                        "content": _split_out_images(_inline_to_runs(tokens[j + 1])),
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


# GFM's task marker, read from the item's RAW source so an escaped `\[ ]` stays
# literal text: `[ ]`/`[x]`/`[X]`, then whitespace or the end of the item.
_TASK_MARKER_RE = re.compile(r"^\[([ xX])\](?:\s+|$)")


def _bullet_or_task_list(tokens: list[Token], start: int, end: int) -> dict[str, Any]:
    """A bullet list is a checklist only when EVERY item carries a task marker;
    a mixed list stays a bullet list with the brackets as text (the frontend
    parser applies the same rule)."""
    items = _consume_list_items(tokens, start, end)
    checked_states = [_task_checked_state(tokens, i) for i in _list_item_opens(tokens, start, end)]
    if not items or None in checked_states:
        return {"type": "bulletList", "content": items}
    return {
        "type": "taskList",
        "content": [
            {"type": "taskItem", "attrs": {"checked": checked}, "content": _strip_task_marker(item["content"])}
            for item, checked in zip(items, checked_states)
        ],
    }


def _list_item_opens(tokens: list[Token], start: int, end: int) -> list[int]:
    opens: list[int] = []
    i = start
    while i < end:
        if tokens[i].type == "list_item_open":
            opens.append(i)
            i = _find_close(tokens, i, "list_item_close")
        i += 1
    return opens


def _task_checked_state(tokens: list[Token], item_open: int) -> bool | None:
    """True/False for a task item's box, None when the item is not a task."""
    if item_open + 2 >= len(tokens) or tokens[item_open + 1].type != "paragraph_open":
        return None
    inline = tokens[item_open + 2]
    children = inline.children or []
    match = _TASK_MARKER_RE.match(inline.content)
    if match is None or not children or children[0].type != "text":
        return None
    return match.group(1) in "xX"


def _strip_task_marker(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop `[ ] ` from the item's leading paragraph, and the whitespace runs it
    leaves behind; the box now lives in the taskItem's `checked` attr."""
    first, *rest = blocks
    runs = [dict(run) for run in first.get("content", [])]
    if runs and "text" in runs[0]:
        runs[0]["text"] = _TASK_MARKER_RE.sub("", runs[0]["text"], count=1)
    while runs and "text" in runs[0] and not runs[0]["text"].strip():
        runs.pop(0)
    if runs and "text" in runs[0]:
        runs[0]["text"] = runs[0]["text"].lstrip()
    paragraph = {"type": "paragraph", "content": runs} if runs else {"type": "paragraph"}
    return [paragraph, *rest]


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
        elif ct == "image":
            # A block node in our schema: `_split_out_images` lifts it out of
            # the paragraph, so marks (an enclosing link) cannot ride along.
            image = image_node(
                child.attrGet("src") or "",
                _plain_text(child.children),
                child.attrGet("title"),
            )
            if image is not None:
                runs.append(image)
        # html_inline etc. are intentionally dropped — out of scope for the
        # StarterKit set.

    return runs


def _plain_text(tokens: list[Token] | None) -> str:
    """markdown-it's `renderInlineAsText`, e.g. an image's alt from its label."""
    parts: list[str] = []
    for tok in tokens or []:
        if tok.type in ("text", "text_special", "code_inline"):
            parts.append(tok.content)
        elif tok.type in ("softbreak", "hardbreak"):
            parts.append("\n")
        elif tok.type == "image":
            parts.append(_plain_text(tok.children))
    return "".join(parts)


def _attachment_from_inline(inline: Token) -> dict[str, Any] | None:
    """A paragraph that is exactly one `[name](src "attachment…")` link."""
    children = inline.children or []
    if len(children) < 2 or children[0].type != "link_open" or children[-1].type != "link_close":
        return None
    inner = children[1:-1]
    if any(tok.type in ("link_open", "image") for tok in inner):
        return None
    title_attrs = parse_attachment_title(children[0].attrGet("title"))
    if title_attrs is None:
        return None
    return attachment_node(children[0].attrGet("href") or "", _plain_text(inner), title_attrs)


def _split_out_images(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Paragraph runs → blocks, lifting each image out as its own block node.

    Without an image this is the paragraph exactly as before; with one, the
    text on each side becomes its own edge-trimmed paragraph.
    """
    if not any(run["type"] == "image" for run in runs):
        return [{"type": "paragraph", "content": runs} if runs else {"type": "paragraph"}]
    blocks: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []

    def flush() -> None:
        trimmed = _trim_edge_whitespace(pending)
        if trimmed:
            blocks.append({"type": "paragraph", "content": trimmed})
        pending.clear()

    for run in runs:
        if run["type"] == "image":
            flush()
            blocks.append(run)
        else:
            pending.append(run)
    flush()
    return blocks


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
            leading = _inline_html_pieces(html[pos : match.start()])
            if leading:
                nodes.extend(_split_out_images(leading))
        tag = match.group(1).lower()
        nodes.extend(_html_block_nodes(tag, match.group(2), match.group(3)))
        pos = match.end()

    trailing = _inline_html_pieces(html[pos:])
    if trailing:
        nodes.extend(_split_out_images(trailing))

    if not nodes:
        nodes.append({"type": "paragraph"})
    return {"type": "doc", "content": nodes}


_HTML_LONE_ANCHOR_RE = re.compile(r"\s*<a\b([^>]*)>(.*?)</a>\s*", re.IGNORECASE | re.DOTALL)


def _html_attachment(inner: str) -> dict[str, Any] | None:
    """`<a href title="attachment…">name</a>` alone in its block — the HTML
    twin of the markdown attachment form."""
    match = _HTML_LONE_ANCHOR_RE.fullmatch(inner)
    if match is None:
        return None
    title_attrs = parse_attachment_title(_attr_from_tag(match.group(1), "title"))
    if title_attrs is None:
        return None
    href = _attr_from_tag(match.group(1), "href") or ""
    return attachment_node(href, _strip_tags(match.group(2)).strip(), title_attrs)


def _html_paragraph_blocks(inner: str) -> list[dict[str, Any]]:
    attachment = _html_attachment(inner)
    if attachment is not None:
        return [attachment]
    return _split_out_images(_inline_html_pieces(inner))


_HTML_LI_RE = re.compile(r"<li\b([^>]*)>(.*?)</li>", re.IGNORECASE | re.DOTALL)
# A checkbox that LEADS its item, past any wrapper tags: GitHub's
# `<li><input type="checkbox"> text` and TipTap's `<li><label><input …>`.
_HTML_LEADING_INPUT_RE = re.compile(
    r"^\s*(?:<(?!input\b)[a-z][^>]*>\s*)*<input\b([^>]*)>", re.IGNORECASE
)
_HTML_CHECKED_ATTR_RE = re.compile(r"(?:^|\s)checked(?=[\s=/>]|$)", re.IGNORECASE)


def _html_task_list(ul_attrs: str, inner: str) -> dict[str, Any] | None:
    """`<ul data-type="taskList">`, or a list whose every item leads with a
    checkbox. Anything else is an ordinary bullet list."""
    items = list(_HTML_LI_RE.finditer(inner))
    boxes = [_html_leading_checkbox(item.group(2)) for item in items]
    is_tiptap_task_list = (_attr_from_tag(ul_attrs, "data-type") or "").casefold() == "tasklist"
    if not items or not (is_tiptap_task_list or None not in boxes):
        return None
    task_items = []
    for item, box_attrs in zip(items, boxes):
        data_checked = _attr_from_tag(item.group(1), "data-checked")
        if data_checked is not None:
            checked = data_checked.casefold() in ("", "true")
        else:
            checked = box_attrs is not None and _HTML_CHECKED_ATTR_RE.search(box_attrs) is not None
        task_items.append({
            "type": "taskItem",
            "attrs": {"checked": checked},
            "content": _html_paragraph_blocks(item.group(2)),
        })
    return {"type": "taskList", "content": task_items}


def _html_leading_checkbox(li_inner: str) -> str | None:
    match = _HTML_LEADING_INPUT_RE.match(li_inner)
    if match is None or (_attr_from_tag(match.group(1), "type") or "").casefold() != "checkbox":
        return None
    return match.group(1)


def _html_block_nodes(tag: str, attrs: str, inner: str) -> list[dict[str, Any]]:
    if tag in {"h1", "h2", "h3"}:
        pieces = _inline_html_pieces(inner)
        heading = {
            "type": "heading",
            "attrs": {"level": int(tag[1])},
            "content": _trim_edge_whitespace([p for p in pieces if p["type"] != "image"]),
        }
        # A heading cannot hold a block image; keep it right after instead.
        return [heading, *(p for p in pieces if p["type"] == "image")]
    if tag == "p":
        return _html_paragraph_blocks(inner)
    if tag == "ul":
        task_list = _html_task_list(attrs, inner)
        if task_list is not None:
            return [task_list]
    if tag in {"ul", "ol"}:
        items = [
            {"type": "listItem", "content": _html_paragraph_blocks(li.group(1))}
            for li in re.finditer(r"<li[^>]*>(.*?)</li>", inner, re.IGNORECASE | re.DOTALL)
        ]
        return [{
            "type": "bulletList" if tag == "ul" else "orderedList",
            "content": items or [{"type": "listItem", "content": [{"type": "paragraph"}]}],
        }]
    if tag == "pre" or tag == "code":
        # PM codeBlock content is plain text — marks are not allowed inside it.
        return [{
            "type": "codeBlock",
            "content": [{"type": "text", "text": _strip_tags(inner)}],
        }]
    if tag == "blockquote":
        return [{"type": "blockquote", "content": _html_paragraph_blocks(inner)}]
    return _html_paragraph_blocks(inner)


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


def _inline_html_pieces(fragment: str) -> list[dict[str, Any]]:
    """Extract PM text runs, and `<img>` image nodes, from an HTML fragment,
    preserving inline marks. `_split_out_images` turns pieces into blocks.

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
        if tag == "img" and not is_close:
            attrs = tag_match.group(3)
            image = image_node(
                _attr_from_tag(attrs, "src") or "",
                _attr_from_tag(attrs, "alt"),
                _attr_from_tag(attrs, "title"),
            )
            if image is not None:
                runs.append(image)
            continue
        mark_type = _INLINE_MARK_TAGS.get(tag)
        if mark_type is None:
            continue

        if is_close:
            _pop_mark(marks, mark_type)
        elif mark_type == "link":
            marks.append({
                "type": "link",
                "attrs": {"href": _attr_from_tag(tag_match.group(3), "href") or ""},
            })
        else:
            marks.append({"type": mark_type})

    emit(fragment[pos:])
    if any(run["type"] == "image" for run in runs):
        return runs  # `_split_out_images` trims each side of every image.
    return _trim_edge_whitespace(runs)


def _attr_from_tag(attrs: str, name: str) -> str | None:
    match = re.search(
        rf"""(?:^|\s){name}\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))""",
        attrs or "",
        re.IGNORECASE,
    )
    if not match:
        return None
    raw = next((group for group in match.groups()[1:] if group is not None), "")
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
    while trimmed and _is_blank_run(trimmed[0]):
        trimmed.pop(0)
    if trimmed and "text" in trimmed[0]:
        trimmed[0]["text"] = trimmed[0]["text"].lstrip()
    while trimmed and _is_blank_run(trimmed[-1]):
        trimmed.pop()
    if trimmed and "text" in trimmed[-1]:
        trimmed[-1]["text"] = trimmed[-1]["text"].rstrip()
    return trimmed


def _is_blank_run(run: dict[str, Any]) -> bool:
    if run["type"] == "hardBreak":
        return True
    return "text" in run and not run["text"].strip()


def _strip_tags(html: str) -> str:
    return _unescape(re.sub(r"<[^>]+>", "", html))
