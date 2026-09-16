# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""`SlotSpec.deprecated` — a slot that stays catalogued but no prompt reads.

render() raises `unknown_slot` for a stored value of a slot the template no
longer declares, so retiring a slot from the prose cannot delete its SlotSpec
without first migrating every bound board's stored values. A deprecated slot
is the interim: catalogued, optional, ignored by the prompts, and exempt from
`unused_slot` so publishing a fork over it is not blocked. The exemption is
narrow by construction — the default stays `False` and a deprecated slot may
never be required, or an operator would be forced to fill a value nothing reads.
"""

import pytest

from app.services.loop_config_validation import OFF_SWITCH_TOOL
from app.services.loop_template_render import (
    SlotSpec,
    TemplateContent,
    validate_template,
)

ROLE = {"name": "ROLE", "kind": "scalar", "required": True}


def _content(**overrides) -> TemplateContent:
    base = {
        "system_prompt": "You are <<ROLE>>.",
        "loop_prompt": "Work on <<ROLE>>.",
        "slots": [ROLE],
        "tools": [OFF_SWITCH_TOOL],
    }
    base.update(overrides)
    return TemplateContent.model_validate(base)


def _legacy_slot(**overrides) -> dict:
    slot = {
        "name": "LEGACY_KEY",
        "kind": "scalar",
        "required": False,
        "label": "Legacy key (legacy)",
        "help": "Kept so stored values keep rendering; no prompt reads it.",
        "default": "",
        "deprecated": True,
    }
    slot.update(overrides)
    return slot


def _findings_for(errors, slot_name: str, code: str) -> list:
    return [
        error
        for error in errors
        if error["code"] == code and error["field"] == f"slots.{slot_name}"
    ]


def test_slot_spec_accepts_a_deprecated_flag_defaulting_to_false():
    spec = SlotSpec(name="X", kind="scalar")
    assert spec.deprecated is False
    assert SlotSpec(**_legacy_slot(name="X")).deprecated is True


def test_deprecated_unreferenced_slot_is_not_an_unused_slot_finding():
    content = _content(slots=[ROLE, _legacy_slot()])
    errors = validate_template(content)
    assert _findings_for(errors, "LEGACY_KEY", "unused_slot") == []
    assert errors == [], [(e["code"], e["field"]) for e in errors]


def test_non_deprecated_unreferenced_slot_still_reports_unused_slot():
    """The exemption is per-slot, never blanket."""
    content = _content(slots=[ROLE, _legacy_slot(deprecated=False)])
    errors = validate_template(content)
    assert len(_findings_for(errors, "LEGACY_KEY", "unused_slot")) == 1


def test_deprecated_slot_may_not_be_required():
    content = _content(slots=[ROLE, _legacy_slot(required=True)])
    errors = validate_template(content)
    assert len(_findings_for(errors, "LEGACY_KEY", "deprecated_slot_required")) == 1


def test_deprecated_slot_that_a_prompt_still_reads_is_a_contradiction():
    """Deprecated means retired from the prose; a placeholder that survives
    would ask for a value the label calls inert."""
    content = _content(
        system_prompt="You are <<ROLE>>. Key: <<LEGACY_KEY>>",
        slots=[ROLE, _legacy_slot()],
    )
    errors = validate_template(content)
    assert len(_findings_for(errors, "LEGACY_KEY", "deprecated_slot_referenced")) == 1


@pytest.mark.parametrize("deprecated", [True, False])
def test_deprecated_flag_round_trips_through_model_dump(deprecated: bool):
    """Stored workspace forks carry the flag; a dump that dropped it would
    resurrect `unused_slot` on the next validate."""
    spec = SlotSpec(**_legacy_slot(deprecated=deprecated))
    assert SlotSpec.model_validate(spec.model_dump()).deprecated is deprecated
