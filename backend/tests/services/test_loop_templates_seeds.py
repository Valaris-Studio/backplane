# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The code-defined system template catalog — SystemTemplate objects, not dicts.

System templates are CODE-DEFINED (spec f52328b3 owner decision Q6), so the
catalog IS the seed data: nothing in the database backstops a malformed one.
These tests are that backstop. They pin the typed shape, the slug/version
lineage, and — for every slotted seed — that `validate_template` finds nothing,
which is the same gate a workspace draft must pass before it can be published.

A seed that fails validation would be listed, offered, bound, and only then
explode at render time on a live board, so the assertion belongs here rather
than at the router.
"""

import re

import pytest

from app.services.loop_template_render import (
    SlotSpec,
    TemplateContent,
    _derived_rail_slots,
    render,
    validate_template,
)
from app.services.loop_templates import (
    LOOP_TEMPLATES,
    SystemTemplate,
    get_system_template,
    list_loop_templates,
)


V1_SLUGS = {"coding-loop-v1", "revision-loop-v1", "triage-loop-v1"}

# Every maintained, slotted template. The catalog outgrew the "v2 trio" it was
# named for: the coding tier became a three-rung ladder and the board-ops family
# gained two members. The name stays because it still means one thing — the
# slotted lineage, as opposed to the retired `-v1` `[CUSTOMIZE:` marker form.
V2_SLUGS = {
    "coding-loop",
    "coding-loop-easy",
    "coding-loop-standard",
    "revision-loop",
    "triage-loop",
    "documentator-loop",
    "secretary-loop",
}

# Scoped by CAPABILITY rather than by lineage, because lineage stopped
# predicting behaviour once the catalog held seven templates: subtraction sets
# derived from "which seed is proven" silently forced "every slot except
# LESSONS is required" and "a completion query exists" onto members for which
# neither is true.

# Kernels that have actually driven completed real runs. Only the advanced
# coding tier qualifies (Loops #1-#7); the guided and standard rungs are
# reductions of it that no run has exercised yet, so they claim `unproven`.
PROVEN_SLUGS = {"coding-loop"}
UNPROVEN_V2_SLUGS = V2_SLUGS - PROVEN_SLUGS

# Templates that carry a `completion_query` derived rail and a RUN_LABEL slot
# feeding it, so "the prompt's scope must equal the completion rail" is a
# meaningful sentence about them. Three members are excluded, for two reasons:
#
#   `secretary-loop` is a STANDING loop by design — `always_run`, no completion
#   query, no run label — so it has no completion condition to express.
#
#   `documentator-loop` and `revision-loop` drain by CONSUMING the run label
#   rather than by moving cards, so their completion is "no card still carries
#   the label" — a label-only query the platform cannot store
#   (`canonicalize_loop_config` forces `exclude_column_type: "done"` back on,
#   and the validator 422s anything else). Rather than ship a rail that means
#   something they can never satisfy, both ship none and verify the claim in
#   their own STOP section. See RAIL_FREE_SLUGS below.
COMPLETING_SLUGS = V2_SLUGS - {
    "secretary-loop",
    "documentator-loop",
    "revision-loop",
}

# Templates that deliberately ship NO completion query. The absence is the
# design, so it is pinned as such: `loopmode.go` skips its verification check
# when the query is nil, which makes each prompt's own re-run the only guard on
# a completion claim.
RAIL_FREE_SLUGS = {"secretary-loop", "documentator-loop", "revision-loop"}

# Templates where every slot the operator sees is required — no defaulted
# strata. The three coding rungs are excluded: each deliberately carries
# optional repo-specific colour (gates, boundaries, landing sub-slots, an
# integration branch) whose surrounding sentences read correctly when empty.
ALL_REQUIRED_SLOT_SLUGS = {
    "revision-loop",
    "triage-loop",
    "documentator-loop",
    "secretary-loop",
}

# The rungs of the coding ladder — the members that clone a repository, run
# gates and open pull requests. Their grants legitimately include the PR tools
# the board-ops family must never receive.
CODING_SLUGS = {"coding-loop", "coding-loop-easy", "coding-loop-standard"}


def _by_slug(slug: str) -> SystemTemplate:
    template = get_system_template(slug)
    assert template is not None, f"{slug} missing from the catalog"
    return template


# --- typed catalog -----------------------------------------------------------


def test_catalog_entries_are_system_templates():
    assert LOOP_TEMPLATES, "catalog is empty"
    for template in LOOP_TEMPLATES:
        assert isinstance(template, SystemTemplate), (
            f"{template!r} is not a SystemTemplate — the catalog must be typed "
            "so the service can union it with DB-backed workspace templates"
        )
        assert isinstance(template.content, TemplateContent)
        assert template.is_system is True


def test_catalog_slugs_are_exactly_the_retired_trio_and_the_maintained_seven():
    """The whole catalog, both lineages, with nothing offered that no set covers.

    Pinning the exact union is what makes a new template a deliberate act: a
    module added to `_MAINTAINED` without being classified into the capability
    sets above fails here first, before it can silently skip the parametrized
    invariants those sets drive.
    """
    assert {t.slug for t in LOOP_TEMPLATES} == V1_SLUGS | V2_SLUGS


def test_catalog_slugs_are_unique():
    slugs = [t.slug for t in LOOP_TEMPLATES]
    assert len(slugs) == len(set(slugs)), f"duplicate slugs: {slugs}"


# Retired, but not frozen: coding-loop-v1 bumped when bundle E removed its
# update_definition instruction and grant, so bound boards see the drift.
V1_VERSIONS = {
    "coding-loop-v1": 2,
    "revision-loop-v1": 1,
    "triage-loop-v1": 1,
}


@pytest.mark.parametrize("slug", sorted(V1_SLUGS))
def test_v1_entries_carry_their_published_version(slug: str):
    assert _by_slug(slug).version == V1_VERSIONS[slug]


# The unversioned slugs are one LINEAGE, not one version number: coding-loop
# moved to 4 when the ladder gave it a rung name and a profile pass, and the two
# board-ops sweeps to 3 when they gained full profiles, rails defaults and the
# four-outcome STOP contract. The coding ladder and the revision sweep each
# bumped once more when they gained the skills distill-and-propose stratum.
# coding-loop, coding-loop-standard and documentator-loop bumped again when
# bundle E removed every direct definition-write instruction and grant.
# documentator-loop and secretary-loop bumped when MCP #4 folded
# append_note / replace_note_section into update_note(mode=...); secretary
# again when get_workspace_velocity folded into get_workspace_metrics.
V2_VERSIONS = {
    "coding-loop": 8,
    "coding-loop-easy": 3,
    "coding-loop-standard": 4,
    "revision-loop": 4,
    "triage-loop": 3,
    "documentator-loop": 3,
    "secretary-loop": 3,
}


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_v2_entries_carry_their_published_version(slug: str):
    assert _by_slug(slug).version == V2_VERSIONS[slug]


def test_get_system_template_returns_none_for_unknown_slug():
    assert get_system_template("no-such-loop") is None


def test_get_system_template_does_not_match_on_prefix():
    """`revision-loop` and `revision-loop-v1` are distinct templates, and a
    lookup that matched loosely would bind a board to a template nobody named.

    Asserting only that the two full slugs resolve correctly is not enough: a
    prefix-matching lookup satisfies that too, because the exact slug is its own
    prefix. The falsifying probe is a TRUNCATED slug, which must miss.
    """
    assert _by_slug("revision-loop").version == V2_VERSIONS["revision-loop"]
    assert _by_slug("revision-loop-v1").version == 1

    for truncated in ("revision", "revision-loop-", "triage", "coding", "r", ""):
        assert (
            get_system_template(truncated) is None
        ), f"{truncated!r} resolved to a template — lookup must be exact"


def test_get_system_template_does_not_match_on_suffix_or_substring():
    for probe in ("loop", "-v1", "revision-loop-v2", "REVISION-LOOP"):
        assert get_system_template(probe) is None, probe


# --- listing vs resolution ---------------------------------------------------


@pytest.mark.parametrize("slug", sorted(V1_SLUGS))
def test_unlisted_v1_resolvable_not_listed(slug: str):
    """The `-v1` lineage is UNLISTED, not deleted (card p3-10 direction).

    The bind step made the legacy chooser path unreachable, so listing the
    deprecated trio only clutters the catalog — but a board bound to a `-v1`
    slug during the transition still needs `get_system_template` to resolve it,
    or its drift lookup 404s instead of reporting drift.
    """
    template = _by_slug(slug)
    assert template.listed is False, f"{slug} must be flagged unlisted"
    assert slug not in {entry["id"] for entry in list_loop_templates()}


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_maintained_v2_entries_stay_listed(slug: str):
    """The half of the flag that keeps the catalog non-empty: unlisting the
    whole catalog would satisfy the `-v1` assertion above just as well."""
    assert _by_slug(slug).listed is True
    assert slug in {entry["id"] for entry in list_loop_templates()}


def test_listed_defaults_to_true_for_new_templates():
    """A template author who says nothing gets a LISTED template: the flag
    exists to retire a lineage, and a default of False would silently hide
    every future seed from the catalog."""
    probe = SystemTemplate(
        slug="probe-loop",
        version=1,
        name="Probe",
        content=_by_slug("coding-loop").content,
    )
    assert probe.listed is True


# --- ordering ----------------------------------------------------------------


def test_list_order_is_by_name_within_the_listed_generation():
    listed = [entry["id"] for entry in list_loop_templates()]
    names = [_by_slug(slug).name for slug in listed]
    assert names == sorted(names), names


# --- validation --------------------------------------------------------------


@pytest.mark.parametrize("slug", sorted(V1_SLUGS | V2_SLUGS))
def test_every_seed_validates_clean(slug: str):
    """Not just the slotted ones: an unpublishable seed is a bug in any
    generation, and the v1 trio must keep its off-switch tool too."""
    errors = validate_template(_by_slug(slug).content)
    assert errors == [], [(e["code"], e["field"], e["message"]) for e in errors]


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_v2_seeds_have_slots(slug: str):
    template = _by_slug(slug)
    assert template.content.slots, f"{slug} v2 carries no slots"
    assert template.has_slots is True


@pytest.mark.parametrize("slug", sorted(V1_SLUGS))
def test_v1_seeds_have_no_slots(slug: str):
    """The v1 trio keeps its free-text `[CUSTOMIZE:` markers, so the legacy raw
    dialog can still apply it — has_slots is what gates that.

    BOTH prompts carry markers, and both must keep them: a v1 template whose
    system prompt quietly lost its customization point still reports
    has_slots=False, so the raw dialog would offer an un-customizable prompt
    with nothing to signal the loss.
    """
    template = _by_slug(slug)
    assert template.content.slots == []
    assert template.has_slots is False
    for field in ("system_prompt", "loop_prompt"):
        assert "[CUSTOMIZE:" in getattr(
            template.content, field
        ), f"{slug}.{field} lost its customization marker"


def test_has_slots_is_derived_from_the_prompt_text_not_the_slot_list():
    """A hand-kept flag drifts; the marker must read the real prompt grammar."""
    slotted = SystemTemplate(
        slug="probe",
        version=1,
        name="Probe",
        profile={},
        content=TemplateContent(
            system_prompt="Ship <<CARD_ID>> today.",
            loop_prompt="no slots",
            slots=[SlotSpec(name="CARD_ID", kind="scalar")],
        ),
    )
    assert slotted.has_slots is True

    lowercase = SystemTemplate(
        slug="probe",
        version=1,
        name="Probe",
        profile={},
        content=TemplateContent(
            system_prompt="Lowercase <<slot>> and bare << >> are not the grammar.",
            loop_prompt="no slots",
        ),
    )
    assert lowercase.has_slots is False


def test_has_slots_reads_the_loop_prompt_too():
    template = SystemTemplate(
        slug="probe",
        version=1,
        name="Probe",
        profile={},
        content=TemplateContent(
            system_prompt="no slots",
            loop_prompt="Iterate on <<RUN_LABEL>>.",
            slots=[SlotSpec(name="RUN_LABEL", kind="scalar")],
        ),
    )
    assert template.has_slots is True


# --- slot quality ------------------------------------------------------------


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_every_v2_slot_documents_itself(slug: str):
    """help/example are what the P3 slot form and its tooltips render — an
    undocumented slot ships an operator a blank box with no idea what to type."""
    for slot in _by_slug(slug).content.slots:
        assert slot.help.strip(), f"{slug}.{slot.name}: empty help"
        assert slot.example.strip(), f"{slug}.{slot.name}: empty example"
        assert slot.label.strip(), f"{slug}.{slot.name}: empty label"


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_v2_seeds_keep_no_customize_markers(slug: str):
    """The whole point of v2: every `[CUSTOMIZE:` free-text marker became a
    real, catalogued, fillable slot."""
    content = _by_slug(slug).content
    for field in ("system_prompt", "loop_prompt"):
        assert "[CUSTOMIZE:" not in getattr(content, field), f"{slug}.{field}"


# --- setup contract & rails --------------------------------------------------

# The real column-type enum (models/kanban/column.py). "To Do"/"In Progress"
# are column NAMES and are never valid here.
COLUMN_TYPES = {"backlog", "active", "review", "done", "blocked"}


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_setup_contract_uses_real_column_types(slug: str):
    contract = _by_slug(slug).content.setup_contract
    assert contract.get("required_column_types"), f"{slug}: no required columns"
    for key in ("required_column_types", "optional_column_types"):
        declared = set(contract.get(key, []))
        assert declared <= COLUMN_TYPES, (
            f"{slug}.{key} names something that is not a column TYPE: "
            f"{sorted(declared - COLUMN_TYPES)}"
        )


@pytest.mark.parametrize("slug", sorted(COMPLETING_SLUGS))
def test_slots_feeding_a_rail_are_required(slug: str):
    """A slot the derived rails read must be required.

    An optional RUN_LABEL renders to the empty string, so `completion_query`
    ships `label: ""` — a query that matches nothing. The harness would then
    never see the run finish and the loop would burn its whole budget rail.
    Every other rail-feeding slot has the same hazard.
    """
    template = _by_slug(slug)
    rail_slots = _derived_rail_slots(template.content.derived_rails)
    assert rail_slots, f"{slug}: no slot reaches derived_rails"

    by_name = {slot.name: slot for slot in template.content.slots}
    for name in rail_slots:
        assert by_name[name].required is True, (
            f"{slug}.{name} feeds derived_rails but is optional — it would "
            "render empty and silently break the rail"
        )


@pytest.mark.parametrize("slug", sorted(ALL_REQUIRED_SLOT_SLUGS))
def test_no_slot_renders_an_empty_hole(slug: str):
    """The rule these seeds actually need: no slot may render a gap.

    This replaces `required is (name != "LESSONS")`, which stated the rule as a
    fact about one slot name and was violated the moment four templates shipped
    a real default (triage's PRIORITY_SCALE, revision's FINDINGS_CAP,
    documentator's STALE_SIGNALS, secretary's QUIET_THRESHOLDS). Each of those
    is optional on purpose — a shippable answer is already filled in — and none
    of them leaves a hole. The restated rule is strictly stronger: it admits a
    defaulted slot only when the default is real, and it still rejects the
    failure the old assertion was written to catch, an optional slot whose
    absent value strands the sentence around it.

    A slot passes on exactly one of three grounds:
      (a) it is `required`, so the operator must answer it;
      (b) it is optional with a NON-EMPTY default, so the render always has
          prose; or
      (c) it is optional with `default=""` and its placeholder sits ALONE on its
          line, so renderer Rule 4a drops the whole line cleanly.
    """
    template = _by_slug(slug)
    prompts = (template.content.system_prompt, template.content.loop_prompt)

    for slot in template.content.slots:
        if slot.required:
            continue
        assert slot.default is not None, (
            f"{slug}.{slot.name} is optional with no default at all — it "
            "renders as a literal gap in the method text"
        )
        if str(slot.default).strip():
            continue
        placeholder = f"<<{slot.name}>>"
        for prompt in prompts:
            for line in prompt.splitlines():
                if placeholder in line:
                    assert line.strip() == placeholder, (
                        f"{slug}.{slot.name} defaults to empty but shares a "
                        f"line with other prose ({line.strip()!r}): the "
                        "renderer cannot drop the line, so the empty value "
                        "strands the sentence around it"
                    )


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_optional_slots_carry_a_default(slug: str):
    """An optional slot with no default renders as a literal gap rather than
    the empty section the prompt intends."""
    for slot in _by_slug(slug).content.slots:
        if not slot.required:
            assert slot.default is not None, f"{slug}.{slot.name}"


@pytest.mark.parametrize("slug", sorted(COMPLETING_SLUGS))
def test_derived_rails_render_a_usable_completion_query(slug: str):
    """derived_rails is what tells the harness the run is over. If the slot
    never substitutes, `label` ships a literal `<<RUN_LABEL>>`, the query
    matches nothing, and the loop runs until the budget rail kills it."""
    template = _by_slug(slug)
    values = {slot.name: slot.example for slot in template.content.slots}
    result = render(template.content, values)

    completion_query = result.rails["completion_query"]
    assert completion_query["exclude_column_type"] == "done"
    label = completion_query["label"]
    assert "<<" not in label, f"{slug}: unsubstituted slot in completion_query"
    assert label == values["RUN_LABEL"]


def _rendered_loop_prompt(slug: str, run_label: str) -> str:
    """Render a seed with a falsifying RUN_LABEL.

    The label is deliberately UNLIKE any word the kernel already uses, so an
    assertion that finds it proves substitution reached that section rather
    than matching prose that happened to be there.
    """
    template = _by_slug(slug)
    values = {slot.name: slot.example for slot in template.content.slots}
    values["RUN_LABEL"] = run_label
    return render(template.content, values).loop_prompt


def _section(loop_prompt: str, heading: str) -> str:
    """The body of one `### N. HEADING` section, up to the next `###`."""
    start = loop_prompt.index(heading)
    rest = loop_prompt[start + len(heading) :]
    end = rest.find("\n### ")
    return rest if end == -1 else rest[:end]


@pytest.mark.parametrize(
    ("slug", "pick_heading"),
    [
        ("revision-loop", "### 1. PICK THE CARD"),
        ("triage-loop", "### 1. PICK THE CARD"),
    ],
)
def test_pick_section_filters_by_the_rendered_run_label(slug: str, pick_heading: str):
    """RUN_LABEL claims to scope the run, and `completion_query` honours that.

    The PICK instruction must honour the SAME set: a sweep that selects from
    the whole board while the harness measures completion over one label lets
    the agent edit cards outside its program and still never converge. Naming
    the label in the preamble is not enough — the selection step is where a
    memoryless session decides what to touch.

    The coding loop is asserted separately: it enumerates its scope once in the
    short-circuit section and PICKS FROM THAT RESULT, so the operable filter
    lives one section earlier by design.
    """
    pick = _section(_rendered_loop_prompt(slug, "scope-probe"), pick_heading)
    assert "scope-probe" in pick, (
        f"{slug}: PICK does not mention the rendered run label — selection is "
        "board-wide while the completion rail is label-scoped"
    )
    assert 'label="scope-probe"' in pick, (
        f"{slug}: PICK mentions the label but not as an operable filter "
        '(expected a literal label="scope-probe" argument)'
    )


def test_coding_loop_picks_from_the_labelled_set_it_enumerated():
    """Same invariant, the coding loop's shape.

    It issues ONE operable `search_cards(label=…)` in the short-circuit section
    and then selects from that result, so requiring a second call inside PICK
    would be redundant. What must hold is the chain: the enumerating call is
    label-scoped, and PICK visibly draws from it rather than from the board.
    A PICK that silently re-widened to the whole board would let the agent work
    cards the completion rail never measures.
    """
    prompt = _rendered_loop_prompt("coding-loop", "scope-probe")

    short_circuit = _section(prompt, "### 0. RUN-COMPLETE SHORT-CIRCUIT")
    assert 'label="scope-probe"' in short_circuit, (
        "the enumerating call is not label-scoped — the agent would survey the "
        "whole board while the rail measures one label"
    )

    pick = _section(prompt, "### 2. PICK THE CARD")
    assert "scope-probe" in pick, "PICK lost the run label entirely"

    # Bound to the SELECTION sentence, not the section. The section mentions
    # §0 three more times (the position tie-break, the uuid note, the
    # completion check), so a section-wide search for "§0" stays green while
    # the one clause that sources the candidate set is rewritten to "From the
    # board" — which is precisely the widening this test exists to catch.
    selection = re.search(r"take the ONE highest-priority card", pick)
    assert selection is not None, "PICK no longer states a selection rule"
    sentence_start = pick.rfind("\n\n", 0, selection.start())
    sentence = pick[sentence_start : selection.end()]
    assert "§0" in sentence, (
        "PICK selects from something other than the enumerated §0 result set "
        f"— nothing ties its candidates to the completion rail: {sentence!r}"
    )


# Each seed numbers its own sections — the coding loop carries a short-circuit
# and a repo-setup stratum the sweeps do not — so the invariant is pinned by
# HEADING per slug rather than by a number the kernels never agreed on.
SCOPING_SECTIONS = {
    "coding-loop": ("### 2. PICK THE CARD", "### 6. STOP"),
    "coding-loop-easy": ("### 2. PICK THE CARD", "### 6. STOP"),
    "coding-loop-standard": ("### 2. PICK THE CARD", "### 6. STOP"),
    "revision-loop": ("### 1. PICK THE CARD", "### 4. STOP"),
    "triage-loop": ("### 1. PICK THE CARD", "### 4. STOP"),
    "documentator-loop": ("### 1. PICK THE CARD", "### 4. STOP"),
    # Registered for its HEADINGS only. The secretary is a standing loop with no
    # run label and no completion query, so the two run-label assertions below
    # are meaningless for it and it is excluded from them via COMPLETING_SLUGS.
    # It still belongs in this table: the guard's whole job is to make a new
    # seed a deliberate entry rather than a silent absence.
    "secretary-loop": ("### 2. PICK THE CARD", "### 5. STOP"),
}


def test_every_v2_seed_declares_its_scoping_sections():
    """Guards the table above, in two directions.

    Membership alone stopped being enough once one member (the secretary) is in
    the table but excluded from the assertions it drives: "everyone here is
    measured" became untrue of its own table, and a guard that asserts a false
    sentence guards nothing. So assert both halves — nobody is silently ABSENT,
    and everybody who IS measured is present with real headings, which is what
    a new completing seed would otherwise skip.
    """
    assert set(SCOPING_SECTIONS) == V2_SLUGS, (
        "a maintained seed is missing from the scoping table and would "
        "silently skip the run-label scoping assertions"
    )
    assert COMPLETING_SLUGS <= set(SCOPING_SECTIONS), (
        "a seed with a completion query has no scoping headings pinned"
    )
    for slug, (pick, stop) in SCOPING_SECTIONS.items():
        prompt = _by_slug(slug).content.loop_prompt
        assert pick in prompt, f"{slug}: no {pick!r} heading"
        assert stop in prompt, f"{slug}: no {stop!r} heading"


@pytest.mark.parametrize("slug", sorted(COMPLETING_SLUGS))
def test_stop_condition_is_scoped_to_the_rendered_run_label(slug: str):
    """The prompt's own completion test must describe the same card set as
    `derived_rails.completion_query`, or the agent stops on a board-wide
    condition the harness never agrees with."""
    _, stop_heading = SCOPING_SECTIONS[slug]
    stop = _section(_rendered_loop_prompt(slug, "scope-probe"), stop_heading)
    assert "scope-probe" in stop, (
        f"{slug}: STOP describes a board-wide completion condition, not the "
        "labelled set the harness measures"
    )


# Which loops enumerate their scope in PICK itself, rather than one section
# earlier. The coding rungs and the documentator run a §0 short-circuit and then
# pick from ITS result set, so their PICK section legitimately names no label —
# `test_prompt_search_scope_is_set_equivalent_to_the_completion_rail` is what
# holds their scoping, over the whole prompt.
FILTERS_IN_PICK = {"revision-loop", "triage-loop"}


@pytest.mark.parametrize("slug", sorted(COMPLETING_SLUGS))
def test_run_label_scoping_survives_a_label_that_is_not_the_example(slug: str):
    """Pins substitution rather than prose: a second, different label must
    reach the scoping sections and the example label must not linger."""
    prompt = _rendered_loop_prompt(slug, "zzz-other-run")
    headings = SCOPING_SECTIONS[slug]
    if slug not in FILTERS_IN_PICK:
        headings = headings[1:]  # STOP only; PICK inherits §0's enumerated set
    for heading in headings:
        body = _section(prompt, heading)
        assert "zzz-other-run" in body, f"{slug}: {heading} lost the run label"
    assert "zzz-other-run" in prompt
    assert "scope-probe" not in prompt


def test_revision_pick_keeps_its_ordering_rule_and_the_active_agent_skip():
    """Scoping the sweep must not cost the ordering rule or the safety skip.

    v3 states the order as "carried the label longest" rather than v2's
    "audited longest ago": once an audited card LOSES the label, every card
    still in the sweep is by definition un-audited, so ordering by audit
    history would rank a set whose members all have the same history. The
    invariant is unchanged — oldest waiting first, and never audit under a
    working agent's feet.
    """
    pick = _section(
        _rendered_loop_prompt("revision-loop", "scope-probe"), "### 1. PICK THE CARD"
    )
    assert "longest" in pick, "PICK lost its oldest-waiting-first ordering rule"
    assert "In\nProgress" in pick or "In Progress" in pick


def test_triage_pick_keeps_newest_untriaged_in_the_backlog_column():
    pick = _section(
        _rendered_loop_prompt("triage-loop", "scope-probe"), "### 1. PICK THE CARD"
    )
    assert "newest un-triaged" in pick
    assert "Backlog" in pick


# --- completion invariant: the prompt's own query must BE the harness rail ----

# `search_cards(..., label="x", exclude_column_type="done")` → the kwargs the
# prompt actually instructs the agent to send. Only the scoping keys matter, so
# a leading `...,` and whitespace/newlines between arguments are tolerated.
_SEARCH_CALL = re.compile(r"search_cards\(([^)]*)\)", re.DOTALL)
_SEARCH_KWARG = re.compile(r'(\w+)\s*=\s*"([^"]*)"')


def _search_scopes(text: str) -> list[dict[str, str]]:
    """Every search_cards(...) call in `text`, as its literal string kwargs."""
    return [
        dict(_SEARCH_KWARG.findall(call.group(1)))
        for call in _SEARCH_CALL.finditer(text)
    ]


@pytest.mark.parametrize("slug", sorted(COMPLETING_SLUGS))
def test_prompt_search_scope_is_set_equivalent_to_the_completion_rail(slug: str):
    """The harness and the agent must measure the SAME card set.

    `derived_rails.completion_query` is what the runner evaluates to decide the
    run is over; the prompt's own `search_cards` call is what the agent
    evaluates. If they describe different sets the loop cannot terminate: a
    card the agent considers out of scope keeps the harness query non-zero
    forever, and the run burns to the budget rail.

    Asserting the label STRING appears in the section is not enough — that
    passes while the two queries still select different columns. This compares
    the parsed query FIELDS.
    """
    template = _by_slug(slug)
    values = {slot.name: slot.example for slot in template.content.slots}
    values["RUN_LABEL"] = "scope-probe"
    result = render(template.content, values)

    rail = result.rails["completion_query"]
    scopes = _search_scopes(result.loop_prompt)
    assert scopes, f"{slug}: prompt issues no search_cards call to scope the sweep"

    for scope in scopes:
        assert scope.get("label") == rail["label"], (
            f"{slug}: a prompt search_cards scopes label={scope.get('label')!r} "
            f"while the rail measures {rail['label']!r}"
        )
        assert scope.get("exclude_column_type") == rail["exclude_column_type"], (
            f"{slug}: a prompt search_cards scopes "
            f"{ {k: v for k, v in scope.items() if k != 'label'} } while the rail "
            f"measures exclude_column_type={rail['exclude_column_type']!r} — the "
            "agent and the harness cannot agree the run is finished"
        )
        assert "column_type" not in scope, (
            f"{slug}: prompt narrows the sweep with column_type="
            f"{scope['column_type']!r}, which the closed completion-query "
            "grammar cannot express — the rail would stay non-zero"
        )


def test_triage_consumes_the_run_label_so_the_rail_can_reach_zero():
    """Triage never MOVES cards — it normalizes them in place.

    So with a non-Done-scoped rail the label itself is the only thing that can
    drain the query. Normalization must therefore REMOVE the label; otherwise
    every card triage successfully finishes still matches the rail and the run
    never completes.
    """
    prompt = _rendered_loop_prompt("triage-loop", "scope-probe")
    normalize = _section(prompt, "### 2. NORMALIZE")
    assert "scope-probe" in normalize, (
        "NORMALIZE never mentions the run label, so nothing tells the agent to "
        "consume it — the completion rail can never reach zero"
    )
    assert "remove" in normalize.lower(), (
        "NORMALIZE mentions the label but does not instruct REMOVING it; "
        "triage moves no cards, so an un-consumed label pins the rail non-zero"
    )


def test_triage_keeps_the_label_on_cards_it_could_not_finish():
    """Consumption must be conditional on SUCCESS.

    An unconditional "remove the label" would drain the rail for a card the
    agent parked as `needs-author` — the run would report complete with
    un-normalized intake still on the board. The partial path is the half that
    makes the marker honest, so it needs its own pin.
    """
    normalize = _section(
        _rendered_loop_prompt("triage-loop", "scope-probe"), "### 2. NORMALIZE"
    )
    assert "needs-author" in normalize, (
        "NORMALIZE lost the could-not-finish path; the label would be consumed "
        "unconditionally and the run could report complete with intake left"
    )
    assert "keep `scope-probe`" in normalize, (
        "NORMALIZE does not tell the agent to KEEP the run label on a card it "
        "could not finish — that card silently leaves the sweep"
    )
    # The removal must also be guarded at the point of instruction: an
    # unconditional "remove the label" reads as always-consume even with the
    # needs-author sentence present two lines later.
    removal = normalize[normalize.index("**remove") - 80 : normalize.index("**remove")]
    assert "workable" in removal, (
        "label removal is stated unconditionally; it must be gated on the card "
        "actually being workable, or parked cards drain the completion rail"
    )


def test_triage_split_slices_inherit_the_run_label():
    """Splitting is the one place triage CREATES intake.

    A slice born without the label is never swept and never normalized, yet the
    parent's consumption still drains the rail — the run reports complete over
    cards no one triaged.
    """
    normalize = _section(
        _rendered_loop_prompt("triage-loop", "scope-probe"), "### 2. NORMALIZE"
    )
    # Bound the slice to the split BULLET. Reading to the end of the section
    # would run into the label-consumption paragraph, whose own `scope-probe`
    # satisfies the assertion no matter what the split rule says.
    split = normalize[normalize.index("split") :]
    split = split[: split.index("\n\n")]
    assert "scope-probe" in split, (
        "cards created by a split do not inherit the run label, so the slices "
        "escape the sweep while the rail still reaches zero"
    )


def test_triage_run_label_slot_help_tells_operators_the_label_is_consumed():
    """The operator picks this value at bind time and sees only the slot help.

    A label that silently disappears from their cards is surprising unless the
    help says so — the card requires this prose explicitly.
    """
    help_text = next(
        slot.help
        for slot in _by_slug("triage-loop").content.slots
        if slot.name == "RUN_LABEL"
    )
    assert "remov" in help_text.lower(), (
        "RUN_LABEL help does not tell the operator the label is consumed on "
        "normalization, so the disappearing label looks like data loss"
    )


def test_triage_setup_contract_documents_the_label_consumption_invariant():
    """The setup contract is what the fit/preview surfaces show an operator
    BEFORE binding. It described only the column requirements while the thing
    that actually ends the run — label consumption — went unstated."""
    notes = _by_slug("triage-loop").content.setup_contract["notes"].lower()
    assert "consumed" in notes or "consumes" in notes, (
        "setup contract does not state that the run label is consumed on "
        "normalization, so an operator cannot tell what drains the rail"
    )
    assert "outside backlog" in notes or "outside a backlog" in notes, (
        "setup contract does not say labelled cards outside backlog are still "
        "handled, the case that silently wedged the run"
    )


def test_triage_preamble_declares_the_label_is_consumed():
    """A memoryless session reads the preamble before it reads step 2. The
    marker semantics belong there, not only at the point of mutation."""
    prompt = _rendered_loop_prompt("triage-loop", "scope-probe")
    preamble = prompt[: prompt.index("### 1. PICK")]
    assert "marker" in preamble.lower(), (
        "the preamble never tells the agent the label is a consumable intake "
        "marker rather than a permanent tag"
    )


def test_triage_handles_labelled_cards_outside_backlog_instead_of_ignoring_them():
    """A labelled card sitting in active/review/blocked matches the rail but is
    not valid intake. Silently skipping it is the exact wedge this card fixes:
    PICK finds nothing while the harness still sees a non-empty query."""
    pick = _section(_rendered_loop_prompt("triage-loop", "scope-probe"), "### 1. PICK")
    assert "backlog" in pick.lower(), "PICK lost the valid-intake column rule"

    # Naming the out-of-backlog case is not a handler: the wedge is the agent
    # doing NOTHING with such a card while it still counts against the rail. So
    # assert the disposition — that PICK forbids skipping it and routes it into
    # normalization — not merely that the situation is mentioned.
    assert "skip" in pick.lower(), (
        "PICK describes labelled cards outside backlog but never forbids "
        "skipping them — a skipped card keeps the completion rail non-zero "
        "forever with no handler"
    )
    assert "normalize it" in pick.lower(), (
        "PICK does not route a labelled non-backlog card into normalization, "
        "so nothing consumes its label and the sweep cannot finish"
    )


# --- terminal dispositions: every non-empty rail result must have an exit -----

# PR #182 made PICK and the rail measure the same set. That is necessary but not
# sufficient: a card can match the rail while PICK has no candidate to select and
# STOP's only condition is false. Each test below pins one such path to a
# concrete action or a terminal human stop, never a no-candidate fallthrough.


def test_triage_rereads_a_logged_card_that_still_carries_the_label():
    """The `needs-author` idle loop.

    Iteration N parks card C as `needs-author`, keeps the label (correctly), and
    records C in its Triage log. Iteration N+1 searches the rail and receives C
    — but C is no longer "un-triaged", so the newest-un-triaged rule selects
    nothing while the rail stays non-zero. Nobody re-reads C after the author
    answers, so the loop spins forever. PICK must therefore treat a still-
    labelled logged card as a candidate again, not as already handled.
    """
    pick = _section(
        _rendered_loop_prompt("triage-loop", "scope-probe"), "### 1. PICK THE CARD"
    )
    assert "scope-probe" in pick, "PICK lost the run-label scoping"

    # The re-read rule must be gated on the card STILL CARRYING the label — a
    # rule that re-reads every logged card would re-triage finished work. So
    # assert the guard, not merely that re-reading is mentioned somewhere.
    assert "still carries" in pick.lower(), (
        "PICK never re-reads a card its own Triage log already recorded, or "
        "re-reads without gating on the card still carrying the marker: a card "
        "parked `needs-author` is permanently un-selectable while it still "
        "matches the completion rail — a deterministic idle loop"
    )

    para = pick[pick.index("A card your Triage log ALREADY recorded") :]
    end = para.find("\n\n")
    para = (para if end == -1 else para[:end]).lower()
    assert "needs-author" in para, (
        "the re-read paragraph does not name the parked case it must "
        "re-consider; the log-based 'un-triaged' filter silently excludes "
        "exactly those cards"
    )


def test_triage_resumes_normalization_once_the_author_answered():
    """Re-reading is only half an exit — the resumed card must be able to LEAVE.

    If the author supplied the missing context, the card is now workable, so the
    normal path applies: normalize it and consume the marker. Without this the
    re-read is a read-only visit and the rail still never drains.
    """
    prompt = _rendered_loop_prompt("triage-loop", "scope-probe")
    pick = _section(prompt, "### 1. PICK THE CARD")

    # Bound to the re-read PARAGRAPH. PICK's out-of-backlog paragraph already
    # says "normalize it in place", so a section-wide search for the resume
    # route is satisfied by prose about a different case entirely — a mutant
    # that replaced the resume with "note that in your Triage log" passed this
    # test (M12).
    para = pick[pick.index("A card your Triage log ALREADY recorded") :]
    end = para.find("\n\n")
    para = (para if end == -1 else para[:end]).lower()

    assert "answered" in para or "supplied" in para or "resolved" in para, (
        "the re-read paragraph never says what to do when the author HAS "
        "answered, so the card is revisited without ever resuming"
    )
    assert "normalize" in para and "consume the marker" in para, (
        "the re-read paragraph does not route the resumed card back into "
        "normalization AND marker consumption, so re-reading is a read-only "
        "visit and the completion rail stays non-zero"
    )


def _outcome_bullet(prompt: str, outcome: str, stop_heading: str = "### 4. STOP") -> str:
    """One structured-outcome bullet out of the STOP section, alone.

    Bounded to its own bullet on purpose. Reading the whole STOP section makes
    these assertions unfalsifiable: the neighbouring outcomes discuss the same
    residuals, and `set_board_loop` appears in the intent-stop paragraph — so a
    mutant that guts one outcome's own disposition still satisfies a
    section-wide grep. (Mutants M5 and M7 both survived exactly that way before
    this helper existed.)
    """
    stop = _section(prompt, stop_heading)
    marker = f"`{outcome}`"
    start = stop.index(f"- **{marker}**")
    rest = stop[start + 1 :]
    end = rest.find("\n- **`")
    return rest if end == -1 else rest[:end]


def test_triage_reports_outcomes_instead_of_disabling_itself():
    """The structured outcome IS the harness contract, and v2 did not honour it.

    v2's STOP told the agent to call `set_board_loop(enabled=false)` for
    completion. Three things break when it does: the harness gets no outcome to
    parse and loses its park backstop; the stop is the agent's word rather than
    the completion query's, which the runner re-runs precisely to verify; and a
    blocked-on-human state is converted into a terminal one, bypassing the
    `max_blocked_on_human` rail entirely. So the four outcomes must be named in
    the template's own words, and completion must NOT route through the off
    switch.
    """
    stop = _section(_rendered_loop_prompt("triage-loop", "scope-probe"), "### 4. STOP")
    for outcome in ("worked", "nothing_ready", "blocked_on_human", "objective_complete"):
        assert f"`{outcome}`" in stop, (
            f"STOP never names the `{outcome}` outcome, so the agent has no "
            "word for that state and the harness receives nothing to parse"
        )

    completion = _outcome_bullet(
        _rendered_loop_prompt("triage-loop", "scope-probe"), "objective_complete"
    )
    assert "set_board_loop" not in completion or "do NOT call" in completion, (
        "the completion outcome instructs set_board_loop — self-executed "
        "completion, which strips the harness of the verification query it "
        "re-runs to check the claim"
    )
    assert "verif" in completion.lower(), (
        "the completion outcome never says the harness VERIFIES the claim, so "
        "an agent has no reason to re-run the query before claiming"
    )


def test_triage_stops_for_a_human_when_only_parked_intake_remains():
    """The terminal exit for residual A.

    If the only cards left on the rail are ones waiting on their author, the
    loop cannot make progress and must not keep spending iterations. Ending the
    iteration "normally" is the money-loop: the harness sees a non-empty query
    and respawns. So the blocked outcome must enumerate this residual by name.
    """
    bullet = _outcome_bullet(
        _rendered_loop_prompt("triage-loop", "scope-probe"), "blocked_on_human"
    )
    assert "needs-author" in bullet.lower(), (
        "the blocked-on-human outcome does not enumerate author-parked cards; "
        "the agent has no word for that state and the loop is respawned forever"
    )


def test_triage_never_mutates_a_labelled_untyped_card():
    """Residual B: untyped columns are human-only.

    `search_cards(label=..., exclude_column_type="done")` keeps untyped cards
    (repository default `include_untyped=True`), and the runner's completion
    probe sends no `include_untyped` at all, so such a card counts against the
    rail. But the MCP contract forbids an autonomous agent from acting on it.
    The prompt must name the case and forbid the mutation, or the agent either
    violates the boundary or wedges.
    """
    prompt = _rendered_loop_prompt("triage-loop", "scope-probe")
    pick = _section(prompt, "### 1. PICK THE CARD")
    lowered = pick.lower()
    assert "untyped" in lowered, (
        "PICK never mentions untyped columns, yet such a card matches the rail "
        "the harness measures — the agent has no rule for it"
    )

    # Read the untyped PARAGRAPH, not the section. PICK already says "never
    # silently skip it" about out-of-backlog cards, so a section-wide search for
    # a prohibition is satisfied by unrelated prose — a mutant that named
    # untyped columns and then said "normalize it in place like any other
    # labelled card" passed this test (M9). The prohibition has to bind to
    # normalization, in the sentence that introduces the case.
    para_start = lowered.index("untyped")
    para = lowered[para_start:]
    end = para.find("\n\n")
    para = para if end == -1 else para[:end]

    assert "never normalize" in para, (
        "the untyped paragraph does not forbid NORMALIZING the card. Naming the "
        "case without prohibiting the mutation lets the agent treat it like any "
        "other labelled card, violating the human-only boundary"
    )
    assert "stop" in para, (
        "the untyped paragraph forbids the mutation but routes nowhere, leaving "
        "the agent with a card it may not touch and no exit — the rail stays "
        "non-zero forever"
    )


def test_triage_stops_for_a_human_on_untyped_intake_instead_of_looping():
    """The terminal exit for residual B.

    An untyped labelled card can only be drained by a human — moving it to a
    typed column or removing the label. The agent cannot do either legally, so
    the only honest disposition is to record the required action and report
    blocked. Silently skipping it is the wedge; mutating it is the violation.
    """
    bullet = _outcome_bullet(
        _rendered_loop_prompt("triage-loop", "scope-probe"), "blocked_on_human"
    ).lower()
    assert "untyped" in bullet, (
        "the blocked-on-human outcome does not enumerate untyped labelled "
        "intake as one of the cases it covers, so the loop spins on a card it "
        "is forbidden to touch"
    )

    # Naming the residual is only half a handoff. A park that does not say what
    # the human owes leaves an operator staring at a stopped loop with no
    # instruction, so the run stalls just as hard as the money-loop it fixed.
    assert "owes" in bullet, (
        "the blocked branch reports the state without recording the action its "
        "human owes; the operator has no way to know how to unblock the run"
    )
    # And the record must come FIRST: an outcome reported before the blocker is
    # written down loses the blocker with the session.
    assert "first" in bullet, (
        "the blocked branch does not require writing the blocker down BEFORE "
        "reporting, so the specifics die with the memoryless session"
    )


def test_triage_human_stop_is_not_a_completion_claim():
    """Stopping for a human must NOT masquerade as completion.

    The run really is unfinished: intake remains on the rail. If the blocked
    outcome could be reported as `objective_complete`, the board history would
    record a clean sweep over cards nobody triaged — worse than the loop it
    replaces. This is the single most important invariant in this file, and it
    survived the v2→v3 STOP rewrite intact: only the wording it reads changed.
    """
    prompt = _rendered_loop_prompt("triage-loop", "scope-probe")
    blocked = _outcome_bullet(prompt, "blocked_on_human")

    assert "never a completion claim" in blocked.lower(), (
        "the blocked branch does not forbid claiming completion, so a future "
        "edit can drift it back into the completion outcome unchecked"
    )
    assert "objective_complete" not in blocked, (
        "the blocked-on-human branch names the completion outcome as one of "
        "its own dispositions, claiming a finished sweep while intake still "
        "sits on the rail"
    )

    # The completion outcome must in turn be gated on the rail being EMPTY, and
    # must say a refuted claim is a failure — otherwise "report complete" is a
    # free action and the two outcomes collapse into one.
    completion = _outcome_bullet(prompt, "objective_complete")
    assert "scope-probe" in completion, (
        "the completion outcome is not scoped to the rendered run label, so it "
        "describes a board-wide condition the harness never measures"
    )
    assert "fail" in completion.lower(), (
        "the completion outcome does not say a refuted claim is a FAILED "
        "iteration, so over-claiming costs the agent nothing"
    )


def test_triage_setup_contract_warns_about_untyped_labelled_cards():
    """The fit/preview surfaces show the setup contract BEFORE binding.

    An operator who labels a card sitting in their scratchpad column would
    otherwise only discover the park by watching the loop disable itself.
    """
    notes = _by_slug("triage-loop").content.setup_contract["notes"].lower()
    assert "untyped" in notes, (
        "setup contract never warns that labelling an untyped-column card "
        "parks the run, though that is a rail the loop cannot drain"
    )
    # Naming the column type is not a warning. The operator needs the
    # CONSEQUENCE — the loop cannot drain that card — or the note reads as
    # trivia and they label the scratchpad card anyway.
    assert "cannot drain" in notes or "parks" in notes, (
        "setup contract mentions untyped columns without stating the "
        "consequence (the loop cannot drain that card and parks itself), so an "
        "operator has no reason to avoid labelling one"
    )
    assert "typed columns" in notes, (
        "setup contract states the problem but never the instruction — only "
        "label cards that sit in typed columns"
    )


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_seed_renders_with_its_own_examples(slug: str):
    """Every slot's `example` is offered to the operator as a starting value,
    so the examples themselves must produce a renderable prompt."""
    template = _by_slug(slug)
    values = {slot.name: slot.example for slot in template.content.slots}
    result = render(template.content, values)
    for field in ("system_prompt", "loop_prompt"):
        rendered = getattr(result, field)
        assert "<<" not in rendered, f"{slug}.{field} kept an unrendered slot"
        assert rendered.strip()


# --- profiles ----------------------------------------------------------------


def test_wire_projection_carries_each_templates_own_content():
    """`list_loop_templates` is the only place SystemTemplate is flattened onto
    the wire, so every projected field must come from THAT template rather than
    a constant or a neighbour: a swapped prompt ships an operator the wrong
    method text under the right name."""
    projected = {entry["id"]: entry for entry in list_loop_templates()}
    assert set(projected) == {t.slug for t in LOOP_TEMPLATES if t.listed}

    for template in LOOP_TEMPLATES:
        entry = projected.get(template.slug)
        if entry is None:
            assert not template.listed
            continue
        assert entry["name"] == template.name
        assert entry["description"] == template.profile["tagline"]
        assert entry["system_prompt"] == template.content.system_prompt
        assert entry["loop_prompt"] == template.content.loop_prompt
        assert entry["tools"] == list(template.content.tools)
        assert entry["has_slots"] is template.has_slots


def test_wire_projection_does_not_alias_the_catalog_tool_lists():
    """The catalog is a process-wide singleton; handing out the same list object
    would let one request's edit leak into every later response."""
    entry = list_loop_templates()[0]
    template = get_system_template(entry["id"])
    assert entry["tools"] is not template.content.tools


