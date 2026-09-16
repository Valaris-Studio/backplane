# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import enum
import uuid

from sqlalchemy import BigInteger, Enum, ForeignKey, JSON, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class ResourceType(str, enum.Enum):
    file = "file"
    folder = "folder"


class Resource(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "resources"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    board_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), nullable=True, index=True
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("resources.id"), nullable=True
    )
    resource_type: Mapped[ResourceType] = mapped_column(Enum(ResourceType))
    name: Mapped[str] = mapped_column(String(500))
    gcs_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    mime_type: Mapped[str | None] = mapped_column(String(255), nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    uploaded_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id")
    )
    meta: Mapped[dict] = mapped_column("metadata", JSON, server_default="{}", nullable=False, default=dict)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
