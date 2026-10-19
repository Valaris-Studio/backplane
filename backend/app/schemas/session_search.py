# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Searching one of your sessions' retained text and calls.

The query travels in the request body only, so it never reaches a URL or an
access log; a rejected request does not echo it back."""

import uuid
from datetime import datetime
from typing import Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.json_response import UTCModel
from app.schemas.session_content import ContentChannel
from app.services.session_search_text import (
    FORBIDDEN_QUERY_CHARACTERS,
    MAX_QUERY_CHARS,
)

MAX_SEARCH_HITS = 20
MAX_SEARCH_CURSOR_LENGTH = 1024
# Every content channel, plus the call kinds of the calls API.
SearchType = Literal[ContentChannel, "tool", "mcp", "subagent"]


class SessionSearchRequest(BaseModel):
    """A literal, case-insensitive substring (Unicode case folding, no
    accent or other normalization; `%`, `_` and `\\` are literal). Filters
    intersect; several `types` are alternatives. `tool` covers tool input and
    output content and the fields of tool calls; `mcp` the content and fields
    of MCP calls; `subagent` matches nothing here, since a linked child
    session is searched on its own. Failure and linked work are the calls'
    current state. Pass `next_cursor` back, with the same query and filters,
    to continue a scan."""

    model_config = ConfigDict(extra="forbid")

    q: str = Field(min_length=1, max_length=MAX_QUERY_CHARS)
    types: list[SearchType] | None = Field(None, max_length=len(get_args(SearchType)))
    failures_only: bool = False
    work_only: bool = False
    cursor: str | None = Field(None, min_length=1, max_length=MAX_SEARCH_CURSOR_LENGTH)
    limit: int = Field(MAX_SEARCH_HITS, ge=1, le=MAX_SEARCH_HITS)

    @field_validator("q")
    @classmethod
    def _searchable(cls, value: str) -> str:
        if any(character in value for character in FORBIDDEN_QUERY_CHARACTERS):
            raise ValueError("q contains a character that is never searchable")
        return value


SourceState = Literal["available", "unavailable"]


class SessionSearchHit(UTCModel):
    """One match, at its exact original UTF-8 bytes within `field`: a
    content body (`body`) or an event's string leaf: its root field (such as
    `prompt.text` or `tool.arguments`), then one `.`-separated segment per
    member or array index, member names escaping `~` as `~0` and `.` as `~1`
    (through JSON text where a member holds some). `snippet` is at most 2 KiB
    of the current bytes around it, starting at `snippet_byte_start`; none
    when the source cannot be verified now (`source_state`)."""

    source_kind: Literal["content", "event"]
    source_id: uuid.UUID
    content_id: uuid.UUID | None
    event_id: str | None
    call_key: str | None
    channel: ContentChannel | None
    field: str
    occurred_at: datetime
    byte_start: int
    byte_end: int
    snippet: str | None
    snippet_byte_start: int | None
    source_state: SourceState


class CoverageCount(BaseModel):
    count: int
    # None when any item's size is unknown.
    bytes: int | None


class LinkedChildMetadata(BaseModel):
    count: int
    searchable: Literal[False] = False


class SessionSearchCoverage(UTCModel):
    """What this session retains, by searchability, evaluated now. `indexed`
    is what a scan reads; `pending_index` is retained text not indexed yet
    (including anything written before search existed); `eligible` is both.
    `available` counts every body readable now, text or not. A scan that
    completes covers `indexed` only: `index_ready` says whether that is all
    of the retained text."""

    indexed: CoverageCount
    pending_index: CoverageCount
    pending_upload: CoverageCount
    withheld: CoverageCount
    uncaptured: CoverageCount
    unavailable: CoverageCount
    nontext: CoverageCount
    available: CoverageCount
    eligible: CoverageCount
    linked_child_metadata: LinkedChildMetadata
    index_ready: bool
    extractor_version: str
    verified_at: datetime


class SessionSearchPage(UTCModel):
    """Hits in chronological order. A request scans at most 8 MiB of folded
    text and returns at most `limit` hits; `complete` is true only when the
    scan reached the end. `generation` changes whenever the session's
    searchable text changes, and a cursor from another generation (or whose
    filtered calls changed) answers 409 `session_search_stale`: start again."""

    items: list[SessionSearchHit]
    generation: int
    scanned_bytes: int
    eligible_bytes: int
    next_cursor: str | None
    complete: bool
    coverage: SessionSearchCoverage
