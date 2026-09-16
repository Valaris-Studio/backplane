# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""UTC-aware datetime serialization for API responses.

DB timestamp columns are naive `TIMESTAMP WITHOUT TIME ZONE` holding UTC values
(Postgres `func.now()` on a UTC instance). Serialized as-is they reach the
frontend without an offset (`"2026-07-19T08:15:00"`), which `new Date()` parses
as LOCAL time — the "just now" bug on hours-old events.

`to_utc_isoformat` is the single source of truth: a naive datetime is ASSUMED to
be UTC (true for every column here) and stamped `+00:00`; an aware datetime is
converted to UTC. `UTCModel` applies it to every datetime field so response
schemas opt in by inheritance rather than per-field annotations.
"""

from datetime import datetime, timezone

from pydantic import BaseModel, field_serializer


def to_utc_isoformat(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


class UTCModel(BaseModel):
    """Base for response schemas: serializes every datetime field as UTC-aware.

    The wildcard serializer only rewrites `datetime` values (checked at runtime),
    so non-datetime fields pass through unchanged. It carries NO return
    annotation on purpose: Pydantic would otherwise use it as every field's
    serialization JSON schema, erasing the field types from the OpenAPI spec.
    """

    @field_serializer("*", when_used="json", check_fields=False)
    def _serialize_datetimes_as_utc(self, value: object):
        if isinstance(value, datetime):
            return to_utc_isoformat(value)
        return value
