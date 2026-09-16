# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Public read-only signal of which integrations the platform admin has wired.

Frontends use this to disable "Connect GitHub" before the user clicks (and gets
a 503 from /oauth/github/start). No auth required — the response is binary
configured/not-configured per provider, no secrets, no per-tenant data.
"""

from fastapi import APIRouter

from app import config as _config

router = APIRouter(prefix="/api/integrations", tags=["integrations"])


@router.get("/config-status")
async def get_integrations_config_status() -> dict[str, bool]:
    s = _config.settings
    return {
        "github_oauth_configured": bool(
            s.GITHUB_OAUTH_CLIENT_ID
            and s.GITHUB_OAUTH_CLIENT_SECRET
            and s.OAUTH_STATE_SIGNING_KEY
            and s.INTEGRATIONS_TOKEN_KEY
        ),
        # Gates "Add token" the same way the flag above gates "Connect
        # GitHub" — PAT storage needs only the Fernet key, not an OAuth app.
        "token_storage_configured": bool(s.INTEGRATIONS_TOKEN_KEY),
    }
