# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The two new rungs of the coding ladder — Guided and Standard.

The ladder exists so an operator meets a tier sized to what they can evaluate:
`coding-loop-easy` decides everything a developer would normally decide, and
`coding-loop-standard` asks for the eight facts that genuinely differ per board.
Both are reductions of the proven `coding-loop` kernel, so the failure mode
these tests exist to catch is a reduction that dropped a load-bearing clause —
the branch-equality guard, the dead-predecessor rule, the status length cap —
while still rendering cleanly.

The modules are imported DIRECTLY rather than through the catalog, so a failure
here names the rung that broke rather than the registry that exposed it; the
pins that genuinely need catalog membership reach for `get_system_template`
inside the test body.
"""

import re

import pytest

from app.services.loop_template_lint import lint_template_content
from app.services.loop_template_render import (
    SlotSpec,
    render,
    validate_template,
)
from app.services.loop_templates.coding_loop_easy import TEMPLATE as EASY
from app.services.loop_templates.coding_loop_standard import TEMPLATE as STANDARD

# R-PROMPT-7's ceilings, as the assertion values: a number in a rulebook nobody
# measures is a suggestion.
LOOP_PROMPT_CEILINGS = {"coding-loop-easy": 125, "coding-loop-standard": 240}

# R-TEST-2: each template's own literal scoping headings. Contiguous numbering
# is per-template, so the pin is the heading STRING, never the number.
SCOPING_SECTIONS = {
    "coding-loop-easy": ("### 2. PICK THE CARD", "### 6. STOP"),
    "coding-loop-standard": ("### 2. PICK THE CARD", "### 6. STOP"),
}

PROFILE_KEYS = (
    "emoji",
    "tagline",
    "tags",
    "what_i_do",
    "when_to_use",
    "when_not_to_use",
    "needs_from_board",
    "needs_from_runner",
    "how_i_end",
    "how_i_learn",
)

LADDER = {"coding-loop-easy": EASY, "coding-loop-standard": STANDARD}

_SEARCH_CALL = re.compile(r"search_cards\(([^)]*)\)", re.DOTALL)
_SEARCH_KWARG = re.compile(r'(\w+)\s*=\s*"([^"]*)"')
_SLOT_REF = re.compile(r"<<([A-Z0-9_]+)>>")


def _slots(template) -> dict[str, SlotSpec]:
    return {slot.name: slot for slot in template.content.slots}


def _bare_tools(template) -> set[str]:
    return {name.removeprefix("mcp__valaris__") for name in template.content.tools}


def _render_with(template, **overrides):
    """Render from every slot's own example, with `overrides` on top."""
    values = {slot.name: slot.example for slot in template.content.slots}
    values.update(overrides)
    return render(template.content, values)


def _render_required_only(template, **overrides):
    """The real bind path for an operator who fills nothing optional."""
    values = {
        slot.name: slot.example
        for slot in template.content.slots
        if slot.required and slot.kind != "variant"
    }
    values.update(overrides)
    return render(template.content, values)


def _section(prompt: str, heading: str) -> str:
    """The body of one `### N. HEADING` section, up to the next `###`."""
    assert heading in prompt, f"missing section heading {heading!r}"
    start = prompt.index(heading)
    rest = prompt[start + len(heading) :]
    end = rest.find("\n### ")
    return rest if end == -1 else rest[:end]


def _search_scopes(text: str) -> list[dict[str, str]]:
    return [
        dict(_SEARCH_KWARG.findall(call.group(1)))
        for call in _SEARCH_CALL.finditer(text)
    ]


def _assert_no_prose_seams(rendered: str, field: str) -> None:
    """Scan for the double spaces and stranded punctuation an empty slot leaves.

    Per LINE, and prose only: fences, tables and indented blocks carry
    whitespace the author chose, and a `code span` may legitimately hold " ."
    """
    in_fence = False
    for number, line in enumerate(rendered.split("\n"), start=1):
        body = line.strip()
        if body.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or body.startswith(("|", "-", "*")) or "    " in line:
            continue
        prose = re.sub(r"`[^`]*`", "CODE", body)
        assert "  " not in prose, f"{field}:{number}: double space: {line!r}"
        orphan = re.search(r"\s[.,;:]", prose)
        assert orphan is None, (
            f"{field}:{number}: punctuation left stranded by an empty slot: {line!r}"
        )


# --- identity ----------------------------------------------------------------


