# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from contextvars import ContextVar

current_mcp_invocation_id: ContextVar[uuid.UUID | None] = ContextVar(
    "current_mcp_invocation_id", default=None
)


class MCPInvocationContextMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        values = [
            value
            for key, value in scope.get("headers", [])
            if key.lower() == b"x-backplane-invocation-id"
        ]
        invocation_id = None
        if scope["type"] == "http" and len(values) == 1:
            try:
                invocation_id = uuid.UUID(values[0].decode("ascii"))
            except (ValueError, UnicodeDecodeError):
                pass
        token = current_mcp_invocation_id.set(invocation_id)
        try:
            await self.app(scope, receive, send)
        finally:
            current_mcp_invocation_id.reset(token)
