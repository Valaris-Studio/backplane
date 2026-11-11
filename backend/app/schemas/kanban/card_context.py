# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from typing import Any, Literal

from pydantic import Field

from app.core.json_response import UTCModel


class ContextSnapshotManifest(UTCModel):
    schema_version: Literal[0] = 0
    digest_basis: Literal["sha256_utf8_rendered_text"] = "sha256_utf8_rendered_text"
    inclusions: list[dict[str, Any]] = Field(default_factory=list)
    omissions: list[dict[str, Any]] = Field(default_factory=list)
    omissions_summary: dict[str, Any] = Field(default_factory=dict)
    limits: dict[str, int]


class ContextSnapshotRead(UTCModel):
    purpose: Literal["bootstrap"] = "bootstrap"
    principal_kind: Literal["user", "installation", "agent"]
    blocks: list[dict[str, Any]] = Field(default_factory=list)
    manifest: ContextSnapshotManifest
