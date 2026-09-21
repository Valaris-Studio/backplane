# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Repo-fact leak lint contract (spec f52328b3 F12, card p4-04).

The lint is a HINT, not a control: every assertion here is about what an author
gets TOLD, never about anything being refused. False positives are acceptable
by operator direction; the tests that matter most are therefore the negative
ones — a lint that fires on the shipped Coding Loop v2 kernel would train
authors to ignore it.
"""

import logging

import pytest

from app.services.loop_template_lint import (
    lint_repo_facts,
    lint_template_content,
    lint_variant_rail_coverage,
)
from app.services.loop_template_render import SlotSpec, SlotVariant, TemplateContent
from app.services.loop_templates import get_system_template


def _codes(findings) -> list[str]:
    return [finding["code"] for finding in findings]


def _matches(findings, code: str) -> list[str]:
    return [finding["match"] for finding in findings if finding["code"] == code]


# --- the four heuristics on prompt bodies --------------------------------


def test_lint_flags_url_sha_orgrepo_path():
    """The Backplane binding values pasted into a kernel — AC #1."""
    kernel = (
        "Repo: https://github.com/example/project\n"
        "Clone example/project.git into place.\n"
        "Prod serves main at commit ce4ea8b4 today.\n"
        "CWD ~/backplane-runner/repos/loop/4ad6b3a4\n"
    )

    findings = lint_repo_facts(kernel)

    assert {"url", "org_repo", "git_ref", "abs_path"} <= set(_codes(findings))
    assert "https://github.com/example/project" in _matches(
        findings, "url"
    )
    assert "ce4ea8b4" in _matches(findings, "git_ref")
    assert "~/backplane-runner/repos/loop/4ad6b3a4" in _matches(findings, "abs_path")
    # Every finding points the author at the fix, not just at the problem.
    assert all(finding["hint"] for finding in findings)


def test_lint_reports_one_based_line_numbers():
    """`line` is what the editor gutter renders, so off-by-one is a real bug."""
    kernel = "clean first line\nclean second line\nsee https://example.com/x here"

    findings = lint_repo_facts(kernel)

    assert [finding["line"] for finding in findings] == [3]


def test_lint_sha_requires_context_unless_full_length():
    """Bare 7-hex prose words are not SHAs — the documented false-positive guard.

    `deadbeef` in prose must stay quiet, while a 40-hex string is a SHA on its
    own and a short hex WITH a context word is one too.
    """
    assert _codes(lint_repo_facts("the deadbeef pattern is a classic")) == []
    assert _codes(lint_repo_facts("facebee is a word, cabbage too")) == []

    assert "git_ref" in _codes(lint_repo_facts("merged at sha deadbeef"))
    assert "git_ref" in _codes(lint_repo_facts("commit 1234abc landed"))
    assert "git_ref" in _codes(lint_repo_facts("a" * 39 + "0 is the anchor"))


def test_lint_dedupes_by_code_and_match():
    """One repeated fact is one finding — an author fixes it in one edit."""
    kernel = "https://example.com/a\nagain https://example.com/a\n"

    assert len(lint_repo_facts(kernel)) == 1


def test_lint_allowlist_suppresses_a_known_fact():
    """`allow` is how a template legitimately naming a public docs URL stays quiet."""
    kernel = "See https://docs.valaris.dev/loops for the contract."

    assert _codes(lint_repo_facts(kernel)) == ["url"]
    assert (
        lint_repo_facts(kernel, allow={"https://docs.valaris.dev/loops"}) == []
    )


def test_lint_clean_kernel_no_findings():
    """Golden negative: the shipped Coding Loop v2 kernel must lint clean.

    This is the assertion that keeps the lint trustworthy. If a future seed
    edit pastes a repo fact into the kernel, this test is the tripwire.
    """
    # The v2 lineage holds the unversioned slug; `coding-loop-v1` is the
    # retired one (p3-10 unlisted it), so this is the kernel authors copy.
    template = get_system_template("coding-loop")
    assert template is not None, "coding-loop seed missing"

    findings = lint_template_content(template.content)

    assert findings == [], f"clean kernel produced findings: {findings}"


# --- slot_leftover: values only, never the kernel -------------------------


def test_lint_slot_leftover_in_values_only():
    """AC #2: `<<RUN_LABEL>>` is a leftover in a slot VALUE, normal in a kernel."""
    content = TemplateContent(
        system_prompt="You are <<ROLE>>, working carefully.",
        loop_prompt="Advance <<ROLE>> now.",
        slots=[
            SlotSpec(name="ROLE", kind="scalar"),
            SlotSpec(name="LABEL", kind="scalar", default="<<RUN_LABEL>>"),
        ],
    )

    findings = lint_template_content(content)

    assert _codes(findings) == ["slot_leftover"]
    assert _matches(findings, "slot_leftover") == ["<<RUN_LABEL>>"]
    # The kernel's own slots are the renderer's business, not the lint's.
    assert "<<ROLE>>" not in _matches(findings, "slot_leftover")


def test_lint_scans_slot_examples_as_well_as_defaults():
    """An `example` ships in the export too, so a leftover there also counts."""
    content = TemplateContent(
        system_prompt="Plain kernel.",
        loop_prompt="Plain loop.",
        slots=[SlotSpec(name="LABEL", kind="scalar", example="<<RUN_LABEL>>")],
    )

    assert _codes(lint_template_content(content)) == ["slot_leftover"]


