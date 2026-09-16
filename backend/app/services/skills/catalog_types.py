# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Catalog entry dataclasses, split out so `catalog_entries/*` modules can
import them without re-triggering `catalog.py` (which imports those modules)."""

from dataclasses import dataclass

from app.services.skills.manifest import parse_manifest


@dataclass(frozen=True)
class CatalogFile:
    path: str
    content: str


@dataclass(frozen=True)
class CatalogEntry:
    """One code-defined catalog entry.

    Frozen because the catalog is a process-wide singleton — a handler that
    mutated an entry would corrupt every later request in the same worker.
    """

    catalog_id: str
    catalog_version: int
    name: str
    description: str
    files: tuple[CatalogFile, ...]

    @property
    def toolsets(self) -> list[str]:
        """DERIVED from the entry's own SKILL.md frontmatter — never a second
        hand-typed field that could drift from the manifest."""
        manifest = next(f.content for f in self.files if f.path == "SKILL.md")
        return parse_manifest(manifest).toolsets
