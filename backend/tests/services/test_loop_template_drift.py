# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Drift is a pure comparison of two template snapshots.

Everything here exercises `compute_drift` directly rather than through a
request, because drift's whole job is to be a function of (source, versions,
content) — routing it through HTTP would test the binding path a second time
and hide which input actually drove the verdict.
"""

from app.services.loop_template_drift import (
    DRIFT_BINDING_CORRUPT,
    DRIFT_RAW_EDITED,
    compute_drift,
    diff_binding,
)
from app.services.loop_template_render import SlotSpec, TemplateContent


def _content(
    *, system_prompt="You work on <<PROJECT>>.", slots=None
) -> TemplateContent:
    return TemplateContent(
        system_prompt=system_prompt,
        loop_prompt="Advance it.",
        slots=slots
        if slots is not None
        else [SlotSpec(name="PROJECT", kind="scalar", required=True)],
    )


def _drift(
    *,
    source="workspace",
    bound_version=1,
    current_version=1,
    bound=None,
    current=None,
):
    return compute_drift(
        source=source,
        bound_version=bound_version,
        current_version=current_version,
        bound_content=_content() if bound is None else bound,
        current_content=_content() if current is None else current,
    )


# --- kind ----------------------------------------------------------------


def test_drift_none_when_versions_match():
    assert _drift()["kind"] == "none"


def test_drift_template_newer_after_publish():
    verdict = _drift(bound_version=1, current_version=2)

    assert verdict["kind"] == "template_newer"
    assert verdict["bound_version"] == 1
    assert verdict["current_version"] == 2


def test_drift_system_bumped_for_a_code_defined_template():
    """Same version arithmetic, different KIND — the banner copy differs.

    A workspace bump is something a teammate did on purpose; a system bump
    arrived with a deploy nobody on this board asked for, so the UI names them
    apart (spec §3.2 / Q8).
    """
    verdict = _drift(source="system", bound_version=2, current_version=3)

    assert verdict["kind"] == "system_bumped"


def test_drift_none_when_the_catalog_version_is_unresolvable():
    """An archived or deleted template yields no version — claiming drift on a
    None would render a banner offering an Update that cannot run."""
    assert _drift(current_version=None)["kind"] == "none"


def test_drift_none_when_the_bound_version_is_ahead():
    """Binding to a historical version is legal; the catalog being BEHIND the
    board is not drift, because there is nothing newer to update to."""
    assert _drift(bound_version=5, current_version=2)["kind"] == "none"


def test_drift_slots_changed_when_the_same_version_carries_different_slots():
    verdict = _drift(
        bound_version=1,
        current_version=1,
        current=_content(
            slots=[
                SlotSpec(name="PROJECT", kind="scalar", required=True),
                SlotSpec(name="EXTRA", kind="scalar", required=True),
            ]
        ),
    )

    assert verdict["kind"] == "slots_changed"


def test_version_drift_outranks_a_slot_change():
    """A newer version usually ALSO changed slots; reporting slots_changed
    there would hide the Update the operator actually needs."""
    verdict = _drift(
        bound_version=1,
        current_version=2,
        current=_content(slots=[SlotSpec(name="OTHER", kind="scalar")]),
    )

    assert verdict["kind"] == "template_newer"


# --- payload -------------------------------------------------------------


def test_new_required_slots_lists_only_the_required_additions():
    verdict = _drift(
        bound_version=1,
        current_version=2,
        current=_content(
            slots=[
                SlotSpec(name="PROJECT", kind="scalar", required=True),
                SlotSpec(name="MUST_FILL", kind="scalar", required=True),
                SlotSpec(name="OPTIONAL", kind="scalar", required=False),
            ]
        ),
    )

    assert verdict["new_required_slots"] == ["MUST_FILL"]


def test_removed_slots_names_what_the_new_version_dropped():
    verdict = _drift(
        bound_version=1,
        current_version=2,
        bound=_content(
            slots=[
                SlotSpec(name="PROJECT", kind="scalar", required=True),
                SlotSpec(name="GONE", kind="scalar"),
            ]
        ),
    )

    assert verdict["removed_slots"] == ["GONE"]


def test_a_slot_that_became_required_counts_as_new_required():
    """The board's binding has no value for it either way — an optional slot
    promoted to required blocks a re-render exactly like a brand-new one."""
    verdict = _drift(
        bound_version=1,
        current_version=2,
        bound=_content(slots=[SlotSpec(name="PROJECT", kind="scalar", required=False)]),
        current=_content(
            slots=[SlotSpec(name="PROJECT", kind="scalar", required=True)]
        ),
    )

    assert verdict["new_required_slots"] == ["PROJECT"]


def test_prompt_changed_tracks_the_kernel_text():
    unchanged = _drift(bound_version=1, current_version=2)
    changed = _drift(
        bound_version=1,
        current_version=2,
        current=_content(system_prompt="A wholly rewritten kernel."),
    )

    assert unchanged["prompt_changed"] is False
    assert changed["prompt_changed"] is True


def test_drift_none_carries_an_empty_payload():
    """The thin `{kind: none}` the UI keys on must not be polluted with the
    slot lists a real drift carries."""
    verdict = _drift()

    assert verdict["new_required_slots"] == []
    assert verdict["removed_slots"] == []
    assert verdict["prompt_changed"] is False


# --- diff ----------------------------------------------------------------


def test_diff_is_empty_when_only_slots_changed():
    result = diff_binding(
        bound_content=_content(),
        current_content=_content(
            slots=[
                SlotSpec(name="PROJECT", kind="scalar", required=True),
                SlotSpec(name="EXTRA", kind="scalar"),
            ]
        ),
    )

    assert result["system_prompt"] == ""
    assert result["loop_prompt"] == ""
    assert result["slots_delta"]["added"] == ["EXTRA"]


def test_diff_reports_the_changed_kernel_as_unified_text():
    result = diff_binding(
        bound_content=_content(system_prompt="Old kernel line."),
        current_content=_content(system_prompt="New kernel line."),
    )

    assert "-Old kernel line." in result["system_prompt"]
    assert "+New kernel line." in result["system_prompt"]


def test_diff_slots_delta_names_additions_and_removals():
    result = diff_binding(
        bound_content=_content(slots=[SlotSpec(name="DROPPED", kind="scalar")]),
        current_content=_content(slots=[SlotSpec(name="ADDED", kind="scalar")]),
    )

    assert result["slots_delta"] == {"added": ["ADDED"], "removed": ["DROPPED"]}


# --- the guard that keeps slots_changed theoretical ----------------------


async def test_publish_always_bumps_version_so_slots_changed_is_guarded(
    db_session, test_workspace, test_user
):
    """`slots_changed` can only fire if content moved WITHOUT a version bump.

    Publishing twice must land on two DIFFERENT versions, so a content change
    always shows up as `template_newer` and `slots_changed` stays the guard the
    card describes. The day publish reuses a version, this test — not a bound
    board rendering stale prompts — is what reports it.
    """
    from app.services.loop_template import LoopTemplateService

    service = LoopTemplateService(db_session)
    payload = {
        "slug": "drift-guard",
        "name": "Drift Guard",
        "profile": {"tagline": "guard"},
        "content": {
            "system_prompt": "You are a careful agent.",
            "loop_prompt": "Do one thing.",
            "tools": ["mcp__valaris__set_board_loop"],
        },
    }
    created = await service.create_draft(
        test_workspace.id, actor_id=test_user.id, data=payload
    )
    assert created.version == 0

    # Read the number off each publish IMMEDIATELY: publish returns the same
    # identity-mapped row, so holding the object and comparing it later would
    # compare the second version against itself and pass vacuously.
    first_version = (
        await service.publish(
            test_workspace.id, created.id, expected_version=0, actor_id=test_user.id
        )
    ).version

    await service.update_draft(
        test_workspace.id,
        created.id,
        data={
            "content": {
                **payload["content"],
                "system_prompt": "A wholly rewritten kernel.",
            }
        },
        expected_updated_at=None,
    )
    second_version = (
        await service.publish(
            test_workspace.id,
            created.id,
            expected_version=first_version,
            actor_id=test_user.id,
        )
    ).version

    assert first_version == 1
    assert second_version == 2


# --- binding_corrupt (B8 N3) ---------------------------------------------
#
# A workspace binding whose `template_ref` lost its `id` cannot be resolved at
# all, so `current_version_for` yields None — indistinguishable, until now,
# from "the catalog entry was archived". The first is a corrupt row an operator
# must know about; the second is a benign state that deliberately reads clean.


def test_a_corrupt_ref_is_an_error_kind_not_clean():
    verdict = compute_drift(
        source="workspace",
        bound_version=1,
        current_version=None,
        bound_content=_content(),
        current_content=None,
        ref_corrupt=True,
    )

    assert verdict["kind"] == DRIFT_BINDING_CORRUPT
    assert verdict["current_version"] is None


def test_a_corrupt_ref_outranks_every_other_verdict():
    """Nothing computed from an unresolvable ref is trustworthy, so the
    corruption is reported instead of a version comparison that would be read
    as an actionable Update."""
    verdict = compute_drift(
        source="workspace",
        bound_version=1,
        current_version=9,
        bound_content=_content(),
        current_content=_content(system_prompt="Moved on."),
        ref_corrupt=True,
    )

    assert verdict["kind"] == DRIFT_BINDING_CORRUPT


def test_an_archived_template_still_reads_clean():
    """The negative control for the kind above: `current_version is None` with
    an INTACT ref is the archived case and must not become an error."""
    verdict = compute_drift(
        source="workspace",
        bound_version=1,
        current_version=None,
        bound_content=_content(),
        current_content=None,
        ref_corrupt=False,
    )

    assert verdict["kind"] == "none"


# --- raw_edited (B8 f) ----------------------------------------------------
#
# `rendered_hash` is the sha256 of the prompts this binding rendered. Comparing
# it against a hash of what the board serves NOW is the only way an operator's
# raw edit behind an intact binding becomes visible: versions still match, the
# slot values still match, and every other signal reads clean.


def test_raw_edited_when_the_boards_prompts_no_longer_match_the_render():
    verdict = compute_drift(
        source="workspace",
        bound_version=2,
        current_version=2,
        bound_content=_content(),
        current_content=_content(),
        rendered_hash="abc123",
        config_hash="deadbeef",
    )

    assert verdict["kind"] == DRIFT_RAW_EDITED


def test_matching_hashes_stay_clean():
    verdict = compute_drift(
        source="workspace",
        bound_version=2,
        current_version=2,
        bound_content=_content(),
        current_content=_content(),
        rendered_hash="abc123",
        config_hash="abc123",
    )

    assert verdict["kind"] == "none"


def test_a_binding_with_no_stored_hash_cannot_claim_a_raw_edit():
    """Bindings written before the hash column was populated carry None. A
    missing hash is unknown, not different — claiming drift there would put a
    permanent banner on every legacy board."""
    verdict = compute_drift(
        source="workspace",
        bound_version=2,
        current_version=2,
        bound_content=_content(),
        current_content=_content(),
        rendered_hash=None,
        config_hash="deadbeef",
    )

    assert verdict["kind"] == "none"


def test_a_version_bump_outranks_a_raw_edit():
    """When the template ALSO moved on, the actionable verdict is the Update.
    A re-render overwrites the raw edit anyway, so reporting it separately
    would offer the operator a choice that does not exist."""
    verdict = compute_drift(
        source="workspace",
        bound_version=1,
        current_version=2,
        bound_content=_content(),
        current_content=_content(system_prompt="Moved on."),
        rendered_hash="abc123",
        config_hash="deadbeef",
    )

    assert verdict["kind"] == "template_newer"
