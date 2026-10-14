# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events import API_KEY_FIRST_USED
from app.exceptions import ConflictError, ResourceNotFoundError
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


@dataclass(frozen=True)
class ApiKeyStamp:
    api_key_id: uuid.UUID
    user_id: uuid.UUID
    key_name: str
    used_at: datetime
    # Set only for the request whose write moved the key off "never used".
    first_use_workspace_ids: list[uuid.UUID] | None


class ApiKeyService:
    def __init__(self, db: AsyncSession):
        self.repo = ApiKeyRepository(db)

    async def create_key(
        self,
        user_id: uuid.UUID,
        name: str,
        installation_id: uuid.UUID | None = None,
    ) -> tuple[ApiKey, str]:
        raw = KEY_PREFIX + secrets.token_urlsafe(32)
        key_hash = hashlib.sha256(raw.encode()).hexdigest()
        key_prefix = raw[:8]
        api_key = await self.repo.create(
            user_id=user_id,
            name=name,
            key_hash=key_hash,
            key_prefix=key_prefix,
            installation_id=installation_id,
        )
        return api_key, raw

    async def rotate_installation_key(
        self, user_id: uuid.UUID, installation_id: uuid.UUID, name: str
    ) -> tuple[ApiKey, str]:
        """One key per installation: minting replaces whatever it held before.

        The row lock makes a concurrent rotation wait and then replace this
        key; the unique index is the backstop if one still slips past, and the
        device answers that 409 by reading the key that won.
        """
        await self.repo.lock_installation(installation_id)
        await self.repo.delete_for_installation(installation_id)
        try:
            async with self.repo.db.begin_nested():
                return await self.create_key(user_id, name, installation_id)
        except IntegrityError:
            raise ConflictError(
                "Another request replaced this device's agent key; read it again",
                error_code="agent_key_rotation_conflict",
            ) from None

    async def get_installation_key(self, installation_id: uuid.UUID) -> ApiKey | None:
        return await self.repo.latest_for_installation(installation_id)

    async def delete_installation_keys(self, installation_id: uuid.UUID) -> None:
        await self.repo.delete_for_installation(installation_id)

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
        api_key = await self.repo.get_by_key_hash(key_hash)
        # Revoking an installation deletes its keys; this refuses one that
        # survived anyway (defence in depth), on HTTP and WebSocket alike.
        if (
            api_key is not None
            and api_key.installation_id is not None
            and await self.repo.installation_revoked(api_key.installation_id)
        ):
            return None
        return api_key

    async def touch(self, api_key: ApiKey) -> ApiKeyStamp | None:
        """Stamp that `api_key` just authenticated a request, on the caller's session.

        Called from both verify sites (HTTP auth and the WS handshake) while the
        caller's session holds nothing but the key lookup; the caller commits
        the returned stamp at once and then calls `announce`. A session of its
        own would check out a second pooled connection per request (pool_size=3,
        see app/database.py). Usage tracking is telemetry, so no failure in it
        may turn a valid credential into a rejected one: failures are logged and
        reported as "nothing stamped". Returns None when nothing was written.
        """
        now = datetime.now(timezone.utc)
        if not self._needs_touch(api_key, now):
            return None
        user_id = api_key.user_id
        try:
            # The savepoint keeps a failed stamp from aborting the caller's
            # transaction; the loaded key row stays usable either way.
            async with self.repo.db.begin_nested():
                is_first_use = await self.repo.stamp_last_used(
                    api_key.id,
                    now,
                    older_than=now - LAST_USED_REFRESH_INTERVAL,
                    expect_never_used=api_key.last_used_at is None,
                )
                first_use_workspace_ids = (
                    await WorkspaceMemberRepository(
                        self.repo.db
                    ).list_workspace_ids_for_user(user_id)
                    if is_first_use
                    else None
                )
        except Exception:
            logger.exception("api key touch failed key=%s", api_key.id)
            return None
        return ApiKeyStamp(
            api_key_id=api_key.id,
            user_id=user_id,
            key_name=api_key.name,
            used_at=now,
            first_use_workspace_ids=first_use_workspace_ids,
        )

    async def announce(self, stamp: ApiKeyStamp | None) -> None:
        """Publish first use, only after the caller committed the stamp.

        A failure here loses the event permanently and that is DELIBERATE: the
        claim is NOT released back to NULL. The column is the durable signal and
        the event is only a latency optimization — the frontend wizard falls
        back to refetching. Rolling the stamp back would strand an agent that
        makes exactly one call, leaving last_used_at NULL forever.
        """
        if stamp is None or stamp.first_use_workspace_ids is None:
            return
        try:
            await self._publish_first_used(stamp)
        except Exception:
            logger.exception("api key first-use publish failed key=%s", stamp.api_key_id)

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

    async def _publish_first_used(self, stamp: ApiKeyStamp) -> None:
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
            "api_key_id": str(stamp.api_key_id),
            "user_id": str(stamp.user_id),
            "key_name": stamp.key_name,
            "last_used_at": stamp.used_at.isoformat(),
        }
        for workspace_id in stamp.first_use_workspace_ids or []:
            await event_bus.publish(
                event_type=API_KEY_FIRST_USED,
                payload=payload,
                workspace_id=workspace_id,
            )
