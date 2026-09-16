# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B1: OIDC discovery + JWKS client and ID-token verification.

A fixture IdP (static discovery + JWKS signed by a throwaway RSA key) is served
through `httpx.MockTransport`, so nothing here touches the network. The signing
key is generated per-test so a leaked fixture key is never a real credential.
"""

from __future__ import annotations

import base64
import json
import time
from typing import Any

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa as crsa
from google.auth import jwt as google_jwt
from google.auth.crypt import rsa as google_rsa

from app.core.oidc import (
    OidcClient,
    OidcError,
)

ISSUER = "https://idp.example/realms/backplane"
CLIENT_ID = "backplane"


def _b64u(value: int) -> str:
    raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


class FixtureIdp:
    """A minimal OIDC provider: one signing key, discovery + JWKS endpoints."""

    def __init__(self, *, issuer: str = ISSUER, kid: str = "key-1"):
        self.issuer = issuer
        self.kid = kid
        self.discovery_hits = 0
        self.jwks_hits = 0
        self._new_key(kid)

    def _new_key(self, kid: str) -> None:
        self.kid = kid
        self._key = crsa.generate_private_key(public_exponent=65537, key_size=2048)
        self._priv_pem = self._key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )

    def rotate_key(self, kid: str) -> None:
        """Replace the signing key — simulates an IdP key rotation."""
        self._new_key(kid)

    @property
    def discovery(self) -> dict[str, Any]:
        return {
            "issuer": self.issuer,
            "authorization_endpoint": f"{self.issuer}/protocol/openid-connect/auth",
            "token_endpoint": f"{self.issuer}/protocol/openid-connect/token",
            "jwks_uri": f"{self.issuer}/protocol/openid-connect/certs",
            "end_session_endpoint": f"{self.issuer}/protocol/openid-connect/logout",
        }

    @property
    def jwks(self) -> dict[str, Any]:
        numbers = self._key.public_key().public_numbers()
        return {
            "keys": [
                {
                    "kty": "RSA",
                    "kid": self.kid,
                    "alg": "RS256",
                    "use": "sig",
                    "n": _b64u(numbers.n),
                    "e": _b64u(numbers.e),
                }
            ]
        }

    def id_token(self, **overrides: Any) -> str:
        now = int(time.time())
        claims: dict[str, Any] = {
            "iss": self.issuer,
            "aud": CLIENT_ID,
            "sub": "user-123",
            "email": "alice@valaris.studio",
            "iat": now,
            "exp": now + 600,
            "nonce": "nonce-abc",
        }
        claims.update(overrides)
        signer = google_rsa.RSASigner.from_string(self._priv_pem, self.kid)
        return google_jwt.encode(signer, claims).decode()  # encode() returns bytes

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/.well-known/openid-configuration"):
            self.discovery_hits += 1
            return self._json(self.discovery)
        if path.endswith("/protocol/openid-connect/certs"):
            self.jwks_hits += 1
            return self._json(self.jwks)
        return httpx.Response(404, content=b"unhandled fixture-idp url")

    @staticmethod
    def _json(payload: dict[str, Any]) -> httpx.Response:
        return httpx.Response(
            200,
            content=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
        )


@pytest.fixture
def idp() -> FixtureIdp:
    return FixtureIdp()


def _client(idp: FixtureIdp, **kwargs: Any) -> OidcClient:
    def factory() -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(idp.handler))

    return OidcClient(
        issuer=idp.issuer,
        client_id=CLIENT_ID,
        client_secret="s3cret",
        http_client_factory=factory,
        **kwargs,
    )


# ── discovery ──


@pytest.mark.asyncio
async def test_discovery_exposes_endpoints(idp):
    client = _client(idp)
    discovery = await client.discovery()
    assert discovery.authorization_endpoint == idp.discovery["authorization_endpoint"]
    assert discovery.token_endpoint == idp.discovery["token_endpoint"]
    assert discovery.end_session_endpoint == idp.discovery["end_session_endpoint"]


@pytest.mark.asyncio
async def test_discovery_is_cached_across_calls(idp):
    client = _client(idp)
    await client.discovery()
    await client.discovery()
    assert idp.discovery_hits == 1


@pytest.mark.asyncio
async def test_discovery_rejects_issuer_mismatch(idp):
    """A discovery doc claiming a different issuer is a misconfigured/hostile IdP."""
    client = _client(idp)
    client._issuer = "https://attacker.example"  # discovery still says idp.example
    with pytest.raises(OidcError):
        await client.discovery()


@pytest.mark.asyncio
async def test_end_session_endpoint_optional(idp):
    discovery = dict(idp.discovery)
    del discovery["end_session_endpoint"]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/.well-known/openid-configuration"):
            return FixtureIdp._json(discovery)
        return idp.handler(request)

    def factory() -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    client = OidcClient(
        issuer=idp.issuer,
        client_id=CLIENT_ID,
        client_secret="s3cret",
        http_client_factory=factory,
    )
    assert (await client.discovery()).end_session_endpoint is None


# ── ID-token verification ──


@pytest.mark.asyncio
async def test_verify_id_token_happy_path(idp):
    client = _client(idp)
    claims = await client.verify_id_token(idp.id_token(), nonce="nonce-abc")
    assert claims["email"] == "alice@valaris.studio"
    assert claims["sub"] == "user-123"


@pytest.mark.asyncio
async def test_verify_rejects_tampered_signature(idp):
    client = _client(idp)
    token = idp.id_token()
    tampered = token[:-6] + ("AAAAAA" if not token.endswith("AAAAAA") else "BBBBBB")
    with pytest.raises(OidcError):
        await client.verify_id_token(tampered, nonce="nonce-abc")


@pytest.mark.asyncio
async def test_verify_rejects_wrong_audience(idp):
    client = _client(idp)
    with pytest.raises(OidcError):
        await client.verify_id_token(
            idp.id_token(aud="someone-else"), nonce="nonce-abc"
        )


@pytest.mark.asyncio
async def test_verify_rejects_wrong_issuer(idp):
    client = _client(idp)
    with pytest.raises(OidcError):
        await client.verify_id_token(
            idp.id_token(iss="https://attacker.example"), nonce="nonce-abc"
        )


@pytest.mark.asyncio
async def test_verify_rejects_expired_token(idp):
    client = _client(idp)
    now = int(time.time())
    with pytest.raises(OidcError):
        await client.verify_id_token(
            idp.id_token(iat=now - 7200, exp=now - 3600), nonce="nonce-abc"
        )


@pytest.mark.asyncio
async def test_verify_rejects_nonce_mismatch(idp):
    """Nonce binding is what stops an ID token replayed from another login."""
    client = _client(idp)
    with pytest.raises(OidcError):
        await client.verify_id_token(idp.id_token(), nonce="a-different-nonce")


@pytest.mark.asyncio
async def test_verify_rejects_token_without_email(idp):
    client = _client(idp)
    token = idp.id_token(email=None)
    with pytest.raises(OidcError):
        await client.verify_id_token(token, nonce="nonce-abc")


# ── JWKS caching + rotation ──


@pytest.mark.asyncio
async def test_jwks_cached_between_verifications(idp):
    client = _client(idp)
    await client.verify_id_token(idp.id_token(), nonce="nonce-abc")
    await client.verify_id_token(idp.id_token(), nonce="nonce-abc")
    assert idp.jwks_hits == 1


@pytest.mark.asyncio
async def test_unknown_kid_triggers_refetch(idp):
    """Key rotation must recover without a restart — refetch on kid miss."""
    client = _client(idp)
    await client.verify_id_token(idp.id_token(), nonce="nonce-abc")
    assert idp.jwks_hits == 1

    idp.rotate_key("key-2")
    claims = await client.verify_id_token(idp.id_token(), nonce="nonce-abc")
    assert claims["email"] == "alice@valaris.studio"
    assert idp.jwks_hits == 2


@pytest.mark.asyncio
async def test_kid_miss_refetch_happens_once_per_verification(idp):
    """A token signed by a key the IdP never publishes must not hammer the IdP."""
    client = _client(idp)
    await client.verify_id_token(idp.id_token(), nonce="nonce-abc")
    hits_before = idp.jwks_hits

    stranger = FixtureIdp(issuer=idp.issuer, kid="unknown-key")
    with pytest.raises(OidcError):
        await client.verify_id_token(stranger.id_token(), nonce="nonce-abc")
    assert idp.jwks_hits == hits_before + 1


# ── IdP transport failures ──


@pytest.mark.asyncio
async def test_idp_unreachable_raises_oidc_error(idp):
    def factory() -> httpx.AsyncClient:
        def boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("idp down")

        return httpx.AsyncClient(transport=httpx.MockTransport(boom))

    client = OidcClient(
        issuer=idp.issuer,
        client_id=CLIENT_ID,
        client_secret="s3cret",
        http_client_factory=factory,
    )
    with pytest.raises(OidcError):
        await client.discovery()


@pytest.mark.asyncio
async def test_idp_error_status_raises_oidc_error(idp):
    def factory() -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda r: httpx.Response(503, content=b"nope")
            )
        )

    client = OidcClient(
        issuer=idp.issuer,
        client_id=CLIENT_ID,
        client_secret="s3cret",
        http_client_factory=factory,
    )
    with pytest.raises(OidcError):
        await client.discovery()


# ── authorization-code exchange ──


@pytest.mark.asyncio
async def test_exchange_code_posts_pkce_verifier_and_returns_id_token(idp):
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/protocol/openid-connect/token"):
            seen["body"] = request.content.decode()
            seen["auth"] = request.headers.get("authorization")
            return FixtureIdp._json(
                {"id_token": idp.id_token(), "token_type": "Bearer"}
            )
        return idp.handler(request)

    def factory() -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    client = OidcClient(
        issuer=idp.issuer,
        client_id=CLIENT_ID,
        client_secret="s3cret",
        http_client_factory=factory,
    )
    token = await client.exchange_code(
        code="auth-code",
        code_verifier="verifier-xyz",
        redirect_uri="https://app.example/api/auth/oidc/callback",
    )
    # the raw ID token is returned verbatim for the caller to verify
    assert google_jwt.decode(token, verify=False)["email"] == "alice@valaris.studio"
    assert "code=auth-code" in seen["body"]
    assert "code_verifier=verifier-xyz" in seen["body"]
    assert "grant_type=authorization_code" in seen["body"]
    assert seen["auth"], "client credentials must authenticate the token request"


@pytest.mark.asyncio
async def test_exchange_code_without_id_token_raises(idp):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/protocol/openid-connect/token"):
            return FixtureIdp._json({"access_token": "a", "token_type": "Bearer"})
        return idp.handler(request)

    def factory() -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    client = OidcClient(
        issuer=idp.issuer,
        client_id=CLIENT_ID,
        client_secret="s3cret",
        http_client_factory=factory,
    )
    with pytest.raises(OidcError):
        await client.exchange_code(
            code="c", code_verifier="v", redirect_uri="https://app.example/cb"
        )


@pytest.mark.asyncio
async def test_exchange_code_error_never_leaks_upstream_body(idp):
    """Token-endpoint errors must not surface IdP internals to the caller."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/protocol/openid-connect/token"):
            return httpx.Response(400, content=b"client_secret=hunter2 is wrong")
        return idp.handler(request)

    def factory() -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    client = OidcClient(
        issuer=idp.issuer,
        client_id=CLIENT_ID,
        client_secret="s3cret",
        http_client_factory=factory,
    )
    with pytest.raises(OidcError) as exc:
        await client.exchange_code(
            code="c", code_verifier="v", redirect_uri="https://app.example/cb"
        )
    assert "hunter2" not in str(exc.value)