def test_every_template_carries_a_display_profile():
    """The library page renders emoji + tagline + tags for each card; a seed
    with an empty profile shows up as a blank tile."""
    for template in LOOP_TEMPLATES:
        profile = template.profile
        assert profile.get("emoji"), f"{template.slug}: no emoji"
        assert profile.get("tagline", "").strip(), f"{template.slug}: no tagline"
        assert profile.get("tags"), f"{template.slug}: no tags"


@pytest.mark.parametrize("slug", sorted(V1_SLUGS))
def test_v1_profiles_are_tagged_as_the_deprecated_lineage(slug: str):
    tags = set(_by_slug(slug).profile["tags"])
    assert {"v1", "customize-markers"} <= tags, tags


@pytest.mark.parametrize("slug", sorted(UNPROVEN_V2_SLUGS))
def test_v2_seeds_record_that_the_kernel_is_unproven(slug: str):
    """Honesty in the profile page: these kernels have never driven a real run,
    unlike the Coding Loop whose lineage is seven completed loops."""
    assert "unproven" in _by_slug(slug).lineage_notes.lower()


@pytest.mark.parametrize("slug", sorted(PROVEN_SLUGS))
def test_the_proven_seed_does_not_claim_to_be_unproven(slug: str):
    """The honesty rule cuts both ways. The advanced coding loop's lineage IS
    its selling point on the profile page — copying the neighbours' "unproven"
    disclaimer would understate the one seed with a real track record."""
    lineage = _by_slug(slug).lineage_notes.lower()
    assert "unproven" not in lineage
    assert lineage.strip(), f"{slug}: no lineage notes at all"