def test_easy_is_the_guided_rung_at_version_three():
    # v2: the skills distill-and-propose stratum landed.
    assert EASY.slug == "coding-loop-easy"
    assert EASY.name == "Coding loop — Guided"
    assert EASY.version == 3
    assert EASY.listed is True
    assert EASY.profile["emoji"] == "🌱"


def test_standard_is_the_default_rung_at_version_four():
    # v2: the skills distill-and-propose stratum landed.
    # v3: bundle E — run history moved from the definition to notes.
    assert STANDARD.slug == "coding-loop-standard"
    assert STANDARD.name == "Coding loop — Standard"
    assert STANDARD.version == 4
    assert STANDARD.listed is True
    assert STANDARD.profile["emoji"] == "🔁"


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_ladder_tags_name_the_rung_and_the_unproven_reduction(slug: str):
    """Tags render on the profile page, and the tier word is what makes the tag
    row itself a ladder signal — guided / standard / advanced."""
    tags = LADDER[slug].profile["tags"]
    assert "coding" in tags and "tdd" in tags and "slots" in tags
    assert "unproven" in tags
    assert (slug == "coding-loop-easy") == ("guided" in tags)
    assert (slug == "coding-loop-standard") == ("standard" in tags)


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_ladder_lineage_records_the_reduction_is_unproven(slug: str):
    """R-LIN-3: neither reduction has driven a completed run, and a template
    that claimed otherwise would borrow the advanced tier's track record."""
    lineage = LADDER[slug].lineage_notes
    assert "unproven" in lineage
    assert "v55" in lineage


def test_ladder_slugs_join_the_maintained_catalog():
    from app.services.loop_templates import get_system_template

    for slug in LADDER:
        assert get_system_template(slug) is not None


# --- validation and lint -----------------------------------------------------


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_ladder_templates_validate_clean(slug: str):
    """The same gate a workspace draft passes before it can be published. A
    seed that failed it would be listed, bound, and only then explode at render
    time on a live board."""
    assert validate_template(LADDER[slug].content) == []


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_ladder_templates_lint_clean(slug: str):
    """R-PROF-7: no board-specific facts — no repo URLs, SHAs or org/repo — in
    a kernel every board inherits."""
    assert lint_template_content(LADDER[slug].content) == []


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_ladder_prompts_carry_no_retired_customize_markers(slug: str):
    """R-PROMPT-10: `[CUSTOMIZE:` is the retired v1 form."""
    content = LADDER[slug].content
    assert "[CUSTOMIZE:" not in content.system_prompt
    assert "[CUSTOMIZE:" not in content.loop_prompt


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_every_slot_reference_in_a_prompt_is_catalogued_and_vice_versa(slug: str):
    """R-LIN-6 in both directions: an uncatalogued `<<X>>` ships a literal
    placeholder into a live prompt, and a catalogued slot no prompt uses is a
    form field the operator fills for nothing."""
    template = LADDER[slug]
    catalogued = set(_slots(template))
    referenced = set(
        _SLOT_REF.findall(template.content.system_prompt)
        + _SLOT_REF.findall(template.content.loop_prompt)
    )
    variant_fills = {
        target
        for slot in template.content.slots
        for variant in slot.variants
        for target in variant.fills
    }
    derived = set(_SLOT_REF.findall(str(template.content.derived_rails)))

    assert referenced <= catalogued, f"uncatalogued: {referenced - catalogued}"
    unused = catalogued - referenced - variant_fills - derived
    unused = {
        name for name in unused if _slots(template)[name].kind != "variant"
    }
    assert not unused, f"catalogued but unused: {unused}"


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_ladder_prompts_use_only_the_five_runner_variables(slug: str):
    """R-PROMPT-9: any other `{{.X}}` fails the runner with unknown_runner_var,
    and a raw `{{` must be escaped as `{{"{{"}}`."""
    from app.services.loop_config_validation import (
        LOOP_RUNNER_VARS,
        RUNNER_VAR_PATTERN,
    )

    content = LADDER[slug].content
    for text in (content.system_prompt, content.loop_prompt):
        assert set(RUNNER_VAR_PATTERN.findall(text)) <= set(LOOP_RUNNER_VARS)


