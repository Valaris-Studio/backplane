# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Generic OIDC discovery, JWKS and ID-token verification.

Verification runs on `google.auth.jwt`, already a dependency for the IAP path,
so a generic IdP needs no new crypto library: JWKS keys are converted from JWK
(n/e) to PEM with `cryptography` and handed to the same verifier that checks
Google's IAP assertions.

Nothing here blocks startup — discovery and JWKS are fetched lazily on first
use and cached in-process, mirroring how IAP_CERTS_URL is handled. An IdP that
is down therefore breaks logins, not the whole service.
"""

from __future__ import annotations

import base64
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from google.auth import jwt as google_jwt

from app.exceptions import ValarisError

DISCOVERY_PATH = "/.well-known/openid-configuration"
DISCOVERY_TTL_SECONDS = 3600
JWKS_TTL_SECONDS = 3600
HTTP_TIMEOUT_SECONDS = 10.0


class OidcError(ValarisError):
    """Any OIDC failure. The message is safe to log, never safe to echo upstream."""

    status_code = 403
    detail = "OIDC authentication failed"
    error_code = "oidc_error"


@dataclass(frozen=True)
class OidcDiscovery:
    issuer: str
    authorization_endpoint: str
    token_endpoint: str
    jwks_uri: str
    end_session_endpoint: str | None


def _jwk_to_pem(jwk: dict[str, Any]) -> bytes:
    def decode_int(value: str) -> int:
        padded = value + "=" * (-len(value) % 4)
        return int.from_bytes(base64.urlsafe_b64decode(padded), "big")

    try:
        numbers = rsa.RSAPublicNumbers(decode_int(jwk["e"]), decode_int(jwk["n"]))
    except (KeyError, ValueError) as exc:
        raise OidcError("Malformed JWKS key") from exc
    return numbers.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )


class OidcClient:
    """Discovery + JWKS + ID-token verification against one IdP.

    `http_client_factory` exists so tests can inject an `httpx.MockTransport`
    — production callers get a plain timeout-bounded AsyncClient.
    """

    def __init__(
        self,
        *,
        issuer: str,
        client_id: str,
        client_secret: str,
        http_client_factory: Callable[[], httpx.AsyncClient] | None = None,
    ):
        self._issuer = issuer.rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._http_client_factory = http_client_factory or self._default_http_client
        self._discovery: OidcDiscovery | None = None
        self._discovery_fetched_at = 0.0
        self._jwks: dict[str, bytes] = {}
        self._jwks_fetched_at = 0.0

    @staticmethod
    def _default_http_client() -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS)

    async def _get_json(self, url: str) -> dict[str, Any]:
        try:
            async with self._http_client_factory() as client:
                response = await client.get(url)
                response.raise_for_status()
                return response.json()
        except httpx.HTTPError as exc:
            # Never surface the upstream body — it can carry client credentials.
            raise OidcError(f"OIDC request to {url} failed") from exc
        except ValueError as exc:
            raise OidcError(f"OIDC response from {url} was not JSON") from exc

    async def discovery(self) -> OidcDiscovery:
        fresh = time.monotonic() - self._discovery_fetched_at < DISCOVERY_TTL_SECONDS
        if self._discovery is not None and fresh:
            return self._discovery

        document = await self._get_json(f"{self._issuer}{DISCOVERY_PATH}")
        # The issuer must match what we were configured with, or a hostile
        # discovery document could point us at an attacker's endpoints.
        if str(document.get("issuer", "")).rstrip("/") != self._issuer:
            raise OidcError("OIDC discovery issuer does not match OIDC_ISSUER")
        try:
            discovery = OidcDiscovery(
                issuer=document["issuer"],
                authorization_endpoint=document["authorization_endpoint"],
                token_endpoint=document["token_endpoint"],
                jwks_uri=document["jwks_uri"],
                end_session_endpoint=document.get("end_session_endpoint"),
            )
        except KeyError as exc:
            raise OidcError(
                "OIDC discovery document is missing required fields"
            ) from exc

        self._discovery = discovery
        self._discovery_fetched_at = time.monotonic()
        return discovery

    async def _fetch_jwks(self) -> dict[str, bytes]:
        jwks_uri = (await self.discovery()).jwks_uri
        document = await self._get_json(jwks_uri)
        keys = {
            str(key["kid"]): _jwk_to_pem(key)
            for key in document.get("keys", [])
            if key.get("kid") and key.get("kty") == "RSA"
        }
        if not keys:
            raise OidcError("OIDC JWKS contained no usable RSA keys")
        self._jwks = keys
        self._jwks_fetched_at = time.monotonic()
        return keys

    async def _certs_for(self, kid: str) -> dict[str, bytes]:
        """JWKS keyed by kid, refetched once when `kid` is unknown (key rotation)."""
        expired = time.monotonic() - self._jwks_fetched_at >= JWKS_TTL_SECONDS
        if not self._jwks or expired:
            return await self._fetch_jwks()
        if kid not in self._jwks:
            return await self._fetch_jwks()
        return self._jwks

    async def verify_id_token(self, token: str, *, nonce: str) -> dict[str, Any]:
        try:
            kid = str(google_jwt.decode_header(token).get("kid", ""))
        except Exception as exc:
            raise OidcError("ID token header is malformed") from exc

        certs = await self._certs_for(kid)
        try:
            claims = google_jwt.decode(token, certs=certs, audience=self._client_id)
        except Exception as exc:
            # Covers bad signature, wrong aud, expired, unknown kid.
            raise OidcError("ID token verification failed") from exc

        if str(claims.get("iss", "")).rstrip("/") != self._issuer:
            raise OidcError("ID token issuer mismatch")
        # Binds the token to *this* login attempt (replay defense).
        if not nonce or claims.get("nonce") != nonce:
            raise OidcError("ID token nonce mismatch")
        if not claims.get("email"):
            raise OidcError("ID token has no email claim")
        return claims

    async def exchange_code(
        self, *, code: str, code_verifier: str, redirect_uri: str
    ) -> str:
        """Trade an authorization code for the raw ID token (verified by the caller)."""
        token_endpoint = (await self.discovery()).token_endpoint
        form = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
            "client_id": self._client_id,
        }
        try:
            async with self._http_client_factory() as client:
                response = await client.post(
                    token_endpoint,
                    data=form,
                    auth=(self._client_id, self._client_secret),
                    headers={"accept": "application/json"},
                )
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPError as exc:
            raise OidcError("OIDC token exchange failed") from exc
        except ValueError as exc:
            raise OidcError("OIDC token response was not JSON") from exc

        id_token = payload.get("id_token")
        if not id_token:
            raise OidcError("OIDC token response contained no id_token")
        return str(id_token)
