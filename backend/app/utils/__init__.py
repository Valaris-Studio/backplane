# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import re
from datetime import UTC, datetime


_SLUG_NON_ALNUM = re.compile(r"[^a-z0-9]+")

# Accepted shape for user-supplied slugs: lowercase alphanumeric, optional
# internal hyphens, no leading/trailing hyphen, no empty string.
SLUG_FORMAT = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def slugify(value: str, fallback: str = "item") -> str:
    """ASCII slug: lowercase, non-alphanumeric runs collapse to single hyphen."""
    slug = _SLUG_NON_ALNUM.sub("-", (value or "").lower()).strip("-")
    return slug or fallback


def utcnow() -> datetime:
    """Naive UTC timestamp compatible with TIMESTAMP WITHOUT TIME ZONE columns."""
    return datetime.now(UTC).replace(tzinfo=None)


def shallow_merge_dicts(existing: dict, updates: dict) -> dict:
    """Merge updates into existing dict (one level deep).

    - Keys present in updates overwrite existing keys.
    - Keys with value None are removed from the result.
    - Keys not in updates are preserved from existing.
    """
    merged = {**existing, **updates}
    return {k: v for k, v in merged.items() if v is not None}
