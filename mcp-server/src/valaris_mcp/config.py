# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import os
import re
import sys
import uuid
from collections.abc import Mapping
from dataclasses import dataclass


API_BASE_URL = os.environ.get("VALARIS_API_URL", "http://localhost:8000")
AGENT_EMAIL = os.environ.get("VALARIS_AGENT_EMAIL", "agent@valaris.dev")

# Personal API key (vlr_...) — simplest auth for end users.
# When set, sends Authorization: Bearer header and skips IAP/email auth.
# Generate keys from the platform Settings page.
API_KEY = os.environ.get("VALARIS_API_KEY", "")

# Set to the IAP client ID to enable Google IAP authentication.
# When set, the client uses ADC (Application Default Credentials) to obtain
# an OIDC token, and X-User-Email is ignored.
# Supported credential types (auto-detected via google.auth.default()):
#   1. Impersonated SA: `gcloud auth application-default login --impersonate-service-account=SA@...`
#   2. SA key file: GOOGLE_APPLICATION_CREDENTIALS pointing to a JSON key
#   3. GCE metadata server: automatic on Compute Engine / Cloud Run
IAP_AUDIENCE = os.environ.get("VALARIS_IAP_AUDIENCE", "")

DEFAULT_WORKSPACE_SLUG_ENV = "VALARIS_DEFAULT_WORKSPACE_SLUG"
DEFAULT_BOARD_ID_ENV = "VALARIS_DEFAULT_BOARD_ID"
DEFAULT_BOARD_NAME_ENV = "VALARIS_DEFAULT_BOARD_NAME"

# These values land in the handshake instructions an agent reads as guidance.
# The backend stores slugs as unconstrained Str255, so only the shape the
# platform generates is accepted (backend `SLUG_FORMAT`); anything else could
# carry quotes or newlines out of the DEFAULT BOARD section.
_WORKSPACE_SLUG_FORMAT = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MAX_WORKSPACE_SLUG_CHARS = 255
# One line, bounded; rendered as a JSON literal too (server.build_instructions).
MAX_DEFAULT_BOARD_NAME_CHARS = 200


@dataclass(frozen=True)
class DefaultBoard:
    workspace_slug: str
    board_id: str | None
    board_name: str | None


def _warn(message: str) -> None:
    print(f"backplane-mcp: {message}", file=sys.stderr)


def load_default_board(environ: Mapping[str, str] = os.environ) -> DefaultBoard | None:
    """The board a launcher started this server for; a bad id is dropped, never fatal."""
    workspace_slug = environ.get(DEFAULT_WORKSPACE_SLUG_ENV, "").strip()
    raw_board_id = environ.get(DEFAULT_BOARD_ID_ENV, "").strip()
    if workspace_slug and (
        len(workspace_slug) > MAX_WORKSPACE_SLUG_CHARS
        or not _WORKSPACE_SLUG_FORMAT.match(workspace_slug)
    ):
        _warn(f"{DEFAULT_WORKSPACE_SLUG_ENV} ignored: not a workspace slug (lowercase letters, digits, hyphens)")
        return None
    if not workspace_slug:
        if raw_board_id:
            _warn(f"{DEFAULT_BOARD_ID_ENV} ignored: {DEFAULT_WORKSPACE_SLUG_ENV} is not set")
        return None

    board_id: str | None = None
    if raw_board_id:
        try:
            board_id = str(uuid.UUID(raw_board_id))
        except ValueError:
            _warn(f"{DEFAULT_BOARD_ID_ENV} ignored: not a UUID")
    board_name = " ".join(environ.get(DEFAULT_BOARD_NAME_ENV, "").split())
    return DefaultBoard(
        workspace_slug=workspace_slug,
        board_id=board_id,
        board_name=(board_name[:MAX_DEFAULT_BOARD_NAME_CHARS] or None) if board_id else None,
    )
