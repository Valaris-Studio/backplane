# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Neutralise unsafe URLs in markdown/HTML text without re-encoding it.

For rich text stored as the string an author wrote (approvals), where
converting to ProseMirror JSON would change what API and MCP readers get
back. Only an unsafe URL target is rewritten; every other byte is kept:

- markdown inline and reference destinations become `<>` (an empty target);
- a markdown autolink to an unsafe scheme is removed;
- an HTML `<img>` with an unsafe `src` is removed, and an unsafe `href` is
  removed from its `<a>`.

"Unsafe" is `is_safe_media_url` after decoding the way a renderer would
(backslash escapes and HTML entities); a link target may also be `mailto:`,
an image source may not. The scan over-matches (a `](` inside a code span is
scrubbed too) because only unsafe targets are ever touched.

This runs inside request handlers, so every pass is linear: each scan
resumes after the span it already consumed, and no pattern can restart a
long match at every position.
"""
from __future__ import annotations

import html
import re
from collections.abc import Iterable

from app.services.notes.media_markdown import is_safe_media_url

_ASCII_PUNCTUATION = r"!-/:-@\[-`{-~"
_BACKSLASH_ESCAPE_RE = re.compile(rf"\\([{_ASCII_PUNCTUATION}])")
_EMPTY_DESTINATION = "<>"

_INLINE_DESTINATION_OPEN_RE = re.compile(r"\]\(")
# A definition starts a line, optionally inside blockquote and list markers.
# The label is one line of at most 999 chars (CommonMark's cap) with disjoint
# alternatives, so a failed attempt costs at most that line.
_REFERENCE_DEFINITION_RE = re.compile(
    r"^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?"
    r"\[(?:[^\[\]\\\n]|\\.){1,999}\]:[ \t]*(?:\n[ \t]*)?",
    re.MULTILINE,
)
_AUTOLINK_RE = re.compile(r"<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^\x00-\x20<>]*)>")

# HTML tokenizer whitespace (no vertical tab), and tag names followed by what
# ends a tag name.
_HTML_WHITESPACE = "\t\n\x0c\r "
_HTML_URL_TAG_RE = re.compile(r"<(img|a)(?=[\t\n\x0c\r />])", re.IGNORECASE)
_UNSAFE_ATTRIBUTE_BY_TAG = {"img": "src", "a": "href"}
_LINK_TAGS = {"a"}
_MAILTO_RE = re.compile(r"^mailto:", re.IGNORECASE)
_TAB_OR_NEWLINE_RE = re.compile(r"[\t\n\r]")


def neutralise_unsafe_markup_urls(text: str) -> str:
    text = _scrub_html_tags(text)
    text = _scrub_inline_destinations(text)
    # A definition can serve a link or an image; a `mailto:` image source is
    # inert (no request, no script), so definitions use the link allowlist.
    definitions = ((m.start(), m.end(), True) for m in _REFERENCE_DEFINITION_RE.finditer(text))
    text = _scrub_destinations(text, definitions)
    return _AUTOLINK_RE.sub(lambda m: m.group(0) if _is_safe_url(m.group(1), link=True) else "", text)


def _is_safe_url(decoded: str, *, link: bool) -> bool:
    if is_safe_media_url(decoded):
        return True
    # Same edge/tab rules as is_safe_media_url: `mail\tto:` parses as `mailto:`.
    return (
        link
        and decoded == decoded.strip("\x00 \t\n\r\x0c")
        and _MAILTO_RE.match(_TAB_OR_NEWLINE_RE.sub("", decoded)) is not None
    )


def _is_safe_target(encoded: str, *, link: bool) -> bool:
    decoded = html.unescape(_BACKSLASH_ESCAPE_RE.sub(r"\1", encoded))
    return decoded == "" or _is_safe_url(decoded, link=link)


# --- markdown ---------------------------------------------------------------


def _scrub_inline_destinations(text: str) -> str:
    if "](" not in text:
        return text
    image_label_closers = _image_label_closers(text)
    openers = (
        (match.start(), match.end(), match.start() not in image_label_closers)
        for match in _INLINE_DESTINATION_OPEN_RE.finditer(text)
    )
    return _scrub_destinations(text, openers, skip_lead=True)


def _scrub_destinations(
    text: str, openers: Iterable[tuple[int, int, bool]], *, skip_lead: bool = False
) -> str:
    """Replace each unsafe destination with `<>`. `openers` yields (opener
    start, destination start, is a link). An opener inside a destination
    already consumed is part of it, not a new link, so scanning resumes after
    it, which also keeps this linear."""
    pieces: list[str] = []
    cursor = 0
    consumed_until = 0
    for opener_start, start, is_link in openers:
        if opener_start < consumed_until:
            continue
        if skip_lead:
            start = _skip_destination_lead(text, start)
        destination = _destination_span(text, start)
        if destination is None:
            continue
        span_start, span_end, raw = destination
        consumed_until = span_end
        if _is_safe_target(raw, link=is_link):
            continue
        pieces.append(text[cursor:span_start])
        pieces.append(_EMPTY_DESTINATION)
        cursor = span_end
    pieces.append(text[cursor:])
    return "".join(pieces)


def _image_label_closers(text: str) -> set[int]:
    """Indexes of each `]` closing an image label (`![`), in one forward pass.
    A `]` with no `[` to match is included too: the stricter reading."""
    openers: list[bool] = []
    image_closers: set[int] = set()
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == "[":
            openers.append(index > 0 and text[index - 1] == "!" and not _bang_was_escaped(text, index - 1))
        elif char == "]":
            if not openers or openers.pop():
                image_closers.add(index)
        index += 1
    return image_closers


def _bang_was_escaped(text: str, bang_index: int) -> bool:
    backslashes = 0
    while bang_index - backslashes - 1 >= 0 and text[bang_index - backslashes - 1] == "\\":
        backslashes += 1
    return backslashes % 2 == 1


def _skip_destination_lead(text: str, index: int) -> int:
    """CommonMark allows spaces, tabs and at most one line ending after `(`."""
    seen_newline = False
    while index < len(text) and text[index] in " \t\n":
        if text[index] == "\n":
            if seen_newline:
                break
            seen_newline = True
        index += 1
    return index


def _destination_span(text: str, start: int) -> tuple[int, int, str] | None:
    """(start, end, raw destination) per CommonMark's link-destination rules.
    Unbalanced parentheses still yield the span: it is consumed either way."""
    if start >= len(text):
        return None
    if text[start] == "<":
        index = start + 1
        while index < len(text):
            char = text[index]
            if char == "\\" and index + 1 < len(text):
                index += 2
                continue
            if char in "<\n":
                return None
            if char == ">":
                return start, index + 1, text[start + 1 : index]
            index += 1
        return None
    depth = 0
    index = start
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text):
            index += 2
            continue
        if ord(char) <= 0x20 or char == "\x7f":
            break
        if char == "(":
            depth += 1
        elif char == ")":
            if depth == 0:
                break
            depth -= 1
        index += 1
    if index == start:
        return None
    return start, index, text[start:index]


# --- HTML -------------------------------------------------------------------


def _scrub_html_tags(text: str) -> str:
    pieces: list[str] = []
    cursor = 0
    scanned_until = 0
    for match in _HTML_URL_TAG_RE.finditer(text):
        # A `<img` inside an attribute value of a tag already scanned is text.
        if match.start() < scanned_until:
            continue
        tag = match.group(1).lower()
        tag_end, attributes = _scan_attributes(text, match.end())
        scanned_until = tag_end
        unsafe = [
            (start, end)
            for start, end, name, value in attributes
            if name == _UNSAFE_ATTRIBUTE_BY_TAG[tag]
            and not _is_safe_html_url(value, link=tag in _LINK_TAGS)
        ]
        if not unsafe:
            continue
        pieces.append(text[cursor : match.start()])
        if tag == "a":
            kept = match.start()
            for start, end in unsafe:
                pieces.append(text[kept:start])
                kept = end
            pieces.append(text[kept:tag_end])
        cursor = tag_end
    pieces.append(text[cursor:])
    return "".join(pieces)


def _is_safe_html_url(value: str | None, *, link: bool) -> bool:
    # A bare `href`/`src` with no value carries no URL.
    return value is None or _is_safe_url(html.unescape(value), link=link)


def _scan_attributes(text: str, index: int) -> tuple[int, list[tuple[int, int, str, str | None]]]:
    """Walk a start tag the way the HTML tokenizer does (quoted values may hold
    `>`); returns the index after the tag and each attribute's span, lowercased
    name and raw value."""
    attributes: list[tuple[int, int, str, str | None]] = []
    length = len(text)
    while index < length:
        char = text[index]
        if char in _HTML_WHITESPACE or char == "/":
            index += 1
            continue
        if char == ">":
            return index + 1, attributes
        start = index
        name_end = index + 1
        while name_end < length and text[name_end] not in _HTML_WHITESPACE and text[name_end] not in "/>=":
            name_end += 1
        name = text[start:name_end].lower()
        value_index = name_end
        while value_index < length and text[value_index] in _HTML_WHITESPACE:
            value_index += 1
        value: str | None = None
        end = name_end
        if value_index < length and text[value_index] == "=":
            value_index += 1
            while value_index < length and text[value_index] in _HTML_WHITESPACE:
                value_index += 1
            if value_index < length and text[value_index] in "\"'":
                closing = text.find(text[value_index], value_index + 1)
                end = length if closing == -1 else closing + 1
                value = text[value_index + 1 : closing if closing != -1 else length]
            else:
                end = value_index
                while end < length and text[end] not in _HTML_WHITESPACE and text[end] != ">":
                    end += 1
                value = text[value_index:end]
        attributes.append((start, end, name, value))
        index = end
    return length, attributes
