# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import uuid

import pytest
from sqlalchemy import func, select
from starlette.requests import Request

from app.exceptions import PayloadTooLargeError, ValidationError
from app.models.mcp_invocation import MCPInvocation
from app.routers.mcp_invocation import router
from app.schemas.mcp_invocation import MCPInvocationCreate
from app.services.mcp_invocation import MCPInvocationService

REQUEST_LIMIT = 32 * 1024
TEXT_FIELDS = [
    "tool_name",
    "workspace_slug",
    "arguments_summary",
    "result_summary",
    "error_message",
]


def outcome(**values):
    return {
        "id": str(uuid.uuid4()),
        "tool_name": "synthetic",
        "status": "completed",
        "started_at": "2026-09-24T02:00:00Z",
        "completed_at": "2026-09-24T02:00:01Z",
        "duration_seconds": 1,
        **values,
    }


@pytest.mark.parametrize("chunked", [False, True])
async def test_maximum_receipt_and_exact_request_byte_limit_are_accepted(
    client, chunked
):
    data = outcome(
        tool_name="🧪" * 200,
        workspace_slug="🧪" * 200,
        arguments_summary="🧪" * 200,
        result_summary="🧪" * 500,
        error_message="🧪" * 500,
    )
    encoded = json.dumps(data).encode()
    assert len(encoded) < REQUEST_LIMIT
    encoded += b" " * (REQUEST_LIMIT - len(encoded))

    async def chunks():
        for position in range(0, len(encoded), 1024):
            yield encoded[position : position + 1024]

    response = await client.post(
        "/api/me/mcp-invocations",
        content=chunks() if chunked else encoded,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 200
    assert response.json()["result_summary"] == data["result_summary"]


@pytest.mark.parametrize("chunked", [False, True])
async def test_over_limit_receipt_is_rejected_without_persistence(
    client, db_session, chunked
):
    data = outcome(result_summary="SC04_PRIVATE_OVERSIZE_SENTINEL")
    encoded = json.dumps(data).encode()
    encoded += b" " * (REQUEST_LIMIT + 1 - len(encoded))

    async def chunks():
        for position in range(0, len(encoded), 1024):
            yield encoded[position : position + 1024]

    response = await client.post(
        "/api/me/mcp-invocations",
        content=chunks() if chunked else encoded,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 413
    assert "SC04_PRIVATE" not in response.text
    assert await db_session.scalar(select(func.count()).select_from(MCPInvocation)) == 0


@pytest.mark.parametrize(
    "content_length,expected_reads", [(str(REQUEST_LIMIT + 1), 0), (None, 3), ("1", 3)]
)
async def test_oversize_reader_stops_before_consuming_remaining_body(
    content_length, expected_reads
):
    pieces = [
        b" " * (REQUEST_LIMIT // 2),
        b" " * (REQUEST_LIMIT // 2),
        b"x",
        b"MUST_NOT_READ",
    ]
    reads = 0

    async def receive():
        nonlocal reads
        assert reads < 3, "Oversize reader consumed the rest of the request"
        body = pieces[reads]
        reads += 1
        return {"type": "http.request", "body": body, "more_body": True}

    headers = [(b"content-type", b"application/json")]
    if content_length is not None:
        headers.append((b"content-length", content_length.encode()))
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/me/mcp-invocations",
            "headers": headers,
        },
        receive,
    )
    route = next(route for route in router.routes if "POST" in route.methods)
    with pytest.raises(PayloadTooLargeError):
        await route.get_route_handler()(request)
    assert reads == expected_reads


@pytest.mark.parametrize("field", TEXT_FIELDS)
@pytest.mark.parametrize("invalid", ["\x00", "\ud800"])
async def test_unsupported_text_is_rejected_generically(
    client, db_session, caplog, field, invalid
):
    encoded = json.dumps(
        outcome(**{field: "SC04_PRIVATE_TEXT_SENTINEL" + invalid})
    ).encode()
    response = await client.post(
        "/api/me/mcp-invocations",
        content=encoded,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert "SC04_PRIVATE_TEXT_SENTINEL" not in response.text + caplog.text
    assert await db_session.scalar(select(func.count()).select_from(MCPInvocation)) == 0


@pytest.mark.parametrize("field", TEXT_FIELDS)
@pytest.mark.parametrize("invalid", ["\x00", "\ud800"])
async def test_service_revalidates_postgres_text_before_inserting(
    db_session, test_user, field, invalid
):
    data = MCPInvocationCreate(**outcome()).model_copy(
        update={field: "SC04_PRIVATE_TEXT_SENTINEL" + invalid}
    )
    with pytest.raises(ValidationError) as raised:
        await MCPInvocationService(db_session).record(test_user.id, data)
    assert "SC04_PRIVATE_TEXT_SENTINEL" not in str(raised.value)
    assert await db_session.scalar(select(func.count()).select_from(MCPInvocation)) == 0


async def test_openapi_preserves_receipt_schema_and_documents_byte_limit(client):
    schema = (await client.get("/api/openapi.json")).json()
    operation = schema["paths"]["/api/me/mcp-invocations"]["post"]
    body = operation["requestBody"]
    assert body["content"]["application/json"]["schema"]["$ref"].endswith(
        "/MCPInvocationCreate"
    )
    assert "32768" in body["description"]
    assert operation["x-surface"] == "internal"
