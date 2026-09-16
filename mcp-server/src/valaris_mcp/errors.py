# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import functools
import json

import httpx


def handle_api_errors(fn):
    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except httpx.HTTPStatusError as e:
            detail = e.response.text
            error_code = None
            try:
                body = e.response.json()
                detail = body.get("detail", detail)
                error_code = body.get("error_code")
            except Exception:
                pass
            payload = {"error": True, "status": e.response.status_code, "message": detail}
            if error_code is not None:
                payload["error_code"] = error_code
            return json.dumps(payload, indent=2)
        except httpx.ConnectError:
            return json.dumps(
                {"error": True, "message": "Cannot reach the Valaris API. Is the server running?"},
                indent=2,
            )
        except httpx.TimeoutException:
            return json.dumps(
                {"error": True, "message": "Request to Valaris API timed out. Retry the operation."},
                indent=2,
            )
        except httpx.HTTPError as e:
            # Catches all remaining httpx transport errors (read errors, pool
            # exhaustion, protocol violations, etc.)
            return json.dumps(
                {"error": True, "message": f"API transport error: {e}"},
                indent=2,
            )
        except Exception as e:
            return json.dumps(
                {"error": True, "message": f"Unexpected error: {e}"},
                indent=2,
            )

    return wrapper
