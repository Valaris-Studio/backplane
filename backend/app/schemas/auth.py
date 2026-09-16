# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from pydantic import BaseModel, Field

from app.core.password import MIN_PASSWORD_LENGTH


class FirstRunSetupRequest(BaseModel):
    email: str = Field(pattern=r".+@.+")
    password: str = Field(min_length=MIN_PASSWORD_LENGTH)


# No min_length on login: the stored hash decides, and a length rule here
# would only advertise policy to attackers and lock out legacy credentials.
class LocalLoginRequest(BaseModel):
    email: str
    password: str


# No min_length on current_password (legacy credentials may predate the rule);
# the NEW password is held to the same bar as setup.
class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=MIN_PASSWORD_LENGTH)
