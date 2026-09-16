# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


@compiles(UUID, "sqlite")
def _uuid_char32_on_sqlite(type_, compiler, **kw):
    # SQLite gives a column typed "UUID" NUMERIC affinity, so a uuid4 whose
    # 32-hex form is all decimal digits is silently coerced to a REAL and
    # crashes the Uuid result processor on read (~1 in 2.7M per uuid4 — the
    # CI "flake" in build f2eb2729). CHAR(32) forces TEXT affinity.
    return "CHAR(32)"


class UUIDMixin:
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, server_default=func.gen_random_uuid()
    )


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())
