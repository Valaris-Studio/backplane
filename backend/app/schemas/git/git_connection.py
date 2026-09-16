# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from pydantic import field_validator, model_validator

from app.core.json_response import UTCModel

from app.models.git.git_repo import GitProvider


class GitConnectionRead(UTCModel):
    """Outbound representation of a git connection — never includes tokens."""

    id: uuid.UUID
    workspace_id: uuid.UUID
    provider: GitProvider
    account_login: str
    account_type: str
    auth_kind: str
    scopes: list[str]
    expires_at: datetime | None
    base_url: str | None
    last_verified_at: datetime | None
    last_error: str | None
    scopes_confirmed: bool | None
    connected_by: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class GitConnectionPatCreate(UTCModel):
    """Operator-supplied personal access token for a forge account.

    The account identity is deliberately absent: it comes from probing the
    forge with the token, never from what the operator claims.
    """

    provider: GitProvider
    token: str
    base_url: str | None = None

    @field_validator("token")
    @classmethod
    def _token_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("token must not be empty")
        return v.strip()

    @field_validator("base_url")
    @classmethod
    def _base_url_is_http(cls, v: str | None) -> str | None:
        if v is None:
            return v
        candidate = v.strip().rstrip("/")
        if not candidate:
            return None
        if not candidate.startswith(("http://", "https://")):
            raise ValueError("base_url must start with http:// or https://")
        return candidate

    @model_validator(mode="after")
    def _gitea_requires_base_url(self) -> "GitConnectionPatCreate":
        # Without a base_url a gitea credential can never be host-matched by
        # CredentialResolver, so it would store fine and then never be usable.
        if self.provider is GitProvider.gitea and not self.base_url:
            raise ValueError(
                "base_url is required for gitea connections — there is no "
                "default gitea host, so Backplane cannot tell which host this "
                "token belongs to."
            )
        return self


class ConnectionCheck(UTCModel):
    """One verified duty and what to do when it is not satisfied."""

    name: str
    ok: bool
    guidance: str


class GitConnectionVerifyResult(UTCModel):
    connection: GitConnectionRead
    checks: list[ConnectionCheck]


class GitConnectionCreateInternal(UTCModel):
    """Service-layer input — plaintext tokens encrypted before persist.

    Not exposed via any router. The OAuth callback handler (Sprint 2) builds
    one of these after exchanging the auth code for tokens.
    """

    workspace_id: uuid.UUID
    provider: GitProvider
    account_login: str
    account_type: str
    access_token: str
    refresh_token: str | None = None
    scopes: list[str] = []
    expires_at: datetime | None = None
    base_url: str | None = None
    connected_by: uuid.UUID
