# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import re
import time
from collections import defaultdict

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from app.config import settings

# Per-minute limits
UNAUTHENTICATED_LIMIT = 60
AUTHENTICATED_LIMIT = 300
API_KEY_LIMIT = 100
# Password attempts get their own, much tighter per-IP budget: the general
# 60/min tier is far too generous for a credential-guessing surface. This is
# the cheap first filter only — the authoritative brute-force defence is the
# DB-backed account lockout in LocalAuthService (per-instance counters cannot
# be trusted across replicas or restarts).
LOGIN_LIMIT = 10
# Browser-code pairing is unauthenticated. Starting one is cheap to abuse
# (each creates a row), so it gets the login-tight budget; polling at the
# 5-second interval is 12/min per device, so 60 leaves room for a few devices
# behind one NAT.
PAIRING_START_LIMIT = 10
PAIRING_POLL_LIMIT = 60
PAIRING_START_PATH = "/api/companion/pairing"
PAIRING_POLL_PATH = "/api/companion/pairing/token"
# A device only mints an agent key when its keychain has none; ten an hour
# per device token is far above that and stops a loop from churning keys.
AGENT_KEY_MINT_LIMIT = 10
AGENT_KEY_MINT_WINDOW_SECONDS = 3600
AGENT_KEY_PATH = "/api/companion/agent-key"
AGENT_KEY_BUCKET = "agent-key:"
# A device's own calls, keyed by its token: at most 8 ingest batches + 4 chunk
# PUTs + 4 finalizes or resumes per 1 s daemon tick, plus slack for status and policy.
DEVICE_LIMIT = 60 * (8 + 4 + 4 + 1)
DEVICE_BUCKET = "device:"
DEVICE_PATH_PREFIX = "/api/companion/"
# Device-tier requests no device route verified (forged or revoked tokens,
# wrong paths), per client IP: a forged prefix would otherwise open a fresh bucket.
DEVICE_REFUSED_BUCKET = "device-refused:"
WINDOW_SECONDS = 60
# Rendering one image-heavy note issues a request per image, so durable media
# reads get their own per-identity bucket instead of eating the API budget.
MEDIA_LIMIT = 600
MEDIA_BUCKET = "media:"
_MEDIA_READ_PATH = re.compile(
    r"^/api/workspaces/[^/]+/(?:media/(?!upload-url$)[^/]+/.+|resources/[^/]+/content)$"
)


