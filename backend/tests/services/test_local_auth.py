# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""LocalAuthService: do these credentials identify a real user? (local-auth card 2)

The service must return None for unknown email, missing local credential, and
wrong password alike — a caller must not be able to tell those apart, or the
login endpoint built on top of it becomes a user-enumeration oracle.

Card 7 adds DB-backed lockout: N consecutive failures lock the account for a
cooldown, state persisted on `users` so it survives restarts and replicas.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from argon2 import PasswordHasher
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.password import hash_password, verify_password
from app.models.user import User
from app.services.auth.local_auth import (
    LOCKOUT_COOLDOWN,
    MAX_FAILED_LOGIN_ATTEMPTS,
    LocalAuthService,
)


@pytest.fixture
def service(db_session: AsyncSession) -> LocalAuthService:
    return LocalAuthService(db_session)


async def _add_user(
    db: AsyncSession, email: str, password: str | None = None
) -> User:
    user = User(
        email=email,
        name="Pat",
        password_hash=hash_password(password) if password is not None else None,
    )
    db.add(user)
    await db.flush()
    return user


@pytest.mark.asyncio
async def test_authenticate_valid_credentials_returns_user(service, db_session):
    user = await _add_user(db_session, "pat@example.com", "hunter2hunter2")
    found = await service.authenticate("pat@example.com", "hunter2hunter2")
    assert found is not None and found.id == user.id


@pytest.mark.asyncio
async def test_authenticate_wrong_password_returns_none(service, db_session):
    await _add_user(db_session, "pat@example.com", "hunter2hunter2")
    assert await service.authenticate("pat@example.com", "wrong") is None


@pytest.mark.asyncio
async def test_authenticate_unknown_email_returns_none(service):
    assert await service.authenticate("ghost@example.com", "whatever") is None


@pytest.mark.asyncio
async def test_authenticate_null_hash_returns_none(service, db_session):
    """OIDC/IAP-provisioned users have no local credential and must not log in."""
    await _add_user(db_session, "sso-only@example.com", password=None)
    assert await service.authenticate("sso-only@example.com", "") is None
    assert await service.authenticate("sso-only@example.com", "anything") is None


@pytest.mark.asyncio
async def test_authenticate_email_case_insensitive(service, db_session):
    user = await _add_user(db_session, "Pat@Example.com", "hunter2hunter2")
    found = await service.authenticate("pat@example.com", "hunter2hunter2")
    assert found is not None and found.id == user.id


# ── lockout (card 7) ──


async def _fail_login(service: LocalAuthService, times: int) -> None:
    for _ in range(times):
        assert await service.authenticate("pat@example.com", "wrong") is None


@pytest.mark.asyncio
async def test_lockout_after_max_failed_attempts(service, db_session):
    user = await _add_user(db_session, "pat@example.com", "hunter2hunter2")
    await _fail_login(service, MAX_FAILED_LOGIN_ATTEMPTS)

    assert user.failed_login_attempts == MAX_FAILED_LOGIN_ATTEMPTS
    assert user.locked_until is not None


@pytest.mark.asyncio
async def test_lockout_rejects_correct_password_while_locked(service, db_session):
    await _add_user(db_session, "pat@example.com", "hunter2hunter2")
    await _fail_login(service, MAX_FAILED_LOGIN_ATTEMPTS)

    assert await service.authenticate("pat@example.com", "hunter2hunter2") is None


@pytest.mark.asyncio
async def test_fewer_than_max_failures_does_not_lock(service, db_session):
    user = await _add_user(db_session, "pat@example.com", "hunter2hunter2")
    await _fail_login(service, MAX_FAILED_LOGIN_ATTEMPTS - 1)

    found = await service.authenticate("pat@example.com", "hunter2hunter2")
    assert found is not None and found.id == user.id


@pytest.mark.asyncio
async def test_success_resets_failed_attempt_counter(service, db_session):
    user = await _add_user(db_session, "pat@example.com", "hunter2hunter2")
    await _fail_login(service, MAX_FAILED_LOGIN_ATTEMPTS - 2)

    assert await service.authenticate("pat@example.com", "hunter2hunter2") is not None
    assert user.failed_login_attempts == 0
    assert user.locked_until is None


@pytest.mark.asyncio
async def test_lockout_expires_after_cooldown(service, db_session):
    user = await _add_user(db_session, "pat@example.com", "hunter2hunter2")
    user.failed_login_attempts = MAX_FAILED_LOGIN_ATTEMPTS
    user.locked_until = datetime.now(UTC) - timedelta(seconds=1)
    await db_session.flush()

    found = await service.authenticate("pat@example.com", "hunter2hunter2")
    assert found is not None
    assert user.failed_login_attempts == 0
    assert user.locked_until is None


@pytest.mark.asyncio
async def test_expired_lockout_opens_a_fresh_failure_window(service, db_session):
    """After the cooldown, failures count from zero — one wrong password must
    not instantly re-lock an account whose lockout already expired."""
    user = await _add_user(db_session, "pat@example.com", "hunter2hunter2")
    user.failed_login_attempts = MAX_FAILED_LOGIN_ATTEMPTS
    user.locked_until = datetime.now(UTC) - timedelta(seconds=1)
    await db_session.flush()

    assert await service.authenticate("pat@example.com", "wrong") is None
    assert user.failed_login_attempts == 1
    assert user.locked_until is None


@pytest.mark.asyncio
async def test_lockout_sets_cooldown_from_constant(service, db_session):
    user = await _add_user(db_session, "pat@example.com", "hunter2hunter2")
    before = datetime.now(UTC)
    await _fail_login(service, MAX_FAILED_LOGIN_ATTEMPTS)

    locked_until = user.locked_until
    # SQLite strips tzinfo — normalize before comparing (CLAUDE.md).
    if locked_until.tzinfo is None:
        locked_until = locked_until.replace(tzinfo=UTC)
    assert locked_until >= before + LOCKOUT_COOLDOWN - timedelta(seconds=5)
    assert locked_until <= datetime.now(UTC) + LOCKOUT_COOLDOWN


@pytest.mark.asyncio
async def test_lockout_persists_across_sessions(service, db_session, db_engine):
    """The card's central design point: lockout state lives in the DATABASE.

    A second session + a fresh service instance simulate another replica (or a
    restarted process) — the lock must still hold there. In-process rate-limit
    state cannot pass this test.
    """
    await _add_user(db_session, "pat@example.com", "hunter2hunter2")
    await _fail_login(service, MAX_FAILED_LOGIN_ATTEMPTS)
    await db_session.commit()

    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as fresh_session:
        fresh_service = LocalAuthService(fresh_session)
        assert (
            await fresh_service.authenticate("pat@example.com", "hunter2hunter2")
        ) is None


@pytest.mark.asyncio
async def test_authenticate_rehashes_outdated_hash(service, db_session):
    """A hash made with older parameters is transparently upgraded on login."""
    weak_hash = PasswordHasher(time_cost=1).hash("hunter2hunter2")
    user = await _add_user(db_session, "pat@example.com")
    user.password_hash = weak_hash
    await db_session.flush()

    found = await service.authenticate("pat@example.com", "hunter2hunter2")
    assert found is not None

    stored = (
        await db_session.execute(select(User).where(User.id == user.id))
    ).scalar_one()
    assert stored.password_hash != weak_hash
    assert verify_password("hunter2hunter2", stored.password_hash)
