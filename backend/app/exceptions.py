# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from typing import Any


class ValarisError(Exception):
    status_code: int = 500
    detail: Any = "Internal server error"
    error_code: str = "internal_error"

    def __init__(
        self,
        detail: Any = None,
        *,
        error_code: str | None = None,
        error_params: dict[str, Any] | None = None,
        context: dict[str, Any] | None = None,
    ):
        self.detail = detail or self.__class__.detail
        self.error_code = error_code or self.__class__.error_code
        self.error_params = dict(error_params or {})
        # Machine-readable extras for clients that need more than the prose
        # message (e.g. the stale-version 409's current/expected pair). Rendered
        # as a sibling top-level key so every error body keeps the same shape.
        self.context = context
        super().__init__(self.detail)


class ResourceNotFoundError(ValarisError):
    status_code = 404
    detail = "Resource not found"
    error_code = "not_found"


class ForbiddenError(ValarisError):
    status_code = 403
    detail = "Access denied"
    error_code = "forbidden"


class InvalidCredentialsError(ValarisError):
    status_code = 401
    detail = "Invalid email or password"
    error_code = "invalid_credentials"


class ConflictError(ValarisError):
    status_code = 409
    detail = "Resource conflict"
    error_code = "conflict"


class BoardFrozenError(ConflictError):
    detail = "Board is frozen — mutations are rejected until it is unfrozen"
    error_code = "board_frozen"


class BadRequestError(ValarisError):
    status_code = 400
    detail = "Bad request"
    error_code = "bad_request"


class PayloadTooLargeError(ValarisError):
    status_code = 413
    detail = "Payload too large"
    error_code = "payload_too_large"


class BadGatewayError(ValarisError):
    status_code = 502
    detail = "Bad gateway"
    error_code = "bad_gateway"


class StorageUnavailableError(ValarisError):
    status_code = 501
    detail = "Object storage is not configured"
    error_code = "storage_unavailable"


class ServiceUnavailableError(ValarisError):
    status_code = 503
    detail = "Service unavailable"
    error_code = "service_unavailable"


class ValidationError(ValarisError):
    status_code = 422
    detail = "Validation error"
    error_code = "validation_error"
