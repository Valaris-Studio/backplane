# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.auth import may_manage_credentials
from app.core.time import as_utc
from app.exceptions import (
    BadRequestError,
    ConflictError,
    ForbiddenError,
    ResourceNotFoundError,
    ValarisError,
)
from app.models.companion_pairing import CompanionPairing
from app.repositories.companion import CompanionRepository
from app.repositories.companion_pairing import CompanionPairingRepository
from app.schemas.companion_pairing import (
    PairingGrant,
    PairingRequestRead,
    PairingStart,
    PairingStarted,
)
from app.services.companion import CompanionService
from app.services.session_events import Invalidation, installation_updated

PAIRING_TTL = timedelta(minutes=10)
POLL_INTERVAL_SECONDS = 5
# RFC 8628 §6.1: consonants only (no vowels, so no words), no look-alike digits.
USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"
USER_CODE_LENGTH = 8
# 20^8 codes, 5 guesses per user per 10 minutes.
MAX_FAILED_LOOKUPS = 5
FAILED_LOOKUP_WINDOW = timedelta(minutes=10)
VERIFICATION_PATH = "/companion/pair"


class PairingGrantRefused(BadRequestError):
    """An RFC 8628 token-endpoint error. Rendered by the router rather than
    raised through `get_db`, so the poll it records is committed."""

    def __init__(self, error_code: str):
        super().__init__(error_code.replace("_", " "), error_code=error_code)


class PairingCodeNotFound(ResourceNotFoundError):
    """Rendered by the router rather than raised through `get_db`, so the failed
    attempt it records is committed and counts toward the cap."""

    detail = "Pairing code not found"


