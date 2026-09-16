# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The signed session cookie minted after a successful OIDC login.

Same itsdangerous approach as the GitHub OAuth state cookie — no sessions
table, no Redis — with a distinct salt so neither cookie can be replayed as
the other. There is no server-side revocation list: signing out clears the
cookie and OIDC_SESSION_TTL_SECONDS bounds how long a stolen one stays useful.
"""

from __future__ import annotations

import uuid
from typing import Any

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from app.exceptions import ValarisError

SESSION_COOKIE_NAME = "backplane_session"
SESSION_SALT = "oidc-session"


class SessionInvalid(ValarisError):
    status_code = 403
    detail = "Session is invalid or expired"
    error_code = "session_invalid"


def _serializer(signing_key: str) -> URLSafeTimedSerializer:
    if not signing_key:
        # Never fall back to an unsigned cookie — that would make the session
        # forgeable by anyone who can set a cookie.
        raise SessionInvalid("Session signing key is not configured")
    return URLSafeTimedSerializer(signing_key, salt=SESSION_SALT)


def write_session(user_id: uuid.UUID, *, signing_key: str) -> str:
    return _serializer(signing_key).dumps({"uid": str(user_id)})


def read_session(raw: str, *, signing_key: str, max_age: int) -> uuid.UUID:
    serializer = _serializer(signing_key)
    try:
        data: Any = serializer.loads(raw, max_age=max_age)
    except SignatureExpired as exc:
        raise SessionInvalid("Session has expired") from exc
    except BadSignature as exc:
        raise SessionInvalid("Session signature is invalid") from exc
    if not isinstance(data, dict) or "uid" not in data:
        raise SessionInvalid("Session payload is malformed")
    try:
        return uuid.UUID(str(data["uid"]))
    except ValueError as exc:
        raise SessionInvalid("Session subject is not a user id") from exc
