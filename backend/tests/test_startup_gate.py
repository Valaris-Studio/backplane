# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Production fails closed unless *some* tier can verify who a caller is.

Dev mode trusts a bare header, so shipping that config to production would let
anyone name themselves anyone — `create_app` refuses to start instead.
"""

import pytest

from app.config import settings as app_settings
from app.main import create_app


@pytest.fixture
def production(monkeypatch):
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "")
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", False)
    monkeypatch.setattr(app_settings, "OIDC_ISSUER", "")
    monkeypatch.setattr(app_settings, "LOCAL_AUTH_ENABLED", False)


def test_production_without_any_verifier_refuses_to_start(production):
    with pytest.raises(RuntimeError, match="Refusing to start"):
        create_app()


def test_iap_audience_satisfies_the_gate(production, monkeypatch):
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "/projects/1/x/2")
    assert create_app() is not None


def test_trusted_proxy_satisfies_the_gate(production, monkeypatch):
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", True)
    assert create_app() is not None


def test_oidc_issuer_satisfies_the_gate(production, monkeypatch):
    """OIDC verifies identity itself, so it counts as a verifier (B-D6)."""
    monkeypatch.setattr(app_settings, "OIDC_ISSUER", "https://idp.example")
    assert create_app() is not None


def test_local_auth_alone_satisfies_the_gate(production, monkeypatch):
    """L4: local password auth is the zero-dependency production verifier."""
    monkeypatch.setattr(app_settings, "LOCAL_AUTH_ENABLED", True)
    assert create_app() is not None


def test_local_auth_disabled_still_refuses_to_start(production):
    """The `production` fixture turns every verifier off, local auth included."""
    with pytest.raises(RuntimeError, match="Refusing to start"):
        create_app()


def test_development_starts_without_a_verifier(monkeypatch):
    monkeypatch.setattr(app_settings, "ENV", "development")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "")
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", False)
    monkeypatch.setattr(app_settings, "OIDC_ISSUER", "")
    assert create_app() is not None


# ── Signing key required by any login-capable verifier (b78fd004) ──
#
# LOCAL_AUTH_ENABLED and OIDC_ISSUER both mint session cookies signed with
# OAUTH_STATE_SIGNING_KEY. A fresh self-host with LOCAL_AUTH_ENABLED=true (the
# default) and an unset key starts fine and serves the first-run screen, then
# every login attempt 403s with "Session signing key is not configured" —
# healthy-looking, permanently unusable. IAP needs no signing key at all, so
# it must stay exempt from this check.


def test_local_auth_without_signing_key_refuses_to_start(production, monkeypatch):
    monkeypatch.setattr(app_settings, "LOCAL_AUTH_ENABLED", True)
    monkeypatch.setattr(app_settings, "OAUTH_STATE_SIGNING_KEY", "")

    with pytest.raises(RuntimeError, match="OAUTH_STATE_SIGNING_KEY"):
        create_app()


def test_oidc_without_signing_key_refuses_to_start(production, monkeypatch):
    monkeypatch.setattr(app_settings, "OIDC_ISSUER", "https://idp.example")
    monkeypatch.setattr(app_settings, "OAUTH_STATE_SIGNING_KEY", "")

    with pytest.raises(RuntimeError, match="OAUTH_STATE_SIGNING_KEY"):
        create_app()


def test_signing_key_error_names_the_generate_command(production, monkeypatch):
    monkeypatch.setattr(app_settings, "LOCAL_AUTH_ENABLED", True)
    monkeypatch.setattr(app_settings, "OAUTH_STATE_SIGNING_KEY", "")

    with pytest.raises(RuntimeError, match="openssl rand -hex 32"):
        create_app()


def test_local_auth_with_signing_key_starts(production, monkeypatch):
    monkeypatch.setattr(app_settings, "LOCAL_AUTH_ENABLED", True)
    monkeypatch.setattr(app_settings, "OAUTH_STATE_SIGNING_KEY", "a" * 32)

    assert create_app() is not None


def test_iap_only_without_signing_key_still_starts(production, monkeypatch):
    """IAP verifies identity via Google's signed JWT — it never touches our session cookie."""
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "/projects/1/x/2")
    monkeypatch.setattr(app_settings, "OAUTH_STATE_SIGNING_KEY", "")

    assert create_app() is not None


def test_no_verifier_at_all_refuses_to_start_before_signing_key_check(
    production, monkeypatch
):
    """With nothing configured, the pre-existing no-verifier refusal must fire first."""
    monkeypatch.setattr(app_settings, "OAUTH_STATE_SIGNING_KEY", "")

    with pytest.raises(RuntimeError, match="Refusing to start"):
        create_app()
