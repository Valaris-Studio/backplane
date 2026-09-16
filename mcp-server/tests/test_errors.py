# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import httpx
import pytest

from valaris_mcp.errors import handle_api_errors


@handle_api_errors
async def _ok():
    return "success"


@handle_api_errors
async def _http_error_json():
    resp = httpx.Response(404, json={"detail": "Board not found"}, request=httpx.Request("GET", "http://test"))
    raise httpx.HTTPStatusError("Not Found", request=resp.request, response=resp)


@handle_api_errors
async def _http_error_plain():
    resp = httpx.Response(500, text="Internal Server Error", request=httpx.Request("GET", "http://test"))
    raise httpx.HTTPStatusError("Server Error", request=resp.request, response=resp)


@handle_api_errors
async def _connect_error():
    raise httpx.ConnectError("Connection refused")


@handle_api_errors
async def _timeout_error():
    raise httpx.ReadTimeout("timed out")


@handle_api_errors
async def _transport_error():
    raise httpx.ReadError("connection reset")


@handle_api_errors
async def _unexpected_error():
    raise ValueError("unexpected")


@pytest.mark.anyio
async def test_success_passes_through():
    assert await _ok() == "success"


@pytest.mark.anyio
async def test_http_error_extracts_json_detail():
    result = json.loads(await _http_error_json())
    assert result["error"] is True
    assert result["status"] == 404
    assert result["message"] == "Board not found"


@pytest.mark.anyio
async def test_http_error_falls_back_to_text():
    result = json.loads(await _http_error_plain())
    assert result["error"] is True
    assert result["status"] == 500
    assert "Internal Server Error" in result["message"]


@pytest.mark.anyio
async def test_connect_error_returns_friendly_message():
    result = json.loads(await _connect_error())
    assert result["error"] is True
    assert "Cannot reach" in result["message"]


@pytest.mark.anyio
async def test_timeout_error_returns_retry_message():
    result = json.loads(await _timeout_error())
    assert result["error"] is True
    assert "timed out" in result["message"]


@pytest.mark.anyio
async def test_transport_error_returns_structured_json():
    result = json.loads(await _transport_error())
    assert result["error"] is True
    assert "transport error" in result["message"]


@pytest.mark.anyio
async def test_unexpected_error_returns_structured_json():
    result = json.loads(await _unexpected_error())
    assert result["error"] is True
    assert "unexpected" in result["message"]
