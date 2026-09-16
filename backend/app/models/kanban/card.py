# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import CheckConstraint, Date, DateTime, Enum, Float, ForeignKey, Integer, JSON, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDMixin


class CardType(str, enum.Enum):
    task = "task"
    issue = "issue"
    feature = "feature"
    bug = "bug"


class Priority(str, enum.Enum):
    none = "none"
    low = "low"
    medium = "medium"
    high = "high"
    urgent = "urgent"


class ParticipantRole(str, enum.Enum):
    hero = "hero"
    viewer = "viewer"
    stakeholder = "stakeholder"
    helper = "helper"


class CardParticipant(Base):
    __tablename__ = "card_participants"

    card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cards.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    agent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="SET NULL"), nullable=True
    )
    role: Mapped[str] = mapped_column(String(20))
    # Canonical pipeline-role discriminator. The legacy `role` column above
    # carries the display-only hero/helper/etc. enum; `pipeline_role` carries
    # the stage-role name (planner, implementer, reviewer, documentator,
    # rework_mediator, plus any user-defined role). Nullable for back-compat
    # with pre-migration rows — a NULL means "no pipeline role recorded" and
    # role-aware filters short-circuit to "no match".
    pipeline_role: Mapped[str | None] = mapped_column(
        String(64), nullable=True, default=None
    )
    added_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    card: Mapped["Card"] = relationship(back_populates="participants", lazy="raise")
    user: Mapped["User"] = relationship("User", lazy="raise")  # noqa: F821
    agent: Mapped["Agent"] = relationship("Agent", lazy="raise")  # noqa: F821


class CardDependency(Base):
    """A "card N depends on card M" edge.

    DEP-1 (spec note 233e4429 §Part A). Distinct from `parent_card_id`
    (consolidator lineage). Composite PK = natural key + idempotency via
    ON CONFLICT DO NOTHING. CASCADE both sides so deleting a prerequisite
    unblocks dependents.
    """

    __tablename__ = "card_dependencies"
    __table_args__ = (
        CheckConstraint(
            "card_id <> depends_on_card_id",
            name="ck_card_dependencies_no_self",
        ),
    )

    card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cards.id", ondelete="CASCADE"),
        primary_key=True,
    )
    depends_on_card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cards.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id")
    )


class Card(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "cards"

    column_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("columns.id", ondelete="CASCADE"), index=True
    )
    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str] = mapped_column(Text, default="")
    card_type: Mapped[CardType] = mapped_column(Enum(CardType), default=CardType.task)
    priority: Mapped[Priority] = mapped_column(Enum(Priority), default=Priority.none)
    position: Mapped[float] = mapped_column(Float, default=0.0)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str | None] = mapped_column(String(255), nullable=True)
    labels: Mapped[list | None] = mapped_column(JSON, nullable=True, server_default="[]")
    # SWE-AF #2: count of review_verdict notes seen on this card. Never resets;
    # if a human unparks a `needs-advisor` card the counter keeps running.
    review_iterations: Mapped[int] = mapped_column(
        Integer, nullable=True, server_default="0", default=0
    )
    # SWE-AF #2: sliding window of the last 3 feedback hashes (SHA-256). When
    # the window contains >=2 collisions the card is flipped to `needs-advisor`.
    recent_feedback_hashes: Mapped[list | None] = mapped_column(
        JSON, nullable=True, server_default="[]", default=list
    )
    # PAR-3a: links a conflict-resolution consolidator card (created by PAR-3c)
    # back to the original card whose merge failed. NULL for ordinary cards.
    parent_card_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cards.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # UX-3: first-class PR URL + branch. Runner writes these alongside the
    # legacy "---\nBranch: ...\nPR: ..." description footer for one deploy
    # cycle (rolling-deploy safety). Frontend prefers these columns and falls
    # back to footer parsing only for historical rows where they are NULL.
    pr_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    branch_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Cluster I: per-card budget runway (USD). NULL means "no override — use
    # the workspace-global max_budget_usd ceiling". An outsized card can be
    # given more runway from the board without editing the global yaml; the
    # runner's budget-SUSPEND classifier consults it. See
    # budget_cutoff_checkpoint_resume_design.
    budget_usd_override: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Multi-repo boards: which of the board's git_repos this card targets,
    # matched against GitRepo.slug. NULL means "the board's primary/first repo"
    # — preserves single-repo boards (every existing card) bit-for-bit. The
    # scheduler resolves it in _build_bundle; an unknown slug degrades to the
    # primary rather than handing the runner a null repo. See
    # project_consolidation_and_fe_revamp_2026_06_04.
    git_repo_slug: Mapped[str | None] = mapped_column(String(255), nullable=True)

    completion_mode: Mapped[str] = mapped_column(
        String(20), nullable=False, default="source", server_default="source"
    )

    column: Mapped["Column"] = relationship(back_populates="cards", lazy="raise")  # noqa: F821
    creator: Mapped["User"] = relationship("User", foreign_keys=[created_by], lazy="raise")  # noqa: F821
    participants: Mapped[list[CardParticipant]] = relationship(
        back_populates="card", cascade="all, delete-orphan", lazy="raise"
    )
    parent_card: Mapped["Card | None"] = relationship(
        "Card",
        remote_side="Card.id",
        foreign_keys=[parent_card_id],
        back_populates="child_cards",
        lazy="raise",
    )
    child_cards: Mapped[list["Card"]] = relationship(
        "Card",
        back_populates="parent_card",
        foreign_keys=[parent_card_id],
        lazy="raise",
    )
