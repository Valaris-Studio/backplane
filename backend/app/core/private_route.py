# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from starlette.datastructures import MutableHeaders
from starlette.types import Message, Receive, Scope, Send

from app.exceptions import ValidationError


class PrivateRoute(APIRoute):
    """Route class for owner-private capture surfaces.

    Responses are never cached, and request validation errors do not echo the
    input: the global handler would repeat captured prompts, paths or tokens
    back into logs and error trackers.
    """

    cache_control = "no-store"

    async def handle(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def private_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)["Cache-Control"] = self.cache_control
            await send(message)

        # Exception handlers render inside the route's ASGI app, after the
        # request handler below has raised. Stamp their responses too.
        await super().handle(scope, receive, private_send)

    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private_handler(request):
            try:
                return await handler(request)
            except RequestValidationError:
                raise ValidationError("Invalid request") from None

        return private_handler


class PrivateContentRoute(PrivateRoute):
    """Captured content and its previews: kept out of shared caches too."""

    cache_control = "private, no-store"
