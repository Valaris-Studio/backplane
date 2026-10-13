# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from starlette.types import ASGIApp, Receive, Scope, Send

WEBSOCKET_SCHEMES = {"http": "ws", "https": "wss"}


class ForwardedProtoMiddleware:
    """Take the request scheme — and only the scheme — from X-Forwarded-Proto.

    Cloud Run ends TLS at Google's front end, so the socket is plain http and
    any URL built from the request (a redirect Location) downgraded to http://.

    Uvicorn's own --proxy-headers can't be used for this: it trusts the scheme
    and X-Forwarded-For together, and Cloud Run's peer address isn't a fixed IP
    to allowlist, so it would need `--forwarded-allow-ips=*` — which hands the
    client address to whatever XFF the caller sends (Google's front end appends,
    so the first entry is client-controlled) and lets anyone rotate the IP the
    rate limiter and audit log key on. A forged scheme, by contrast, only
    changes URLs echoed back to the forger, and no auth decision reads it.

    The last entry wins: each proxy appends, so it is the hop nearest us.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            forwarded_scheme = _nearest_forwarded_scheme(scope)
            if forwarded_scheme:
                if scope["type"] == "websocket":
                    forwarded_scheme = WEBSOCKET_SCHEMES[forwarded_scheme]
                scope = {**scope, "scheme": forwarded_scheme}
        await self.app(scope, receive, send)


def _nearest_forwarded_scheme(scope: Scope) -> str | None:
    values = [value for name, value in scope["headers"] if name == b"x-forwarded-proto"]
    if not values:
        return None
    nearest = values[-1].decode("latin-1").rsplit(",", 1)[-1].strip().lower()
    return nearest if nearest in WEBSOCKET_SCHEMES else None
