# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings

# Conservative default-deny CSP: the JSON API serves no HTML/JS of its own, so
# `default-src 'none'` costs nothing and blocks any accidental inline content.
# `frame-ancestors 'none'` is the modern, header-value equivalent of
# X-Frame-Options: DENY (kept alongside it for older-browser coverage).
_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'"
# One-year HSTS with subdomains; only emitted off-dev so localhost http keeps
# working and browsers don't pin https on a dev origin.
_STRICT_TRANSPORT_SECURITY = "max-age=31536000; includeSubDomains"


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers.setdefault("x-content-type-options", "nosniff")
        response.headers.setdefault("x-frame-options", "DENY")
        response.headers.setdefault("referrer-policy", "no-referrer")
        response.headers.setdefault("content-security-policy", _CONTENT_SECURITY_POLICY)
        if not settings.is_development:
            response.headers.setdefault(
                "strict-transport-security", _STRICT_TRANSPORT_SECURITY
            )
        return response