def test_lint_repo_facts_in_slot_values_are_not_reported():
    """Slot values carry the B/C facts on purpose — that is the whole design.

    Only `slot_leftover` applies to values; a repo URL sitting in a slot default
    is the CORRECT place for it and flagging it would invert the lesson.
    """
    content = TemplateContent(
        system_prompt="Plain kernel.",
        loop_prompt="Plain loop.",
        slots=[
            SlotSpec(
                name="REPO_URL",
                kind="scalar",
                default="https://github.com/example/project",
            )
        ],
    )

    assert lint_template_content(content) == []


def test_lint_template_content_reports_both_prompt_fields():
    """A fact in either kernel field must surface — not just the first one."""
    content = TemplateContent(
        system_prompt="Base at https://example.com/system",
        loop_prompt="Also at https://example.com/loop",
    )

    assert sorted(_matches(lint_template_content(content), "url")) == [
        "https://example.com/loop",
        "https://example.com/system",
    ]


# --- secrets -------------------------------------------------------------


@pytest.mark.parametrize(
    "secret",
    [
        "vlr_abcdefgh12345678",
        "sk-abcdefgh12345678",
        "ghp_abcdefgh12345678",
        "AKIAIOSFODNN7EXAMPLE",
    ],
)
def test_lint_flags_secret_shapes(secret):
    assert "secret_like" in _codes(lint_repo_facts(f"token {secret} here"))


def test_lint_secret_like_not_logged(caplog):
    """AC #3: the operator is warned, but the secret never reaches the log."""
    secret = "vlr_abcdefgh12345678"

    with caplog.at_level(logging.WARNING, logger="app.services.loop_template_lint"):
        findings = lint_repo_facts(f"Use {secret} to authenticate.")

    assert _matches(findings, "secret_like") == [secret]
    assert caplog.records, "a secret-shaped match must be logged at WARNING"
    logged = " ".join(record.getMessage() for record in caplog.records)
    assert secret not in logged
    assert "secret_like" in logged


def test_lint_does_not_log_non_secret_findings(caplog):
    """Only secrets get the extra log line; URLs are already visible to the author."""
    with caplog.at_level(logging.WARNING, logger="app.services.loop_template_lint"):
        lint_repo_facts("See https://example.com/x")

    assert caplog.records == []


# --- rail coherence across a variant slot (card B9) -----------------------


def _variant_slot(*variant_rails) -> TemplateContent:
    """One variant slot over N variants, each with the given `rails` dict."""
    return TemplateContent(
        system_prompt="Land it: <<LANDING_STEPS>>",
        loop_prompt="Go.",
        slots=[
            SlotSpec(
                name="LANDING_STEPS",
                kind="scalar",
                default="merge it",
            ),
            SlotSpec(
                name="LANDING",
                kind="variant",
                default="a",
                variants=[
                    SlotVariant(
                        id=chr(ord("a") + index),
                        label=f"Variant {index}",
                        fills={"LANDING_STEPS": f"step {index}"},
                        rails=rails,
                    )
                    for index, rails in enumerate(variant_rails)
                ],
            ),
        ],
        rails_defaults={"loop_landing": "human"},
    )


def test_lint_flags_a_variant_that_inherits_a_rail_its_siblings_set():
    """The shape that let Coding Loop v2 contradict itself: variant C set
    `loop_landing`, A and B set nothing, so A's self-merge prose rendered
    with the `human` rail inherited from `rails_defaults`."""
    content = _variant_slot({}, {}, {"loop_landing": "merge_queue"})

    findings = lint_template_content(content)

    assert _codes(findings) == ["variant_rail_inherited"]
    assert _matches(findings, "variant_rail_inherited") == ["LANDING.loop_landing"]
    assert "a, b" in findings[0]["hint"], findings[0]["hint"]


def test_lint_clean_when_every_variant_resolves_the_rail():
    content = _variant_slot(
        {"loop_landing": "self_merge"},
        {"loop_landing": "human"},
        {"loop_landing": "merge_queue"},
    )

    assert lint_template_content(content) == []


def test_lint_ignores_a_variant_slot_where_no_variant_sets_a_rail():
    """A slot that only fills text has no rail to disagree about — flagging it
    would train authors to ignore the lint."""
    assert lint_template_content(_variant_slot({}, {}, {})) == []


def test_lint_finds_no_inherited_rail_in_the_shipped_coding_loop():
    """The seed that MOTIVATED `variant_rail_inherited` must not trip it.

    Distinct from the golden negative above: that one would still pass if the
    rule silently returned nothing, because it asserts an empty list either
    way. This one asserts the rule RAN over the seed's variant slot — the
    slot's rail set is non-empty, so a rule that reads it correctly has
    something to be silent about.
    """
    template = get_system_template("coding-loop")
    landing = next(
        slot for slot in template.content.slots if slot.kind == "variant"
    )
    assert {rail for v in landing.variants for rail in v.rails} == {"loop_landing"}

    assert lint_variant_rail_coverage(landing) == []


def test_lint_ignores_a_lone_variant_that_sets_a_rail():
    """A one-variant slot has no sibling to disagree with, so the rail it sets
    is simply that slot's rail. Reporting it would flag every single-variant
    slot in the catalog — the false-positive rate that gets a warn-only lint
    ignored."""
    content = _variant_slot({"loop_landing": "self_merge"})

    assert lint_template_content(content) == []


def test_lint_ignores_a_variant_slot_with_no_variants_at_all():
    """A raw draft can carry `kind="variant"` with the list still empty."""
    content = TemplateContent(
        system_prompt="Plain.",
        loop_prompt="Plain.",
        slots=[SlotSpec(name="LANDING", kind="variant")],
    )

    assert lint_template_content(content) == []