# Counter state lives in-process (instance-local dict). On multi-replica
# deploys (Cloud Run scales horizontally), the effective per-client limit
# becomes N × LIMIT where N is the number of running revisions. This is
# documented as acceptable for the current scale: the limits are cheap-by-
# design (300 req/min for an authed user is well below what a misbehaving
# client can burn before any single instance saturates), and the platform
# fronts the API behind IAP + Cloud Armor in production. Switch to a Redis
# sliding window (or a managed quota at the LB) if any of: (a) authed limits
# tighten enough that N× becomes meaningful, (b) per-key abuse becomes a real
# threat model, (c) we need cross-instance fairness for cost-sensitive
# endpoints.
class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp):
        super().__init__(app)
        self._requests: dict[str, list[float]] = defaultdict(list)
        # Device buckets a device route verified. Only a real token gets in,
        # so it grows with enrolled devices, not with forgeries.
        self._verified: set[str] = set()

    async def _resolve_client_key(self, request: Request) -> tuple[str, int]:
        key, limit = self._get_client_key(request)
        # The IAP JWT is checked only when the caller would otherwise land in
        # the IP tier, so login/pairing/API-key traffic never pays for it.
        if key.startswith("ip:") and settings.IAP_AUDIENCE and not settings.is_development:
            from app.core.auth import verified_iap_email

            email = await verified_iap_email(request)
            if email:
                return self._get_client_key(request, verified_iap_email=email)
        return key, limit

    def _get_client_key(
        self, request: Request, verified_iap_email: str | None = None
    ) -> tuple[str, int]:
        key, limit = self._identity_key(request, verified_iap_email)
        # Anonymous callers keep the tight per-IP budget: they are denied
        # anyway, and a bigger bucket would only help a scraper.
        if (
            key.startswith(("user:", "apikey:"))
            and request.method == "GET"
            and _MEDIA_READ_PATH.match(request.url.path)
        ):
            return f"{MEDIA_BUCKET}{key}", MEDIA_LIMIT
        return key, limit

    def _identity_key(
        self, request: Request, verified_iap_email: str | None = None
    ) -> tuple[str, int]:
        # The login endpoint is always keyed by client IP with its own tight
        # bucket — before any cookie or trusted-header check. A valid session
        # (or API key) must not raise the budget for password guessing.
        if request.method == "POST" and request.url.path == "/api/auth/login":
            from app.core.auth import resolve_client_ip

            return f"login:{resolve_client_ip(request)}", LOGIN_LIMIT
        # With the companion off its routes answer 404 like unknown ones, so
        # they must also spend the generic budget: a dedicated bucket's early
        # 429 would reveal them.
        if (
            settings.COMPANION_ENABLED
            and request.method == "POST"
            and request.url.path in (PAIRING_START_PATH, PAIRING_POLL_PATH)
        ):
            from app.core.auth import resolve_client_ip

            if request.url.path == PAIRING_START_PATH:
                return f"pair-start:{resolve_client_ip(request)}", PAIRING_START_LIMIT
            return f"pair-poll:{resolve_client_ip(request)}", PAIRING_POLL_LIMIT

        auth_header = request.headers.get("authorization", "")
        # Only device tokens spend the mint bucket: anything else is refused
        # by the route, and must not use up a device's hourly budget.
        if (
            settings.COMPANION_ENABLED
            and request.method == "POST"
            and request.url.path == AGENT_KEY_PATH
            and auth_header.startswith("Bearer bpc_")
        ):
            return f"{AGENT_KEY_BUCKET}{auth_header[:20]}", AGENT_KEY_MINT_LIMIT
        if (
            settings.COMPANION_ENABLED
            and request.url.path.startswith(DEVICE_PATH_PREFIX)
            and auth_header.startswith("Bearer bpc_")
        ):
            return f"{DEVICE_BUCKET}{auth_header[:20]}", DEVICE_LIMIT
        if auth_header.startswith("Bearer vlr_"):
            return f"apikey:{auth_header[:20]}", API_KEY_LIMIT

        # The email headers are spoofable, so only trust them for the authed
        # tier/key where an upstream verifier stands behind them: dev mode (no
        # verifier, but a trusted local deployment) or TRUSTED_PROXY_AUTH
        # opted in (the fronting proxy authenticated the user — and all users
        # share the proxy's client IP, so IP-keying would throttle the whole
        # instance as one caller). Otherwise a client could rotate
        # x-user-email to claim 300/min and mint a fresh window per request —
        # key on the real client IP with the unauthenticated limit.
        from app.core.auth import (
            proxy_secret_valid,
            resolve_client_ip,
            session_user_id,
        )

        # A signed session cookie is verified, so it earns the authed tier keyed
        # by user id — no header trust required.
        from app.exceptions import ForbiddenError

        try:
            uid = session_user_id(getattr(request, "cookies", {}).get)
        except ForbiddenError:
            uid = None  # invalid cookie: fall through to the IP tier
        if uid is not None:
            return f"user:{uid}", AUTHENTICATED_LIMIT
        # Not IAP_AUDIENCE alone: run.app and the LB's non-IAP paths reach us
        # without IAP, where Google's email header is whatever the caller sent.
        if verified_iap_email:
            return f"user:{verified_iap_email}", AUTHENTICATED_LIMIT

        email_header_is_trusted = (
            settings.is_development
            or (settings.TRUSTED_PROXY_AUTH and proxy_secret_valid(request.headers.get))
        )
        if email_header_is_trusted:
            email = (
                request.headers.get("x-user-email")
                or request.headers.get("x-goog-authenticated-user-email")
                or request.headers.get(settings.TRUSTED_PROXY_AUTH_HEADER.lower())
            )
            if email:
                return f"user:{email}", AUTHENTICATED_LIMIT

        # Behind a proxy every caller arrives with the same peer address, so
        # peer-keying would collapse all unauthenticated traffic into one
        # 60/min bucket. Same client resolution as the audit log.
        return f"ip:{resolve_client_ip(request)}", UNAUTHENTICATED_LIMIT

    @staticmethod
    def _window_seconds(key: str) -> int:
        if key.startswith(AGENT_KEY_BUCKET):
            return AGENT_KEY_MINT_WINDOW_SECONDS
        return WINDOW_SECONDS

    def _clean_window(self, key: str, now: float) -> list[float]:
        cutoff = now - self._window_seconds(key)
        self._requests[key] = [t for t in self._requests[key] if t > cutoff]
        return self._requests[key]

    @staticmethod
    def _limited(limit: int, window_seconds: int) -> JSONResponse:
        return JSONResponse(
            status_code=429,
            content={
                "detail": "Rate limit exceeded. Try again later.",
                "error_code": "rate_limited",
                "error_params": {
                    "limit": limit,
                    "retry_after_seconds": window_seconds,
                },
                "context": None,
            },
            headers={
                "x-ratelimit-limit": str(limit),
                "x-ratelimit-remaining": "0",
                "retry-after": str(window_seconds),
            },
        )

    async def dispatch(self, request: Request, call_next) -> Response:
        key, limit = await self._resolve_client_key(request)
        now = time.time()
        if key.startswith(DEVICE_BUCKET):
            return await self._dispatch_device(request, call_next, key, now)
        window = self._clean_window(key, now)
        window_seconds = self._window_seconds(key)

        remaining = max(0, limit - len(window))

        if remaining == 0:
            return self._limited(limit, window_seconds)

        window.append(now)
        response = await call_next(request)
        response.headers["x-ratelimit-limit"] = str(limit)
        response.headers["x-ratelimit-remaining"] = str(max(0, limit - len(window)))
        return response

    async def _dispatch_device(
        self, request: Request, call_next, key: str, now: float
    ) -> Response:
        """Only a token the device route verified keeps a bucket. Any other
        device-tier request reserves a slot of its IP's refused budget before
        it runs (so a concurrent burst is gated like a sequential one) and
        gets it back only if the route verifies it; while that budget is spent,
        only verified tokens pass."""
        from app.core.auth import resolve_client_ip

        refused_key = f"{DEVICE_REFUSED_BUCKET}{resolve_client_ip(request)}"
        known = key in self._verified
        if not known:
            refused = self._clean_window(refused_key, now)
            if len(refused) >= UNAUTHENTICATED_LIMIT:
                return self._limited(UNAUTHENTICATED_LIMIT, WINDOW_SECONDS)
            refused.append(now)
        window = self._clean_window(key, now)
        if len(window) >= DEVICE_LIMIT:
            if not known:
                _discard(self._requests.get(refused_key), now)
            return self._limited(DEVICE_LIMIT, WINDOW_SECONDS)

        window.append(now)
        response = await call_next(request)
        # The live lists: concurrent requests re-clean windows into new ones.
        if getattr(request.state, "device_verified", False):
            self._verified.add(key)
            if not known:
                _discard(self._requests.get(refused_key), now)
        elif key in self._verified:
            # Revoked, rotated away, or a wrong path: it is refused like any
            # other token from now on, until a route verifies it again. A
            # prefix collision must still not drop the verified bucket.
            self._verified.discard(key)
            self._requests[refused_key].append(now)
            _discard(self._requests.get(key), now)
        else:
            self._requests.pop(key, None)
        response.headers["x-ratelimit-limit"] = str(DEVICE_LIMIT)
        response.headers["x-ratelimit-remaining"] = str(
            max(0, DEVICE_LIMIT - len(window))
        )
        return response


def _discard(window: list[float] | None, timestamp: float) -> None:
    """Take back one request's timestamp from a live window, if still there."""
    if window is not None and timestamp in window:
        window.remove(timestamp)
