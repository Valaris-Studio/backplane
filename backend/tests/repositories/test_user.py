# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""UserRepository email identity contract: storage is canonical (lowercase),
lookups normalize the INPUT — so any casing of an address resolves the same
user. Without this, every auto-provisioning entry point that funnels through
get_by_email/get_or_create can mint duplicate identity rows."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.repositories.user import UserRepository


@pytest.fixture
def repo(db_session: AsyncSession) -> UserRepository:
    return UserRepository(db_session)


async def _add_user(db: AsyncSession, email: str) -> User:
    user = User(email=email, name="Pat")
    db.add(user)
    await db.flush()
    return user


async def test_get_by_email_matches_any_case_after_normalization(
    repo: UserRepository, db_session: AsyncSession
):
    user = await _add_user(db_session, "pat@example.com")

    found = await repo.get_by_email("PAT@EXAMPLE.COM")

    assert found is not None
    assert found.id == user.id


async def test_get_or_create_case_variant_returns_existing_user(
    repo: UserRepository, db_session: AsyncSession
):
    user = await _add_user(db_session, "pat@example.com")

    resolved = await repo.get_or_create("Pat@Example.com")

    assert resolved.id == user.id
    assert resolved.email == "pat@example.com"
    assert await repo.count() == 1


async def test_get_or_create_stores_canonical_lowercase_on_create(
    repo: UserRepository,
):
    """The CREATE path must persist the canonical form — resolving an already
    canonical row can mask a dropped normalize on the mint itself."""
    created = await repo.get_or_create("  MixedCase@Example.COM  ")

    assert created.email == "mixedcase@example.com"
