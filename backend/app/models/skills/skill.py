# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    true,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.models.base import Base, TimestampMixin, UUIDMixin


class SkillVersionStatus(str, enum.Enum):
    """Service-layer vocabulary for `SkillVersion.status`.

    The column stays VARCHAR + CHECK rather than a native enum: widening the
    set later costs an in-place constraint swap instead of an ALTER TYPE,
    which is not transactional-rollback friendly on PostgreSQL.
    """

    draft = "draft"
    proposed = "proposed"
    published = "published"
    rejected = "rejected"


SKILL_VERSION_STATUSES = tuple(s.value for s in SkillVersionStatus)


class Skill(Base, UUIDMixin, TimestampMixin):
    """A workspace-scoped SKILL.md bundle identity.

    The registry stores bundles verbatim (open standard — Backplane defines no
    frontmatter keys of its own) and only answers "which skills, which
    version"; it never executes, renders, or interprets them. `name` and
    `description` mirror the root SKILL.md frontmatter, which is authoritative.
    """

    __tablename__ = "skills"
    __table_args__ = (
        UniqueConstraint("workspace_id", "slug", name="uq_skills_workspace_slug"),
        Index("ix_skills_workspace", "workspace_id"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    slug: Mapped[str] = mapped_column(String(255))
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    # NULL until the first publish — what an unpinned binding resolves to.
    latest_published_version: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    # Provenance for catalog copies ("catalog:{id}@{version}"), not a foreign
    # key — after activation the workspace copy is independent.
    origin: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Soft-archive (house rule: skills are never hard-deleted). Set = hidden
    # from the default listing and closed to NEW attachment points; existing
    # bindings, detail, and history keep working.
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    archived_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # passive_deletes: the DB CASCADE owns removal, so a delete never
    # force-loads this lazy="raise" collection during flush.
    versions: Mapped[list["SkillVersion"]] = relationship(
        "SkillVersion",
        lazy="raise",
        order_by="SkillVersion.version",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class SkillVersion(Base, UUIDMixin, TimestampMixin):
    """An immutable snapshot of a skill's files at one version number."""

    __tablename__ = "skill_versions"
    __table_args__ = (
        UniqueConstraint("skill_id", "version", name="uq_skill_versions_skill_version"),
        CheckConstraint(
            "status IN ('draft', 'proposed', 'published', 'rejected')",
            name="ck_skill_versions_status",
        ),
    )

    skill_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("skills.id", ondelete="CASCADE"), index=True
    )
    version: Mapped[int] = mapped_column(Integer)
    # The verbatim bundle: [{"path": ..., "content": ...}, ...].
    files: Mapped[list] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(16))
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_by_agent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="SET NULL"), nullable=True
    )
    # Bare UUID, no FK — approvals arrive with the proposals flow (W2) and the
    # reference must survive approval-row cleanup.
    approval_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    content_hash: Mapped[str] = mapped_column(String(64))


class BoardSkill(Base):
    """A "board uses skill" binding.

    Composite PK = natural key + idempotency: a board binds a skill at most
    once, and a second PUT updates the row in place. CASCADE both sides so
    deleting either parent removes the binding.
    """

    __tablename__ = "board_skills"

    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("boards.id", ondelete="CASCADE"),
        primary_key=True,
    )
    skill_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("skills.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    enabled: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=true()
    )
    # NULL = track the skill's latest published version.
    pinned_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # RESERVED for v2 role-scoped bindings — carried, never populated by v1.
    role: Mapped[str | None] = mapped_column(String(64), nullable=True)
    bound_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    bound_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
