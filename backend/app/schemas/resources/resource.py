# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from pydantic import Field, field_validator
from app.core.json_response import UTCModel

from app.models.resources.resource import ResourceType
from app.schemas.bounded import Str255, Str500, Str1024

MAX_TAGS = 20
MAX_TAG_LENGTH = 50


class ResourceMetadata(UTCModel):
    tags: list[str] = Field(default_factory=list)

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, v: list[str]) -> list[str]:
        if len(v) > MAX_TAGS:
            raise ValueError(f"Maximum {MAX_TAGS} tags allowed")
        for tag in v:
            if len(tag) > MAX_TAG_LENGTH:
                raise ValueError(f"Tag must be {MAX_TAG_LENGTH} characters or less")
            if not tag.strip():
                raise ValueError("Tags cannot be empty")
        return [t.strip() for t in v]


class ResourceCreate(UTCModel):
    name: Str500
    resource_type: ResourceType = ResourceType.file
    parent_id: uuid.UUID | None = None
    mime_type: Str255 | None = None
    size_bytes: int | None = None
    gcs_path: Str1024 | None = None
    metadata: dict | None = None
    description: str | None = None


class ResourceUpdate(UTCModel):
    name: Str500 | None = None
    parent_id: uuid.UUID | None = None
    metadata: dict | None = None
    description: str | None = None


class ResourceRead(UTCModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    parent_id: uuid.UUID | None
    resource_type: ResourceType
    name: str
    gcs_path: str | None
    mime_type: str | None
    size_bytes: int | None
    uploaded_by: uuid.UUID
    metadata: dict = Field(default_factory=dict, validation_alias="meta")
    description: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


def validate_storage_filename(v: str) -> str:
    """One definition shared with the local-storage serving routes — a second
    copy of a security predicate drifts invisibly."""
    v = v.strip()
    if not v.strip("."):
        raise ValueError("filename must not be empty or dots-only")
    if "/" in v:
        raise ValueError("filename must not contain '/'")
    return v


class UploadUrlRequest(UTCModel):
    filename: str
    content_type: str

    @field_validator("filename")
    @classmethod
    def validate_filename(cls, v: str) -> str:
        return validate_storage_filename(v)


class UploadUrlResponse(UTCModel):
    upload_url: str
    gcs_path: str


class DownloadUrlResponse(UTCModel):
    download_url: str
