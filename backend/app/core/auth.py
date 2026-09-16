# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import functools
import hmac
import logging
import uuid
from collections.abc import Callable
from contextvars import ContextVar

import anyio.to_thread
import requests
from cachecontrol import CacheControl
from fastapi import Depends, Request
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.exceptions import ForbiddenError
from app.models.user import User

IAP_CERTS_URL = "https://www.gstatic.com/iap/verify/public_key"

IAP_JWT_HEADER = "X-Goog-IAP-JWT-Assertion"
# Cloud Run's ingress strips X-Goog-IAP-JWT-Assertion from any request IAP did
# not inject on that same service, so a proxy hop (frontend nginx → backend)
# can never deliver it. nginx re-sends the token under this non-reserved name;
# accepting it is safe because the value is still a Google-signed JWT verified
# against IAP_AUDIENCE — the header name carries no trust either way.
IAP_JWT_FALLBACK_HEADER = "X-IAP-JWT-Assertion"

PROXY_SECRET_HEADER = "X-Backplane-Proxy-Secret"

logger = logging.getLogger(__name__)


def log_auth_rejected(reason: str, *, tier: str, path: str, client_ip: str) -> None:
    """One WARNING per rejection with a machine-greppable reason code.

    Never pass header/token values or full emails in `reason` — the 2026-07-25
    IAP outage took 40 minutes of log forensics because rejections were silent.
    """
    logger.warning(
        "auth rejected tier=%s reason=%s path=%s ip=%s", tier, reason, path, client_ip
    )


def proxy_secret_valid(get_header: Callable[[str, str], str]) -> bool:
    """True when TRUSTED_PROXY_SECRET is unset, or the request carries it."""
    secret = settings.TRUSTED_PROXY_SECRET
    if not secret:
        return True
    presented = get_header(PROXY_SECRET_HEADER, "") or get_header(
        PROXY_SECRET_HEADER.lower(), ""
    )
    return hmac.compare_digest(presented, secret)


def normalize_email(email: str) -> str:
    # Canonical-on-write: every entry point stores and queries the lowercase
    # form, so the hot auth path stays on the plain ix_users_email index and
    # case-duplicate rows (MultipleResultsFound) are structurally impossible.
    return email.strip().lower()


def email_domain_allowed(email: str) -> bool:
    """True when AUTH_ALLOWED_EMAIL_DOMAINS is empty or exactly matches the domain."""
    raw = settings.AUTH_ALLOWED_EMAIL_DOMAINS
    if not raw:
        return True
    allowed = {d.strip().lower() for d in raw.split(",") if d.strip()}
    domain = email.rsplit("@", 1)[-1].lower()
    return domain in allowed


# Set when the request is authenticated via an API key.
# ActivityService reads this to tag activity records with the key name.
current_api_key_name: ContextVar[str | None] = ContextVar(
    "current_api_key_name", default=None
)

# Set when the API key is linked to a registered agent.
current_agent_id: ContextVar[uuid.UUID | None] = ContextVar(
    "current_agent_id", default=None
)

# Shared across requests. CacheControl wraps the session so verify_token's
# cert fetch honors the cache headers IAP_CERTS_URL sends instead of hitting
# Google on every single verification — certs are public keys, the one
# auth-path value docs/caching-policy.md's DO-NOT-CACHE list doesn't cover.
_google_request = google_requests.Request(session=CacheControl(requests.Session()))


def extract_iap_jwt(get_header: Callable[[str, str], str]) -> str:
    """Read the IAP JWT, preferring Google's own header over the proxied copy.

    Takes a getter rather than a Request so the WebSocket path — whose header
    keys are lowercased — can share one definition of which headers to trust.
    """
    for name in (IAP_JWT_HEADER, IAP_JWT_FALLBACK_HEADER):
        token = get_header(name, "") or get_header(name.lower(), "")
        if token:
            return token
    return ""


def forwarded_for_is_trusted(get_header: Callable[[str, str], str]) -> bool:
    """True when a hop we control is guaranteed to have rewritten X-Forwarded-For.

    XFF is client-settable, so trusting it unconditionally would let anyone
    forge the IP in our audit log. It is only trustworthy when the request
    provably came through our own edge: IAP (Google's LB appends the real
    client as the first hop and strips client-supplied copies), or trusted-proxy
    mode where the hop also proved TRUSTED_PROXY_SECRET. With no verifier — or a
    trusted-proxy handshake we cannot check — we fall back to the peer address,
    which is at worst useless rather than actively misleading.
    """
    if settings.IAP_AUDIENCE:
        return True
    if not settings.TRUSTED_PROXY_AUTH:
        return False
    # A configured secret is what distinguishes our proxy from a direct client.
    return bool(settings.TRUSTED_PROXY_SECRET) and proxy_secret_valid(get_header)


