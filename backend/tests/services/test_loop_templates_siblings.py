# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Per-template pins for the two NEW board-ops siblings (SPEC §6.7, §7.7).

Kept out of `test_loop_templates_seeds.py` so each template's own invariants
read as a group rather than as parametrize entries scattered through 1,490
lines of catalog-wide set algebra.

The modules are imported DIRECTLY rather than through the catalog, so a failure
here names the template that broke rather than the registry that exposed it;
the handful of assertions that genuinely need catalog membership reach for
`get_system_template` inside the test body.
"""

import re

import pytest

from app.services.loop_template_lint import lint_template_content
from app.services.loop_template_render import render, validate_template
from app.services.loop_templates.documentator_loop import TEMPLATE as DOCUMENTATOR
from app.services.loop_templates.secretary_loop import TEMPLATE as SECRETARY

# R-PROMPT-7's ceilings for the two new siblings, budgeted like revision-loop.
LOOP_PROMPT_CEILINGS = {"documentator-loop": 140, "secretary-loop": 140}

# The ten profile fields R-PROF-1 requires non-empty on every template.
PROFILE_FIELDS = (
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

SIBLINGS = {"documentator-loop": DOCUMENTATOR, "secretary-loop": SECRETARY}


def _bare_tools(template) -> set[str]:
    return {name.removeprefix("mcp__valaris__") for name in template.content.tools}


def _all_example_values(template) -> dict[str, str]:
    return {slot.name: slot.example for slot in template.content.slots}


def _required_only_values(template) -> dict[str, str]:
    return {
        slot.name: slot.example
        for slot in template.content.slots
        if slot.required and slot.kind != "variant"
    }


def _section(loop_prompt: str, heading: str) -> str:
    """The body of one `### N. HEADING` section, up to the next `###`."""
    start = loop_prompt.index(heading)
    rest = loop_prompt[start + len(heading) :]
    end = rest.find("\n### ")
    return rest if end == -1 else rest[:end]


# --- identity ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("slug", "name", "emoji", "version"),
    [
        ("documentator-loop", "Documentator loop", "📚", 3),
        ("secretary-loop", "Secretary loop", "🗂️", 3),
    ],
)
def test_sibling_identity(slug: str, name: str, emoji: str, version: int):
    """Slug is the permanent binding id (R-NAME-2); name and emoji are what an
    operator picks by. New templates start at version 1 (R-LIN-1)."""
    template = SIBLINGS[slug]
    assert template.slug == slug
    assert template.name == name
    assert template.version == version
    assert template.listed is True
    assert template.is_system is True
    assert template.profile["emoji"] == emoji


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_content_validates_and_lints_clean(slug: str):
    """The same gate a workspace draft must pass before publication. A seed
    that fails it would be listed, offered, bound, and only then explode at
    render time on a live board."""
    content = SIBLINGS[slug].content
    assert validate_template(content) == []
    assert lint_template_content(content) == []


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_siblings_are_in_the_catalog(slug: str):
    from app.services.loop_templates import get_system_template

    assert get_system_template(slug) is not None


# --- profile -----------------------------------------------------------------


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_profile_fills_all_ten_fields(slug: str):
    """R-PROF-1. The profile page renders these as its whole page; an empty key
    is a blank section on the one screen that explains what the loop IS. Note
    `tagline` is structurally load-bearing beyond display — `SystemTemplate
    .description` reads it, so omitting it is a KeyError, not an assertion."""
    profile = SIBLINGS[slug].profile
    for key in PROFILE_FIELDS:
        value = profile.get(key)
        assert value, f"{slug}: profile.{key} is empty"
        if isinstance(value, str):
            assert value.strip() == value.strip(), f"{slug}.{key}"


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_when_to_use_opens_with_a_standalone_hint_line(slug: str):
    """`TemplateChooser.firstLine()` splits on `\\n`, NOT on sentence
    punctuation, so a single-paragraph value dumps the whole field into a
    `text-xs` chooser card. Two paragraphs: hint line, newline, detail."""
    when_to_use = SIBLINGS[slug].profile["when_to_use"]
    assert "\n" in when_to_use, f"{slug}: when_to_use has no literal newline"
    first_line = when_to_use.split("\n")[0]
    assert first_line.strip(), f"{slug}: when_to_use opens with a blank line"
    assert len(first_line) <= 120, f"{slug}: hint line is {len(first_line)} chars"


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_when_not_to_use_routes_to_a_named_sibling(slug: str):
    """R-PROF-9. Routing by DISPLAY NAME is how the ladder self-navigates — an
    operator who lands on the wrong template must be told which one to read."""
    when_not = SIBLINGS[slug].profile["when_not_to_use"]
    named = [
        name
        for name in ("Coding loop", "Triage loop", "Revision loop", "Secretary loop")
        if name in when_not
    ]
    assert named, f"{slug}: when_not_to_use names no sibling to route to"
    assert "-loop" not in when_not, f"{slug}: cross-references must use names, not slugs"


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_tags_carry_the_family_and_the_proven_marker(slug: str):
    """R-TAG-2/3/5. `unproven` is a product property, not bookkeeping: it is
    what an operator reads before trusting a loop with a budget."""
    tags = SIBLINGS[slug].profile["tags"]
    assert 3 <= len(tags) <= 5, f"{slug}: {len(tags)} tags"
    assert "board-ops" in tags
    assert "slots" in tags
    assert "unproven" in tags
    assert "proven" not in tags


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_lineage_says_the_kernel_is_unproven(slug: str):
    """R-LIN-3, and it must agree with the tag above. Neither kernel has driven
    a completed run, and claiming otherwise on a first bind is the exact
    first-run dishonesty R-PROF-5 exists to stop."""
    assert "unproven" in SIBLINGS[slug].lineage_notes.lower()


# --- slots -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("slug", "expected_names", "expected_required"),
    [
        (
            "documentator-loop",
            {"RUN_LABEL", "DOC_SURFACE", "DOC_STANDARD", "STALE_SIGNALS", "LESSONS"},
            {"RUN_LABEL", "DOC_SURFACE", "DOC_STANDARD"},
        ),
        (
            "secretary-loop",
            {
                "REPORT_AUDIENCE",
                "REPORT_CADENCE",
                "ESCALATION_PATH",
                "QUIET_THRESHOLDS",
                "LESSONS",
            },
            {"REPORT_AUDIENCE", "REPORT_CADENCE", "ESCALATION_PATH"},
        ),
    ],
)
def test_sibling_slot_catalog_is_exactly_five_with_three_required(
    slug: str, expected_names: set[str], expected_required: set[str]
):
    """R-SLOT-2: 5 catalogued, 3 required, 3 hand-typed. This number is what
    measures "configuration hell", and it is the one the owner cares about, so
    it is pinned as a literal rather than a bound."""
    slots = SIBLINGS[slug].content.slots
    assert {slot.name for slot in slots} == expected_names
    assert {slot.name for slot in slots if slot.required} == expected_required


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_slots_leave_no_hole_when_unfilled(slug: str):
    """R-TEST-1b, restated: every slot is either required, or optional with a
    NON-EMPTY default, or optional with `default=""` whose placeholder sits
    alone on its line so renderer rule 4a drops the line cleanly.

    The old form of this rule ("LESSONS is the only optional slot") is violated
    by both of these templates on purpose — `STALE_SIGNALS` and
    `QUIET_THRESHOLDS` are optional with real, shippable defaults.
    """
    template = SIBLINGS[slug]
    loop_prompt = template.content.loop_prompt
    system_prompt = template.content.system_prompt
    for slot in template.content.slots:
        if slot.required:
            continue
        assert slot.default is not None, f"{slug}.{slot.name}: optional with no default"
        if slot.default:
            continue
        placeholder = f"<<{slot.name}>>"
        for text in (system_prompt, loop_prompt):
            for line in text.split("\n"):
                if placeholder in line:
                    assert line.strip() == placeholder, (
                        f"{slug}.{slot.name} defaults to empty but its placeholder "
                        f"shares a line with prose: {line!r} — rule 4a cannot drop it"
                    )


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_slots_carry_label_help_and_example(slug: str):
    """R-SLOT-8. The bind form shows nothing else; a slot with no help is a
    field an operator fills by guessing."""
    for slot in SIBLINGS[slug].content.slots:
        assert slot.label.strip(), f"{slug}.{slot.name}: no label"
        assert not slot.label.endswith("."), f"{slug}.{slot.name}: label is a sentence"
        assert slot.help.strip(), f"{slug}.{slot.name}: no help"
        assert slot.example.strip(), f"{slug}.{slot.name}: no example"


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_defaulted_slot_help_never_says_leave_empty(slug: str):
    """R-SLOT-8b. `initialSlotValues()` pre-fills a default into the field's
    VALUE, not its placeholder, so a defaulted slot NEVER opens empty. Help
    that says "leave empty for X" describes an interaction that cannot happen,
    and an operator who reads it then sees text will delete the default they
    were promised."""
    for slot in SIBLINGS[slug].content.slots:
        if not slot.default:
            continue
        assert "leave empty" not in slot.help.lower(), f"{slug}.{slot.name}"
        assert "leave it empty" not in slot.help.lower(), f"{slug}.{slot.name}"


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_examples_and_defaults_never_nest_a_slot(slug: str):
    """R-SLOT-9. The renderer is single-pass, so a `<<NAME>>` inside a default
    ships literally into a live prompt."""
    for slot in SIBLINGS[slug].content.slots:
        for text in (slot.example, str(slot.default or "")):
            assert "<<" not in text, f"{slug}.{slot.name}: nested slot in {text!r}"


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_every_placeholder_is_catalogued_and_every_slot_is_used(slug: str):
    """Both directions. An uncatalogued `<<NAME>>` raises at validate; a
    catalogued slot no prompt uses is a question asked of the operator whose
    answer reaches nothing."""
    template = SIBLINGS[slug]
    catalogued = {slot.name for slot in template.content.slots}
    used = set()
    for field in ("system_prompt", "loop_prompt"):
        used |= set(re.findall(r"<<([A-Z][A-Z0-9_]*)>>", getattr(template.content, field)))
    assert used == catalogued, (
        f"{slug}: placeholders {sorted(used)} != catalogue {sorted(catalogued)}"
    )


# --- prompts -----------------------------------------------------------------


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_loop_prompt_is_within_its_line_ceiling(slug: str):
    """R-PROMPT-7 / R-TEST-2c. Instruction adherence degrades with length, and
    a number in a rulebook nobody measures is a suggestion."""
    lines = SIBLINGS[slug].content.loop_prompt.count("\n") + 1
    ceiling = LOOP_PROMPT_CEILINGS[slug]
    assert lines <= ceiling, f"{slug}: loop prompt is {lines} lines, ceiling {ceiling}"


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_declares_its_precedence_order_once(slug: str):
    """R-PROMPT-8. Contradictory instructions burn reasoning; the fix is a
    stated precedence, and stating it twice reintroduces the contradiction."""
    loop_prompt = SIBLINGS[slug].content.loop_prompt
    assert loop_prompt.lower().count("## direction") == 1, f"{slug}"
    assert "definition" in loop_prompt.lower()


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_prompts_use_only_runner_vars(slug: str):
    """R-PROMPT-9. `{{.Board}}` (a typo for `{{.BoardID}}`) is a Go template
    error at loop time, invisible until a paid iteration runs."""
    allowed = {"Workspace", "BoardID", "AgentID", "ExecutionID", "Iteration"}
    content = SIBLINGS[slug].content
    for field in ("system_prompt", "loop_prompt"):
        used = set(re.findall(r"\{\{\.([A-Za-z_][A-Za-z0-9_]*)", getattr(content, field)))
        assert used <= allowed, f"{slug}.{field}: unknown runner vars {sorted(used - allowed)}"


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_carries_no_customize_markers(slug: str):
    """R-PROMPT-10. `[CUSTOMIZE:` is the retired v1 form — free text where a
    catalogued slot belongs."""
    content = SIBLINGS[slug].content
    for field in ("system_prompt", "loop_prompt"):
        assert "[CUSTOMIZE:" not in getattr(content, field), f"{slug}.{field}"


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_pins_its_pick_and_stop_headings(slug: str):
    """R-PROMPT-3. The scoping tests locate sections by literal heading, not by
    number — the kernels never agreed on numbering."""
    loop_prompt = SIBLINGS[slug].content.loop_prompt
    assert re.search(r"^### \d+\. PICK THE CARD$", loop_prompt, re.M), slug
    assert re.search(r"^### \d+\. STOP$", loop_prompt, re.M), slug


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_renders_with_all_example_values(slug: str):
    """Every slot's `example` is offered to the operator as a starting value,
    so the examples themselves must produce a renderable prompt."""
    template = SIBLINGS[slug]
    result = render(template.content, _all_example_values(template))
    for field in ("system_prompt", "loop_prompt"):
        rendered = getattr(result, field)
        assert "<<" not in rendered, f"{slug}.{field} kept an unrendered slot"
        assert rendered.strip()


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_renders_clean_with_only_required_slots_filled(slug: str):
    """R-TEST-3.8, the prose-seam detector. The real bind path for an operator
    who fills nothing optional: every optional sentence must survive its value
    being empty, leaving no stranded double space or orphaned punctuation."""
    template = SIBLINGS[slug]
    result = render(template.content, _required_only_values(template))

    for field in ("system_prompt", "loop_prompt"):
        rendered = getattr(result, field)
        assert "<<" not in rendered, f"{slug}.{field} kept an unrendered slot"
        in_fence = False
        for number, line in enumerate(rendered.split("\n"), start=1):
            body = line.strip()
            if body.startswith("```"):
                in_fence = not in_fence
                continue
            if in_fence or body.startswith(("|", "-", "*")) or "    " in line:
                continue
            prose = re.sub(r"`[^`]*`", "CODE", body)
            assert "  " not in prose, f"{slug}.{field}:{number}: double space: {line!r}"
            orphan = re.search(r"\s[.,;:]", prose)
            assert orphan is None, (
                f"{slug}.{field}:{number}: punctuation left stranded by an "
                f"empty slot: {line!r}"
            )


# --- tools -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("slug", "extras"),
    [
        (
            "documentator-loop",
            {
                "update_card",
                "create_card",
                "update_note",
                "list_resources",
                "get_resource",
            },
        ),
        (
            "secretary-loop",
            {
                "update_card",
                "update_note",
                "list_activity",
                "get_board_health",
                "get_workspace_metrics",
            },
        ),
    ],
)
def test_sibling_grants_exactly_eighteen_tools(slug: str, extras: set[str]):
    """R-TOOL-4. The count is the review surface, so the literal is pinned:
    13 common + 5 extras (MCP #4 folded the note-write pair into update_note).
    Every tool beyond these is a capability the prompt does not govern."""
    template = SIBLINGS[slug]
    tools = template.content.tools
    assert len(tools) == 18, f"{slug}: expected 18 tools, got {len(tools)}"
    assert len(set(tools)) == len(tools), f"{slug}: duplicate tool in the grant"
    bare = _bare_tools(template)
    assert all(name.startswith("mcp__valaris__") for name in tools)
    assert "set_board_loop" in bare, f"{slug}: off switch missing"
    # The extras beyond COMMON_TOOLS, named so a silent addition fails review.
    assert extras <= bare, f"{slug}: missing {sorted(extras - bare)}"


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_grants_nothing_destructive(slug: str):
    """R-TOOL-3. A misread card must never become data loss, and no sibling
    administers agents or freezes boards."""
    bare = _bare_tools(SIBLINGS[slug])
    assert not {name for name in bare if "delete" in name}, bare
    forbidden = {
        "create_agent",
        "rotate_agent_key",
        "pause_agent",
        "restart_agent",
        "hard_delete_agent",
        "freeze_board",
        "unfreeze_board",
    }
    assert not (forbidden & bare), f"{slug}: {sorted(forbidden & bare)}"


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_excludes_the_pr_landing_tools(slug: str):
    """R-TOOL-5. `enqueue_pr_for_merge` reaches the coding family through the
    LANDING variant only; a repo-less sweep that could enqueue a PR would be
    acting on a repository it is forbidden to touch."""
    bare = _bare_tools(SIBLINGS[slug])
    assert "enqueue_pr_for_merge" not in bare
    assert "enqueue_for_merge" not in bare
    assert "move_card" not in bare, (
        f"{slug}: move_card is withheld — an agent move into a done-typed "
        "column is exactly the pr_url_missing gate-tripping case"
    )


def test_note_writers_grant_update_note_not_the_retired_aliases():
    """MCP #4 folded append_note / replace_note_section into
    update_note(mode=...). Both note-writing siblings grant the folded tool
    and neither grants a deprecated alias (a grant naming one trips the
    runner's deprecated-grant pre-flight). "Never rewrite a page wholesale"
    is a prompt rule in the documentator — the allowlist never backed it,
    since update_note always replaced whole bodies."""
    for template in (DOCUMENTATOR, SECRETARY):
        bare = _bare_tools(template)
        assert "update_note" in bare
        assert "append_note" not in bare
        assert "replace_note_section" not in bare
    assert "wholesale" in DOCUMENTATOR.content.loop_prompt


def test_documentator_cannot_write_resources():
    """The profile and the DOC_SURFACE help both promise resources are
    readable but not editable; the grant is what makes that true."""
    bare = _bare_tools(DOCUMENTATOR)
    assert {"list_resources", "get_resource"} <= bare
    assert "update_resource" not in bare
    assert "create_resource" not in bare


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_every_granted_tool_is_named_by_a_prompt(slug: str):
    """R-TOOL-7, the direction that catches dead grant: an allowlisted tool no
    prompt names is a capability nothing governs. The common read/record core
    is exempt — it is the orientation floor every loop shares."""
    template = SIBLINGS[slug]
    from app.services.loop_templates._types import COMMON_TOOLS

    prompts = template.content.system_prompt + template.content.loop_prompt
    for name in _bare_tools(template) - set(COMMON_TOOLS):
        assert name in prompts, f"{slug}: {name} is granted but no prompt names it"


# --- rails and setup contract ------------------------------------------------


def test_documentator_rails_size_a_cheap_board_only_sweep():
    """R-RAIL-4. rails_defaults apply on FIRST bind only, so these are the
    numbers an operator inherits by not thinking about them. A typo here must
    fail a test rather than a run."""
    rails = DOCUMENTATOR.content.rails_defaults
    assert rails["model"] == "mid"
    assert rails["iteration_delay_seconds"] == 30
    assert rails["iteration_timeout_seconds"] == 1200
    assert rails["budget_usd"] == 40
    assert rails["max_iterations"] == 25
    assert rails["max_consecutive_failures"] == 3
    assert rails["max_blocked_on_human"] == 3
    assert rails["starvation_policy"] == "park"


@pytest.mark.parametrize("slug", sorted(SIBLINGS))
def test_sibling_omits_the_landing_rails(slug: str):
    """R-RAIL-6. `loop_landing` and `merge_gate` are prompt/agent-facing only;
    shipping them on a repo-less template implies a PR flow it does not have."""
    rails = SIBLINGS[slug].content.rails_defaults
    assert "loop_landing" not in rails, slug
    assert "merge_gate" not in rails, slug
    assert "enabled" not in rails, f"{slug}: the operator flips the switch"
    assert "provider" not in rails, f"{slug}: provider is white-label, board-owned"


def test_documentator_ships_no_completion_query():
    """The family rail is WRONG for this loop, so it ships none.

    Its subject is SHIPPED work, so its cards sit in the done column by
    definition. The family's `{label, exclude_column_type: "done"}` query
    therefore matched zero cards on a correctly-labelled board, and
    `loopmode.go:321` disabled the run before iteration 1 — with the whole sweep
    waiting. The honest rail would be label-only, but the platform cannot store
    one: `canonicalize_loop_config` (`loop_config_validation.py:179`) forces the
    exclusion back on and `_completion_query_errors` (`:215`) 422s anything
    else, so writing one here yields the broken shape again, silently.

    Both places a rail can hide are checked: `derived_rails` is what the bind
    step substitutes, `rails_defaults` is what a board inherits.
    """
    assert "completion_query" not in (DOCUMENTATOR.content.derived_rails or {})
    assert "completion_query" not in (DOCUMENTATOR.content.rails_defaults or {})


def test_documentator_verifies_its_own_completion_claim():
    """With no query, `loopmode.go:434` skips the check that refutes a false
    `objective_complete`, so the prompt is the only guard left."""
    result = render(
        DOCUMENTATOR.content,
        {**_all_example_values(DOCUMENTATOR), "RUN_LABEL": "release-probe"},
    )
    stop = _section(result.loop_prompt, "### 4. STOP")
    assert "must re-run" in stop.lower(), (
        "STOP does not make the completion re-check mandatory — an unenforced "
        "'check first' is no guard once the harness stops verifying"
    )
    assert 'search_cards(label="release-probe")' in stop
    assert "exclude_column_type" not in stop, (
        "the verification narrows by column, but a documented card keeps its "
        "place in the done column and loses only its label"
    )


@pytest.mark.parametrize(
    ("slug", "required_columns", "requires_run_label"),
    [
        ("documentator-loop", ["done"], True),
        ("secretary-loop", ["active"], False),
    ],
)
def test_sibling_setup_contract_states_every_key(
    slug: str, required_columns: list[str], requires_run_label: bool
):
    """R-SETUP-1/3/4. The contract drives the fit checklist an operator sees
    BEFORE binding, and `git_repo_bound: False` is what stops the fit check
    demanding a repo it will never use."""
    contract = SIBLINGS[slug].content.setup_contract
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
    assert contract["required_column_types"] == required_columns
    assert contract["requires_run_label"] is requires_run_label
    assert contract["git_repo_bound"] is False
    assert contract["agent_bound_with_tools"] is True
    assert contract["dependencies_server_side"] is False
    assert contract["notes"].strip()
    valid = {"backlog", "active", "review", "done", "blocked"}
    assert set(contract["required_column_types"]) <= valid
    assert set(contract["optional_column_types"]) <= valid


# --- documentator method pins (SPEC §6.7) ------------------------------------


def test_documentator_never_writes_to_a_repository():
    """R-TEST-3.9 / R-TOOL-8. The MCP allowlist does NOT gate shell or file
    access — `--allowedTools` receives only `mcp__valaris__*` ids, while
    Bash/Edit/Read come from the runner's permission mode, which templates do
    not control. The SYSTEM prompt's repo floor is therefore the ONLY control
    stopping this agent cloning a repo and editing files, and this pin exists
    to stop that clause being edited away as redundant."""
    system_prompt = render(
        DOCUMENTATOR.content, _all_example_values(DOCUMENTATOR)
    ).system_prompt.lower()
    assert "never touch a repository" in system_prompt
    assert "never run a command" in system_prompt
    assert "never write code" in system_prompt
    assert not {name for name in _bare_tools(DOCUMENTATOR) if "repo" in name}


def test_documentator_drains_by_consuming_the_label():
    """Without this the loop cannot finish AT ALL.

    Its subject matter is SHIPPED work, and a shipped card already sits in the
    done column — so the `exclude_column_type: "done"` rail would return zero
    at iteration 1 and the loop would report `objective_complete` having done
    nothing. The label is the only real drain: the operator labels shipped
    cards wherever they sit, and RECORD must instruct removing the label as
    each card's documentation is settled.
    """
    loop_prompt = _rendered_documentator("release-probe")
    record = _section(loop_prompt, "### 3. RECORD")
    assert "release-probe" in record, (
        "RECORD never names the run label, so nothing tells the agent to "
        "consume it — the sweep can never drain"
    )
    lowered = record.lower()
    assert "remove" in lowered, "RECORD does not instruct removing the label"

    # And the mechanism must be stated where the operator reads it, not only
    # in the prompt: how_i_end and the RUN_LABEL help are the two surfaces.
    assert "label" in DOCUMENTATOR.profile["how_i_end"].lower()
    run_label_help = next(
        slot.help for slot in DOCUMENTATOR.content.slots if slot.name == "RUN_LABEL"
    ).lower()
    assert "remove" in run_label_help
    assert "done column" in run_label_help


def test_documentator_short_circuit_states_the_label_not_the_column_drains():
    """The trap this template exists to avoid is an operator moving cards out
    of done to make the sweep progress. Section 0 must say plainly that a card
    leaves the set by LOSING ITS LABEL, not by moving column."""
    short_circuit = _section(
        _rendered_documentator("release-probe"), "### 0. RUN-COMPLETE SHORT-CIRCUIT"
    ).lower()
    assert "label" in short_circuit
    assert "column" in short_circuit


def test_documentator_files_a_card_rather_than_editing_code():
    """The repo floor is only half the contract; the other half is where the
    finding GOES. A loop that can see stale documentation in a repository and
    has nowhere to put it will either invent a write path or drop the finding."""
    improve = _section(_rendered_documentator("release-probe"), "### 2. IMPROVE ONE PAGE")
    assert "create_card" in improve, (
        "IMPROVE never names create_card, so in-repository documentation "
        "findings have no route off this loop"
    )


def test_documentator_search_scope_is_the_label_alone():
    """R-PROMPT-6, against the label-only drain this loop actually uses.

    Every `search_cards` the prompt issues must scope on the run label and
    NOTHING else. A column narrowing of any kind — the old
    `exclude_column_type="done"`, or a `column_type=` — hides the done-column
    cards that ARE this loop's subject, so the agent would read an empty sweep
    on a board full of work. The pin parses kwargs rather than prose, because
    the wrong narrowing reads perfectly well.
    """
    result = render(
        DOCUMENTATOR.content,
        {**_all_example_values(DOCUMENTATOR), "RUN_LABEL": "release-probe"},
    )
    calls = re.findall(r"search_cards\(([^)]*)\)", result.loop_prompt, re.DOTALL)
    assert calls, "documentator issues no search_cards call to scope the sweep"
    for call in calls:
        kwargs = dict(re.findall(r'(\w+)\s*=\s*"([^"]*)"', call))
        assert kwargs.get("label") == "release-probe", kwargs
        assert "exclude_column_type" not in kwargs, (
            f"scoping excludes a column: {kwargs} — the done column is where "
            "this loop's subject matter lives"
        )
        assert "column_type" not in kwargs, kwargs


def test_documentator_routes_a_page_by_its_diataxis_type():
    """The method's core move: decide what a page is FOR before touching it.
    A page that is two types at once is the most common finding on any
    project, and the loop must propose the split rather than perform it."""
    improve = _section(
        _rendered_documentator("release-probe"), "### 2. IMPROVE ONE PAGE"
    ).lower()
    for kind in ("tutorial", "how-to", "reference", "explanation"):
        assert kind in improve, f"IMPROVE never names the {kind} page type"
    assert "split" in improve


def test_documentator_changelog_forbids_pasting_a_commit_log():
    """Keep a Changelog's six categories exist for the people who USE the
    thing; a pasted commit log is the failure mode it was written against."""
    improve = _section(_rendered_documentator("release-probe"), "### 2. IMPROVE ONE PAGE")
    for category in ("Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"):
        assert category in improve, f"changelog categories omit {category}"
    assert "commit log" in improve.lower()


def test_documentator_stop_maps_all_four_outcomes():
    """R-STOP-5 in the template's own words, never delegated to a table."""
    stop = _section(_rendered_documentator("release-probe"), "### 4. STOP")
    for outcome in ("worked", "nothing_ready", "blocked_on_human", "objective_complete"):
        assert outcome in stop, f"STOP never maps {outcome}"
    assert "release-probe" in stop, (
        "STOP describes a board-wide completion condition, not the labelled "
        "set the harness measures"
    )
    lowered = stop.lower()
    assert "never" in lowered and "silently" in lowered, "R-STOP-7 closing line missing"


def test_documentator_non_goals_forbid_the_high_blast_radius_moves():
    """R-ESC-7. Both pr-agent and Anthropic's security-review spend more prompt
    budget on exclusions than on detection; these four are the escalations
    R-ESC-3 names for this family."""
    improve = _section(
        _rendered_documentator("release-probe"), "### 2. IMPROVE ONE PAGE"
    ).lower()
    assert "non-goals" in improve
    assert "wholesale" in improve
    assert "reorganize" in improve
    assert "has not shipped" in improve


def _rendered_documentator(run_label: str) -> str:
    """Render with a falsifying RUN_LABEL — deliberately unlike any word the
    kernel already uses, so an assertion that finds it proves substitution
    reached that section rather than matching prose that happened to be there.
    """
    values = {**_all_example_values(DOCUMENTATOR), "RUN_LABEL": run_label}
    return render(DOCUMENTATOR.content, values).loop_prompt


# --- secretary method pins (SPEC §7.7) ---------------------------------------


def _rendered_secretary() -> str:
    return render(SECRETARY.content, _all_example_values(SECRETARY)).loop_prompt


def test_secretary_requires_always_run_starvation_policy():
    """R-RAIL-5, and this template's R-TEST-3.9 pin: the ONE setting whose loss
    makes the loop silently do nothing.

    Under the default `park`, readiness is a ready-card count, so a reporting
    loop on a quiet board parks forever and is misread as having nothing to do.
    It fails healthy, which is why it needs a test and three human surfaces.
    """
    assert SECRETARY.content.rails_defaults["starvation_policy"] == "always_run"
    assert "always_run" in SECRETARY.profile["needs_from_runner"]
    assert "always run" in SECRETARY.profile["when_to_use"].lower()
    assert "always_run" in SECRETARY.content.setup_contract["notes"]


def test_secretary_ships_no_completion_query():
    """R-RAIL-8. A standing loop has no completion condition, and a rail that
    claims one would let the harness disable a loop the operator still wants."""
    assert SECRETARY.content.derived_rails == {}
    assert "completion_query" not in SECRETARY.content.rails_defaults


def test_secretary_cadence_rail_is_a_day():
    """R-RAIL-5b. Under `always_run` the readiness probe is SKIPPED, so this
    rail IS the cadence and every wake costs a session: 3600 would bill 24
    sessions a day to report `nothing_ready` 23 times, contradicting the
    template's own once-a-day cadence copy."""
    rails = SECRETARY.content.rails_defaults
    assert rails["iteration_delay_seconds"] == 86400
    assert rails["max_iterations"] == 30
    assert rails["model"] == "mid"
    assert rails["iteration_timeout_seconds"] == 1200
    assert rails["budget_usd"] == 40
    assert rails["max_consecutive_failures"] == 3
    assert rails["max_blocked_on_human"] == 5


def test_secretary_never_claims_objective_complete():
    """R-STOP-5's standing-family row. The outcome that ends a run is exactly
    the one a stuck agent reaches for, so refusing it must be stated rather
    than left as an omission."""
    stop = _section(_rendered_secretary(), "### 5. STOP")
    assert "objective_complete" in stop, "STOP never mentions the outcome it refuses"
    assert "never" in stop.lower()
    for outcome in ("worked", "nothing_ready", "blocked_on_human"):
        assert outcome in stop, f"STOP never maps {outcome}"
    assert "nothing_ready" in stop
    assert "set_board_loop" in stop, "R-STOP-3: no intent-stop route"


def test_secretary_has_no_run_complete_short_circuit():
    """R-PROMPT-2 / R-RAIL-8. The standing family opens at ORIENT: a
    short-circuit section implies a completion condition it does not have, and
    an agent that found one would stop a loop meant to keep running."""
    loop_prompt = SECRETARY.content.loop_prompt
    assert "RUN-COMPLETE SHORT-CIRCUIT" not in loop_prompt
    assert "search_cards(" not in loop_prompt, (
        "a literal search_cards call implies a completion sweep this loop "
        "does not have"
    )
    assert "RUN_LABEL" not in loop_prompt


def test_secretary_never_writes_to_a_repository():
    """R-TOOL-8, extending the documentator pin: the allowlist does not gate
    shell, so this prompt clause is the only control."""
    system_prompt = render(
        SECRETARY.content, _all_example_values(SECRETARY)
    ).system_prompt.lower()
    assert "never touch a repository" in system_prompt
    assert "never finish" in system_prompt or "no state of this board" in system_prompt


def test_secretary_blocker_contract_names_three_things():
    """The strongest single finding for this profile: a blocker that cannot
    name what is stuck, what is needed, and by when is a planning problem
    being laundered into a report."""
    report = _section(_rendered_secretary(), "### 3. WRITE THE REPORT").lower()
    assert "what is stuck" in report
    assert "what is needed" in report
    assert "by when" in report


def test_secretary_re_surfaces_blockers_that_missed_their_sla():
    """The SLA leg is what separates a secretary from a report generator, and
    it is the one behaviour that depends on ESCALATION_PATH having a value."""
    report = _section(_rendered_secretary(), "### 3. WRITE THE REPORT")
    assert "re-surface" in report.lower() or "resurface" in report.lower()
    escalation = next(
        slot for slot in SECRETARY.content.slots if slot.name == "ESCALATION_PATH"
    )
    assert escalation.required is True, (
        "ESCALATION_PATH optional would leave the SLA leg with no deadline to "
        "measure against, silently degrading the loop to a report generator"
    )


def test_secretary_never_nudges_the_same_card_twice():
    """R-ESC-4, the `remove-stale-when-updated` invariant. A nudge repeated
    with nothing new since is what makes an automated nag unwelcome, and it is
    the failure that gets a standing loop switched off."""
    loop_prompt = SECRETARY.content.loop_prompt + SECRETARY.content.system_prompt
    lowered = loop_prompt.lower()
    assert "twice" in lowered
    assert "new activity" in lowered


def test_secretary_caps_the_quiet_sweep_with_a_numeral():
    """R-ESC-6 / R-PROMPT-11: adjectives don't constrain agents. Without a
    numeral, a first cycle against a large board nudges every participant."""
    report = _section(_rendered_secretary(), "### 3. WRITE THE REPORT")
    assert re.search(r"\b10 cards\b", report), (
        "the quiet sweep states no numeric cap, so a first cycle against a "
        "large board would nudge every card past the threshold at once"
    )


def test_secretary_names_the_metric_tools_it_was_granted():
    """R-TOOL-7 in the other direction. `get_board_health` and
    `get_workspace_metrics` were granted for the periodic review's numbers; a
    grant no prompt names is dead, and the evidence rule this section already
    demands has nowhere to source figures from."""
    report = _section(_rendered_secretary(), "### 3. WRITE THE REPORT")
    assert "get_board_health" in report
    assert "get_workspace_metrics" in report


def test_secretary_non_goals_forbid_deciding_the_work():
    """R-ESC-3's secretary rows: labelling and nudging are automatable,
    closing and reassigning are policy and commit other people's time."""
    report = _section(_rendered_secretary(), "### 3. WRITE THE REPORT").lower()
    assert "non-goals" in report
    assert "reassign" in report
    assert "priority" in report
    assert "close" in report


def test_secretary_update_card_is_scoped_to_labelling():
    """`update_card` is the one write tool that could rewrite a card outright.
    It is granted for labelling a quiet card and nothing else, and the prompt
    is what keeps that honest."""
    loop_prompt = SECRETARY.content.loop_prompt
    assert "update_card" in loop_prompt
    report = _section(loop_prompt, "### 3. WRITE THE REPORT").lower()
    assert "label" in report
