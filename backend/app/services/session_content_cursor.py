# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import base64
import binascii
import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from app.core.time import as_utc
from app.exceptions import ValidationError

ContentPosition = tuple[datetime, int, uuid.UUID]
CursorPurpose = Literal["earlier", "later", "refresh"]
WindowOrigin = Literal["latest", "beginning"]
MAX_WINDOW_CURSOR_LENGTH = 512
_UTC_MICROSECONDS = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z")


def _position_json(position: ContentPosition) -> list:
    at, order, row_id = position
    return [
        as_utc(at)
        .astimezone(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z"),
        order,
        str(row_id),
    ]


def _read_position(value: object) -> ContentPosition:
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError
    at, order, row_id = value
    if not isinstance(at, str) or not _UTC_MICROSECONDS.fullmatch(at):
        raise ValueError
    if type(order) is not int or not -(1 << 63) <= order < (1 << 63):
        raise ValueError
    if not isinstance(row_id, str):
        raise ValueError
    parsed_id = uuid.UUID(row_id)
    if str(parsed_id) != row_id:
        raise ValueError
    return datetime.fromisoformat(at), order, parsed_id


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError
        value[key] = item
    return value


@dataclass(frozen=True)
class ContentWindowCursor:
    session_id: uuid.UUID
    purpose: CursorPurpose
    boundary: ContentPosition | None = None
    lower: ContentPosition | None = None
    upper: ContentPosition | None = None
    origin: WindowOrigin | None = None
    empty_direction: Literal["earlier", "later"] | None = None

    def encode(self) -> str:
        payload = {"v": 1, "s": str(self.session_id), "p": self.purpose}
        if self.boundary is not None:
            payload["b"] = _position_json(self.boundary)
            if self.empty_direction is not None:
                payload["e"] = True
                payload["d"] = self.empty_direction
        elif self.origin is not None:
            payload["o"] = self.origin
        else:
            payload["l"] = _position_json(self.lower)
            payload["h"] = _position_json(self.upper)
        raw = json.dumps(payload, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    @classmethod
    def decode(
        cls, cursor: str, session_id: uuid.UUID, purpose: CursorPurpose
    ) -> "ContentWindowCursor":
        # Scope and purpose prevent accidental replay; an unsigned cursor never
        # grants authority. The service checks current ownership on every read.
        try:
            if len(cursor) > MAX_WINDOW_CURSOR_LENGTH or not re.fullmatch(
                r"[A-Za-z0-9_-]+", cursor
            ):
                raise ValueError
            raw = base64.b64decode(
                cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True
            )
            if base64.urlsafe_b64encode(raw).decode().rstrip("=") != cursor:
                raise ValueError
            payload = json.loads(raw, object_pairs_hook=_unique_object)
            if not isinstance(payload, dict):
                raise ValueError
            if (
                type(payload.get("v")) is not int
                or payload["v"] != 1
                or payload.get("s") != str(session_id)
                or payload.get("p") != purpose
            ):
                raise ValueError
            if purpose in ("earlier", "later"):
                if set(payload) != {"v", "s", "p", "b"}:
                    raise ValueError
                return cls(session_id, purpose, boundary=_read_position(payload["b"]))
            if set(payload) == {"v", "s", "p", "b", "e", "d"}:
                if payload["e"] is not True or payload["d"] not in ("earlier", "later"):
                    raise ValueError
                return cls(
                    session_id,
                    purpose,
                    boundary=_read_position(payload["b"]),
                    empty_direction=payload["d"],
                )
            if set(payload) == {"v", "s", "p", "o"}:
                if payload["o"] not in ("latest", "beginning"):
                    raise ValueError
                return cls(session_id, purpose, origin=payload["o"])
            if set(payload) != {"v", "s", "p", "l", "h"}:
                raise ValueError
            lower, upper = _read_position(payload["l"]), _read_position(payload["h"])
            if lower > upper:
                raise ValueError
            return cls(session_id, purpose, lower=lower, upper=upper)
        except (ValueError, TypeError, UnicodeDecodeError, binascii.Error):
            raise ValidationError("Invalid content window cursor") from None
