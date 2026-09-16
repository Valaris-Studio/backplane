# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Signed, short-lived OAuth state cookie payloads.

The OAuth callback runs without DB lookup of in-flight states — the state
is round-tripped through a signed cookie that the browser holds for the
~10s the user spends on github.com. Using itsdangerous keeps us off Redis
and avoids a DB table; the signing key (settings.OAUTH_STATE_SIGNING_KEY)
is rotation-safe because the cookie TTL is shorter than any plausible
rotation window.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import Any

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from app.exceptions import BadRequestError, ValarisError

OAUTH_STATE_COOKIE_NAME = "valaris_oauth_state"
OAUTH_STATE_MAX_AGE_SECONDS = 600


class OAuthStateConfigError(ValarisError):
    status_code = 503
    detail = "OAuth state signing key not configured"
    error_code = "oauth_state_config_error"


class OAuthStateInvalid(BadRequestError):
    detail = "OAuth state is invalid or expired"
    error_code = "oauth_state_invalid"


@dataclass(frozen=True)
class OAuthStatePayload:
    state: str  # the random nonce echoed back to the provider
    workspace_slug: str
    user_id: str  # str(uuid) — JSON-safe round-trip


def new_state_nonce() -> str:
    return secrets.token_hex(32)


def serialize_state(payload: OAuthStatePayload, *, signing_key: str) -> str:
    if not signing_key:
        raise OAuthStateConfigError()
    serializer = URLSafeTimedSerializer(signing_key, salt="git-oauth-state")
    return serializer.dumps(_payload_dict(payload))


def deserialize_state(
    raw: str, *, signing_key: str, max_age: int = OAUTH_STATE_MAX_AGE_SECONDS
) -> OAuthStatePayload:
    if not signing_key:
        raise OAuthStateConfigError()
    serializer = URLSafeTimedSerializer(signing_key, salt="git-oauth-state")
    try:
        data: Any = serializer.loads(raw, max_age=max_age)
    except SignatureExpired as exc:
        raise OAuthStateInvalid("OAuth state cookie has expired") from exc
    except BadSignature as exc:
        raise OAuthStateInvalid("OAuth state cookie is invalid") from exc
    if not isinstance(data, dict):
        raise OAuthStateInvalid("OAuth state cookie has malformed payload")
    try:
        return OAuthStatePayload(
            state=str(data["state"]),
            workspace_slug=str(data["workspace_slug"]),
            user_id=str(data["user_id"]),
        )
    except KeyError as exc:
        raise OAuthStateInvalid("OAuth state cookie is missing fields") from exc


def _payload_dict(payload: OAuthStatePayload) -> dict[str, str]:
    return {
        "state": payload.state,
        "workspace_slug": payload.workspace_slug,
        "user_id": payload.user_id,
    }