def resolve_client_ip(request: Request) -> str:
    """The originating client IP for audit logs, XFF-aware but spoofing-aware.

    Takes the FIRST X-Forwarded-For hop (the original client; later entries are
    intermediate proxies) — but only when `forwarded_for_is_trusted`.
    """
    peer = request.client.host if request.client else "unknown"
    if not forwarded_for_is_trusted(request.headers.get):
        return peer
    forwarded = request.headers.get("X-Forwarded-For", "") or request.headers.get(
        "x-forwarded-for", ""
    )
    first_hop = forwarded.split(",")[0].strip()
    return first_hop or peer


def session_user_id(get_cookie: Callable[[str], str | None]) -> uuid.UUID | None:
    """The user id in a valid OIDC session cookie, or None when there isn't one.

    Returns None only when no cookie is present — a cookie that fails to verify
    raises, because silently falling through to a weaker tier would let an
    attacker downgrade a rejected session into header-based trust.
    """
    from app.core.session_cookie import (
        SESSION_COOKIE_NAME,
        SessionInvalid,
        read_session,
    )

    raw = get_cookie(SESSION_COOKIE_NAME)
    if not raw:
        return None
    try:
        return read_session(
            raw,
            signing_key=settings.OAUTH_STATE_SIGNING_KEY,
            max_age=settings.OIDC_SESSION_TTL_SECONDS,
        )
    except SessionInvalid as exc:
        raise ForbiddenError(
            "Session is invalid or expired", error_code="session_invalid"
        ) from exc


async def _verify_iap_jwt(jwt_token: str, *, audience: str, certs_url: str) -> dict:
    """Runs google-auth's verification off the event loop.

    `id_token.verify_token` is synchronous and — absent a cache hit — makes a
    blocking HTTP call to fetch certs, so calling it inline here would stall
    every other in-flight request. `functools.partial` binds the keyword args
    ahead of the thread hop since `anyio.to_thread.run_sync` forwards
    positional args only. Looked up via the module (`id_token.verify_token`)
    rather than bound earlier so tests patching `app.core.auth.id_token.verify_token`
    still intercept the call.
    """
    verify = functools.partial(
        id_token.verify_token,
        jwt_token,
        _google_request,
        audience=audience,
        certs_url=certs_url,
    )
    return await anyio.to_thread.run_sync(verify)


async def _extract_email_from_iap_jwt(request: Request) -> str:
    jwt_token = extract_iap_jwt(request.headers.get)
    if not jwt_token:
        log_auth_rejected(
            "missing_iap_jwt",
            tier="iap",
            path=request.url.path,
            client_ip=resolve_client_ip(request),
        )
        raise ForbiddenError("Missing IAP JWT token")

    try:
        claims = await _verify_iap_jwt(
            jwt_token, audience=settings.IAP_AUDIENCE, certs_url=IAP_CERTS_URL
        )
    except Exception:
        log_auth_rejected(
            "invalid_iap_jwt",
            tier="iap",
            path=request.url.path,
            client_ip=resolve_client_ip(request),
        )
        raise ForbiddenError("Invalid IAP JWT token")

    email = claims.get("email", "")
    if not email:
        log_auth_rejected(
            "iap_jwt_no_email",
            tier="iap",
            path=request.url.path,
            client_ip=resolve_client_ip(request),
        )
        raise ForbiddenError("No email in IAP JWT claims")
    return email


def extract_email_from_trusted_proxy_header(
    get_header: Callable[[str, str], str],
) -> str:
    """Read the identity header an authenticating proxy set, per TRUSTED_PROXY_AUTH_HEADER.

    Takes a getter rather than a Request so the WebSocket path — whose header
    keys are lowercased — can share one definition of "which header, stripped how".
    """
    header_name = settings.TRUSTED_PROXY_AUTH_HEADER
    email = get_header(header_name, "") or get_header(header_name.lower(), "")
    # IAP prefixes with accounts.google.com:
    return email.removeprefix("accounts.google.com:")


