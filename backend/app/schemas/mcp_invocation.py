# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime
from typing import Literal

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from app.core.json_response import UTCModel
from app.core.harness import HarnessName, NativeId


class MCPInvocationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID
    workspace_slug: str | None = Field(None, min_length=1, max_length=200)
    tool_name: str = Field(min_length=1, max_length=200)
    arguments_summary: str | None = Field(None, max_length=200)
    result_summary: str | None = Field(None, max_length=500)
    error_message: str | None = Field(None, max_length=500)
    status: Literal["completed", "failed", "aborted"]
    started_at: AwareDatetime
    completed_at: AwareDatetime
    duration_seconds: float = Field(ge=0, allow_inf_nan=False)
    # Native context: which harness made the call and its own id for it, so a
    # captured session of the same owner can claim this invocation.
    harness: HarnessName | None = None
    native_call_id: NativeId | None = None
    client_name: str | None = Field(None, min_length=1, max_length=200)
    client_version: str | None = Field(None, min_length=1, max_length=64)
    server_instance_id: str | None = Field(None, min_length=1, max_length=200)
    # Only from harnesses that cannot send a native call id: a hash of the
    # call's arguments that the backend may correlate with a captured call.
    arguments_fingerprint: str | None = Field(None, pattern=r"^[0-9a-f]{64}$")

    @field_validator(
        "workspace_slug",
        "tool_name",
        "arguments_summary",
        "result_summary",
        "error_message",
        "client_name",
        "client_version",
        "server_instance_id",
    )
    @classmethod
    def postgres_text(cls, value: str | None) -> str | None:
        if value is not None:
            if "\x00" in value:
                raise ValueError("Unsupported invocation text")
            try:
                value.encode("utf-8")
            except UnicodeEncodeError:
                raise ValueError("Unsupported invocation text") from None
        return value

    @model_validator(mode="after")
    def ordered_times(self):
        if self.completed_at < self.started_at:
            raise ValueError("Completion precedes start")
        return self


class MCPInvocationRead(UTCModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    owner_id: uuid.UUID
    agent_id: uuid.UUID | None
    workspace_id: uuid.UUID | None
    workspace_slug: str | None
    scope_status: Literal["authorized", "unavailable", "unscoped"]
    tool_name: str
    arguments_summary: str | None
    result_summary: str | None
    error_message: str | None
    status: Literal["completed", "failed", "aborted"]
    started_at: datetime
    completed_at: datetime
    duration_seconds: float
    harness: str | None
    native_call_id: str | None
    client_name: str | None
    client_version: str | None
    server_instance_id: str | None
    created_at: datetime
