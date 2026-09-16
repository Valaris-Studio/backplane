# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Local password login business logic (docs/plans/local-auth.md).

`authenticate` answers exactly one question — do these credentials identify a
real user? — and returns None for unknown email, missing local credential,
wrong password, and locked account alike. Callers must not be able to tell
those apart: the distinction only ever reaches operator logs, never the wire.

Lockout (card 7, L7) is DB-backed: the in-process rate limiter is per-instance
(counters multiply across replicas and evaporate on restart), so the account
lockout — the authoritative brute-force layer — lives on the users row.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, insert, literal, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import email_domain_allowed, log_auth_rejected, normalize_email
from app.core.password import hash_password, needs_rehash, verify_password
from app.exceptions import BadRequestError, ForbiddenError
from app.models.user import User

logger = logging.getLogger(__name__)

MAX_FAILED_LOGIN_ATTEMPTS = 5
# Auto-expiring, not admin-unlock-only: anyone who knows an email can trigger
# a lockout (griefing), so the damage must be bounded and self-healing. The
# manual escape hatch is card 8's admin-set-temporary-password.
LOCKOUT_COOLDOWN = timedelta(minutes=15)


def _lockout_active(locked_until: datetime | None, now: datetime) -> bool:
    if locked_until is None:
        return False
    if locked_until.tzinfo is None:
        # SQLite strips tzinfo; stored values are always UTC.
        locked_until = locked_until.replace(tzinfo=UTC)
    return locked_until > now


