# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events import API_KEY_FIRST_USED
from app.database import async_session
from app.exceptions import ResourceNotFoundError
from app.models.api_key import ApiKey
from app.repositories.api_key import ApiKeyRepository
from app.repositories.workspace import WorkspaceMemberRepository

logger = logging.getLogger(__name__)

KEY_PREFIX = "vlr_"

# How stale a stamp must be before a request rewrites it. Every authenticated
# request passes through the touch, and the connection pool is deliberately tiny
# (pool_size=3, see app/database.py) — a write per request would spend it on
# telemetry. An hour is well inside the resolution any "last used" view needs.
LAST_USED_REFRESH_INTERVAL = timedelta(hours=1)


class ApiKeyService:
    def __init__(self, db: AsyncSession):
        self.repo = ApiKeyRepository(db)

    async def create_key(self, user_id: uuid.UUID, name: str) -> tuple[ApiKey, str]:
        raw = KEY_PREFIX + secrets.token_urlsafe(32)
        key_hash = hashlib.sha256(raw.encode()).hexdigest()
        key_prefix = raw[:8]
        api_key = await self.repo.create(
            user_id=user_id,
            name=name,
            key_hash=key_hash,
            key_prefix=key_prefix,
        )
        return api_key, raw

    async def get_key(self, key_id: uuid.UUID) -> ApiKey | None:
        return await self.repo.get_by_id(key_id)

    async def list_keys(self, user_id: uuid.UUID) -> list[ApiKey]:
        return await self.repo.list_by_user(user_id)

    async def delete_key(self, key_id: uuid.UUID, user_id: uuid.UUID) -> None:
        key = await self.repo.get_by_id(key_id)
        if not key or key.user_id != user_id:
            raise ResourceNotFoundError("API key not found")
        await self.repo.delete(key)

    async def verify_key(self, raw_key: str) -> ApiKey | None:
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        return await self.repo.get_by_key_hash(key_hash)

    async def touch(self, api_key: ApiKey) -> None:
        """Record that `api_key` just authenticated a request.

        Called from both verify sites (HTTP auth and the WS handshake) and
        wrapped end-to-end: usage tracking is telemetry, and no failure in it
        may turn a valid credential into a rejected one.
        """
        try:
            now = datetime.now(timezone.utc)
            if not self._needs_touch(api_key, now):
                return
            await self._apply_touch(api_key, now)
        except Exception:
            logger.exception("api key touch failed key=%s", api_key.id)

    @staticmethod
    def _needs_touch(api_key: ApiKey, now: datetime) -> bool:
        """Throttle decided in memory, from the row auth already loaded — no
        extra query, and no write at all on the overwhelmingly common path."""
        last_used = api_key.last_used_at
        if last_used is None:
            return True
        if last_used.tzinfo is None:
            # SQLite (tests, local dev) returns the stamp naive; it was written
            # as UTC, so read it back as UTC rather than comparing across kinds.
            last_used = last_used.replace(tzinfo=timezone.utc)
        return now - last_used >= LAST_USED_REFRESH_INTERVAL

    async def _apply_touch(self, api_key: ApiKey, now: datetime) -> None:
        """Write the stamp on a session of its own, then publish first use.

        Deliberately NOT the request-scoped session: `get_db` rolls back on any
        exception, so a stamp written there would vanish whenever the request
        later 4xx/5xxes — precisely the requests where "did my agent reach the
        API?" matters most.

        `async_session` is read from module globals on each call (never bound to
        self or a default arg), so tests can monkeypatch
        `app.services.api_key.async_session` onto their in-memory engine — the
        same seam `app.routers.events` uses.
        """
        async with async_session() as session:
            repo = ApiKeyRepository(session)
            if api_key.last_used_at is None:
                is_first_use = await repo.claim_first_use(api_key.id, now)
            else:
                is_first_use = False
                await repo.refresh_last_used(
                    api_key.id, now, older_than=now - LAST_USED_REFRESH_INTERVAL
                )
            # Read the fan-out targets while the session is open, so the publish
            # below doesn't hold a pooled connection (pool_size=3) across its
            # network I/O.
            workspace_ids = (
                await WorkspaceMemberRepository(session).list_workspace_ids_for_user(
                    api_key.user_id
                )
                if is_first_use
                else []
            )
            await session.commit()

        # Publish outside the session block, after the stamp is durable. A
        # failure here loses the event permanently and that is DELIBERATE: we do
        # NOT release the claim back to NULL. The column is the durable signal
        # and the event is only a latency optimization — the frontend wizard
        # falls back to refetching. Rolling the stamp back would strand an agent
        # that makes exactly one call, leaving last_used_at NULL forever with no
        # second request to re-trigger it.
        if is_first_use:
            await self._publish_first_used(workspace_ids, api_key, now)

    async def _publish_first_used(
        self, workspace_ids: list[uuid.UUID], api_key: ApiKey, used_at: datetime
    ) -> None:
        """Announce first use into every workspace the key's owner belongs to.

        API keys are not workspace-scoped, but the WS fan-out is: a subscriber
        only ever hears events for the workspace its socket is attached to, and
        we cannot know which one the user is watching. Publishing to all of them
        (filtered per-user on delivery) is what makes the wizard react wherever
        the user happens to be. At most once per key, ever — so the fan-out cost
        is nil.
        """
        # Imported here rather than at module scope: app.core.event_bus pulls in
        # the configured backend at import time, and this module is imported
        # from app.core.auth on every API-key request.
        from app.core.event_bus import event_bus

        payload = {
            "api_key_id": str(api_key.id),
            "user_id": str(api_key.user_id),
            "key_name": api_key.name,
            "last_used_at": used_at.isoformat(),
        }
        for workspace_id in workspace_ids:
            await event_bus.publish(
                event_type=API_KEY_FIRST_USED,
                payload=payload,
                workspace_id=workspace_id,
            )
