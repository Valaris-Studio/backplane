# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.database import get_db
from app.models.user import User
from app.exceptions import PayloadTooLargeError, ValidationError
from app.schemas.mcp_invocation import MCPInvocationCreate, MCPInvocationRead
from app.services.mcp_invocation import MCPInvocationService


MAX_INVOCATION_REQUEST_BYTES = 32 * 1024


async def _bounded_request(request: Request) -> Request:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            length = int(content_length)
        except ValueError:
            raise ValidationError("Invalid invocation request") from None
        if length < 0:
            raise ValidationError("Invalid invocation request")
        if length > MAX_INVOCATION_REQUEST_BYTES:
            raise PayloadTooLargeError()
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_INVOCATION_REQUEST_BYTES:
            raise PayloadTooLargeError()
        body.extend(chunk)

    # Replay only the bounded body through FastAPI's normal parser/dependencies;
    # keeping the typed endpoint preserves its generated OpenAPI contract.
    replayed = False

    async def receive():
        nonlocal replayed
        if not replayed:
            replayed = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}
        return await request.receive()

    return Request(request.scope, receive)


class PrivateInvocationRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private_handler(request):
            if request.method == "POST":
                request = await _bounded_request(request)
            try:
                return await handler(request)
            except RequestValidationError:
                raise ValidationError("Invalid invocation request") from None

        return private_handler


router = APIRouter(
    prefix="/api/me/mcp-invocations",
    tags=["mcp-invocations"],
    route_class=PrivateInvocationRoute,
)


@router.post(
    "",
    response_model=MCPInvocationRead,
    openapi_extra={
        "requestBody": {
            "description": f"Maximum encoded request size: {MAX_INVOCATION_REQUEST_BYTES} bytes "
            "(32 KiB), including whitespace. Text must be valid UTF-8 without U+0000."
        }
    },
)
async def record_invocation(
    data: MCPInvocationCreate,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Record one private outcome. An identical authorized retry returns the same row."""
    response.headers["Cache-Control"] = "no-store"
    return await MCPInvocationService(db).record(user.id, data)


@router.get("/{invocation_id}", response_model=MCPInvocationRead)
async def get_invocation(
    invocation_id: uuid.UUID,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    response.headers["Cache-Control"] = "no-store"
    return await MCPInvocationService(db).get(user.id, invocation_id)