# The ten fields the Profile tab renders as its whole page (R-PROF-1). `tagline`
# is structurally load-bearing beyond display: `SystemTemplate.description`
# reads it, and the wire projection compares against it.
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


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_every_maintained_seed_fills_the_whole_profile_page(slug: str):
    """One parametrized pin instead of seven per-template ones.

    Until the ladder shipped, only `coding-loop` had a test for this, so six
    templates could have gone out with a profile page that was mostly blank
    sections — the one screen an operator reads to decide whether to trust a
    loop with a budget.
    """
    profile = _by_slug(slug).profile
    for key in PROFILE_FIELDS:
        value = profile.get(key)
        assert value, f"{slug}: profile.{key} is empty"


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_when_to_use_leads_with_a_line_the_chooser_can_show(slug: str):
    """The chooser shows the first line, not the field. A single-paragraph
    `when_to_use` therefore dumps the entire block into a one-line slot."""
    when_to_use = _by_slug(slug).profile["when_to_use"]
    assert "\n" in when_to_use, (
        f"{slug}: when_to_use is one paragraph, so the chooser has no short "
        "form to show — lead with a sentence, then a blank line, then detail"
    )
    lead = when_to_use.split("\n")[0]
    assert 0 < len(lead) <= 120, f"{slug}: lead line is {len(lead)} chars"


