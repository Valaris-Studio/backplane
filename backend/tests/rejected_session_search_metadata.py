# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Rejected global coverage query retained only for historical causal controls.

This query changed a successful baseline SERIALIZABLE schedule. Product code
must not import it; passing expression-work controls do not qualify this design.
"""

from __future__ import annotations

import uuid

from sqlalchemy import (
    Select,
    and_,
    case,
    false,
    func,
    literal,
    not_,
    select,
    union_all,
)

from app.models.agent_session import AgentSessionContent as Content
from app.models.session_search import SessionSearchSource as Source
from app.schemas.session_content import TEXT_MEDIA_TYPES


SMALL_COVERAGE_ROWS = 2048


def _fixed_string(value: str):
    return literal(value, literal_execute=True)


def _small_coverage_groups(classified):
    # A bounded corpus needs only one scalar Source lookup per Content row.
    keys = [
        classified.c.state,
        classified.c.coverage,
        classified.c.is_text,
        classified.c.index_status,
        classified.c.unverified,
    ]
    return select(
        *keys,
        func.count().label("count"),
        func.coalesce(func.sum(classified.c.stored_bytes), 0).label("stored_bytes"),
        func.count(classified.c.stored_bytes).label("stored_known"),
        func.coalesce(func.sum(classified.c.original_bytes), 0).label("original_bytes"),
        func.count(classified.c.original_bytes).label("original_known"),
    ).group_by(*keys)


def _coverage_groups(classified):
    # Only one terminal status can match, so its branch alone compares the
    # digests. Boolean grouping keys keep cardinality finite across the UNION.
    statuses = ("indexed", "unavailable", "not_text")
    flags = [
        case(
            (
                classified.c.index_status == _fixed_string(status),
                func.coalesce(classified.c.digest_matches, false()),
            ),
            else_=false(),
        ).label("status_" + status)
        for status in statuses
    ]
    keys = [
        classified.c.state,
        classified.c.coverage,
        classified.c.is_text,
        classified.c.unverified,
        *flags,
    ]
    grouped = (
        select(
            *keys,
            func.count().label("count"),
            func.coalesce(func.sum(classified.c.stored_bytes), 0).label("stored_bytes"),
            func.count(classified.c.stored_bytes).label("stored_known"),
            func.coalesce(func.sum(classified.c.original_bytes), 0).label(
                "original_bytes"
            ),
            func.count(classified.c.original_bytes).label("original_known"),
        )
        .group_by(*keys)
        .subquery("coverage_group_totals")
    )
    status = case(
        *((grouped.c["status_" + value], _fixed_string(value)) for value in statuses),
        else_=None,
    ).label("index_status")
    return select(
        grouped.c.state,
        grouped.c.coverage,
        grouped.c.is_text,
        status,
        grouped.c.unverified,
        grouped.c.count,
        grouped.c.stored_bytes,
        grouped.c.stored_known,
        grouped.c.original_bytes,
        grouped.c.original_known,
    )


def _coverage_fields(content, status, unverified):
    return [
        content.c.state.label("state"),
        content.c.coverage.label("coverage"),
        func.coalesce(
            content.c.media_type.in_(
                tuple(_fixed_string(value) for value in sorted(TEXT_MEDIA_TYPES))
            ),
            false(),
        ).label("is_text"),
        status.label("index_status"),
        func.coalesce(content.c.id.in_(unverified), false()).label("unverified"),
        content.c.byte_count.label("stored_bytes"),
        func.coalesce(content.c.original_byte_count, content.c.byte_count).label(
            "original_bytes"
        ),
    ]


def coverage_totals_query(
    session_id: uuid.UUID, extractor_version: str, unverified: set[uuid.UUID]
) -> Select:
    """One snapshot, with bounded lookups for small sessions and ordered metadata for large ones."""
    probe = (
        select(
            Content.id,
            Content.state,
            Content.coverage,
            Content.media_type,
            Content.sha256,
            Content.byte_count,
            Content.original_byte_count,
        )
        .where(Content.session_id == session_id)
        .order_by(Content.id)
        .limit(literal(SMALL_COVERAGE_ROWS + 1, literal_execute=True))
        .cte("coverage_probe")
        .prefix_with("MATERIALIZED")
    )
    terminal_statuses = tuple(
        _fixed_string(value) for value in ("indexed", "unavailable", "not_text")
    )
    small_status = (
        select(Source.status)
        .where(
            Source.content_id == probe.c.id,
            Source.extractor_version == extractor_version,
            Source.source_digest == probe.c.sha256,
            Source.status.in_(terminal_statuses),
        )
        .limit(literal(1, literal_execute=True))
        .scalar_subquery()
    )
    small = _small_coverage_groups(
        select(*_coverage_fields(probe, small_status, unverified)).subquery()
    ).subquery()

    # Keep Source metadata ordered across prepared-plan reuse. Unique
    # content_id allows digest classification after the join without adding
    # rows: stale or NULL digests retain the unmatched NULL status.
    ordered_status_branches = [
        select(Source.content_id, Source.status, Source.source_digest)
        .where(
            Source.status == terminal_status,
            Source.extractor_version == extractor_version,
        )
        .order_by(Source.content_id)
        for terminal_status in terminal_statuses
    ]
    current_sources = (
        union_all(*ordered_status_branches)
        .order_by("content_id")
        .offset(literal(0, literal_execute=True))
        .subquery("coverage_current_sources")
    )
    classified = (
        select(
            *_coverage_fields(Content.__table__, current_sources.c.status, unverified),
            (current_sources.c.source_digest == Content.sha256).label("digest_matches"),
        )
        .select_from(Content)
        .outerjoin(current_sources, current_sources.c.content_id == Content.id)
        .where(Content.session_id == session_id)
        .subquery()
    )
    large = _coverage_groups(classified).subquery()
    choose_small = select(func.count()).select_from(probe).scalar_subquery() <= literal(
        SMALL_COVERAGE_ROWS, literal_execute=True
    )
    return union_all(
        select(*small.c).where(choose_small), select(*large.c).where(not_(choose_small))
    )


def historical_coverage_oracle_query(
    session_id: uuid.UUID,
    extractor_version: str,
    unverified: set[uuid.UUID],
):
    """Terminal-filtered oracle retained for the rejected expression control."""
    current = and_(
        Source.content_id == Content.id,
        Source.extractor_version == extractor_version,
        Source.source_digest == Content.sha256,
        Source.status.in_(("indexed", "unavailable", "not_text")),
    )
    original = func.coalesce(Content.original_byte_count, Content.byte_count)
    # Grouped through subquery columns: the expressions carry bind
    # parameters, which PostgreSQL would not match in a GROUP BY.
    classified = (
        select(
            Content.state.label("state"),
            Content.coverage.label("coverage"),
            case((Content.media_type.in_(TEXT_MEDIA_TYPES), 1), else_=0).label(
                "is_text"
            ),
            Source.status.label("index_status"),
            case((Content.id.in_(unverified), 1), else_=0).label("unverified"),
            Content.byte_count.label("stored_bytes"),
            original.label("original_bytes"),
        )
        .select_from(Content)
        .outerjoin(Source, current)
        .where(Content.session_id == session_id)
        .subquery()
    )
    return select(
        classified.c.state,
        classified.c.coverage,
        classified.c.is_text,
        classified.c.index_status,
        classified.c.unverified,
        func.count(),
        func.coalesce(func.sum(classified.c.stored_bytes), 0),
        func.count(classified.c.stored_bytes),
        func.coalesce(func.sum(classified.c.original_bytes), 0),
        func.count(classified.c.original_bytes),
    ).group_by(
        classified.c.state,
        classified.c.coverage,
        classified.c.is_text,
        classified.c.index_status,
        classified.c.unverified,
    )
