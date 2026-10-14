# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""One guarded assembly's immutable selection, for in-process reuse.

Internal only (never on the wire): a consumer renders and records provenance
from these exact fetched bodies and admitted bytes instead of reading notes
again. It is request-local, inside the caller's transaction, not a cache.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from app.repositories.notes.context_note import ContextNoteBody
from app.schemas.agents.context import (
    ContextAdmission,
    ContextBudgetReport,
    ContextDiagnostics,
    ContextExclusion,
)
from app.services.agents.context_budget import ContextBudgetPolicy


@dataclass(frozen=True)
class AdmittedNote:
    source_index: int
    candidate_index: int
    # The single row fetched for this note in this assembly, shared by aliases.
    body: ContextNoteBody
    rendered: str
    rendered_sha256: str
    rendered_bytes: int
    revision_sha256: str


@dataclass(frozen=True)
class SelectedSource:
    source_index: int
    kind: str
    alias: str
    filter: Mapping[str, Any]
    required: bool
    text: str
    admission: ContextAdmission
    notes: tuple[AdmittedNote, ...]
    # board_definition's admitted non-note part, ahead of its notes.
    definition_part: str | None
    # Every exclusion of the window; the manifest's diagnostics are a bounded view.
    exclusions: tuple[ContextExclusion, ...]


@dataclass(frozen=True)
class GuardedSelection:
    policy: ContextBudgetPolicy
    sources: tuple[SelectedSource, ...]
    budget: ContextBudgetReport
    diagnostics: ContextDiagnostics