# The rulebook's per-field caps, encoded so they are measured rather than
# reviewed. Every one is authoring discipline the backend does not enforce, and
# four fields shipped over cap precisely because "reviewers enforce them by
# counting" had no counter behind it.
PROFILE_FIELD_CAPS = {
    "tagline": 140,          # line-clamp-2 on the library card
    "when_to_use": 320,
    "when_not_to_use": 320,
    "needs_from_board": 400,
    "needs_from_runner": 320,
    "how_i_end": 400,
    "how_i_learn": 320,
}
WHAT_I_DO_BULLET_CAP = 140


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_profile_prose_stays_within_the_rulebook_caps(slug: str):
    """Caps exist because these fields render into fixed furniture — a clamped
    library card, a chooser tile, a profile column. A field over cap is not a
    style opinion; it is text the operator cannot finish reading."""
    profile = _by_slug(slug).profile

    for field, cap in PROFILE_FIELD_CAPS.items():
        value = profile[field]
        assert len(value) <= cap, (
            f"{slug}.{field} is {len(value)} chars against a {cap} cap "
            f"(+{len(value) - cap}) — trim it rather than raising the cap; the "
            "surface it renders into did not get bigger"
        )

    bullets = profile["what_i_do"]
    assert 4 <= len(bullets) <= 6, (
        f"{slug}: what_i_do has {len(bullets)} bullets, expected 4-6 — it is a "
        "walkthrough of one iteration, not a feature list"
    )
    for index, bullet in enumerate(bullets):
        assert len(bullet) <= WHAT_I_DO_BULLET_CAP, (
            f"{slug}.what_i_do[{index}] is {len(bullet)} chars against a "
            f"{WHAT_I_DO_BULLET_CAP} cap"
        )


