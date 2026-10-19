# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The searchable text of a retained session source, folded for literal
case-insensitive matching, and the way back from a folded match to the
original UTF-8 bytes.

Folding is Unicode full case folding per character (`str.casefold`), never
normalization: `café` and `café` stay different. One character folds to
at most three, so a folded index keeps, per chunk, the original characters
whose fold differs and nothing per character of the rest.

Events contribute only the string leaves of the fields a call shows (prompt,
arguments, output, error, diff and tool names), as stored after the mapping's
content level reduced them. Working directories, the server's redaction
fingerprints and the companion's withheld-content placeholders are never
searchable text, nor snippet context around a match."""

import functools
import hashlib
import json
import re
import unicodedata
from bisect import bisect_right
from dataclasses import dataclass

from app.schemas.beacon import REDACTIONS_KEY, canonical_json, companion_declared_bytes

# A folded index is only readable back with the folding that built it.
EXTRACTOR_VERSION = f"session-search-2/unicode-{unicodedata.unidata_version}"

MAX_QUERY_CHARS = 256
MAX_FOLD_EXPANSION = 3
# A match belongs to the chunk it starts in; each chunk also carries this much
# of the next one so the longest folded query always fits inside one chunk.
CHUNK_OVERLAP_CHARS = MAX_QUERY_CHARS * MAX_FOLD_EXPANSION - 1
CHUNK_CHARS = 32 << 10
SNIPPET_BYTES = 2 << 10
# PostgreSQL text cannot hold U+0000; the index stores this noncharacter in its
# place and queries may contain neither.
NUL_STAND_IN = "￿"
FORBIDDEN_QUERY_CHARACTERS = ("\x00", NUL_STAND_IN)

CONTENT_FIELD = "body"
WORKING_DIRECTORY_MEMBERS = frozenset({"cwd", "working_directory", "workdir"})
_TRUNCATION_MARKER = "...[truncated]"
# `[omitted N bytes sha256:…]`, the digest the companion and the standard level
# leave where they withheld file content inside a longer command.
_EMBEDDED_DIGEST = re.compile(r"\[omitted \d+ bytes sha256:[0-9a-f]+\]")
_ASCII_CASE_CHANGING = re.compile(r"[A-Z\x00]")

# Each searchable event root, in extraction order, with the content channel
# its text corresponds to (None: a name, matched only as part of its call).
EVENT_FIELDS: tuple[tuple[str, str | None], ...] = (
    ("prompt.text", "prompt"),
    ("gen_ai.input", "prompt"),
    ("tool.command", "tool_input"),
    ("command.command", "tool_input"),
    ("gen_ai.tool.call.arguments", "tool_input"),
    ("tool.input", "tool_input"),
    ("tool.arguments", "tool_input"),
    ("mcp.arguments", "tool_input"),
    ("output", "tool_output"),
    ("gen_ai.output", "tool_output"),
    ("gen_ai.tool.call.result", "tool_output"),
    ("command.output", "command_output"),
    ("command.stdout", "command_output"),
    ("command.stderr", "command_output"),
    ("tool.output", "tool_output"),
    ("tool.result", "tool_output"),
    ("tool.response", "tool_output"),
    ("tool.stdout", "tool_output"),
    ("tool.stderr", "tool_output"),
    ("mcp.result", "tool_output"),
    ("mcp.response", "tool_output"),
    ("error", "error"),
    ("file.diff", "diff"),
    ("tool.name", None),
    ("gen_ai.tool.name", None),
    ("mcp.server", None),
    ("mcp.tool", None),
    ("mcp.method.name", None),
)


def fold(text: str) -> str:
    return text.casefold().replace("\x00", NUL_STAND_IN)


def fold_length(character: str) -> int:
    return 1 if character == "\x00" else len(character.casefold())


@functools.cache
def _case_changing() -> re.Pattern:
    """Every character whose fold differs from itself, as one class (~600
    ranges, built once per process in well under a second)."""
    ranges: list[tuple[int, int]] = []
    for code_point in range(0x110000):
        if 0xD800 <= code_point <= 0xDFFF:
            continue
        character = chr(code_point)
        if character != "\x00" and character.casefold() == character:
            continue
        if ranges and ranges[-1][1] == code_point - 1:
            ranges[-1] = (ranges[-1][0], code_point)
        else:
            ranges.append((code_point, code_point))
    return re.compile(
        "["
        + "".join(
            re.escape(chr(low)) + ("-" + re.escape(chr(high)) if high > low else "")
            for low, high in ranges
        )
        + "]"
    )


@dataclass(frozen=True)
class FoldedText:
    """Folded text plus the original characters whose fold differs, at their
    folded positions; everything else is its own fold."""

    folded: str
    case_positions: tuple[int, ...]
    case_characters: str

    @classmethod
    def of(cls, text: str) -> "FoldedText":
        folded = fold(text)
        if folded == text:
            return cls(folded, (), "")
        pattern = _ASCII_CASE_CHANGING if text.isascii() else _case_changing()
        positions, characters, expansion = [], [], 0
        for match in pattern.finditer(text):
            character = match.group()
            positions.append(match.start() + expansion)
            characters.append(character)
            expansion += fold_length(character) - 1
        return cls(folded, tuple(positions), "".join(characters))

    @functools.cached_property
    def original(self) -> str:
        pieces, cursor = [], 0
        for position, character in zip(self.case_positions, self.case_characters):
            pieces.append(self.folded[cursor:position])
            pieces.append(character)
            cursor = position + fold_length(character)
        pieces.append(self.folded[cursor:])
        return "".join(pieces)

    @functools.cached_property
    def _expansions(self) -> tuple[list[int], list[int], list[int]]:
        starts, lengths, extra_before, extra = [], [], [], 0
        for position, character in zip(self.case_positions, self.case_characters):
            length = fold_length(character)
            if length > 1:
                starts.append(position)
                lengths.append(length)
                extra_before.append(extra)
                extra += length - 1
        return starts, lengths, extra_before

    def original_index(self, folded_index: int) -> int:
        """The original character whose fold contains `folded_index`."""
        starts, lengths, extra_before = self._expansions
        expansion = bisect_right(starts, folded_index) - 1
        if expansion < 0:
            return folded_index
        start, length = starts[expansion], lengths[expansion]
        if folded_index < start + length:
            return start - extra_before[expansion]
        return folded_index - extra_before[expansion] - (length - 1)

    def original_span(self, folded_start: int, folded_end: int) -> tuple[int, int]:
        """Original character range covering a folded match."""
        return (
            self.original_index(folded_start),
            self.original_index(folded_end - 1) + 1,
        )


@dataclass(frozen=True)
class TextChunk:
    """One bounded piece of a field's folded text. It owns the folded
    characters [0, owned_chars) and carries the overlap after them."""

    ordinal: int
    field: str
    channel: str | None
    # The field bytes snippets may show around a match: a whole body, or one
    # piece of an event leaf between withheld-content placeholders.
    segment_byte_start: int
    segment_byte_end: int
    byte_start: int
    owned_chars: int
    owned_bytes: int
    text: FoldedText


def segment_chunks(
    text: str,
    *,
    field: str,
    channel: str | None,
    segment_byte_start: int,
    first_ordinal: int = 0,
) -> list[TextChunk]:
    segment_byte_end = segment_byte_start + len(text.encode())
    chunks, byte_start = [], segment_byte_start
    for offset in range(0, len(text), CHUNK_CHARS):
        owned = text[offset : offset + CHUNK_CHARS]
        overlap = text[
            offset + CHUNK_CHARS : offset + CHUNK_CHARS + CHUNK_OVERLAP_CHARS
        ]
        folded = FoldedText.of(owned + overlap)
        owned_chars = len(fold(owned))
        chunks.append(
            TextChunk(
                ordinal=first_ordinal + len(chunks),
                field=field,
                channel=channel,
                segment_byte_start=segment_byte_start,
                segment_byte_end=segment_byte_end,
                byte_start=byte_start,
                owned_chars=owned_chars,
                owned_bytes=len(folded.folded[:owned_chars].encode()),
                text=folded,
            )
        )
        byte_start += len(owned.encode())
    return chunks


def content_chunks(text: str, channel: str) -> list[TextChunk]:
    return segment_chunks(
        text, field=CONTENT_FIELD, channel=channel, segment_byte_start=0
    )


# --- events -------------------------------------------------------------------


@dataclass(frozen=True)
class EventSegment:
    field: str
    channel: str | None
    leaf: str
    byte_start: int
    text: str


def _value_at(data: dict, path: str):
    node = data
    for key in path.split("."):
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    return node


def _structured(value: str):
    """A JSON object or array carried as text (an OTLP attribute, a Codex
    argument string), else None."""
    stripped = value.lstrip()
    if not stripped.startswith(("{", "[")):
        return None
    try:
        decoded = json.loads(value)
    except (ValueError, RecursionError):
        return None
    return decoded if isinstance(decoded, (dict, list)) else None


def _is_output_descriptor(value) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == {"bytes", "sha256"}
        and isinstance(value["bytes"], int)
    )


def member_segment(key: str) -> str:
    """A member name as one path segment: `~` and `.` escaped (`~0`, `~1`),
    so `{"a": {"b": …}}` is `a.b` and `{"a.b": …}` is `a~1b`."""
    return key.replace("~", "~0").replace(".", "~1")


def _string_leaves(value, path: str):
    """(field, text) of every searchable string leaf under `value`, depth
    first in sorted member order. Iterative, so an admitted event of any
    nesting depth is walked completely."""
    pending = [(path, value)]
    while pending:
        path, value = pending.pop()
        if isinstance(value, str):
            structured = _structured(value)
            if structured is not None:
                pending.append((path, structured))
            elif companion_declared_bytes(value) is None:
                yield path, value
        elif isinstance(value, dict):
            if _is_output_descriptor(value):
                continue
            members = [
                (f"{path}.{member_segment(key)}", value[key])
                for key in sorted(key for key in value if isinstance(key, str))
                if key.lower() not in WORKING_DIRECTORY_MEMBERS
                and key != REDACTIONS_KEY
            ]
            pending.extend(reversed(members))
        elif isinstance(value, list):
            pending.extend(
                reversed(
                    [(f"{path}.{index}", child) for index, child in enumerate(value)]
                )
            )


def _redacted_paths(event: dict) -> frozenset[str]:
    redactions = event.get(REDACTIONS_KEY)
    return frozenset(redactions) if isinstance(redactions, dict) else frozenset()


def _pieces(leaf: str, path: str, redacted: frozenset[str]):
    """(byte offset, text) of the leaf's searchable pieces: everything but
    embedded withheld-content digests and a server truncation marker."""
    searchable_end = len(leaf)
    if path in redacted and leaf.endswith(_TRUNCATION_MARKER):
        searchable_end -= len(_TRUNCATION_MARKER)
    cursor = 0
    for match in _EMBEDDED_DIGEST.finditer(leaf, 0, searchable_end):
        if match.start() > cursor:
            yield cursor, leaf[cursor : match.start()]
        cursor = match.end()
    if searchable_end > cursor:
        yield cursor, leaf[cursor:searchable_end]


def event_segments(event: dict) -> list[EventSegment]:
    redacted = _redacted_paths(event)
    segments = []
    for root, channel in EVENT_FIELDS:
        value = _value_at(event, root)
        if value is None:
            continue
        for path, leaf in _string_leaves(value, root):
            for char_start, text in _pieces(leaf, path, redacted):
                segments.append(
                    EventSegment(
                        field=path,
                        channel=channel,
                        leaf=leaf,
                        byte_start=len(leaf[:char_start].encode()),
                        text=text,
                    )
                )
    return segments


def event_digest(segments: list[EventSegment]) -> str:
    return hashlib.sha256(
        canonical_json(
            [[segment.field, segment.byte_start, segment.text] for segment in segments]
        ).encode()
    ).hexdigest()


def event_chunks(segments: list[EventSegment]) -> list[TextChunk]:
    chunks: list[TextChunk] = []
    for segment in segments:
        chunks.extend(
            segment_chunks(
                segment.text,
                field=segment.field,
                channel=segment.channel,
                segment_byte_start=segment.byte_start,
                first_ordinal=len(chunks),
            )
        )
    return chunks


def event_leaf(event: dict, field: str) -> str | None:
    """The stored string leaf a field names: its root, then one escaped
    segment per member or array index (see `member_segment`). Resolved the
    way it was indexed, so excluded members never resolve."""
    root = next(
        (
            root
            for root, _ in EVENT_FIELDS
            if field == root or field.startswith(root + ".")
        ),
        None,
    )
    if root is None:
        return None
    value = _value_at(event, root)
    if value is None:
        return None
    return next(
        (leaf for path, leaf in _string_leaves(value, root) if path == field), None
    )


# --- snippets -----------------------------------------------------------------


def snippet_range(
    span_start: int, span_end: int, bound_start: int, bound_end: int
) -> tuple[int, int] | None:
    """At most SNIPPET_BYTES of [bound_start, bound_end) around the span,
    context split evenly; None when the span alone is larger."""
    context = SNIPPET_BYTES - (span_end - span_start)
    if context < 0:
        return None
    before = min(context // 2, span_start - bound_start)
    after = min(context - before, bound_end - span_end)
    # Context the end of the field cannot use goes before the span instead.
    before = min(context - after, span_start - bound_start)
    return span_start - before, span_end + after


def snippet_text(
    data: bytes, data_start: int, span_start: int, span_end: int
) -> tuple[str, int] | None:
    """`data` (the bytes at data_start, covering the span) trimmed to whole
    UTF-8 characters and decoded strictly, with its new start; None when it
    is not valid UTF-8."""
    start = 0
    while start < span_start - data_start and data[start] & 0xC0 == 0x80:
        start += 1
    end = _whole_characters_end(data, span_end - data_start)
    try:
        text = data[start:end].decode("utf-8")
    except UnicodeDecodeError:
        return None
    return text, data_start + start


def _whole_characters_end(data: bytes, floor: int) -> int:
    """len(data), or where its last character starts when the range cut it."""
    lead = len(data) - 1
    while lead > floor and data[lead] & 0xC0 == 0x80:
        lead -= 1
    if lead < floor:
        return len(data)
    byte = data[lead]
    width = 4 if byte >= 0xF0 else 3 if byte >= 0xE0 else 2 if byte >= 0xC0 else 1
    return lead if lead + width > len(data) else len(data)