# --- prompt skeleton ---------------------------------------------------------


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_loop_prompt_stays_within_its_line_ceiling(slug: str):
    """R-PROMPT-7/R-TEST-2c: instruction adherence degrades with length, so the
    ceiling is measured rather than trusted."""
    lines = LADDER[slug].content.loop_prompt.count("\n") + 1
    ceiling = LOOP_PROMPT_CEILINGS[slug]
    assert lines <= ceiling, f"{slug}: loop prompt is {lines} lines, ceiling {ceiling}"


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_loop_prompt_carries_its_scoping_sections(slug: str):
    """R-PROMPT-3: the headings are pinned by string, not by number."""
    prompt = LADDER[slug].content.loop_prompt
    for heading in SCOPING_SECTIONS[slug]:
        assert heading in prompt, f"{slug}: missing {heading}"


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_pick_and_stop_are_scoped_to_the_rendered_run_label(slug: str):
    """R-PROMPT-4: a memoryless session decides what to touch in PICK and when
    to quit in STOP. Both must name the SAME label the harness measures.

    The probe label is unlike any word the kernel already uses, so a match
    proves substitution reached the section rather than prose that was there.
    """
    prompt = _render_with(LADDER[slug], RUN_LABEL="zzz-scope-probe").loop_prompt
    for heading in SCOPING_SECTIONS[slug]:
        body = _section(prompt, heading)
        assert "zzz-scope-probe" in body, f"{slug}: {heading} is not label-scoped"


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_prompt_search_scope_is_set_equivalent_to_the_completion_rail(slug: str):
    """The harness and the agent must measure the SAME card set, or the run
    cannot terminate: a card the agent considers out of scope keeps the rail
    non-zero forever and the run burns to the budget."""
    result = _render_with(LADDER[slug], RUN_LABEL="zzz-scope-probe")
    rail = result.rails["completion_query"]
    scopes = _search_scopes(result.loop_prompt)
    assert scopes, f"{slug}: prompt issues no search_cards call"

    for scope in scopes:
        assert scope.get("label") == rail["label"], scope
        assert scope.get("exclude_column_type") == rail["exclude_column_type"], scope
        assert "column_type" not in scope, (
            f"{slug}: prompt narrows the sweep with column_type, which the "
            "closed completion-query grammar cannot express"
        )


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_precedence_order_is_declared_in_the_loop_prompt_preamble(slug: str):
    """R-PROMPT-8: contradictory instructions burn reasoning; the fix is a
    stated precedence, in the preamble, exactly once."""
    prompt = LADDER[slug].content.loop_prompt
    preamble = prompt.split("\n### ")[0]
    assert "the card wins" in preamble
    assert "the definition wins" in preamble or "the description wins" in preamble


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_stop_section_maps_all_four_outcomes(slug: str):
    """R-STOP-5: the runner vocabulary is exactly four, and a STOP section that
    omits one lets the agent reach for the softest outcome it can name."""
    _, stop_heading = SCOPING_SECTIONS[slug]
    stop = _section(LADDER[slug].content.loop_prompt, stop_heading)
    for outcome in (
        "worked",
        "nothing_ready",
        "blocked_on_human",
        "objective_complete",
    ):
        assert outcome in stop, f"{slug}: STOP never names {outcome}"


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_stop_section_says_a_refuted_completion_claim_is_a_failed_iteration(
    slug: str,
):
    """R-STOP-2: this is what stops an agent guessing at completion."""
    _, stop_heading = SCOPING_SECTIONS[slug]
    stop = _section(LADDER[slug].content.loop_prompt, stop_heading).lower()
    assert "failed iteration" in stop
    assert "never stop silently" in stop


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_three_attempt_cap_is_a_numeral_not_an_adjective(slug: str):
    """R-STOP-8/R-PROMPT-11: without a number, the persistence clause becomes
    an infinite money-loop."""
    prompt = LADDER[slug].content.loop_prompt
    assert "three times" in prompt or "3 times" in prompt or "3 attempts" in prompt


