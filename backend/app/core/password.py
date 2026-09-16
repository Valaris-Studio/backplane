# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""argon2id password hashing (locked decision L1, docs/plans/local-auth.md).

The encoded ``$argon2id$…`` string carries its own parameters, so tuning the
hasher later never invalidates stored hashes — ``needs_rehash`` is how old
hashes get transparently upgraded on login.
"""

from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

# Minimum length is the only strength rule (NIST 800-63B): composition
# requirements push users toward `Password1!`, not toward entropy.
MIN_PASSWORD_LENGTH = 12

_hasher = PasswordHasher()

# Verified on the no-credential path so "unknown user / no local password"
# burns the same work as "wrong password" — otherwise the login endpoint
# becomes a user-enumeration timing oracle.
_DUMMY_HASH = _hasher.hash("dummy-value-burned-for-constant-time")


def hash_password(plain: str) -> str:
    return _hasher.hash(plain)


def verify_password(plain: str, stored: str | None) -> bool:
    if stored is None:
        try:
            _hasher.verify(_DUMMY_HASH, plain)
        except VerificationError:
            pass
        return False
    try:
        return _hasher.verify(stored, plain)
    except (VerificationError, InvalidHashError):
        return False


def needs_rehash(stored: str) -> bool:
    return _hasher.check_needs_rehash(stored)
