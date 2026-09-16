# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Symmetric token vault for OAuth credentials at rest.

LAYER: integrations (provider-agnostic, OAuth, multi-provider).
The legacy single-token path lives in app/services/github_client.py — used by
hot paths (Done-gate, card service) that haven't been migrated yet.

Wrapped by GitConnectionService — never instantiated by routers directly.
"""

from cryptography.fernet import Fernet

from app.integrations.git.exceptions import IntegrationsConfigError


class FernetTokenVault:
    """Encrypts/decrypts OAuth tokens with a single workspace-shared key.

    Stateless. Constructed once per request via DI; the key comes from
    settings.INTEGRATIONS_TOKEN_KEY. An empty key raises on any call —
    we never silently fall back to plaintext storage.
    """

    def __init__(self, key: bytes):
        self._key = key
        # Defer Fernet construction until first use so an empty key fails on
        # encrypt/decrypt (where we can raise IntegrationsConfigError) rather
        # than at import time.
        self._cipher: Fernet | None = None

    def _require_cipher(self) -> Fernet:
        if not self._key:
            raise IntegrationsConfigError(
                "This deployment is not set up to store git credentials yet. "
                "Ask whoever operates your Backplane instance to set the "
                "INTEGRATIONS_TOKEN_KEY environment variable (see "
                "docs/git-credentials.md)."
            )
        if self._cipher is None:
            self._cipher = Fernet(self._key)
        return self._cipher

    def encrypt(self, plaintext: str) -> bytes:
        return self._require_cipher().encrypt(plaintext.encode("utf-8"))

    def decrypt(self, ciphertext: bytes) -> str:
        return self._require_cipher().decrypt(ciphertext).decode("utf-8")
