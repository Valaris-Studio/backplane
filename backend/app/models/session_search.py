# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The owner-private search index of a session's retained text.

Every row hangs off its session, and a source row also off its content or
event, through cascading foreign keys: deleting a session, workspace, user,
device or any one source removes its searchable copy with it. Whether a
source may be searched is decided live against the content row; nothing
here records a permanent verdict about calls, failures or linked work."""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    CHAR,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDMixin

SOURCE_STATUSES = ("pending", "indexed", "unavailable", "not_text")


class SessionSearchState(Base):
    """A session's committed index generation: it moves, in the transaction
    that changed the session's searchable chunks, so a cursor can tell that
    what it paged through has changed."""

    __tablename__ = "session_search_states"

    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_sessions.id", ondelete="CASCADE"),
        primary_key=True,
    )
    generation: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class SessionSearchSource(Base, UUIDMixin):
    """One content item or event as the current extractor read it, bound to
    the exact digest it read. A row of an older extractor or digest is not
    current: the source is pending again."""

    __tablename__ = "session_search_sources"
    __table_args__ = (
        UniqueConstraint("content_id", name="uq_session_search_source_content"),
        UniqueConstraint("event_id", name="uq_session_search_source_event"),
        CheckConstraint(
            "(content_id IS NULL) <> (event_id IS NULL)",
            name="ck_session_search_source_kind",
        ),
        CheckConstraint(
            "status IN ('pending', 'indexed', 'unavailable', 'not_text')",
            name="ck_session_search_source_status",
        ),
        Index("ix_session_search_sources_session", "session_id", "status"),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_sessions.id", ondelete="CASCADE")
    )
    content_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_session_contents.id", ondelete="CASCADE"),
        nullable=True,
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_session_events.id", ondelete="CASCADE"),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(String(16))
    # Why a source is unavailable or not text (a missing object, a digest or
    # size that no longer matches, invalid UTF-8).
    reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    extractor_version: Mapped[str] = mapped_column(String(64))
    # The content's sha256, or the digest of an event's extracted text.
    source_digest: Mapped[str] = mapped_column(CHAR(64))
    # UTF-8 bytes of the text read; a pending upload's declared size.
    byte_count: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    folded_bytes: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    chunk_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # The call the source belongs to, in the calls API's anchor space
    # (`c:<native call id>` or `e:<event id>`); its kind, failure and linked
    # work are evaluated live from the session's events and work records.
    call_anchor: Mapped[str | None] = mapped_column(String(220), nullable=True)
    indexed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class SessionSearchChunk(Base, UUIDMixin):
    """A bounded piece of one field's folded text, in chronological scan
    order: its source's time, its order within that time, then the source and
    the piece. Only the original characters whose fold differs are kept
    (`case_map`), enough to recover the exact original bytes of a match."""

    __tablename__ = "session_search_chunks"
    __table_args__ = (
        Index(
            "ix_session_search_chunks_scan",
            "session_id",
            "sort_us",
            "sort_order",
            "source_id",
            "ordinal",
        ),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_sessions.id", ondelete="CASCADE")
    )
    source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("session_search_sources.id", ondelete="CASCADE"),
        index=True,
    )
    # The source's occurred_at in microseconds since the epoch, and its order
    # among sources at the same time.
    sort_us: Mapped[int] = mapped_column(BigInteger)
    sort_order: Mapped[int] = mapped_column(BigInteger)
    ordinal: Mapped[int] = mapped_column(Integer)
    # A dotted path made of the event's own member names: unbounded.
    field: Mapped[str] = mapped_column(Text)
    channel: Mapped[str | None] = mapped_column(String(32), nullable=True)
    segment_byte_start: Mapped[int] = mapped_column(BigInteger)
    segment_byte_end: Mapped[int] = mapped_column(BigInteger)
    byte_start: Mapped[int] = mapped_column(BigInteger)
    owned_chars: Mapped[int] = mapped_column(Integer)
    owned_bytes: Mapped[int] = mapped_column(Integer)
    folded_text: Mapped[str] = mapped_column(Text)
    case_map: Mapped[str | None] = mapped_column(Text, nullable=True)
