# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute

from app.exceptions import ValidationError


class PrivateRoute(APIRoute):
    """Route class for owner-private capture surfaces.

    Responses are never cached, and request validation errors do not echo the
    input: the global handler would repeat captured prompts, paths or tokens
    back into logs and error trackers.
    """

    cache_control = "no-store"

    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private_handler(request):
            try:
                response = await handler(request)
            except RequestValidationError:
                raise ValidationError("Invalid request") from None
            response.headers["Cache-Control"] = self.cache_control
            return response

        return private_handler


class PrivateContentRoute(PrivateRoute):
    """Captured content and its previews: kept out of shared caches too."""

    cache_control = "private, no-store"
