# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from datetime import datetime, timezone
from typing import Any, Literal

EntityType = Literal[
    "pipeline",
    "team",
    "definition",
    "prompt_config",
    "notes_bundle",
    "pipeline_bundle",
    "loop_template",
]

_VALID_ENTITY_TYPES: frozenset[str] = frozenset(
    {
        "pipeline",
        "team",
        "definition",
        "prompt_config",
        "notes_bundle",
        "pipeline_bundle",
        "loop_template",
    }
)

SCHEMA_VERSION = 1


def build_envelope(
    *,
    entity_type: EntityType,
    source_workspace_slug: str,
    data: dict[str, Any],
    source_board_slug: str | None = None,
) -> dict[str, Any]:
    if entity_type not in _VALID_ENTITY_TYPES:
        raise ValueError(f"Unknown entity_type: {entity_type!r}")

    return {
        "schema_version": SCHEMA_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "entity_type": entity_type,
        "source_workspace_slug": source_workspace_slug,
        "source_board_slug": source_board_slug,
        "data": data,
    }
