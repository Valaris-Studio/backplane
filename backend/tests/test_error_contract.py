# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel, Field

from app.exceptions import ConflictError
from app.main import create_app


async def _request(app, method: str, path: str, **kwargs):
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        return await client.request(method, path, **kwargs)


async def test_valaris_error_preserves_detail_and_exposes_structured_params():
    app = create_app()

    @app.get("/_contract/domain-error")
    async def domain_error():
        raise ConflictError(
            "Workspace 'north' already exists",
            error_code="workspace_name_conflict",
            error_params={"workspace_name": "north"},
        )

    response = await _request(app, "GET", "/_contract/domain-error")

    assert response.status_code == 409
    assert response.json() == {
        "detail": "Workspace 'north' already exists",
        "error_code": "workspace_name_conflict",
        "error_params": {"workspace_name": "north"},
        "context": None,
    }


def test_valaris_error_keeps_existing_empty_detail_fallback():
    assert ConflictError("").detail == ConflictError.detail


async def test_http_exception_promotes_embedded_code_without_changing_detail():
    app = create_app()
    raw_detail = {
        "code": "stale_version",
        "current_version": 8,
        "expected_version": 7,
    }

    @app.get("/_contract/stale-version")
    async def stale_version():
        raise HTTPException(status_code=409, detail=raw_detail)

    response = await _request(app, "GET", "/_contract/stale-version")

    assert response.status_code == 409
    assert response.json() == {
        "detail": raw_detail,
        "error_code": "stale_version",
        "error_params": {"current_version": 8, "expected_version": 7},
        "context": None,
    }


async def test_plain_http_exception_gets_a_stable_status_code():
    app = create_app()

    @app.get("/_contract/oversized-upload")
    async def oversized_upload():
        raise HTTPException(status_code=413, detail="Upload exceeds size limit")

    response = await _request(app, "GET", "/_contract/oversized-upload")

    assert response.status_code == 413
    assert response.json() == {
        "detail": "Upload exceeds size limit",
        "error_code": "payload_too_large",
        "error_params": {},
        "context": None,
    }


class PositiveCountPayload(BaseModel):
    count: int = Field(gt=0)


async def test_request_validation_exposes_localizable_issue_codes_and_raw_detail():
    app = create_app()

    @app.post("/_contract/validated-payload")
    async def validated_payload(payload: PositiveCountPayload):
        return payload

    response = await _request(
        app,
        "POST",
        "/_contract/validated-payload",
        json={"count": 0},
    )

    assert response.status_code == 422
    body = response.json()
    assert body["error_code"] == "request_validation_error"
    assert body["error_params"] == {
        "issues": [
            {
                "field": "body.count",
                "code": "greater_than",
                "params": {"gt": 0},
            }
        ]
    }
    assert body["detail"][0]["type"] == "greater_than"
    assert body["detail"][0]["loc"] == ["body", "count"]
    assert body["detail"][0]["input"] == 0


async def test_framework_404_uses_the_same_error_contract():
    response = await _request(create_app(), "GET", "/_contract/not-a-route")

    assert response.status_code == 404
    assert response.json() == {
        "detail": "Not Found",
        "error_code": "not_found",
        "error_params": {},
        "context": None,
    }
