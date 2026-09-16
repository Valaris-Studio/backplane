# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import httpx

from valaris_mcp.config import AGENT_EMAIL, API_BASE_URL, API_KEY, IAP_AUDIENCE


class ValarisClient:
    """Async HTTP client wrapping the Valaris REST API."""

    def __init__(self) -> None:
        headers = {}
        if API_KEY:
            headers["Authorization"] = f"Bearer {API_KEY}"
        elif not IAP_AUDIENCE:
            # Dev mode uses X-User-Email; production without IAP uses
            # X-Goog-Authenticated-User-Email (the header IAP would set).
            headers["X-User-Email"] = AGENT_EMAIL
            headers["X-Goog-Authenticated-User-Email"] = AGENT_EMAIL

        self._http = httpx.AsyncClient(
            base_url=API_BASE_URL,
            headers=headers,
            timeout=30.0,
        )

        self._id_token_credentials = None
        if IAP_AUDIENCE and not API_KEY:
            from google.auth.transport.requests import Request

            self._google_request = Request()
            self._setup_iap_credentials()

    def _setup_iap_credentials(self) -> None:
        """Set up IAP credentials using ADC with type-based dispatch."""
        import google.auth
        from google.auth import impersonated_credentials
        from google.oauth2 import service_account

        creds, _ = google.auth.default()

        if isinstance(creds, impersonated_credentials.Credentials):
            self._id_token_credentials = (
                impersonated_credentials.IDTokenCredentials(
                    target_credentials=creds,
                    target_audience=IAP_AUDIENCE,
                )
            )
        elif isinstance(creds, service_account.Credentials):
            self._id_token_credentials = creds.with_target_audience(IAP_AUDIENCE)
        # else: compute engine / unknown — fall back to fetch_id_token in _get_iap_headers

    async def close(self) -> None:
        await self._http.aclose()

    def _get_iap_headers(self) -> dict[str, str]:
        """Fetch a fresh OIDC token for IAP using ADC."""
        if self._id_token_credentials is not None:
            self._id_token_credentials.refresh(self._google_request)
            token = self._id_token_credentials.token
        else:
            from google.oauth2.id_token import fetch_id_token

            token = fetch_id_token(self._google_request, IAP_AUDIENCE)
        return {"Authorization": f"Bearer {token}"}

    async def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        if IAP_AUDIENCE and not API_KEY:
            kwargs.setdefault("headers", {}).update(self._get_iap_headers())
        resp = await self._http.request(method, f"/api{path}", **kwargs)
        resp.raise_for_status()
        return resp

    # -- generic helpers --

    async def get(self, path: str, *, headers: dict[str, str] | None = None, **params) -> dict | list:
        resp = await self._request("GET", path, params=params or None, headers=headers or {})
        return resp.json()

    async def post(self, path: str, body: dict | None = None) -> dict:
        resp = await self._request("POST", path, json=body)
        return resp.json()

    async def patch(self, path: str, body: dict) -> dict:
        resp = await self._request("PATCH", path, json=body)
        return resp.json()

    async def put(self, path: str, body: dict) -> dict:
        resp = await self._request("PUT", path, json=body)
        return resp.json()

    async def delete(self, path: str) -> None:
        await self._request("DELETE", path)

    async def request_raw(self, method: str, path: str, **kwargs) -> httpx.Response:
        """Public escape hatch for callers that need the raw httpx.Response.

        Most tools should use get/post/patch/put/delete which auto-decode
        JSON. Use this only when the response may be empty (e.g., 204) or
        when the status code itself carries semantics the caller needs.
        """
        return await self._request(method, path, **kwargs)

    # -- workspace paths --

    def ws(self, slug: str) -> str:
        return f"/workspaces/{slug}"

    def board(self, slug: str, board_id: str) -> str:
        return f"/workspaces/{slug}/boards/{board_id}"