# R-PROF-3. `rails` is the config bag's internal name and the operator's screen
# calls that section something else entirely, so the word names nothing they can
# find; the rest are authoring vocabulary that leaked into operator copy.
HOUSE_WORDS = (" rails", "stratum", "kernel", "binding")


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_profile_prose_carries_no_house_words(slug: str):
    """Catalog-wide, not ladder-wide.

    The same rule was already tested, but parametrized over the two new coding
    rungs only — so the advanced tier's v4 tagline shipped "every stratum of
    the proven Backplane kernel" past a test written to forbid exactly those two
    words. A rule stated, tested and evaded in one change is worse than an
    untested rule, because the green test is read as coverage.
    """
    profile = _by_slug(slug).profile
    prose = " ".join(
        value if isinstance(value, str) else " ".join(value)
        for key, value in profile.items()
        if key not in ("emoji", "tags")
    ).lower()
    for house_word in HOUSE_WORDS:
        assert house_word not in prose, (
            f"{slug}: profile prose says {house_word!r} — an authoring word "
            "with no referent on the operator's screen"
        )


# The closed tag vocabulary (rulebook §2). Adding a tag is a rulebook edit, not
# a template decision — the backend does not validate tags, so without this test
# the vocabulary is folklore and every author invents a synonym.
TAG_VOCABULARY = {
    "coding",
    "board-ops",
    "guided",
    "standard",
    "advanced",
    "tdd",
    "slots",
    "proven",
    "unproven",
    "intake",
    "normalization",
    "audit",
    "curation",
    "docs",
    "reporting",
    "standing",
}


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_tags_come_from_the_closed_vocabulary(slug: str):
    tags = _by_slug(slug).profile["tags"]
    unknown = set(tags) - TAG_VOCABULARY
    assert not unknown, f"{slug}: tags outside the vocabulary: {sorted(unknown)}"
    assert 3 <= len(tags) <= 5, (
        f"{slug}: {len(tags)} tags — fewer than three says nothing about the "
        "template, more than five is noise on the library card's pill row"
    )
    assert len(set(tags)) == len(tags), f"{slug}: duplicate tags {tags}"


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_every_seed_declares_exactly_one_family_and_one_track_record(slug: str):
    """Two tag axes an operator reads as facts: which family the loop is in,
    and whether its kernel has ever finished a real run."""
    tags = set(_by_slug(slug).profile["tags"])
    assert len(tags & {"coding", "board-ops"}) == 1, f"{slug}: {tags}"
    assert len(tags & {"proven", "unproven"}) == 1, f"{slug}: {tags}"
    assert ("proven" in tags) is (slug in PROVEN_SLUGS), (
        f"{slug}: the proven/unproven tag disagrees with the catalog's own "
        "record of which kernels have driven a completed run"
    )