# --- profile -----------------------------------------------------------------


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_profile_fills_all_ten_fields(slug: str):
    """R-PROF-1/R-TEST-2b. `tagline` is structurally load-bearing beyond
    display: `SystemTemplate.description` reads it, so an omission is a
    KeyError somewhere far from here."""
    profile = LADDER[slug].profile
    for key in PROFILE_KEYS:
        assert key in profile, f"{slug}: profile is missing {key}"
        assert profile[key], f"{slug}: profile {key} is empty"
    assert LADDER[slug].description == profile["tagline"]


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_tagline_fits_the_two_line_clamp(slug: str):
    """The library card clamps to two lines at ≤ 140 chars."""
    assert len(LADDER[slug].profile["tagline"]) <= 140


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_when_to_use_opens_with_a_standalone_hint_line(slug: str):
    """`TemplateChooser.firstLine()` splits on `\\n`, NOT on sentence
    punctuation, so a single-paragraph value dumps the whole field into a
    text-xs chooser card."""
    value = LADDER[slug].profile["when_to_use"]
    assert "\n" in value, f"{slug}: when_to_use has no literal newline"
    assert len(value.split("\n")[0]) <= 120


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_when_not_to_use_routes_to_a_sibling_by_display_name(slug: str):
    """R-PROF-9: this is how the ladder self-navigates. Cross-references use
    display names, never slugs."""
    value = LADDER[slug].profile["when_not_to_use"]
    assert "Coding loop — " in value
    assert "coding-loop-" not in value


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_what_i_do_walks_one_iteration_within_the_bullet_cap(slug: str):
    bullets = LADDER[slug].profile["what_i_do"]
    assert 4 <= len(bullets) <= 6
    for bullet in bullets:
        assert len(bullet) <= 140, bullet


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_profile_prose_carries_no_house_words(slug: str):
    """R-PROF-3: `rails` is the config bag's internal name and the operator's
    screen calls that section something else entirely, so the word creates a
    term with no referent."""
    profile = LADDER[slug].profile
    prose = " ".join(
        value if isinstance(value, str) else " ".join(value)
        for key, value in profile.items()
        if key not in ("emoji", "tags")
    ).lower()
    for house_word in (" rails", "stratum", "kernel"):
        assert house_word not in prose, f"{slug}: profile prose says {house_word!r}"


# --- tools -------------------------------------------------------------------


def test_easy_grants_exactly_the_nineteen_tool_allowlist():
    """R-TOOL-4: the smallest grant that can complete the method, plus the
    skills-distill trio. The guided tier never creates cards or wires
    dependencies — it works the list it was given."""
    tools = EASY.content.tools
    assert len(tools) == 19, f"expected 19, got {len(tools)}"
    assert len(set(tools)) == len(tools), "duplicate tool in the grant"
    bare = _bare_tools(EASY)
    assert bare - {
        "get_project_context",
        "get_definition",
        "get_board",
        "get_card",
        "search_cards",
        "list_cards",
        "list_notes",
        "get_note",
        "create_note",
        "get_card_dependency_status",
        "list_card_dependencies",
        "set_board_loop",
        "whoami",
    } == {
        "update_card",
        "move_card",
        "log_execution_update",
        "list_skills",
        "get_skill",
        "propose_skill",
    }
    assert "enqueue_pr_for_merge" not in bare


def test_standard_grants_exactly_the_twenty_three_tool_base_allowlist():
    """The base grant is 23; variant C takes it to 24 — which is easy to
    confuse in review with the ADVANCED tier's pinned base of 24."""
    tools = STANDARD.content.tools
    assert len(tools) == 23, f"expected 23, got {len(tools)}"
    assert len(set(tools)) == len(tools), "duplicate tool in the grant"
    bare = _bare_tools(STANDARD)
    assert bare - {
        "get_project_context",
        "get_definition",
        "get_board",
        "get_card",
        "search_cards",
        "list_cards",
        "list_notes",
        "get_note",
        "create_note",
        "get_card_dependency_status",
        "list_card_dependencies",
        "set_board_loop",
        "whoami",
    } == {
        "get_board_loop",
        "validate_board_dependencies",
        "update_card",
        "move_card",
        "create_card",
        "add_card_dependency",
        "log_execution_update",
        "list_skills",
        "get_skill",
        "propose_skill",
    }
    assert "enqueue_pr_for_merge" not in bare
    # The advanced tier's definition write is deliberately dropped: this tier
    # writes run history through notes, avoiding the clobber hazard.
    assert "update_definition" not in bare


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_ladder_grants_no_destructive_or_admin_tools(slug: str):
    """R-TOOL-3: a misread card must never become data loss."""
    bare = _bare_tools(LADDER[slug])
    assert not {name for name in bare if "delete" in name}, bare
    assert not bare & {
        "create_agent",
        "rotate_agent_key",
        "pause_agent",
        "restart_agent",
        "freeze_board",
        "delete_board",
        "delete_workspace",
    }


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_ladder_keeps_its_off_switch(slug: str):
    """R-TOOL-2: absent, an enabled loop cannot stop itself."""
    assert "mcp__valaris__set_board_loop" in LADDER[slug].content.tools


# --- rails and setup contract ------------------------------------------------


