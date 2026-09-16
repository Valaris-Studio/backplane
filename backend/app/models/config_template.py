# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timezone

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
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.models.base import Base, TimestampMixin, UUIDMixin

# Loops and pipelines are different runner features that happen to share this
# storage. Kept as VARCHAR + CHECK rather than a native enum: widening the set
# then costs an in-place constraint swap instead of an ALTER TYPE, which is not
# transactional-rollback friendly on PostgreSQL.
CONFIG_TEMPLATE_KINDS = ("loop", "pipeline")


class ConfigTemplate(Base, UUIDMixin, TimestampMixin):
    """A workspace-authored template, carrying its draft and its last publish.

    System templates are code-defined and never live here — this table holds
    only what a workspace wrote, which is why `workspace_id` is NOT NULL.

    Draft and published state are deliberately separate columns rather than
    separate rows: an editor autosaves into `draft_*` continuously, while
    `profile`/`content` change only on publish. Bindings render from the
    published pair, so a half-finished edit can never reach a board.
    `version` 0 means never published, and is what distinguishes a draft-only
    template from v1 without a nullable-integer dance.
    """

    __tablename__ = "config_templates"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('loop', 'pipeline')", name="ck_config_templates_kind"
        ),
        # Scoped by kind as well as workspace: a loop and a pipeline may both
        # be called "coding-loop" without either having to rename.
        UniqueConstraint(
            "workspace_id", "kind", "slug", name="uq_config_templates_scope_slug"
        ),
        Index("ix_config_templates_workspace_kind", "workspace_id", "kind"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(String(16))
    slug: Mapped[str] = mapped_column(String(100))
    name: Mapped[str] = mapped_column(String(255))
    version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # NULL until the first publish — the pair that bindings render from.
    profile: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    content: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    draft_profile: Mapped[dict] = mapped_column(JSON)
    draft_content: Mapped[dict] = mapped_column(JSON)
    # NULL means "no pending rename" — readers fall back to the published
    # `name`. That fallback is why the 095 migration needs no backfill, and it
    # is distinct from "", which would be a rename TO blank.
    draft_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Stamped by the autosave path, not by TimestampMixin's updated_at: a
    # publish also touches the row, and the editor's conflict check needs the
    # last DRAFT write specifically.
    draft_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Where this template came from ({source, slug, version} of the template it
    # was duplicated or imported from) — provenance, not a foreign key, because
    # the origin may be a system template or another workspace's export.
    lineage: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    is_archived: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )


class ConfigTemplateVersion(Base, UUIDMixin):
    """An immutable snapshot of one publish.

    Append-only: a board bound to v3 must keep rendering v3 even after the
    template advances, so these rows are never updated in place.
    """

    __tablename__ = "config_template_versions"
    __table_args__ = (
        UniqueConstraint(
            "template_id",
            "version",
            name="uq_config_template_versions_template_version",
        ),
    )

    template_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("config_templates.id", ondelete="CASCADE"),
        index=True,
    )
    version: Mapped[int] = mapped_column(Integer)
    profile: Mapped[dict] = mapped_column(JSON)
    content: Mapped[dict] = mapped_column(JSON)
    published_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None)
    )
    published_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class BoardLoopTemplateBinding(Base):
    """The one template a board's loop is bound to, plus the slot values it
    was rendered with.

    `board_id` is the primary key: a board runs one loop, so a second row for
    the same board is a bug the database should refuse rather than a state the
    service has to disambiguate.

    `rendered_hash` fingerprints the prompts that were written into
    `boards.loop_config` at bind time. Drift detection compares it against a
    re-render, which is how an operator editing the raw loop config behind the
    binding becomes visible instead of being silently overwritten.
    """

    __tablename__ = "board_loop_template_bindings"

    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("boards.id", ondelete="CASCADE"),
        primary_key=True,
    )
    # {source, slug, id?} — `id` only for workspace templates; system
    # templates are code-defined and have no row to point at.
    template_ref: Mapped[dict] = mapped_column(JSON)
    version: Mapped[int] = mapped_column(Integer)
    slot_values: Mapped[dict] = mapped_column(JSON)
    rendered_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None)
    )
    rendered_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    rendered_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