class LocalAuthService:
    def __init__(self, db: AsyncSession):
        self._db = db

    async def authenticate(
        self, email: str, password: str, *, path: str = "", client_ip: str = ""
    ) -> User | None:
        normalized = normalize_email(email)
        user = (
            await self._db.execute(
                select(User).where(func.lower(User.email) == normalized)
            )
        ).scalar_one_or_none()
        now = datetime.now(UTC)

        if user is not None and _lockout_active(user.locked_until, now):
            # Rejected before any password work, so this path is faster than a
            # normal rejection. Deliberate: the timing can only reveal a
            # lockout to whoever is hammering the account — i.e. the party the
            # lockout already answered by existing. The wire response stays
            # byte-identical to every other failure (no enumeration oracle).
            log_auth_rejected(
                "local_auth_account_locked",
                tier="local",
                path=path,
                client_ip=client_ip,
            )
            return None

        stored = user.password_hash if user else None
        # verify_password burns a dummy verification when `stored` is None, so
        # the rejection branches cost the same wall time.
        if not verify_password(password, stored):
            reason = (
                "local_auth_unknown_email"
                if user is None
                else "local_auth_no_local_credential"
                if stored is None
                else "local_auth_wrong_password"
            )
            if user is not None:
                await self._record_failed_attempt(
                    user, now, path=path, client_ip=client_ip
                )
            log_auth_rejected(reason, tier="local", path=path, client_ip=client_ip)
            return None

        if user.failed_login_attempts or user.locked_until is not None:
            user.failed_login_attempts = 0
            user.locked_until = None
            await self._db.flush()
            await self._db.refresh(user)

        if needs_rehash(stored):
            user.password_hash = hash_password(password)
            await self._db.flush()
            await self._db.refresh(user)
        return user

    async def change_password(
        self,
        user: User,
        current_password: str,
        new_password: str,
        *,
        path: str = "",
        client_ip: str = "",
    ) -> None:
        """Self-service password change: the current password proves identity
        (a stolen session alone must not be enough to take over the account).

        Failures feed the same lockout counters as login — otherwise a
        hijacked session would be an unthrottled oracle for guessing the
        current password — and while locked the check is skipped entirely,
        mirroring `authenticate`. The error is deliberately explicit
        (`current_password_incorrect`, not the uniform login body): the caller
        is already authenticated as this account, so there is nothing to
        enumerate.
        """
        now = datetime.now(UTC)
        if _lockout_active(user.locked_until, now):
            log_auth_rejected(
                "local_auth_account_locked",
                tier="local",
                path=path,
                client_ip=client_ip,
            )
            raise BadRequestError(
                "Current password is incorrect",
                error_code="current_password_incorrect",
            )
        if not verify_password(current_password, user.password_hash):
            await self._record_failed_attempt(user, now, path=path, client_ip=client_ip)
            log_auth_rejected(
                "local_auth_change_password_wrong_current",
                tier="local",
                path=path,
                client_ip=client_ip,
            )
            raise BadRequestError(
                "Current password is incorrect",
                error_code="current_password_incorrect",
            )
        await self._apply_new_password(user, new_password)
        logger.info("local auth password changed user_id=%s", user.id)

    async def grant_initial_password(self, user: User, password: str) -> bool:
        """Give a passwordless account its first local credential. Never
        overwrites an existing one — that is the explicit, audited
        temporary-password path — so retried member-adds stay idempotent."""
        if user.password_hash is not None:
            return False
        await self._apply_new_password(user, password)
        return True

    async def set_temporary_password(self, user: User, password: str) -> None:
        """Overwrite the credential and clear lockout state (the L6 recovery
        path — no SMTP, no reset email). Caller is responsible for
        authorization and for recording the audit trail."""
        await self._apply_new_password(user, password)

    async def _apply_new_password(self, user: User, password: str) -> None:
        user.password_hash = hash_password(password)
        # A user who just (re)proved or was granted identity is not the
        # attacker the lockout counters are tracking.
        user.failed_login_attempts = 0
        user.locked_until = None
        await self._db.flush()
        await self._db.refresh(user)

    async def _record_failed_attempt(
        self, user: User, now: datetime, *, path: str, client_ip: str
    ) -> None:
        # An expired lockout opens a fresh window: count from zero rather than
        # instantly re-locking on the first failure after the cooldown.
        if user.locked_until is not None and not _lockout_active(
            user.locked_until, now
        ):
            user.failed_login_attempts = 0
            user.locked_until = None
        user.failed_login_attempts = (user.failed_login_attempts or 0) + 1
        if user.failed_login_attempts >= MAX_FAILED_LOGIN_ATTEMPTS:
            user.locked_until = now + LOCKOUT_COOLDOWN
            # Distinct code so operators can grep attacks; no email in the line.
            log_auth_rejected(
                "local_auth_lockout_triggered",
                tier="local",
                path=path,
                client_ip=client_ip,
            )
        # COMMIT, not flush: the caller's next act is raising the 401/400, and
        # get_db rolls the request's transaction back on exceptions — a flush
        # would evaporate with it and lockout would never persist outside the
        # test harness (caught live by the card-9 acceptance run). This is the
        # deliberate exception to the "services only flush" rule.
        await self._db.commit()

    async def needs_setup(self) -> bool:
        """First-run setup is open exactly while the users table is empty (L2/L3).

        Computed live, never persisted: an empty table means nobody can log in
        anyway, so reopening setup exposes no privilege to steal.
        """
        return not await self._db.scalar(select(select(User.id).exists()))

    async def create_first_admin(
        self, email: str, password: str, *, path: str = "", client_ip: str = ""
    ) -> User | None:
        """Create the very first user, or None when setup is closed."""
        normalized = normalize_email(email)
        if self._db.get_bind().dialect.name == "postgresql":
            # READ COMMITTED lets two concurrent transactions both see an empty
            # snapshot and both pass a NOT EXISTS guard; the advisory lock
            # serializes first-run attempts across connections and replicas.
            await self._db.execute(
                text(
                    "SELECT pg_advisory_xact_lock(hashtext('backplane-first-run-setup'))"
                )
            )
        # Closed-instance check FIRST: a configured deployment answers 404
        # before any policy signal (the domain rule below) can leak.
        if not await self.needs_setup():
            return None
        if not email_domain_allowed(normalized):
            log_auth_rejected(
                "setup_email_domain_not_allowed",
                tier="local",
                path=path,
                client_ip=client_ip,
            )
            raise ForbiddenError(
                "Email domain not allowed", error_code="email_domain_not_allowed"
            )
        return await self._insert_first_admin(normalized, password)

    async def _insert_first_admin(self, email: str, password: str) -> User | None:
        """Atomic conditional insert: the emptiness guard lives in the INSERT
        statement itself, so a stale pre-check can never yield two admins."""
        user_id = uuid.uuid4()
        name = email.split("@")[0].replace(".", " ").title()
        first_admin_row = select(
            literal(user_id, type_=User.__table__.c.id.type),
            literal(email),
            literal(name),
            literal(hash_password(password)),
        ).where(~select(User.id).exists())
        result = await self._db.execute(
            insert(User).from_select(
                ["id", "email", "name", "password_hash"], first_admin_row
            )
        )
        if result.rowcount == 0:
            return None
        return (
            await self._db.execute(select(User).where(User.id == user_id))
        ).scalar_one()
