# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

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
WINDOW_SECONDS = 60


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

    def _get_client_key(self, request: Request) -> tuple[str, int]:
        # The login endpoint is always keyed by client IP with its own tight
        # bucket — before any cookie or trusted-header check. A valid session
        # (or API key) must not raise the budget for password guessing.
        if request.method == "POST" and request.url.path == "/api/auth/login":
            from app.core.auth import resolve_client_ip

            return f"login:{resolve_client_ip(request)}", LOGIN_LIMIT

        auth_header = request.headers.get("authorization", "")
        if auth_header.startswith("Bearer vlr_"):
            return f"apikey:{auth_header[:20]}", API_KEY_LIMIT

        # The email headers are spoofable, so only trust them for the authed
        # tier/key where an upstream verifier stands behind them: dev mode (no
        # verifier, but a trusted local deployment), IAP_AUDIENCE set (IAP
        # verifies the header before it reaches us), or TRUSTED_PROXY_AUTH
        # opted in (the fronting proxy authenticated the user — and all users
        # share the proxy's client IP, so IP-keying would throttle the whole
        # instance as one caller). Otherwise a client could rotate
        # x-user-email to claim 300/min and mint a fresh window per request —
        # key on the real client IP with the unauthenticated limit.
        from app.core.auth import (
            forwarded_for_is_trusted,
            proxy_secret_valid,
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

        email_header_is_trusted = (
            settings.is_development
            or bool(settings.IAP_AUDIENCE)
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
        # 60/min bucket. Use the forwarded client where that header is
        # trustworthy (same rule as the audit log — see forwarded_for_is_trusted).
        client_ip = request.client.host if request.client else "unknown"
        if forwarded_for_is_trusted(request.headers.get):
            forwarded = request.headers.get("x-forwarded-for", "")
            client_ip = forwarded.split(",")[0].strip() or client_ip
        return f"ip:{client_ip}", UNAUTHENTICATED_LIMIT

    def _clean_window(self, key: str, now: float) -> list[float]:
        cutoff = now - WINDOW_SECONDS
        self._requests[key] = [t for t in self._requests[key] if t > cutoff]
        return self._requests[key]

    async def dispatch(self, request: Request, call_next) -> Response:
        key, limit = self._get_client_key(request)
        now = time.time()
        window = self._clean_window(key, now)

        remaining = max(0, limit - len(window))

        if remaining == 0:
            return JSONResponse(
                status_code=429,
                content={
                    "detail": "Rate limit exceeded. Try again later.",
                    "error_code": "rate_limited",
                    "error_params": {
                        "limit": limit,
                        "retry_after_seconds": WINDOW_SECONDS,
                    },
                    "context": None,
                },
                headers={
                    "x-ratelimit-limit": str(limit),
                    "x-ratelimit-remaining": "0",
                    "retry-after": str(WINDOW_SECONDS),
                },
            )

        window.append(now)
        response = await call_next(request)
        response.headers["x-ratelimit-limit"] = str(limit)
        response.headers["x-ratelimit-remaining"] = str(max(0, limit - len(window)))
        return response