def test_easy_rails_are_the_cheapest_on_the_ladder():
    """R-RAIL-7: a non-technical operator's first loop must be the cheapest
    thing on the ladder to be wrong about."""
    rails = EASY.content.rails_defaults
    assert rails["model"] == "mid"
    assert rails["iteration_delay_seconds"] == 60
    assert rails["iteration_timeout_seconds"] == 3600
    assert rails["budget_usd"] == 60
    assert rails["max_iterations"] == 12
    assert rails["max_consecutive_failures"] == 3
    assert rails["max_blocked_on_human"] == 2
    assert rails["starvation_policy"] == "park"
    assert rails["loop_landing"] == "self_merge"
    assert rails["merge_gate"] == "none"


def test_standard_rails_size_a_twenty_card_run():
    rails = STANDARD.content.rails_defaults
    assert rails["model"] == "premium"
    assert rails["iteration_delay_seconds"] == 60
    assert rails["iteration_timeout_seconds"] == 5400
    assert rails["budget_usd"] == 150
    assert rails["max_iterations"] == 20
    assert rails["max_consecutive_failures"] == 3
    assert rails["max_blocked_on_human"] == 3
    assert rails["starvation_policy"] == "park"
    assert rails["loop_landing"] == "self_merge"
    assert rails["merge_gate"] == "forge_ci"


def test_guided_rails_stay_below_the_standard_tier_on_money_and_time():
    """R-RAIL-7 as a relation, so a later edit to either tier cannot quietly
    make the guided rung the expensive one."""
    easy, standard = EASY.content.rails_defaults, STANDARD.content.rails_defaults
    assert easy["budget_usd"] < standard["budget_usd"]
    assert easy["iteration_timeout_seconds"] < standard["iteration_timeout_seconds"]
    assert easy["max_iterations"] < standard["max_iterations"]


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_ladder_completion_query_is_byte_identical_across_the_family(slug: str):
    """R-RAIL-8."""
    assert LADDER[slug].content.derived_rails == {
        "completion_query": {
            "label": "<<RUN_LABEL>>",
            "exclude_column_type": "done",
        }
    }


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_setup_contract_states_every_key_and_uses_real_column_types(slug: str):
    """R-SETUP-1/2: column NAMES are never valid, because every prompt resolves
    by column_type and a name-based contract would contradict the method."""
    contract = LADDER[slug].content.setup_contract
    for key in (
        "required_column_types",
        "optional_column_types",
        "requires_run_label",
        "definition_keys",
        "pinned_notes",
        "card_sections",
        "git_repo_bound",
        "agent_bound_with_tools",
        "dependencies_server_side",
        "notes",
    ):
        assert key in contract, f"{slug}: setup_contract omits {key}"

    legal = {"backlog", "active", "review", "done", "blocked"}
    assert contract["required_column_types"] == ["active", "done"]
    assert set(contract["optional_column_types"]) <= legal
    assert contract["requires_run_label"] is True
    assert contract["git_repo_bound"] is True
    assert contract["agent_bound_with_tools"] is True
    assert contract["notes"]


def test_easy_asks_nothing_of_the_board_beyond_two_columns_and_a_label():
    """The guided board is not asked to author a charter, pin a seed note, or
    structure its cards — Triage loop is what raises that bar."""
    contract = EASY.content.setup_contract
    assert contract["definition_keys"] == []
    assert contract["pinned_notes"] == []
    assert contract["card_sections"] == []
    assert contract["dependencies_server_side"] is False


def test_standard_requires_the_board_structure_its_method_reads():
    contract = STANDARD.content.setup_contract
    assert contract["definition_keys"] == ["loop_charter"]
    assert contract["pinned_notes"] == ["seed"]
    assert contract["card_sections"] == ["## Acceptance Criteria", "## Out of Scope"]
    assert contract["dependencies_server_side"] is True


# --- slots -------------------------------------------------------------------


def test_easy_loop_never_asks_the_operator_for_more_than_the_run_label():
    """R-SLOT-2/2b (SPEC §1.8 pin 1). `TemplateBindStep` renders slots flat,
    with no advanced-settings disclosure: an optional-with-default slot is
    exactly as prominent as a required one. So the VISIBLE field budget fails
    a test here rather than a review."""
    slots = EASY.content.slots
    assert len(slots) <= 2, f"guided tier catalogues {len(slots)} slots"
    required = [slot for slot in slots if slot.required]
    assert [slot.name for slot in required] == ["RUN_LABEL"]
    for slot in slots:
        if not slot.required:
            assert slot.default, f"{slot.name} is optional with no usable default"
    visible = [slot for slot in slots if slot.kind != "variant"]
    assert len(visible) <= 2, f"guided tier shows {len(visible)} fields"