# Per-slug loop-prompt line ceilings (R-PROMPT-7). Instruction adherence
# degrades with length, so every kernel carries a measured bound rather than an
# adjective. The advanced tier's number is its CURRENT size: it may not grow.
LOOP_PROMPT_CEILINGS = {
    # Its size at v3, held: the `in_progress-typed column` correctness fix cost
    # a line and trimming the ungranted tools out of the short-id reference
    # gave two back. v4 still makes zero COSMETIC prompt edits, which is what
    # the no-growth rule protects.
    "coding-loop": 369,
    "coding-loop-easy": 125,
    "coding-loop-standard": 240,
    "triage-loop": 160,
    "revision-loop": 140,
    "documentator-loop": 140,
    "secretary-loop": 140,
}


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_loop_prompt_stays_within_its_line_ceiling(slug: str):
    """A ceiling nobody measures is a suggestion.

    Measured on the AUTHORED prompt, which is what the ceilings were sized
    against — the advanced tier's 369 is its exact current source size, and it
    may not grow. A rendered count would instead measure how verbose an
    operator's own block values are, which is not this kernel's to control.
    """
    lines = len(_by_slug(slug).content.loop_prompt.splitlines())
    assert lines <= LOOP_PROMPT_CEILINGS[slug], (
        f"{slug}: rendered loop prompt is {lines} lines, over its "
        f"{LOOP_PROMPT_CEILINGS[slug]}-line ceiling. Never resolve an overflow "
        "by dropping a safety clause — cut guessable behaviour instead"
    )


@pytest.mark.parametrize("slug", sorted(RAIL_FREE_SLUGS))
def test_rail_free_loops_ship_no_completion_query(slug: str):
    """The absence is load-bearing, so it is pinned like secretary's.

    A label-only completion query cannot be stored: `canonicalize_loop_config`
    (`loop_config_validation.py:179`) does `setdefault("exclude_column_type",
    "done")` and `_completion_query_errors` (`:215`) rejects any other value
    with a 422. So a well-meaning author who "restores" the rail here does not
    get the query they wrote — they get `{label, exclude_column_type: "done"}`,
    which is exactly the shape that broke both loops: the documentator's was
    satisfied at launch (its subject sits in the done column, so the run
    disabled itself before iteration 1), and revision's could never be
    satisfied (nothing removed the label, nothing moved a card), so a correct
    run died as three consecutive FAILED iterations.

    Checked in BOTH places a rail can hide — `derived_rails` is what the bind
    step substitutes, `rails_defaults` is what a board inherits.
    """
    content = _by_slug(slug).content
    assert "completion_query" not in (content.derived_rails or {}), (
        f"{slug}: derived_rails ships a completion_query — the platform will "
        "rewrite it to exclude the done column, which this loop can never "
        "satisfy. Completion is verified in its STOP section instead"
    )
    assert "completion_query" not in (content.rails_defaults or {}), (
        f"{slug}: rails_defaults ships a completion_query"
    )


def test_revision_ships_no_completion_query():
    """Named for the failure it prevents, alongside its documentator and
    secretary twins.

    v2 shipped `{label, exclude_column_type: "done"}` while never removing the
    label and never moving a card, so the query could not reach zero by any
    action the prompt permitted. A run that audited everything correctly
    reported `objective_complete`, was refuted at `loopmode.go:434-441`,
    retried, and died at `max_consecutive_failures: 3` — an operator-visible
    failure for a sweep that had succeeded. v3 removes the rail and makes the
    label consumable, so the sweep can actually drain.
    """
    content = _by_slug("revision-loop").content
    assert "completion_query" not in (content.derived_rails or {})
    assert "completion_query" not in (content.rails_defaults or {})


@pytest.mark.parametrize("slug", sorted(RAIL_FREE_SLUGS - {"secretary-loop"}))
def test_rail_free_loops_verify_completion_in_the_prompt(slug: str):
    """With no completion query, `loopmode.go:434` skips the check that
    normally refutes a false `objective_complete`. The prompt is then the ONLY
    guard, so it must make the agent re-run the search and see zero itself.

    Secretary is excluded because it never claims `objective_complete` at all —
    a standing loop has nothing to verify.
    """
    prompt = _rendered_loop_prompt(slug, "scope-probe")
    stop = _section(prompt, SCOPING_SECTIONS[slug][1])
    assert "objective_complete" in stop, f"{slug}: STOP names no completion"

    lowered = stop.lower()
    assert "must re-run" in lowered, (
        f"{slug}: STOP does not make the completion re-check MANDATORY — with "
        "no completion query the harness cannot verify the claim, so an "
        "unenforced 'check first' is no guard at all"
    )
    assert 'search_cards(label="scope-probe")' in stop or (
        'search_cards(..., label="scope-probe")' in stop
    ), (
        f"{slug}: STOP does not name the exact label-scoped search the agent "
        "must re-run before claiming completion"
    )
    assert "exclude_column_type" not in stop, (
        f"{slug}: STOP's verification narrows by column, but this loop drains "
        "by consuming the label — the card it audited is still in its column"
    )


@pytest.mark.parametrize("slug", sorted(RAIL_FREE_SLUGS - {"secretary-loop"}))
def test_label_consuming_loops_remove_the_label_they_scope_on(slug: str):
    """The drain must exist somewhere in the method, or the sweep is infinite.

    Both loops scope on a label and neither moves a card between columns, so
    removing the label is the ONLY way a card can leave the sweep. A prompt
    that scopes on a label it never consumes describes a run that cannot end.
    """
    prompt = _rendered_loop_prompt(slug, "scope-probe")
    lowered = prompt.lower()
    assert "remove" in lowered and "scope-probe" in prompt, (
        f"{slug}: the prompt never removes the run label, so no card can ever "
        "leave the sweep"
    )
    assert "never move" in lowered or "not move" in lowered, (
        f"{slug}: the prompt does not state that it never moves cards between "
        "columns — the invariant that makes label consumption the only drain"
    )


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_no_optional_slot_strands_its_own_heading_on_a_fresh_run(slug: str):
    """The fresh-run render is the DEFAULT first appearance, not an edge case.

    Every `LESSONS` slot documents itself as "left empty on a fresh run", and
    five templates used to introduce it with a `### Lessons from previous runs`
    heading written into the prompt. Rule 4a correctly dropped the lone
    `<<LESSONS>>` line and left the heading behind, so five of seven templates
    opened their real first run with a titled, empty section — dangling prose
    the agent has to interpret. The heading now lives INSIDE the slot value, so
    an empty slot removes both.

    Asserted over every optional slot rather than `LESSONS` alone: any optional
    slot introduced by its own heading has this failure mode.
    """
    template = _by_slug(slug)
    required_only = {
        slot.name: (slot.example if slot.required else "")
        for slot in template.content.slots
    }
    rendered = render(template.content, required_only)

    for field in ("system_prompt", "loop_prompt"):
        lines = getattr(rendered, field).splitlines()
        for index, line in enumerate(lines):
            if not line.startswith("###"):
                continue
            body = [text.strip() for text in lines[index + 1 :]]
            following = next((text for text in body if text), "")
            assert not (following.startswith("###") or following == ""), (
                f"{slug}.{field} strands the empty heading {line.strip()!r} on "
                "a fresh run — an optional slot's value vanished and took the "
                "section's content with it, leaving the title behind"
            )


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_prompts_only_name_column_types_that_exist(slug: str):
    """A `<name>-typed column` instruction must name a real `ColumnType`.

    The advanced tier shipped `the in_progress-typed column` to production:
    `ColumnType` is `backlog|active|review|done|blocked`, so `in_progress` can
    never resolve. The agent was told to move a card by a column type that does
    not exist, in the section that runs before any work starts, while the same
    prompt insists resolution happens by `column_type` and never by displayed
    name. Nothing failed loudly — the instruction was simply unsatisfiable.

    Parametrized over the whole catalog rather than pinned as one literal: the
    defect is a class, and the next author to invent a plausible-sounding type
    should fail here rather than in a live run.
    """
    from app.models.kanban.column import ColumnType

    real = {member.value for member in ColumnType}
    template = _by_slug(slug)
    values = {slot.name: slot.example for slot in template.content.slots}
    rendered = render(template.content, values)

    for field in ("system_prompt", "loop_prompt"):
        named = set(re.findall(r"`?(\w+)`?-typed column", getattr(rendered, field)))
        invalid = named - real
        assert not invalid, (
            f"{slug}.{field} instructs a column type that does not exist: "
            f"{sorted(invalid)}. Valid types are {sorted(real)} — an agent "
            "resolving by column_type can never satisfy this"
        )


# --- tools -------------------------------------------------------------------


def test_system_templates_are_frozen():
    """Catalog entries are process-wide singletons: a request handler that
    mutated one would corrupt every later request in the worker."""
    template = LOOP_TEMPLATES[0]
    with pytest.raises(Exception):
        template.slug = "mutated"  # type: ignore[misc]


@pytest.mark.parametrize("slug", sorted(V2_SLUGS - CODING_SLUGS))
def test_non_coding_v2_seeds_still_exclude_pr_tools(slug: str):
    """A board-ops loop writes cards and notes; it must never land a pull
    request. Scoped by FAMILY rather than by lineage: the guided and standard
    coding rungs are also unproven, and they legitimately hold the PR tools."""
    bare = {
        name.removeprefix("mcp__valaris__") for name in _by_slug(slug).content.tools
    }
    assert "enqueue_pr_for_merge" not in bare
    assert "set_board_loop" in bare


# The two in-place-upgraded sweeps, pinned to the same density as the four newer
# templates. R-TEST-3 item 2 requires an exact grant for all six new/changed
# templates; these two were the pair still carrying only the family-scoped
# "no PR tools" assertion, which passes for any grant that omits one tool name.
SWEEP_TOOL_GRANTS = {
    "triage-loop": (
        18,
        {
            "update_card",
            "create_card",
            "add_card_dependency",
            "bulk_set_card_dependencies",
            "validate_board_dependencies",
        },
    ),
    "revision-loop": (
        19,
        {
            "update_card",
            "create_card",
            "add_card_dependency",
            # The distill-and-propose stratum: read the skills catalog, then
            # propose — a human decides via the risk-60 approval.
            "list_skills",
            "get_skill",
            "propose_skill",
        },
    ),
}


