# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Rejected eligibility comparator, retained only for semantic regression evidence.

Never imported by production. The global scan changed baseline SERIALIZABLE
outcomes and failed scoped work and latency gates; it is not a repair candidate.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    Select,
    and_,
    case,
    cast,
    exists,
    func,
    literal,
    not_,
    or_,
    select,
    true,
    union_all,
)
from sqlalchemy.dialects.postgresql import array

from app.models.agent_session import AgentSessionContent as Content
from app.models.session_search import SessionSearchChunk as Chunk
from app.models.session_search import SessionSearchSource as Source
from app.schemas.session_content import TEXT_MEDIA_TYPES, WITH_BODY

if TYPE_CHECKING:
    from app.repositories.session_search import SearchScope


SMALL_ELIGIBILITY_ROWS = 2048
SMALL_COVERAGE_ROWS = 2048


def _fixed_string(value: str):
    return literal(value, literal_execute=True)


def _readable_content():
    return and_(
        Content.state == _fixed_string("available"),
        Content.coverage.in_([_fixed_string(value) for value in sorted(WITH_BODY)]),
        Content.media_type.in_(
            [_fixed_string(value) for value in sorted(TEXT_MEDIA_TYPES)]
        ),
        Content.sha256 == Source.source_digest,
    )


def _pure_tool_alias(scope: SearchScope) -> bool:
    return (
        scope.channels == frozenset()
        and scope.tool_alias
        and not scope.tool_anchors
        and not scope.mcp_anchors
        and scope.failed_anchors is None
        and scope.work_anchors is None
    )


def _eligibility_scope_is_empty(scope: SearchScope) -> bool:
    return (
        scope.failed_anchors == frozenset()
        or scope.work_anchors == frozenset()
        or (
            scope.failed_anchors is not None
            and scope.work_anchors is not None
            and not (scope.failed_anchors & scope.work_anchors)
        )
        or (
            scope.channels == frozenset()
            and not scope.tool_alias
            and not scope.tool_anchors
            and not scope.mcp_anchors
        )
    )


def supports_eligibility_scope(scope: SearchScope) -> bool:
    return (
        _eligibility_scope_is_empty(scope)
        or _pure_tool_alias(scope)
        or scope.channels is None
        or (
            not scope.tool_alias
            and scope.tool_anchors is None
            and scope.mcp_anchors is None
        )
    )


def _large_eligibility_totals(session_id: uuid.UUID, scope: SearchScope) -> Select:
    valid_source = [
        Source.status == _fixed_string("indexed"),
        Source.extractor_version == scope.extractor_version,
    ]
    if scope.failed_anchors is not None:
        valid_source.append(Source.call_anchor.in_(scope.failed_anchors))
    if scope.work_anchors is not None:
        valid_source.append(Source.call_anchor.in_(scope.work_anchors))
    live_content = and_(Content.id == Source.content_id, _readable_content())
    invalid_contents = (
        select(Source.id.label("id"))
        .select_from(Source)
        .outerjoin(Content, live_content)
        .where(
            Source.content_id.is_not(None),
            and_(*valid_source, Content.id.is_not(None)).is_not(True),
        )
        .offset(0)
    )
    invalid_events = select(Source.id.label("id")).where(Source.event_id.is_not(None))
    if not _pure_tool_alias(scope):
        invalid_events = invalid_events.where(and_(*valid_source).is_not(True))
    invalid = union_all(invalid_contents, invalid_events).subquery()

    grouped = select(
        Chunk.source_id.label("source_id"),
        func.sum(Chunk.owned_bytes).label("owned_bytes"),
    ).where(Chunk.session_id == session_id)
    if _pure_tool_alias(scope):
        grouped = grouped.where(Chunk.channel.in_(("tool_input", "tool_output")))
    elif scope.channels is not None:
        grouped = grouped.where(Chunk.channel.in_(scope.channels))
    grouped = (
        grouped.group_by(Chunk.source_id)
        .order_by(Chunk.source_id)
        .subquery("scoped_chunk_totals")
    )
    return (
        select(
            func.count(),
            cast(func.coalesce(func.sum(grouped.c.owned_bytes), 0), BigInteger),
        )
        .select_from(grouped)
        .where(
            not_(
                exists(
                    select(1)
                    .select_from(invalid)
                    .where(invalid.c.id == grouped.c.source_id)
                )
            )
        )
    )


def eligibility_totals_query(session_id: uuid.UUID, scope: SearchScope) -> Select:
    """Return one pair of totals; callers retain the original unsupported scopes."""
    if _eligibility_scope_is_empty(scope):
        return select(array([literal(0), literal(0)], type_=BigInteger).label("totals"))
    assert supports_eligibility_scope(scope)
    # Probe raw scoped rows so repeated sources, zero bytes and aliases cannot
    # misclassify a large scope. The complete small corpus needs no chronology.
    probe = (
        select(Chunk.source_id, Chunk.owned_bytes, Chunk.channel)
        .where(Chunk.session_id == session_id)
        .order_by(Chunk.source_id)
        .limit(SMALL_ELIGIBILITY_ROWS + 1)
        .cte("eligibility_probe")
        .prefix_with("MATERIALIZED")
    )
    source_conditions = [
        Source.id == probe.c.source_id,
        Source.status == "indexed",
        Source.extractor_version == scope.extractor_version,
    ]
    if scope.failed_anchors is not None:
        source_conditions.append(Source.call_anchor.in_(scope.failed_anchors))
    if scope.work_anchors is not None:
        source_conditions.append(Source.call_anchor.in_(scope.work_anchors))
    current_source = (
        select(Source.id, Source.content_id, Source.event_id, Source.source_digest)
        .where(*source_conditions)
        .limit(1)
        .lateral()
    )
    current_content = (
        select(Content.state, Content.coverage, Content.media_type, Content.sha256)
        .where(Content.id == current_source.c.content_id)
        .limit(1)
        .lateral()
    )
    readable = and_(
        current_content.c.state == "available",
        current_content.c.coverage.in_(WITH_BODY),
        current_content.c.media_type.in_(TEXT_MEDIA_TYPES),
        current_content.c.sha256 == current_source.c.source_digest,
    )
    small = (
        select(
            array(
                [
                    func.count(func.distinct(probe.c.source_id)),
                    func.coalesce(func.sum(probe.c.owned_bytes), 0),
                ],
                type_=BigInteger,
            )
        )
        .select_from(probe)
        .join(current_source, true())
        .outerjoin(current_content, true())
        .where(or_(current_source.c.event_id.is_not(None), readable))
    )
    if _pure_tool_alias(scope):
        small = small.where(
            current_source.c.content_id.is_not(None),
            probe.c.channel.in_(("tool_input", "tool_output")),
        )
    elif scope.channels is not None:
        small = small.where(probe.c.channel.in_(scope.channels))
    large = _large_eligibility_totals(session_id, scope)
    large = large.with_only_columns(
        array(list(large.selected_columns), type_=BigInteger)
    )
    observed = select(func.count()).select_from(probe).scalar_subquery()
    return select(
        case(
            (observed <= SMALL_ELIGIBILITY_ROWS, small.scalar_subquery()),
            else_=large.scalar_subquery(),
        ).label("totals")
    )