async def get_current_user(
    request: Request, db: AsyncSession = Depends(get_db)
) -> User:
    # API key auth: Bearer vlr_... tokens (prefix distinguishes from IAP OIDC JWTs)
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer vlr_"):
        from app.services.api_key import ApiKeyService

        raw_key = auth_header.removeprefix("Bearer ")
        service = ApiKeyService(db)
        api_key = await service.verify_key(raw_key)
        if not api_key:
            raise ForbiddenError("Invalid API key")
        # Throttled and self-isolating (see ApiKeyService.touch); runs before the
        # agent checks below so a deactivated agent's rejected request still
        # records that the key reached us.
        await service.touch(api_key)
        result = await db.execute(select(User).where(User.id == api_key.user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise ForbiddenError("API key user not found")
        current_api_key_name.set(api_key.name)

        # Look up linked agent for this API key
        from app.models.agents.agent import Agent

        # Bind the identity regardless of is_active: filtering here would make a
        # deactivated agent authenticate as a plain user, silently widening its
        # reach to every workspace its creator belongs to. Deactivation must
        # deny, not unscope.
        agent_result = await db.execute(
            select(Agent).where(Agent.api_key_id == api_key.id)
        )
        agent = agent_result.scalar_one_or_none()
        if agent:
            if not agent.is_active:
                raise ForbiddenError("Agent is deactivated")
            current_agent_id.set(agent.id)

        return user

    path, client_ip = request.url.path, resolve_client_ip(request)

    # OIDC session cookie: outranks IAP/proxy (it is the cheapest verified
    # credential) but never auto-provisions — the user row was created at the
    # callback, so a cookie naming a user who no longer exists is a rejection.
    if not settings.is_development:
        try:
            uid = session_user_id(request.cookies.get)
        except ForbiddenError:
            log_auth_rejected(
                "invalid_session", tier="session", path=path, client_ip=client_ip
            )
            raise
        if uid is not None:
            user = (
                await db.execute(select(User).where(User.id == uid))
            ).scalar_one_or_none()
            if not user:
                log_auth_rejected(
                    "session_user_not_found",
                    tier="session",
                    path=path,
                    client_ip=client_ip,
                )
                raise ForbiddenError(
                    "Session user no longer exists", error_code="session_user_not_found"
                )
            return user

    if settings.is_development:
        tier = "dev"
        email = request.headers.get("X-User-Email", "dev@valaris.dev")
    elif settings.IAP_AUDIENCE:
        tier = "iap"
        email = await _extract_email_from_iap_jwt(request)
    elif settings.TRUSTED_PROXY_AUTH:
        tier = "trusted_proxy"
        if not proxy_secret_valid(request.headers.get):
            log_auth_rejected(
                "invalid_proxy_secret", tier=tier, path=path, client_ip=client_ip
            )
            raise ForbiddenError("Invalid or missing proxy secret")
        email = extract_email_from_trusted_proxy_header(request.headers.get)
    elif settings.LOCAL_AUTH_ENABLED or settings.OIDC_ISSUER:
        # A login path exists (local password auth and/or OIDC); this caller
        # simply didn't present a valid session cookie. Saying "no verifier
        # configured" here would be false and send self-hosters chasing the
        # wrong setting — the fix is signing in, not configuring anything.
        log_auth_rejected("no_session", tier="none", path=path, client_ip=client_ip)
        raise ForbiddenError(
            "Not authenticated. Sign in to obtain a session.",
            error_code="authentication_required",
        )
    else:
        log_auth_rejected("no_verifier", tier="none", path=path, client_ip=client_ip)
        raise ForbiddenError(
            "No authentication verifier configured. Set LOCAL_AUTH_ENABLED=true, "
            "OIDC_ISSUER, IAP_AUDIENCE, or TRUSTED_PROXY_AUTH=true behind an "
            "authenticating proxy."
        )

    if not email:
        log_auth_rejected("no_email", tier=tier, path=path, client_ip=client_ip)
        raise ForbiddenError("No authenticated user")
    email = normalize_email(email)

    if tier != "dev" and not email_domain_allowed(email):
        domain = email.rsplit("@", 1)[-1]
        log_auth_rejected(
            f"email_domain_not_allowed domain={domain}",
            tier=tier,
            path=path,
            client_ip=client_ip,
        )
        raise ForbiddenError("Email domain not allowed")

    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()

    if not user:
        if not settings.AUTH_AUTO_PROVISION:
            log_auth_rejected(
                "user_not_provisioned", tier=tier, path=path, client_ip=client_ip
            )
            raise ForbiddenError("User is not provisioned")
        name = email.split("@")[0].replace(".", " ").title()
        user = User(email=email, name=name)
        db.add(user)
        await db.flush()
        logger.info("auth provisioned user=%s tier=%s", email, tier)

    return user


def forbid_agent_callers(_: User = Depends(get_current_user)) -> None:
    """Refuse agent API keys on routes agents must never drive: self-
    administration, and mutations of the surfaces that govern agents (board
    PATCH/delete, loop templates, skills).

    An agent key resolves to its creating user, and the agent-admin routes
    authorize on `created_by_id` — which is that same user. So an agent could
    widen its own `allowed_workspaces`, reactivate itself, rotate its key, or
    mint a fresh key carrying no agent identity at all. Each defeats workspace
    scoping outright, and the minted key outlives revoking the agent.

    Registered per-route rather than checked in each service: the routes this
    applies to are a deliberate, closed list, and stating it at the route keeps
    the policy where a reader looks for it. Agents keep the surface the runner
    actually uses — reading themselves, heartbeat, executions, workspace work.

    Depends on get_current_user rather than reading the ContextVar directly:
    route-level dependencies resolve before signature parameters, so without
    this the check would run before auth had identified the caller and would
    wave every agent through.
    """
    if current_agent_id.get() is not None:
        raise ForbiddenError("Agent keys cannot perform agent administration")
