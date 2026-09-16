# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""OIDC login business logic: code exchange, token verification, provisioning.

The router stays thin (cookies + redirects); everything that can reject a login
lives here and raises `OidcError`, which the router maps to an opaque redirect
code. Provisioning deliberately reuses Part A's policy helpers so every auth
tier — IAP, trusted proxy, OIDC — answers "who may sign in" the same way.
"""

from __future__ import annotations

import base64
import hashlib
import secrets

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.auth import email_domain_allowed, log_auth_rejected, normalize_email
from app.core.oidc import OidcClient, OidcError
from app.models.user import User


def new_pkce_verifier() -> str:
    return secrets.token_urlsafe(64)


def pkce_challenge(verifier: str) -> str:
    """S256 challenge — the only method worth offering; `plain` defeats PKCE."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


class OidcAuthService:
    """`db` is only needed to resolve/provision a user, so the login and logout
    legs — which never touch the database — may construct this without one."""

    def __init__(self, client: OidcClient, db: AsyncSession | None = None):
        self._db = db
        self._client = client

    async def authorization_url(
        self, *, redirect_uri: str, state: str, nonce: str, code_verifier: str
    ) -> str:
        from urllib.parse import urlencode

        discovery = await self._client.discovery()
        query = urlencode(
            {
                "response_type": "code",
                "client_id": settings.OIDC_CLIENT_ID,
                "redirect_uri": redirect_uri,
                "scope": settings.OIDC_SCOPES,
                "state": state,
                "nonce": nonce,
                "code_challenge": pkce_challenge(code_verifier),
                "code_challenge_method": "S256",
            }
        )
        return f"{discovery.authorization_endpoint}?{query}"

    async def complete_login(
        self, *, code: str, code_verifier: str, redirect_uri: str, nonce: str, path: str
    ) -> User:
        """Exchange the code, verify the ID token, and resolve the local user."""
        id_token = await self._client.exchange_code(
            code=code, code_verifier=code_verifier, redirect_uri=redirect_uri
        )
        claims = await self._client.verify_id_token(id_token, nonce=nonce)
        email = str(claims["email"])
        return await self._provision(email, path=path)

    async def _provision(self, email: str, *, path: str) -> User:
        assert self._db is not None, "provisioning requires a database session"
        # The IdP may assert any casing; identity is the canonical form.
        email = normalize_email(email)
        if not email_domain_allowed(email):
            domain = email.rsplit("@", 1)[-1]
            log_auth_rejected(
                f"email_domain_not_allowed domain={domain}",
                tier="oidc",
                path=path,
                client_ip="idp",
            )
            raise OidcError(
                "Email domain not allowed", error_code="email_domain_not_allowed"
            )

        user = (
            await self._db.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if user:
            return user

        if not settings.AUTH_AUTO_PROVISION:
            log_auth_rejected(
                "user_not_provisioned", tier="oidc", path=path, client_ip="idp"
            )
            raise OidcError(
                "User is not provisioned", error_code="user_not_provisioned"
            )

        user = User(email=email, name=email.split("@")[0].replace(".", " ").title())
        self._db.add(user)
        await self._db.flush()
        return user

    async def end_session_url(self, *, post_logout_redirect_uri: str) -> str | None:
        """The IdP's RP-initiated logout URL, when it advertises one."""
        from urllib.parse import urlencode

        discovery = await self._client.discovery()
        if not discovery.end_session_endpoint:
            return None
        query = urlencode(
            {
                "client_id": settings.OIDC_CLIENT_ID,
                "post_logout_redirect_uri": post_logout_redirect_uri,
            }
        )
        return f"{discovery.end_session_endpoint}?{query}"