def test_easy_loop_offers_no_variant():
    """SPEC §1.8 pin 2 / R-SLOT-13: a non-technical operator cannot evaluate a
    landing strategy, so it is chosen for them — and stays chosen."""
    assert not [slot for slot in EASY.content.slots if slot.kind == "variant"]
    assert EASY.content.rails_defaults["loop_landing"] == "self_merge"


def test_standard_catalogues_exactly_its_eight_slots():
    """R-TEST-3.6: the exact set, and the exact required subset.

    "Eight" counts the operator-facing slots plus the LANDING selector; the
    five LANDING_* sub-slots are derived, which is how the advanced tier's
    frozen 59 is counted too.

    Worth knowing when reading the visible-field budget: `TemplateBindStep`
    renders `slots.map()` flat and `bind-model.ts` treats every non-variant
    slot as operator-fillable, so today the sub-slots DO render as form fields.
    That is a pre-existing frontend gap the advanced tier shares, not something
    this tier's catalog can fix.
    """
    slots = _slots(STANDARD)
    assert set(slots) - {
        "LANDING_POLICY",
        "LANDING_STEPS",
        "LANDING_STUCK_RULE",
        "LANDING_MOVE_TARGET",
        "LANDING_NOTHING_READY",
    } == {
        "RUN_LABEL",
        "REPO_URL",
        "DEFAULT_BRANCH",
        "INTEGRATION_BRANCH",
        "GATES",
        "REPO_BOUNDARIES",
        "LESSONS",
        "LANDING",
    }
    required = {name for name, slot in slots.items() if slot.required}
    assert required == {
        "RUN_LABEL",
        "REPO_URL",
        "DEFAULT_BRANCH",
        "INTEGRATION_BRANCH",
    }


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_every_slot_documents_itself(slug: str):
    """R-SLOT-8: the bind form shows nothing else."""
    for slot in LADDER[slug].content.slots:
        assert slot.label, f"{slug}.{slot.name} has no label"
        assert slot.help, f"{slug}.{slot.name} has no help"
        assert slot.example, f"{slug}.{slot.name} has no example"
        assert not slot.label.endswith((".", ":")), slot.label


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_no_slot_value_a_template_supplies_itself_nests_another_slot(slug: str):
    """R-SLOT-9: the renderer is single-pass, so a nested name ships literally
    into a live prompt."""
    for slot in LADDER[slug].content.slots:
        for text in (slot.default, slot.example):
            if isinstance(text, str):
                assert "<<" not in text, f"{slug}.{slot.name}: {text!r}"
        for variant in slot.variants:
            for target, fill in variant.fills.items():
                assert "<<" not in str(fill), f"{slug}.{variant.id}.{target}"


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_optional_slots_never_render_an_empty_hole(slug: str):
    """R-TEST-1b restated: every slot is either required, or optional with a
    non-empty default, or optional with `default=""` whose placeholder sits
    alone on its line so renderer rule 4a drops the line cleanly.

    Variant fill targets are exempt from the line-shape half: their `default=""`
    is unreachable, because `resolve_variants` always resolves a variant (the
    selector itself defaults to "A"), so the placeholder never renders empty.
    That is why the advanced tier writes `- <<LANDING_POLICY>>` too.
    """
    template = LADDER[slug]
    fill_targets = {
        target
        for slot in template.content.slots
        for variant in slot.variants
        for target in variant.fills
    }
    for slot in template.content.slots:
        if slot.required or slot.kind == "variant" or slot.name in fill_targets:
            continue
        assert slot.default is not None, f"{slug}.{slot.name} has no default"
        if slot.default == "":
            for field in ("system_prompt", "loop_prompt"):
                for line in getattr(template.content, field).split("\n"):
                    if f"<<{slot.name}>>" in line:
                        assert line.strip() == f"<<{slot.name}>>", (
                            f"{slug}.{slot.name} defaults to empty but shares a "
                            f"line with prose: {line!r}"
                        )


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_no_help_string_promises_an_empty_field(slug: str):
    """R-SLOT-8b: `initialSlotValues()` pre-fills the default into the field's
    VALUE, so a defaulted slot never opens empty. An operator told to "leave
    empty" either deletes the default they were promised or stops trusting the
    help."""
    for slot in LADDER[slug].content.slots:
        if slot.default:
            assert "leave empty" not in slot.help.lower(), slot.name
            assert "leave it blank" not in slot.help.lower(), slot.name


def test_run_label_feeds_the_completion_rail_and_is_therefore_required():
    """R-SLOT-6: an empty completion_query.label matches nothing and burns the
    whole budget rail."""
    for template in LADDER.values():
        assert _slots(template)["RUN_LABEL"].required is True


