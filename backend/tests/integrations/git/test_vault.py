# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest
from cryptography.fernet import Fernet

from app.integrations.git.exceptions import IntegrationsConfigError
from app.integrations.git.vault import FernetTokenVault


def test_vault_round_trip_decrypts_to_original():
    vault = FernetTokenVault(Fernet.generate_key())

    ciphertext = vault.encrypt("ghp_secrettoken_abc123")

    assert vault.decrypt(ciphertext) == "ghp_secrettoken_abc123"


def test_vault_raises_when_key_unconfigured():
    vault = FernetTokenVault(b"")

    with pytest.raises(IntegrationsConfigError):
        vault.encrypt("anything")
    with pytest.raises(IntegrationsConfigError):
        vault.decrypt(b"anything")


def test_vault_encrypts_to_different_ciphertext_each_call():
    # Fernet randomizes IV per call — same plaintext, different ciphertexts.
    vault = FernetTokenVault(Fernet.generate_key())

    first = vault.encrypt("same-token")
    second = vault.encrypt("same-token")

    assert first != second
    assert vault.decrypt(first) == vault.decrypt(second) == "same-token"
