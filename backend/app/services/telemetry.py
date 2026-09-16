# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Anonymous instance telemetry — opt-in, minimal, and unable to break the app.

Deliberately OFF by default: a self-hoster who never opens a config file never
phones home. That costs the maintainers accurate install counts and is the
right trade — a default-on ping is the most common reason an otherwise good
open-source release gets a hostile reception on launch day.

What ships when someone opts in is intentionally boring: a derived instance id,
the version, and two coarse counts. No emails, names, workspace slugs, card
content, repo URLs, or IP-identifying data — see `build_payload`, whose test
asserts the absence of exactly those.
"""

from __future__ import annotations

import hashlib
import logging
import platform
import uuid
from collections.abc import Callable

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.user import User
from app.models.workspace import Workspace

logger = logging.getLogger(__name__)

HTTP_TIMEOUT_SECONDS = 5.0

# Namespace keeps derived ids from colliding with unrelated UUIDv5 uses.
_INSTANCE_NAMESPACE = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")


def telemetry_enabled() -> bool:
    return bool(settings.BACKPLANE_TELEMETRY_ENABLED)


def instance_id_for(seed: str) -> str:
    """A stable, one-way instance identifier.

    Stable across restarts so a long-running deployment counts once rather than
    once per boot. Hashed because the natural seed (the database DSN) carries
    credentials and hostnames that must never leave the machine.
    """
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return str(uuid.uuid5(_INSTANCE_NAMESPACE, digest))


async def build_payload(db: AsyncSession) -> dict[str, object]:
    """The entire ping. Adding a field here is a privacy decision — treat it as one."""
    from app import __version__ as backplane_version

    user_count = await db.scalar(select(func.count()).select_from(User)) or 0
    workspace_count = await db.scalar(select(func.count()).select_from(Workspace)) or 0

    return {
        "instance_id": instance_id_for(settings.DATABASE_URL),
        "version": backplane_version,
        "python_version": platform.python_version(),
        "user_count": int(user_count),
        "workspace_count": int(workspace_count),
    }


class TelemetryService:
    def __init__(
        self,
        db: AsyncSession,
        http_client_factory: Callable[[], httpx.AsyncClient] | None = None,
    ):
        self._db = db
        self._http_client_factory = http_client_factory or self._default_client

    @staticmethod
    def _default_client() -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS)

    async def send_ping(self) -> bool:
        """Send one ping. Returns whether it went out; never raises.

        Every failure path is swallowed on purpose: telemetry is the least
        important thing this process does, and must not be able to degrade the
        product for an operator whose network blocks the endpoint.
        """
        if not telemetry_enabled():
            return False
        endpoint = settings.BACKPLANE_TELEMETRY_ENDPOINT
        if not endpoint:
            return False

        try:
            payload = await build_payload(self._db)
            async with self._http_client_factory() as client:
                response = await client.post(endpoint, json=payload)
                response.raise_for_status()
        except Exception:
            logger.debug("telemetry ping failed", exc_info=True)
            return False
        return True