# --- the method invariants that would silently break the loop ----------------


def test_easy_loop_refuses_to_land_on_the_default_branch():
    """SPEC §1.8 pin 3: the single most dangerous configuration this ladder can
    produce. The guided tier ships self_merge with merge_gate none, so an
    INTEGRATION_BRANCH that equals the repository's default branch means "merge
    every card straight into main with no CI gate". The guard must stop the
    iteration BEFORE it clones, and route to blocked_on_human."""
    rendered = _render_required_only(EASY).system_prompt
    lowered = rendered.lower()
    assert "default branch" in lowered
    assert "stop immediately" in lowered
    assert "blocked_on_human" in rendered
    assert "do not clone" in lowered


def test_easy_loop_defaults_the_landing_branch_away_from_main():
    """A default that is usually wrong and dangerous when wrong is worse than
    one that is always safe: `loop-integration` cannot collide with a default
    branch, so the safe path is the lazy path."""
    integration = _slots(EASY)["INTEGRATION_BRANCH"]
    assert integration.required is False
    assert integration.default == "loop-integration"


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_loop_recovers_a_card_left_in_the_active_column(slug: str):
    """SPEC §1.8 pin 4 / §2.8 pin 4 — the dead-predecessor rule.

    This is the mechanism that makes one-card-per-fresh-session safe. Without
    it, a card abandoned mid-iteration keeps the completion query non-zero
    forever while the run burns its iterations picking around it.
    """
    pick_heading, _ = SCOPING_SECTIONS[slug]
    pick = _section(
        _render_with(LADDER[slug], RUN_LABEL="zzz-scope-probe").loop_prompt,
        pick_heading,
    )
    lowered = pick.lower()
    assert "active column" in lowered
    assert "finish" in lowered
    assert "do not start a different one" in lowered or (
        "never silently start a different card" in lowered
    )


def test_easy_loop_keeps_the_card_status_under_the_length_limit():
    """SPEC §1.8 pin 5: the platform 422s a status over 255 chars and a 422
    voids the WHOLE update call, so check output must be routed to the
    description or a comment instead."""
    finish = _section(
        _render_required_only(EASY).loop_prompt, "### 5. FINISH THE CARD"
    )
    assert "255" in finish
    assert "description" in finish.lower()


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_loop_never_weakens_a_test_to_reach_green(slug: str):
    """Three independent published harnesses converge on this one, and it is
    the clause that separates a green run from a real one."""
    prompt = LADDER[slug].content.loop_prompt.lower()
    assert "never weaken" in prompt
    assert "existing test" in prompt or "an existing one" in prompt


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_system_prompt_states_the_no_infrastructure_floor(slug: str):
    """The FIXED S4 spine: no deploys, no infrastructure, no production data.
    This floor is kernel, not something a board may bind away."""
    system = _render_required_only(LADDER[slug]).system_prompt.lower()
    assert "no deploy" in system
    assert "infrastructure" in system or "infra" in system
    assert "production data" in system


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_system_prompt_scopes_the_agent_to_the_run_label(slug: str):
    """Everything else on the board is not yours — the clause that keeps a loop
    out of another program's cards."""
    system = _render_with(LADDER[slug], RUN_LABEL="zzz-scope-probe").system_prompt
    assert "zzz-scope-probe" in system


def test_easy_loop_never_adds_a_dependency():
    """The guided owner cannot evaluate a new dependency, so the tier refuses
    one outright rather than asking."""
    system = _render_required_only(EASY).system_prompt.lower()
    assert "no new dependencies" in system or "never add a dependency" in system


def test_standard_loop_self_checks_the_diff_without_inviting_a_nitpick_pass():
    """A reviewer prompted to find gaps will always find some; the anti-nitpick
    clause is what keeps this one line rather than a second implementation
    pass."""
    finish = _section(
        _render_required_only(STANDARD).loop_prompt, "### 5. FINISH THE CARD"
    )
    lowered = finish.lower()
    assert "acceptance criteria" in lowered
    assert "style" in lowered


# --- rendering ---------------------------------------------------------------


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_renders_clean_with_required_only_values(slug: str):
    """R-TEST-3.8: the prose-seam regression detector. Every optional sentence
    must survive its value being empty — this is what proves the kernel's
    rule-4 phrasing, not merely that the defaults exist."""
    result = _render_required_only(LADDER[slug])
    for field in ("system_prompt", "loop_prompt"):
        rendered = getattr(result, field)
        assert "<<" not in rendered, f"{slug}.{field} kept an unrendered slot"
        _assert_no_prose_seams(rendered, f"{slug}.{field}")


