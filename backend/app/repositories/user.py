# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from sqlalchemy import select

from app.core.auth import normalize_email
from app.models.user import User
from app.repositories.base import BaseRepository


class UserRepository(BaseRepository[User]):
    model = User

    async def get_by_email(self, email: str) -> User | None:
        # Storage is canonical lowercase (migration 104); normalizing the
        # input keeps the lookup on the plain email index.
        email = normalize_email(email)
        result = await self.db.execute(select(User).where(User.email == email))
        return result.scalar_one_or_none()

    async def get_or_create(self, email: str, name: str = "") -> User:
        email = normalize_email(email)
        user = await self.get_by_email(email)
        if not user:
            if not name:
                name = email.split("@")[0].replace(".", " ").title()
            user = await self.create(email=email, name=name)
        return user
