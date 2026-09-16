# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""System loop templates never instruct or grant direct board-definition writes.

Owner decision bundle E: agents PROPOSE (`propose_skill`) and humans approve;
notes are the sanctioned agent memory. A template that tells the agent to
"promote lessons into the run-history definition key" or grants
`update_definition` hands an unattended process the spec of record. Every
registered template is scanned — the retired `-v1` lineage included, because
`get_system_template` still resolves those slugs for bound boards.
"""

import re

import pytest

from app.services.loop_templates import LOOP_TEMPLATES, SystemTemplate

UPDATE_DEFINITION_TOOL = "mcp__valaris__update_definition"

DEFINITION_WRITE_PROSE = re.compile(
    r"update_definition"
    r"|definition key"
    r"|run-history definition"
    r"|run-history key"
    r"|record .{0,40}in the board definition"
    r"|write to the board — notes and the definition"
    r"|notes and the definition",
    re.IGNORECASE | re.DOTALL,
)

MEMORY_TALK = re.compile(r"lessons|run history|between runs", re.IGNORECASE)
NOTE_DESTINATION = re.compile(
    r"log note|create_note|update_note\(mode=\"append\"\)|propose_skill", re.IGNORECASE
)

PROMPT_FIELDS = ("system_prompt", "loop_prompt")

# A version bump is the drift signal for bound boards (loop_template.py
# `latest_version` vs the bound `version`), never an auto-upgrade — so every
# carrier whose prose or grant changes under bundle E must bump.
MINIMUM_VERSIONS = {
    "coding-loop": 7,
    "coding-loop-standard": 3,
    "documentator-loop": 2,
    "coding-loop-v1": 2,
}

ALL_SLUGS = sorted(template.slug for template in LOOP_TEMPLATES)


def _by_slug(slug: str) -> SystemTemplate:
    template = next(t for t in LOOP_TEMPLATES if t.slug == slug)
    return template


def _prompt_text(template: SystemTemplate) -> str:
    return "\n".join(getattr(template.content, field) for field in PROMPT_FIELDS)


def _string_leaves(node, path: str):
    if isinstance(node, str):
        yield path, node
    elif isinstance(node, dict):
        for key, child in node.items():
            yield from _string_leaves(child, f"{path}.{key}" if path else str(key))
    elif isinstance(node, (list, tuple)):
        for index, child in enumerate(node):
            yield from _string_leaves(child, f"{path}[{index}]")


def _display_strings(template: SystemTemplate):
    yield from _string_leaves(template.profile, "profile")
    yield from _string_leaves(template.content.setup_contract, "setup_contract")


def _matches(text: str) -> list[str]:
    return [hit.group(0) for hit in DEFINITION_WRITE_PROSE.finditer(text)]


def test_catalog_scan_covers_the_retired_lineage_too():
    retired = {t.slug for t in LOOP_TEMPLATES if not t.listed}
    assert retired == {"coding-loop-v1", "revision-loop-v1", "triage-loop-v1"}


def test_no_template_grants_update_definition():
    granting = sorted(
        t.slug for t in LOOP_TEMPLATES if UPDATE_DEFINITION_TOOL in t.content.tools
    )
    assert granting == [], (
        f"{granting} grant update_definition — the definition is human-owned; "
        "agents propose, humans approve"
    )


def test_no_template_prompt_instructs_a_definition_write():
    offenders = [
        (template.slug, field, phrase)
        for template in LOOP_TEMPLATES
        for field in PROMPT_FIELDS
        for phrase in _matches(getattr(template.content, field))
    ]
    assert offenders == []


def test_no_template_display_string_describes_a_definition_write():
    """Profile and setup-contract copy is what the chooser shows an operator;
    it must not promise a memory mechanism the grant no longer carries."""
    offenders = [
        (template.slug, path, phrase)
        for template in LOOP_TEMPLATES
        for path, value in _display_strings(template)
        for phrase in _matches(value)
    ]
    assert offenders == []


def test_no_setup_contract_asks_for_a_run_history_definition_key():
    carrying = sorted(
        t.slug
        for t in LOOP_TEMPLATES
        if "loop_run_history" in t.content.setup_contract.get("definition_keys", [])
    )
    assert carrying == [], (
        f"{carrying} still declare loop_run_history as a definition key the loop "
        "depends on — run history lives in notes"
    )


def test_coding_loop_keeps_its_human_authored_definition_keys():
    """Charter and note conventions are read-only ground rules for the agent;
    dropping them would over-delete the setup contract, not fix it."""
    keys = _by_slug("coding-loop").content.setup_contract["definition_keys"]
    assert {"loop_charter", "note_conventions"} <= set(keys)


@pytest.mark.parametrize("slug", ALL_SLUGS)
def test_memory_talk_names_a_note_or_proposal_destination(slug: str):
    """Pins the rewrite direction: wherever a prompt talks about lessons or
    run history, the destination it names is a note or a skill proposal."""
    text = _prompt_text(_by_slug(slug))
    if not MEMORY_TALK.search(text):
        pytest.skip(f"{slug}: prompt does not discuss lessons or run history")
    assert NOTE_DESTINATION.search(text), (
        f"{slug}: discusses lessons/run history without naming the log note, "
        "create_note/update_note(mode=\"append\") or propose_skill as the destination"
    )


@pytest.mark.parametrize("slug", sorted(MINIMUM_VERSIONS))
def test_definition_write_carriers_bumped_their_version(slug: str):
    assert _by_slug(slug).version >= MINIMUM_VERSIONS[slug], (
        f"{slug}: bundle E changes its prose or grant; bound boards learn of "
        "that only through a version bump"
    )


def _coding_slot(name: str):
    return next(slot for slot in _by_slug("coding-loop").content.slots if slot.name == name)


def test_run_history_key_slot_stays_declared_but_deprecated():
    """render() raises `unknown_slot` for a stored value of an undeclared slot,
    so bound boards keep the declaration; removal needs a stored-slot-value
    migration first (follow-up card). Until then it is optional and inert."""
    slot = _coding_slot("RUN_HISTORY_KEY")
    assert slot.required is False, "RUN_HISTORY_KEY must be optional once no prompt reads it"
    assert slot.deprecated is True, "RUN_HISTORY_KEY must carry the deprecated flag (unused_slot exemption)"
    assert "legacy" in f"{slot.label} {slot.help}".lower(), (
        "operators must see RUN_HISTORY_KEY is inert: label or help says legacy"
    )
    assert "<<RUN_HISTORY_KEY>>" not in _prompt_text(_by_slug("coding-loop")), (
        "coding-loop prompts still read <<RUN_HISTORY_KEY>> — run history lives in notes"
    )


def test_charter_key_slot_remains_required_and_referenced():
    """Guards over-deletion: the charter is human-authored ground truth the
    agent still reads at orient."""
    slot = _coding_slot("CHARTER_KEY")
    assert slot.required is True
    assert "<<CHARTER_KEY>>" in _prompt_text(_by_slug("coding-loop"))
