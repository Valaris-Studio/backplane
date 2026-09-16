# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import enum
import uuid

from sqlalchemy import Enum, Float, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDMixin


class ColumnType(str, enum.Enum):
    backlog = "backlog"
    active = "active"
    review = "review"
    done = "done"
    blocked = "blocked"


class Column(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "columns"

    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(255))
    position: Mapped[float] = mapped_column(Float, default=0.0)
    color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    column_type: Mapped[ColumnType | None] = mapped_column(
        Enum(ColumnType, name="columntype"), nullable=True
    )

    board: Mapped["Board"] = relationship(back_populates="columns", lazy="raise")  # noqa: F821
    cards: Mapped[list["Card"]] = relationship(  # noqa: F821
        back_populates="column", cascade="all, delete-orphan", order_by="Card.position", lazy="raise"
    )
