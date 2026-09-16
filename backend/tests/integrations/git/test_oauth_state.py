# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Unit tests for the signed OAuth state cookie helpers."""

from __future__ import annotations

import time

import pytest

from app.integrations.git.oauth_state import (
    OAuthStateConfigError,
    OAuthStateInvalid,
    OAuthStatePayload,
    deserialize_state,
    new_state_nonce,
    serialize_state,
)


SIGNING_KEY = "test-state-signing-key-xyz"


def _payload() -> OAuthStatePayload:
    return OAuthStatePayload(
        state=new_state_nonce(),
        workspace_slug="default",
        user_id="00000000-0000-0000-0000-000000000000",
    )


def test_serialize_then_deserialize_round_trips():
    payload = _payload()
    cookie = serialize_state(payload, signing_key=SIGNING_KEY)
    decoded = deserialize_state(cookie, signing_key=SIGNING_KEY)
    assert decoded == payload


def test_deserialize_with_wrong_signing_key_raises_invalid():
    cookie = serialize_state(_payload(), signing_key=SIGNING_KEY)
    with pytest.raises(OAuthStateInvalid):
        deserialize_state(cookie, signing_key="totally-different-key")


def test_deserialize_with_tampered_cookie_raises_invalid():
    cookie = serialize_state(_payload(), signing_key=SIGNING_KEY)
    with pytest.raises(OAuthStateInvalid):
        deserialize_state(cookie + "tamper", signing_key=SIGNING_KEY)


def test_serialize_without_signing_key_raises_config_error():
    with pytest.raises(OAuthStateConfigError):
        serialize_state(_payload(), signing_key="")


def test_deserialize_with_expired_cookie_raises_invalid():
    cookie = serialize_state(_payload(), signing_key=SIGNING_KEY)
    # itsdangerous expires when `signature_age > max_age` (strict gt), so a
    # 1s ttl + 2s sleep reliably crosses. The total run cost stays well under
    # the per-test 5s timeout. If sleep cost becomes a concern, this test
    # should be tagged @pytest.mark.slow rather than removed — there's no
    # fast substitute for the actual time-bound behavior.
    time.sleep(2.1)
    with pytest.raises(OAuthStateInvalid):
        deserialize_state(cookie, signing_key=SIGNING_KEY, max_age=1)


def test_new_state_nonce_returns_64_char_hex():
    nonce = new_state_nonce()
    assert len(nonce) == 64
    int(nonce, 16)  # raises if not hex
