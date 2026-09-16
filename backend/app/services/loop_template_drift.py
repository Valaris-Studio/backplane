# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Has the template a board is bound to moved on since it rendered?

Drift is DERIVED at read time and never stored (spec §3.2, owner Q3/Q8): it is
a statement about the CATALOG, not about this board, so a system template
bumped by a deploy must show as drifted without anyone re-saving every bound
board. Nothing here changes what a running loop reads — the runner keeps
serving the previously rendered prompts until a human explicitly re-renders.

The four kinds answer different operator questions, which is why they are not
collapsed into one boolean:

  none            the board is on the current version — no banner
  template_newer  a teammate published a newer version of a workspace template
  system_bumped   a deploy shipped a newer code-defined template
  slots_changed   same version, different slot catalog — only reachable if a
                  publish ever reused a version number (a guard, not a path;
                  `publish` bumps unconditionally and a test pins that)
  raw_edited      the template has not moved, but the prompts the board serves
                  no longer match the ones this binding rendered — somebody
                  edited the loop config behind the binding's back
  binding_corrupt the ref itself cannot be resolved (a workspace binding whose
                  `template_ref` lost its `id`), so NO verdict computed from it
                  is trustworthy — reported instead of a comparison

The last two exist because the version comparison alone answers "clean" for
state it never actually checked, which is worse than answering "unknown".
"""

import difflib
from typing import Any

from app.services.loop_template_render import PROMPT_FIELDS, TemplateContent

DRIFT_NONE = "none"
DRIFT_TEMPLATE_NEWER = "template_newer"
DRIFT_SYSTEM_BUMPED = "system_bumped"
DRIFT_SLOTS_CHANGED = "slots_changed"
DRIFT_RAW_EDITED = "raw_edited"
DRIFT_BINDING_CORRUPT = "binding_corrupt"


def _slot_names(content: TemplateContent) -> list[str]:
    return [slot.name for slot in content.slots]


def _required_slot_names(content: TemplateContent) -> set[str]:
    return {slot.name for slot in content.slots if slot.required}


def _version_drift_kind(source: str) -> str:
    """A workspace bump is a teammate's deliberate publish; a system bump rode
    in with a deploy. The UI names them apart, so the kind carries the source
    rather than making every consumer re-derive it."""
    return DRIFT_SYSTEM_BUMPED if source == "system" else DRIFT_TEMPLATE_NEWER


def compute_drift(
    *,
    source: str,
    bound_version: int,
    current_version: int | None,
    bound_content: TemplateContent | None,
    current_content: TemplateContent | None,
    ref_corrupt: bool = False,
    rendered_hash: str | None = None,
    config_hash: str | None = None,
) -> dict[str, Any]:
    """The full drift verdict for one binding.

    `current_version is None` means the catalog entry is gone (archived or
    deleted): reporting drift there would offer an Update that cannot run, so
    it reads as `none`. A bound version AHEAD of the catalog is likewise not
    drift — binding to a historical version is legal and there is nothing
    newer to move to.

    A `None` CONTENT means that snapshot is unrecoverable (an older code-defined
    version). The version comparison still stands — the board is demonstrably
    behind — but the delta does not, so the payload stays empty rather than
    inventing one from a blank template.

    `ref_corrupt` is what tells an unresolvable ref apart from an archived one:
    both surface as `current_version is None`, but the first is a broken row an
    operator must repair and the second is a benign state that reads clean.

    The hashes are compared only once the versions already agree — a template
    that moved on is the actionable verdict, and a re-render overwrites the raw
    edit anyway, so reporting both would offer a choice that does not exist. A
    missing `rendered_hash` (a binding written before the column was populated)
    is UNKNOWN, not different: claiming drift there would put a permanent
    banner on every legacy board.
    """
    payload = {
        "bound_version": bound_version,
        "current_version": current_version,
        "new_required_slots": [],
        "removed_slots": [],
        "prompt_changed": False,
    }
    comparable = bound_content is not None and current_content is not None

    if ref_corrupt:
        return {**payload, "kind": DRIFT_BINDING_CORRUPT}

    if current_version is None or current_version <= bound_version:
        # Same version but a different slot catalog can only happen if a
        # publish reused a version number. Kept as a guard so the condition
        # surfaces as a named kind instead of a board silently rendering
        # prompts whose slots no longer exist.
        if (
            comparable
            and current_version == bound_version
            and _slot_names(bound_content) != _slot_names(current_content)
        ):
            return {
                **payload,
                **_delta(bound_content, current_content),
                "kind": DRIFT_SLOTS_CHANGED,
            }
        if (
            rendered_hash is not None
            and config_hash is not None
            and rendered_hash != config_hash
        ):
            return {**payload, "kind": DRIFT_RAW_EDITED}
        return {**payload, "kind": DRIFT_NONE}

    return {
        **payload,
        **(_delta(bound_content, current_content) if comparable else {}),
        "kind": _version_drift_kind(source),
    }


def _delta(bound: TemplateContent, current: TemplateContent) -> dict[str, Any]:
    """What actually moved between two snapshots.

    `new_required_slots` counts a slot the new version REQUIRES that the old
    one did not — a slot promoted from optional to required blocks a re-render
    exactly like a brand-new one, because the binding holds no value for it
    either way.
    """
    current_names = set(_slot_names(current))
    newly_required = _required_slot_names(current) - _required_slot_names(bound)

    return {
        "new_required_slots": [
            name for name in _slot_names(current) if name in newly_required
        ],
        "removed_slots": [
            name for name in _slot_names(bound) if name not in current_names
        ],
        "prompt_changed": any(
            (getattr(bound, field) or "") != (getattr(current, field) or "")
            for field in PROMPT_FIELDS
        ),
    }


def _unified(before: str, after: str, label: str) -> str:
    """Empty string — not a header-only diff — when nothing changed, so callers
    can treat the field as falsy without parsing it."""
    if before == after:
        return ""
    return "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=f"{label} (bound)",
            tofile=f"{label} (current)",
        )
    )


def diff_binding(
    *,
    bound_content: TemplateContent | None,
    current_content: TemplateContent | None,
) -> dict[str, Any]:
    """Unified kernel diffs plus the slot-catalog delta, computed on demand.

    Never stored: the bound version's content is already reconstructible from
    the version snapshot, so caching this would only add a way for it to go
    stale against the template it describes.

    An unrecoverable snapshot yields an EMPTY diff, not a diff against a blank
    template — "we cannot show you what changed" must not render as "the whole
    kernel was added".
    """
    if bound_content is None or current_content is None:
        return {
            **{field: "" for field in PROMPT_FIELDS},
            "slots_delta": {"added": [], "removed": []},
        }

    return {
        **{
            field: _unified(
                getattr(bound_content, field) or "",
                getattr(current_content, field) or "",
                field,
            )
            for field in PROMPT_FIELDS
        },
        "slots_delta": {
            "added": [
                name
                for name in _slot_names(current_content)
                if name not in set(_slot_names(bound_content))
            ],
            "removed": [
                name
                for name in _slot_names(bound_content)
                if name not in set(_slot_names(current_content))
            ],
        },
    }