@pytest.mark.parametrize("slug", sorted(SWEEP_TOOL_GRANTS))
def test_sweep_grants_exactly_its_pinned_tool_allowlist(slug: str):
    """R-TOOL-4. The count is the review surface, so pin the literal.

    Neither sweep may land a pull request or move a card: triage drains by
    consuming the run label and revision audits content, never workflow state.
    `move_card` is withheld from both deliberately — an agent moving a card into
    a done-typed column on a repo-linked board trips the backend's done-merge
    gate with `pr_url_missing`.
    """
    from app.services.loop_templates._types import COMMON_TOOLS

    expected_count, extras = SWEEP_TOOL_GRANTS[slug]
    tools = _by_slug(slug).content.tools
    assert len(tools) == expected_count, (
        f"{slug}: expected {expected_count} tools, got {len(tools)} — a grant "
        "changed without the review this literal exists to force"
    )
    assert len(set(tools)) == len(tools), f"{slug}: duplicate tool in the grant"
    assert all(name.startswith("mcp__valaris__") for name in tools)

    bare = {name.removeprefix("mcp__valaris__") for name in tools}
    assert bare - set(COMMON_TOOLS) == extras, (
        f"{slug}: extras beyond the common core are "
        f"{sorted(bare - set(COMMON_TOOLS))}, pinned as {sorted(extras)}"
    )
    assert "set_board_loop" in bare, f"{slug}: off switch missing"
    for withheld in ("move_card", "enqueue_pr_for_merge"):
        assert withheld not in bare, f"{slug}: must not be granted {withheld}"
    assert not [name for name in bare if "delete" in name], (
        f"{slug}: granted a delete tool — a misread card becomes data loss"
    )


# Retired slugs still resolve for bound boards, so their prose is served too.
@pytest.mark.parametrize("slug", sorted(V2_SLUGS | V1_SLUGS))
def test_prompts_never_name_a_tool_the_template_does_not_grant(slug: str):
    """R-TOOL-7, the prose→grant direction.

    The advanced tier's short-id reference listed `delete_card`,
    `bulk_set_card_dependencies`, `get_card_verdict`, `remove_card_dependency`
    and the two participant tools — none of them granted. Naming an ungranted
    tool costs the agent a failed call it then has to reason about, and naming
    `delete_card` in a prompt whose grant deliberately withholds every delete
    tool is worse than wasteful.

    Scoped to tool names the prompt presents as callable (backticked, or with
    an argument list), so ordinary prose about a concept is not a finding.
    """
    template = _by_slug(slug)
    from tests.test_mcp_catalog_drift import collect_mcp_tool_names

    granted = {
        name.removeprefix("mcp__valaris__") for name in template.content.tools
    }
    catalog = collect_mcp_tool_names() - granted
    for field in ("system_prompt", "loop_prompt"):
        text = getattr(template.content, field)
        named = {name for name in catalog if f"`{name}`" in text or f"{name}(" in text}
        assert not named, (
            f"{slug}.{field} names ungranted tools {sorted(named)} — the agent "
            "is told about calls its allowlist will refuse"
        )


# --- coding loop v2 ----------------------------------------------------------

# Note 4201e496 §2 counts 58 slots, and the kernel text carries exactly 58
# `<<NAME>>` placeholders. The catalog holds ONE more SlotSpec than that: the
# `LANDING` variant selector, which appears in no prompt because its job is to
# fill the five LANDING_* sub-slots that do. The note has no row for it because
# at authoring time a human chose the variant by hand; mechanizing that choice
# is what the `variant` kind is for.
CODING_LOOP_PLACEHOLDER_COUNT = 57
# LANDING (variant selector) and RUN_HISTORY_KEY (deprecated: catalogued so
# stored values keep rendering, but no prompt reads it) have no placeholder.
CODING_LOOP_SLOT_COUNT = CODING_LOOP_PLACEHOLDER_COUNT + 2

# The five landing sub-slots are filled TOGETHER from one variant (§3.3): a
# binding that answered some of them would mix self-merge steps into a
# stop-at-PR policy and tell the agent two different things about landing.
LANDING_SUB_SLOTS = {
    "LANDING_POLICY",
    "LANDING_STEPS",
    "LANDING_STUCK_RULE",
    "LANDING_MOVE_TARGET",
    "LANDING_NOTHING_READY",
}


def _coding_loop() -> SystemTemplate:
    return _by_slug("coding-loop")


def _coding_slots() -> dict[str, SlotSpec]:
    return {slot.name: slot for slot in _coding_loop().content.slots}


def test_coding_loop_catalogues_every_slot_the_profile_specifies():
    assert len(_coding_loop().content.slots) == CODING_LOOP_SLOT_COUNT


def test_coding_loop_kernel_carries_the_documented_placeholder_count():
    """Counting SlotSpecs alone would let a dropped kernel sentence pass: the
    slot stays catalogued, validate_template reports `unused_slot`, and the
    operator is asked to fill a value no prompt reads. Count the TEXT."""
    content = _coding_loop().content
    placeholders = set()
    for field in ("system_prompt", "loop_prompt"):
        placeholders |= set(re.findall(r"<<([A-Z][A-Z0-9_]*)>>", getattr(content, field)))
    assert len(placeholders) == CODING_LOOP_PLACEHOLDER_COUNT

    # The variant selector and the deprecated run-history key are the only
    # catalogued slots with no placeholder.
    catalogued = {slot.name for slot in content.slots}
    assert catalogued - placeholders == {"LANDING", "RUN_HISTORY_KEY"}


def test_coding_loop_ships_the_landing_variant_with_three_options():
    """Landing is the one genuinely branching decision in the kernel, and the
    renderer expands it through the `variant` kind rather than three parallel
    bindings the operator must keep consistent by hand."""
    landing = _coding_slots()["LANDING"]
    assert landing.kind == "variant"
    assert [variant.id for variant in landing.variants] == ["A", "B", "C"]


def test_coding_loop_defaults_to_the_battle_tested_landing():
    """Variant A is the only landing seven completed runs actually exercised;
    B and C are written from the contract. An operator who never opens the
    variant picker must get the proven one, not whichever sorts first."""
    assert _coding_slots()["LANDING"].default == "A"


def test_every_landing_variant_fills_every_landing_sub_slot():
    """A half-filled variant is worse than none: the kernel would carry a
    self-merge policy bullet beside stop-at-PR landing steps, and the agent
    would follow whichever it read last."""
    landing = _coding_slots()["LANDING"]
    for variant in landing.variants:
        assert set(variant.fills) == LANDING_SUB_SLOTS, (
            f"variant {variant.id} fills {sorted(variant.fills)}, "
            f"expected exactly {sorted(LANDING_SUB_SLOTS)}"
        )


def test_landing_sub_slots_are_never_asked_of_the_operator():
    """They are derived from the variant choice. Marking one required would
    make the bind step demand a value the variant already supplies, and a
    hand-typed answer could contradict the other four."""
    slots = _coding_slots()
    for name in LANDING_SUB_SLOTS:
        assert slots[name].required is False, f"{name} must come from the variant"


@pytest.mark.parametrize("slug", sorted(V2_SLUGS))
def test_no_slot_value_a_seed_supplies_itself_nests_another_slot(slug: str):
    """Values are injected in ONE pass and never re-scanned (renderer rule 2).

    A `<<NAME>>` written inside a variant fill, a default or an example is
    therefore shipped LITERALLY into the live prompt — and rule 8 does not
    catch it, because the name is catalogued, so `unrendered_slot` never fires.
    The board would run a loop told to "check out `<<INTEGRATION_BRANCH>>`".

    Note 4201e496 §2 assumed the opposite ("the renderer substitutes until no
    `<<` remains"), which is why this is asserted rather than trusted.
    """
    seed_authored: list[tuple[str, str]] = []
    for slot in _by_slug(slug).content.slots:
        seed_authored.append((f"{slot.name}.example", slot.example))
        if isinstance(slot.default, str):
            seed_authored.append((f"{slot.name}.default", slot.default))
        for variant in slot.variants:
            for target, filled in variant.fills.items():
                if isinstance(filled, str):
                    seed_authored.append(
                        (f"{slot.name}.{variant.id}.fills.{target}", filled)
                    )

    for where, value in seed_authored:
        nested = re.findall(r"<<[A-Z][A-Z0-9_]*>>", value)
        assert not nested, (
            f"{slug}.{where} nests {nested} — the renderer makes one pass, so "
            "this ships literally into the rendered prompt"
        )


def test_merge_queue_variant_grants_the_tool_its_policy_names():
    """Variant C tells the agent to call enqueue_pr_for_merge. Without the
    matching grant the loop reaches its landing step and cannot finish a single
    card — the failure appears only on a live board, at the very end."""
    landing = _coding_slots()["LANDING"]
    merge_queue = next(v for v in landing.variants if v.id == "C")
    assert merge_queue.tools_extra == ["mcp__valaris__enqueue_pr_for_merge"]
    assert merge_queue.rails == {"loop_landing": "merge_queue"}
    assert "enqueue_pr_for_merge" in merge_queue.fills["LANDING_POLICY"]


def test_self_merge_variant_adds_no_tools_and_no_rails():
    """Variant A lands with plain git, so it must not widen the grant. A
    stray tools_extra here would hand every default binding a merge-queue
    capability its policy text never mentions.

    Its ONE rail is the landing name itself (card B9): a variant that stays
    silent inherits `rails_defaults`, which is how A's self-merge prose came to
    ship under `loop_landing="human"`.
    """
    landing = _coding_slots()["LANDING"]
    self_merge = next(v for v in landing.variants if v.id == "A")
    assert self_merge.tools_extra == []
    assert self_merge.rails == {"loop_landing": "self_merge"}


def test_coding_loop_grants_exactly_the_twenty_three_tool_allowlist():
    """The v55 grant (profile §1) minus `update_definition` (bundle E: the
    definition is human-owned) plus the skills-distill trio. Tools are PART
    of the template: a coding loop that cannot update_card or create_note
    cannot finish or remember."""
    tools = _coding_loop().content.tools
    assert len(tools) == 23, f"expected the v55 grant - update_definition + skills trio, got {len(tools)}"
    assert len(set(tools)) == len(tools), "duplicate tool in the grant"
    bare = {name.removeprefix("mcp__valaris__") for name in tools}
    assert {"update_card", "move_card", "create_note", "set_board_loop"} <= bare
    # Variant C adds it; the base grant must not, or variant B/A bindings would
    # silently carry a merge-queue capability their policy text forbids.
    assert "enqueue_pr_for_merge" not in bare


def test_coding_loop_grants_no_destructive_tools():
    """Profile §1: "No delete tools, no agent-admin tools." The loop edits
    cards and writes notes; a delete grant turns a misread card into data
    loss no PR review can catch."""
    bare = {
        name.removeprefix("mcp__valaris__") for name in _coding_loop().content.tools
    }
    assert not {name for name in bare if name.startswith("delete_")}, bare


def test_coding_loop_rails_defaults_size_the_run_from_v55():
    """rails_defaults are applied on FIRST bind, so they are the numbers an
    operator inherits by not thinking. They come from the v55 config that
    drove Loop #7 (profile §1 "My knobs")."""
    rails = _coding_loop().content.rails_defaults
    assert rails["model"] == "premium"
    assert rails["iteration_delay_seconds"] == 60
    assert rails["iteration_timeout_seconds"] == 5400
    assert rails["budget_usd"] == 250
    assert rails["max_consecutive_failures"] == 3
    assert rails["max_blocked_on_human"] == 3
    assert rails["starvation_policy"] == "park"
    # The DEFAULT variant's own value (card B9), so a render that never names
    # LANDING still resolves a landing that matches the prose it ships.
    assert rails["loop_landing"] == "self_merge"
    assert rails["merge_gate"] == "forge_ci"


