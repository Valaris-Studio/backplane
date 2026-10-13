# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Where a session content body is stored: one object per body and per
upload chunk under
`session-content/v1/{workspace}/{owner}/{installation}/{session}/{content}/`.
The generic local-storage route refuses this shape."""

import uuid

CONTENT_ROOT = "session-content/v1"
# The {content} segment of a key, counting from `session-content`.
_CONTENT_SEGMENT = 6


def installation_prefix(
    workspace_id: uuid.UUID, owner_id: uuid.UUID, installation_id: uuid.UUID
) -> str:
    return f"{CONTENT_ROOT}/{workspace_id}/{owner_id}/{installation_id}/"


def session_prefix(
    workspace_id: uuid.UUID,
    owner_id: uuid.UUID,
    installation_id: uuid.UUID,
    session_id: uuid.UUID,
) -> str:
    return (
        installation_prefix(workspace_id, owner_id, installation_id) + f"{session_id}/"
    )


def content_prefix(content) -> str:
    return (
        session_prefix(
            content.workspace_id,
            content.owner_id,
            content.installation_id,
            content.session_id,
        )
        + f"{content.id}/"
    )


def body_key(content) -> str:
    return content_prefix(content) + "body"


def staging_prefix(content) -> str:
    return content_prefix(content) + "staging/"


def staging_key(content, index: int) -> str:
    return staging_prefix(content) + f"{index:02d}"


def uuid_of(segment: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(segment)
    except ValueError:
        return None


def content_id_of(key: str) -> uuid.UUID | None:
    """The content a key belongs to; None for a key of no recognizable shape."""
    segments = key.split("/")
    if len(segments) <= _CONTENT_SEGMENT + 1:
        return None
    return uuid_of(segments[_CONTENT_SEGMENT])