@pytest.mark.parametrize("slug", sorted(LADDER))
def test_renders_clean_with_every_example_filled(slug: str):
    """The examples are rendered as placeholders in the bind form, so a bad one
    produces a visibly bad prompt."""
    result = _render_with(LADDER[slug])
    for field in ("system_prompt", "loop_prompt"):
        assert "<<" not in getattr(result, field)


def test_standard_loop_defaults_render_a_runnable_prompt_without_gates():
    """SPEC §2.8 pin 2: the GATES default is a real instruction, not a
    placeholder — an unfilled slot still tells the agent to find the project's
    own test command and require a clean exit."""
    result = _render_required_only(STANDARD)
    assert "test command" in result.loop_prompt
    assert "clean exit" in result.loop_prompt
    # And the universal repo floor ships even when the operator adds nothing.
    assert "No deploys" in result.system_prompt


# --- the landing variant -----------------------------------------------------


def test_standard_ships_the_landing_variant_with_three_options():
    landing = _slots(STANDARD)["LANDING"]
    assert landing.kind == "variant"
    assert landing.default == "A"
    assert [variant.id for variant in landing.variants] == ["A", "B", "C"]


def test_every_landing_variant_fills_every_landing_sub_slot():
    """R-SLOT-12: a half-filled variant leaves the prompt contradicting itself
    — the policy says one thing and the finish steps another."""
    landing = _slots(STANDARD)["LANDING"]
    sub_slots = {
        "LANDING_POLICY",
        "LANDING_STEPS",
        "LANDING_STUCK_RULE",
        "LANDING_MOVE_TARGET",
        "LANDING_NOTHING_READY",
    }
    for variant in landing.variants:
        assert set(variant.fills) == sub_slots, variant.id
        for target, fill in variant.fills.items():
            assert str(fill).strip(), f"{variant.id}.{target} is empty"


def test_landing_sub_slots_are_never_asked_of_the_operator():
    """R-SLOT-12: they are derived from the choice, so marking one required
    would ask the operator for something the variant already supplies."""
    for name, slot in _slots(STANDARD).items():
        if name.startswith("LANDING_"):
            assert slot.required is False, name
            assert slot.default == "", name


def test_standard_loop_landing_variant_swaps_every_landing_clause():
    """SPEC §2.8 pin 1: a HALF-swapped landing is the failure this tier is most
    exposed to — the policy bullet says "merge it yourself" while the finish
    steps enqueue, and the loop wedges holding a PR nobody lands."""
    self_merge = _render_required_only(STANDARD, LANDING="A")
    queued = _render_required_only(STANDARD, LANDING="C")

    assert self_merge.rails["loop_landing"] == "self_merge"
    assert queued.rails["loop_landing"] == "merge_queue"

    # The policy bullet lives in the system prompt; the other three clauses in
    # the loop prompt. All four must move together.
    assert "merge it yourself" in self_merge.system_prompt.lower()
    assert "enqueue_pr_for_merge" in queued.system_prompt
    assert "enqueue_pr_for_merge" in queued.loop_prompt

    finish_self = _section(self_merge.loop_prompt, "### 5. FINISH THE CARD")
    finish_queued = _section(queued.loop_prompt, "### 5. FINISH THE CARD")
    assert finish_self != finish_queued
    assert "done" in finish_self.lower()
    assert "review" in finish_queued.lower()

    stop_self = _section(self_merge.loop_prompt, "### 6. STOP")
    stop_queued = _section(queued.loop_prompt, "### 6. STOP")
    assert stop_self != stop_queued

    assert "mcp__valaris__enqueue_pr_for_merge" in queued.tools
    assert "mcp__valaris__enqueue_pr_for_merge" not in self_merge.tools
    # The 23-tool base grant plus variant C's merge-queue tool.
    assert len(queued.tools) == 24


def test_human_landing_stops_at_the_pull_request():
    """Variant B's whole point: the agent must not merge, and nothing_ready
    becomes the NORMAL outcome while PRs await review."""
    human = _render_required_only(STANDARD, LANDING="B")
    assert human.rails["loop_landing"] == "human"
    assert "mcp__valaris__enqueue_pr_for_merge" not in human.tools

    stop = _section(human.loop_prompt, "### 6. STOP").lower()
    assert "nothing_ready" in stop
    assert "human" in stop or "review" in stop