def test_coding_loop_setup_contract_names_the_columns_it_moves_cards_through():
    """The loop moves a card active → done every iteration and measures
    completion by done-typed column, so those two are structural. Backlog and
    review are conveniences a board may name differently."""
    contract = _coding_loop().content.setup_contract
    assert set(contract["required_column_types"]) == {"active", "done"}
    assert set(contract["optional_column_types"]) == {"backlog", "review"}


def test_coding_loop_setup_contract_states_what_the_board_must_supply():
    """fit/preview render this before an operator binds. Each key here is a
    precondition whose absence makes the loop fail on a live board rather
    than at bind time."""
    contract = _coding_loop().content.setup_contract
    assert contract["requires_run_label"] is True
    assert contract["git_repo_bound"] is True
    assert contract["agent_bound_with_tools"] is True
    assert contract["dependencies_server_side"] is True
    # Human-authored, read-only keys; run history moved to notes (bundle E).
    assert contract["definition_keys"] == ["loop_charter", "note_conventions"]
    assert contract["card_sections"] == [
        "## Acceptance Criteria",
        "## DoD",
        "## Out of Scope",
    ]


def test_coding_loop_requires_the_slots_that_would_break_the_method():
    """The required set is the contract with the operator: skip one of these
    and the rendered prompt names no repo, no branch, or no scope."""
    slots = _coding_slots()
    for name in (
        "RUN_LABEL",
        "INTEGRATION_BRANCH",
        "CARD_BRANCH_PREFIX",
        "REPO_URL",
        "REPO_DIR",
        "DEFAULT_BRANCH",
        "DEFAULT_BRANCH_CONSEQUENCE",
        "ANCHOR_SHA",
        "ANCHOR_DATE",
        "SEED_NOTE_TITLE",
        "SEED_NOTE_ID",
        "CHARTER_KEY",
        "ENGAGEMENT_BRIEF",
        "REPO_BOUNDARIES",
        "GATES",
        "BOOTSTRAP",
        "CLONE_DIR",
        "MCP_SERVER_PIN",
        "BASELINES",
    ):
        assert slots[name].required is True, f"{name} must be required"
    # Deprecated since v6: stays catalogued for stored values, never required.
    assert slots["RUN_HISTORY_KEY"].required is False


def test_coding_loop_optional_slots_all_default_to_empty():
    """Rule 4: an optional slot's sentence is written to read correctly when
    the value is empty, and the renderer drops the line or the adjacent space.
    A None default would instead reach _stringify as the string "None"."""
    for slot in _coding_loop().content.slots:
        if slot.required or slot.kind == "variant":
            continue
        assert slot.default == "", f"{slot.name}: default={slot.default!r}"


def test_coding_loop_renders_with_only_its_required_slots_filled():
    """The real bind path for an operator who fills nothing optional. Every
    optional sentence must survive its value being empty — this is what proves
    the kernel's rule-4 phrasing, not just that the defaults exist.
    """
    template = _coding_loop()
    values = {
        slot.name: slot.example
        for slot in template.content.slots
        if slot.required and slot.kind != "variant"
    }
    result = render(template.content, values)

    for field in ("system_prompt", "loop_prompt"):
        rendered = getattr(result, field)
        assert "<<" not in rendered, f"{field} kept an unrendered slot"
        # An empty optional value must not leave the seam it was removed from.
        # Checked per LINE: joining the prompt first would splice unrelated
        # line ends together and manufacture failures that are not there.
        in_fence = False
        for number, line in enumerate(rendered.split("\n"), start=1):
            body = line.strip()
            if body.startswith("```"):
                in_fence = not in_fence
                continue
            # Inside a fence, and in tables and indented blocks, whitespace is
            # alignment the author chose — never a seam left by an empty slot.
            if in_fence or body.startswith(("|", "-", "*")) or "    " in line:
                continue
            # Prose only: a `code span` may legitimately hold " ." or double
            # spacing (a jq filter, a shell pipeline), and flagging it would
            # say nothing about whether an empty slot left a seam behind.
            # Code spans collapse to a single word rather than vanish: deleting
            # them outright would turn "`objective_complete`, the harness" into
            # " , the harness" and report a seam that is not there.
            prose = re.sub(r"`[^`]*`", "CODE", body)
            assert "  " not in prose, f"{field}:{number}: double space: {line!r}"
            # A seam looks like `word ,` — whitespace BEFORE the punctuation.
            # "#4, #5" and "1. Orient" are ordinary prose and must not trip it.
            orphan = re.search(r"\s[.,;:]", prose)
            assert orphan is None, (
                f"{field}:{number}: punctuation left stranded by an empty "
                f"slot: {line!r}"
            )


def test_coding_loop_default_binding_lands_with_plain_git():
    """Omitting the variant selection entirely must still produce Variant A's
    self-merge instructions — the resolve_variants default fallback is what
    makes "fill only the required slots" a complete binding."""
    template = _coding_loop()
    values = {
        slot.name: slot.example
        for slot in template.content.slots
        if slot.required and slot.kind != "variant"
    }
    result = render(template.content, values)

    assert "git merge --no-ff" in result.loop_prompt
    assert "enqueue_pr_for_merge" not in result.loop_prompt
    assert result.rails["loop_landing"] == "self_merge"
    assert "mcp__valaris__enqueue_pr_for_merge" not in result.tools


def test_merge_queue_binding_swaps_the_landing_everywhere_at_once():
    """Choosing variant C must change the policy bullet, the landing steps,
    the move target AND the rail together. A partial swap would tell the agent
    to enqueue and then move the card to Done itself, double-landing it."""
    template = _coding_loop()
    values = {
        slot.name: slot.example
        for slot in template.content.slots
        if slot.required and slot.kind != "variant"
    }
    values["LANDING"] = "C"
    result = render(template.content, values)

    assert "enqueue_pr_for_merge" in result.system_prompt
    assert "enqueue_pr_for_merge" in result.loop_prompt
    assert "git merge --no-ff" not in result.loop_prompt
    assert result.rails["loop_landing"] == "merge_queue"
    assert "mcp__valaris__enqueue_pr_for_merge" in result.tools


def test_coding_loop_keeps_the_default_branch_floor_after_rendering():
    """The hardest floor in the profile. It survives rendering only if the
    branch name is substituted into it rather than hard-coded — a binding for
    another repo must forbid ITS default branch, not `main`."""
    template = _coding_loop()
    values = {
        slot.name: slot.example
        for slot in template.content.slots
        if slot.required and slot.kind != "variant"
    }
    values["DEFAULT_BRANCH"] = "trunk"
    values["INTEGRATION_BRANCH"] = "big-feature"
    result = render(template.content, values)

    assert "You NEVER touch trunk" in result.system_prompt
    assert "never trunk" in result.system_prompt
    # The floor must not still name the example repo's branch.
    assert "NEVER touch main" not in result.system_prompt


def test_coding_loop_prompts_use_only_the_five_runner_variables():
    """The runner fills exactly five PromptContext fields; any other {{.X}}
    renders as a zero value or fails the iteration outright. validate_template
    enforces this, but pin it on the seed so a kernel edit cannot regress it
    behind a passing validator refactor."""
    errors = validate_template(_coding_loop().content)
    assert [e for e in errors if e["code"] == "unknown_runner_var"] == []
    assert "{{.Iteration}}" in _coding_loop().content.loop_prompt
    assert "{{.Workspace}}" in _coding_loop().content.system_prompt


def test_coding_loop_profile_carries_the_page_the_manager_renders():
    """eb7d83ab renders these fields as the Profile tab. An empty key there is
    a blank section on the one page that explains what the loop IS."""
    profile = _coding_loop().profile
    # 🔁 moved to the standard rung when the ladder shipped, so the default icon
    # marks the default choice; the advanced rung took the toolbox.
    assert profile["emoji"] == "🛠️"
    for key in (
        "tagline",
        "what_i_do",
        "when_to_use",
        "when_not_to_use",
        "needs_from_board",
        "needs_from_runner",
        "how_i_end",
        "how_i_learn",
    ):
        assert profile.get(key), f"profile.{key} is empty"


def test_coding_loop_carries_the_memory_protocol_that_replaces_a_lessons_block():
    """The sweeps inherit findings through a Lessons slot an operator edits.

    The coding loop instead makes each iteration WRITE its own memory, because
    a fresh session with no memory of the last one is otherwise guaranteed to
    rediscover the same defects. Three things must hold together, and a kernel
    edit that dropped any one of them would leave the loop amnesiac while the
    other two still read fine: the agent must be told to READ prior logs, to
    WRITE one, and to report what was wrong so the prompt itself improves.
    """
    prompt = _coding_loop().content.loop_prompt
    assert "### 4. RECORD WHAT YOU LEARNED" in prompt
    assert "Notes titled \"Loop run log\" are how previous iterations talk" in prompt
    assert "create_note" in prompt
    assert "WRONG OR MISSING" in prompt


def test_coding_loop_profile_records_its_lineage_through_seven_runs():
    """The track record is the reason to pick this template over writing a
    prompt by hand, so it belongs on the profile rather than only in a note."""
    lineage = _coding_loop().lineage_notes
    assert "v55" in lineage
    assert "seven" in lineage.lower() or "#7" in lineage


# --- landing rail coherence (card B9) ----------------------------------------


@pytest.mark.parametrize(
    "landing_variant, expected_rail",
    [("A", "self_merge"), ("B", "human"), ("C", "merge_queue")],
)
def test_coding_loop_landing_variant_resolves_its_own_rail(
    landing_variant: str, expected_rail: str
):
    """The LANDING prose and the `loop_landing` rail must name the same mode.

    Variant A instructs the agent to merge its own PR and move the card to
    Done. A rail that says `human` describes a board waiting on a person who
    is never coming — nothing errors, so the contradiction only surfaces as an
    operator wondering why the run behaves nothing like the config.
    """
    template = _by_slug("coding-loop")
    values = {slot.name: slot.example for slot in template.content.slots}
    values["LANDING"] = landing_variant

    assert render(template.content, values).rails["loop_landing"] == expected_rail


def test_coding_loop_default_landing_renders_the_self_merge_rail():
    """A render that never names LANDING falls back twice — to the slot default
    (`A`) and, for any rail A leaves unset, to `rails_defaults`. Both paths must
    reach the same value or the default bind is the contradictory one."""
    template = _by_slug("coding-loop")
    values = {
        slot.name: slot.example
        for slot in template.content.slots
        if slot.name != "LANDING"
    }

    assert render(template.content, values).rails["loop_landing"] == "self_merge"
    assert template.content.rails_defaults["loop_landing"] == "self_merge"
