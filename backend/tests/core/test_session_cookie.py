# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B3 groundwork: the signed session cookie minted after an OIDC login.

Same itsdangerous pattern as the GitHub OAuth state cookie, with a distinct
salt so a cookie from one context can never be replayed into the other.
"""

from __future__ import annotations

import uuid

import pytest

from app.core.session_cookie import (
    SESSION_COOKIE_NAME,
    SessionInvalid,
    read_session,
    write_session,
)

SIGNING_KEY = "test-signing-key"


def test_roundtrip_preserves_user_id():
    user_id = uuid.uuid4()
    raw = write_session(user_id, signing_key=SIGNING_KEY)
    assert read_session(raw, signing_key=SIGNING_KEY, max_age=3600) == user_id


def test_tampered_cookie_is_rejected():
    raw = write_session(uuid.uuid4(), signing_key=SIGNING_KEY)
    with pytest.raises(SessionInvalid):
        read_session(raw[:-4] + "AAAA", signing_key=SIGNING_KEY, max_age=3600)


def test_cookie_signed_with_another_key_is_rejected():
    raw = write_session(uuid.uuid4(), signing_key="attacker-key")
    with pytest.raises(SessionInvalid):
        read_session(raw, signing_key=SIGNING_KEY, max_age=3600)


def test_expired_cookie_is_rejected():
    raw = write_session(uuid.uuid4(), signing_key=SIGNING_KEY)
    with pytest.raises(SessionInvalid):
        read_session(raw, signing_key=SIGNING_KEY, max_age=-1)


def test_oauth_state_cookie_cannot_be_replayed_as_a_session():
    """Distinct salts keep the two signed-cookie contexts from crossing over."""
    from app.integrations.git.oauth_state import OAuthStatePayload, serialize_state

    foreign = serialize_state(
        OAuthStatePayload(state="n", workspace_slug="w", user_id=str(uuid.uuid4())),
        signing_key=SIGNING_KEY,
    )
    with pytest.raises(SessionInvalid):
        read_session(foreign, signing_key=SIGNING_KEY, max_age=3600)


def test_missing_signing_key_is_rejected_not_silently_unsigned():
    with pytest.raises(SessionInvalid):
        write_session(uuid.uuid4(), signing_key="")


def test_malformed_payload_is_rejected():
    with pytest.raises(SessionInvalid):
        read_session("not-a-cookie", signing_key=SIGNING_KEY, max_age=3600)


def test_cookie_name_is_distinct_from_oauth_state():
    from app.integrations.git.oauth_state import OAUTH_STATE_COOKIE_NAME

    assert SESSION_COOKIE_NAME != OAUTH_STATE_COOKIE_NAME
