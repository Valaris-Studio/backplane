# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Local auth card 1: argon2id password hashing helpers.

The single most important invariant here: a NULL stored hash must NEVER
verify — users provisioned via OIDC/IAP have no local credential and must
not become passwordless-loginable.
"""

from __future__ import annotations

from app.core.password import hash_password, needs_rehash, verify_password


def test_verify_password_round_trip():
    hashed = hash_password("correct horse battery staple")
    assert verify_password("correct horse battery staple", hashed) is True


def test_verify_password_wrong_password():
    hashed = hash_password("correct horse battery staple")
    assert verify_password("wrong password", hashed) is False


def test_verify_password_null_hash_never_verifies():
    assert verify_password("anything", None) is False


def test_verify_password_null_hash_empty_password_does_not_raise():
    assert verify_password("", None) is False


def test_verify_password_garbage_hash_fails_closed():
    assert verify_password("anything", "not-an-argon2-hash") is False


def test_hash_password_salted_hashes_differ():
    assert hash_password("same password") != hash_password("same password")


def test_hash_password_encodes_argon2id():
    assert hash_password("p").startswith("$argon2id$")


def test_needs_rehash_false_for_fresh_hash():
    assert needs_rehash(hash_password("p")) is False
