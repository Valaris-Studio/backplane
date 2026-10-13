# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.core.json_response import UTCModel
from app.schemas.companion import DeviceName

PairingState = Literal["pending", "approved", "denied", "consumed", "expired"]
PairingTokenError = Literal[
    "authorization_pending", "slow_down", "expired_token", "access_denied"
]
PlatformToken = Annotated[
    str, StringConstraints(pattern=r"^[a-z0-9_]{1,32}$")
]


class PairingStart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: DeviceName | None = None
    platform: PlatformToken = Field(description="Go GOOS, e.g. `darwin`.")
    arch: PlatformToken = Field(description="Go GOARCH, e.g. `arm64`.")
    companion_version: str = Field(min_length=1, max_length=64)


class PairingStarted(BaseModel):
    device_code: str = Field(
        description="Secret; only the device keeps it and polls with it."
    )
    user_code: str = Field(description="Shown to the person as `XXXX-XXXX`.")
    verification_uri: str
    verification_uri_complete: str
    interval: int = Field(description="Minimum seconds between polls.")
    expires_in: int = Field(description="Seconds until both codes expire.")


class PairingTokenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_code: str = Field(min_length=1, max_length=128)


class PairingCodeRequest(BaseModel):
    """The code travels in the body so it never lands in a URL or access log.
    Anything that is not a code answers like an unknown code (404), not 422."""

    model_config = ConfigDict(extra="forbid")

    user_code: str = Field(max_length=64)


class PairingGrant(BaseModel):
    """Returned exactly once per pairing; a replay is `expired_token`."""

    installation_id: uuid.UUID
    device_token: str


class PairingTokenErrorBody(BaseModel):
    detail: str
    error_code: PairingTokenError
    error_params: dict
    context: None = None


class PairingRequestRead(UTCModel):
    name: str | None = Field(
        description="The name the device asked for; null means the neutral "
        "`platform-arch-<id8>` default is used on approval."
    )
    platform: str
    arch: str
    requested_at: datetime
    expires_at: datetime
    state: PairingState