class PairingAttemptsExceeded(ValarisError):
    status_code = 429
    detail = "Too many pairing codes tried. Wait a few minutes and try again."
    error_code = "rate_limited"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _code_hash(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def normalize_user_code(typed: str) -> str | None:
    """People read the code off a screen: case, dashes and spaces do not matter."""
    code = "".join(typed.split()).replace("-", "").upper()
    if len(code) != USER_CODE_LENGTH or any(c not in USER_CODE_ALPHABET for c in code):
        return None
    return code


def _new_user_code() -> str:
    return "".join(secrets.choice(USER_CODE_ALPHABET) for _ in range(USER_CODE_LENGTH))


def _display_code(code: str) -> str:
    return f"{code[:4]}-{code[4:]}"


def _request_read(pairing: CompanionPairing) -> PairingRequestRead:
    return PairingRequestRead(
        name=pairing.requested_name,
        platform=pairing.platform,
        arch=pairing.arch,
        requested_at=pairing.created_at,
        expires_at=pairing.expires_at,
        state=pairing.state,
    )


class CompanionPairingService:
    """Browser-code device pairing (RFC 8628).

    The device starts a pairing without credentials and polls with its secret
    device_code; a signed-in person approves the short user_code in the browser.
    Approval only records who approved; the device's winning poll creates the
    installation, owned by the approver, and receives its token exactly once.
    """

    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = CompanionPairingRepository(db)

    # --- device side (unauthenticated) --------------------------------------

    async def start(self, data: PairingStart) -> PairingStarted:
        user_code = _new_user_code()
        # A collision among live codes is ~1 in 10^10; retrying costs nothing.
        while await self.repo.user_code_hash_exists(_code_hash(user_code)):
            user_code = _new_user_code()
        device_code = secrets.token_urlsafe(32)
        now = utcnow()
        await self.repo.add(
            CompanionPairing(
                device_code_hash=_code_hash(device_code),
                user_code_hash=_code_hash(user_code),
                requested_name=data.name,
                platform=data.platform,
                arch=data.arch,
                companion_version=data.companion_version,
                state="pending",
                expires_at=now + PAIRING_TTL,
                created_at=now,
            )
        )
        verification_uri = settings.FRONTEND_URL.rstrip("/") + VERIFICATION_PATH
        return PairingStarted(
            device_code=device_code,
            user_code=_display_code(user_code),
            verification_uri=verification_uri,
            # A fragment is never sent to a server, so the code stays out of
            # access logs and Referer headers.
            verification_uri_complete=f"{verification_uri}#code={_display_code(user_code)}",
            interval=POLL_INTERVAL_SECONDS,
            expires_in=int(PAIRING_TTL.total_seconds()),
        )

    async def collect(
        self, device_code: str
    ) -> tuple[PairingGrant, list[Invalidation]]:
        now = utcnow()
        code_hash = _code_hash(device_code)
        pairing = await self.repo.by_device_code_hash(code_hash)
        if pairing is None or not hmac.compare_digest(pairing.device_code_hash, code_hash):
            # Unknown and already-collected codes answer alike.
            raise PairingGrantRefused("expired_token")
        await self._settle_expiry(pairing, now)
        if pairing.state in ("consumed", "expired"):
            raise PairingGrantRefused("expired_token")
        polled_too_fast = pairing.last_polled_at is not None and now - as_utc(
            pairing.last_polled_at
        ) < timedelta(seconds=POLL_INTERVAL_SECONDS)
        pairing.last_polled_at = now
        await self.db.flush()
        if polled_too_fast:
            raise PairingGrantRefused("slow_down")
        if pairing.state == "denied":
            raise PairingGrantRefused("access_denied")
        if pairing.state == "pending":
            raise PairingGrantRefused("authorization_pending")
        # Only the poll that wins this claim creates the installation, so a
        # replayed or concurrent poll can never mint a second one.
        if not await self.repo.claim_approved(pairing.id):
            raise PairingGrantRefused("expired_token")
        installation_id = uuid.uuid4()
        installation, token = await CompanionService(self.db).create_installation(
            pairing.approved_by,
            installation_id,
            pairing.requested_name
            or f"{pairing.platform}-{pairing.arch}-{str(installation_id)[:8]}",
            f"{pairing.platform}/{pairing.arch}",
        )
        pairing = await self.repo.get(pairing.id)
        pairing.installation_id = installation.id
        await self.db.flush()
        workspace_ids = await CompanionRepository(self.db).member_workspace_ids_of(
            installation.owner_id
        )
        return (
            PairingGrant(installation_id=installation.id, device_token=token),
            installation_updated(installation, workspace_ids, "paired"),
        )

    # --- person side (signed in, never an agent key) -------------------------

    async def lookup(self, user_id: uuid.UUID, typed_code: str) -> PairingRequestRead:
        pairing = await self._visible(user_id, typed_code)
        await self._settle_expiry(pairing, utcnow())
        return _request_read(pairing)

    async def approve(self, user_id: uuid.UUID, typed_code: str) -> PairingRequestRead:
        """Record the approval only; the device's next poll creates the
        installation, owned by the approver."""
        now = utcnow()
        pairing = await self._visible(user_id, typed_code)
        await self._settle_expiry(pairing, now)
        if pairing.state in ("approved", "consumed"):
            # Only the approver gets this far (see _visible): a retry is a no-op.
            return _request_read(pairing)
        self._refuse_decided(pairing)
        if not await self.repo.claim_pending(pairing.id, "approved", user_id, now):
            pairing = await self._after_lost_claim(user_id, pairing.id, now)
            if pairing.state in ("approved", "consumed"):
                return _request_read(pairing)
            self._refuse_decided(pairing)
        return _request_read(await self.repo.get(pairing.id))

    async def deny(self, user_id: uuid.UUID, typed_code: str) -> PairingRequestRead:
        now = utcnow()
        pairing = await self._visible(user_id, typed_code)
        await self._settle_expiry(pairing, now)
        if pairing.state == "pending" and await self.repo.claim_pending(
            pairing.id, "denied", None, now
        ):
            return _request_read(await self.repo.get(pairing.id))
        pairing = await self._after_lost_claim(user_id, pairing.id, now)
        if pairing.state == "denied":
            return _request_read(pairing)
        raise ConflictError(
            "This pairing was already decided", error_code=f"pairing_{pairing.state}"
        )

    async def _after_lost_claim(
        self, user_id: uuid.UUID, pairing_id: uuid.UUID, now: datetime
    ) -> CompanionPairing:
        """The pairing as a concurrent decision left it. Approved by someone
        else, it is as invisible to this person as an unknown code."""
        pairing = await self.repo.get(pairing_id)
        if pairing.approved_by not in (None, user_id):
            await self.repo.record_lookup_failure(user_id, now)
            raise PairingCodeNotFound()
        return pairing

    # --- shared ---------------------------------------------------------------

    async def _visible(self, user_id: uuid.UUID, typed_code: str) -> CompanionPairing:
        """The pairing a person may see: any undecided one whose code they hold,
        and approved ones only for their approver. Every miss counts toward a
        per-user cap, so codes cannot be enumerated."""
        if not may_manage_credentials():
            raise ForbiddenError("Agent keys cannot pair companion devices")
        now = utcnow()
        failures = await self.repo.recent_lookup_failures(
            user_id, now - FAILED_LOOKUP_WINDOW
        )
        if failures >= MAX_FAILED_LOOKUPS:
            raise PairingAttemptsExceeded()
        # A malformed code is still hashed and looked up, so a miss costs the
        # same whatever made it one (best effort against timing probes).
        code_hash = _code_hash(normalize_user_code(typed_code) or typed_code)
        pairing = await self.repo.by_user_code_hash(code_hash)
        if (
            pairing is None
            or not hmac.compare_digest(pairing.user_code_hash, code_hash)
            or pairing.approved_by not in (None, user_id)
        ):
            await self.repo.record_lookup_failure(user_id, now)
            raise PairingCodeNotFound()
        return pairing

    @staticmethod
    def _refuse_decided(pairing: CompanionPairing) -> None:
        if pairing.state in ("denied", "expired", "consumed"):
            raise ConflictError(
                "This pairing can no longer be approved",
                error_code=f"pairing_{pairing.state}",
            )

    async def _settle_expiry(self, pairing: CompanionPairing, now: datetime) -> None:
        if pairing.state not in ("pending", "approved") or now < as_utc(
            pairing.expires_at
        ):
            return
        pairing.state = "expired"
        await self.db.flush()
