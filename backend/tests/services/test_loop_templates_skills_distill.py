# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Skills self-improvement enablement — the distill-and-propose stratum.

The skills registry shipped with `propose_skill` behind a risk-60 human
approval, but no system loop template ever TOLD an agent the tool exists or
granted it — the self-improvement chain's first link was missing. These tests
pin that link into every maintained template that does real work and learns
from it: the three coding rungs and the revision sweep.

The instruction block lives in the SYSTEM prompt (the loop prompts sit at
test-pinned line ceilings that may not grow), is byte-identical across the
four templates so it stays one reviewable stratum, and grants come with it:
`test_prompts_never_name_a_tool_the_template_does_not_grant` makes naming
`propose_skill` without granting it a failure, and the serve-side
`skills_proposal_enabled` strip keeps the grant safe on boards that opt out.
"""

import pytest

from app.services.loop_templates import get_system_template

DISTILL_SLUGS = [
    "coding-loop",
    "coding-loop-easy",
    "coding-loop-standard",
    "revision-loop",
]

SKILL_TOOLS = {
    "mcp__valaris__list_skills",
    "mcp__valaris__get_skill",
    "mcp__valaris__propose_skill",
}

DISTILL_HEADING = "## Distill reusable methodology into skills"


def _by_slug(slug: str):
    template = get_system_template(slug)
    assert template is not None, f"{slug} missing from the catalog"
    return template


@pytest.mark.parametrize("slug", DISTILL_SLUGS)
def test_system_prompt_carries_the_distill_block(slug: str):
    """The block must say WHEN to distill (durable methodology, not project
    trivia), HOW (SKILL.md via propose_skill, versioning over duplicating),
    and WHO decides (a human — the agent never assumes publication)."""
    prompt = _by_slug(slug).content.system_prompt
    assert DISTILL_HEADING in prompt, f"{slug}: distill section missing"
    for clause in (
        "durable, reusable methodology",
        "SKILL.md",
        # Conditional, not imperative: opted-out boards get propose_skill
        # STRIPPED from the served allowlist while the stored system prompt is
        # served verbatim — the prose must stay valid without the tool.
        "If `propose_skill` is in\nyour tool set",
        "opted out of proposals",
        "`list_skills`/`get_skill`",
        "a human reviews and decides",
        "never assume it was accepted",
    ):
        assert clause in prompt, f"{slug}: distill block lost {clause!r}"


@pytest.mark.parametrize("slug", DISTILL_SLUGS)
def test_distill_block_is_identical_across_templates(slug: str):
    """One stratum, four carriers: a reviewer reads the block once. Diverging
    copies would drift independently and each would need its own review."""
    reference = _extract_block(_by_slug("coding-loop").content.system_prompt)
    assert _extract_block(_by_slug(slug).content.system_prompt) == reference


def _extract_block(prompt: str) -> str:
    start = prompt.index(DISTILL_HEADING)
    rest = prompt[start + len(DISTILL_HEADING) :]
    next_heading = rest.find("\n## ")
    return rest if next_heading == -1 else rest[:next_heading]


@pytest.mark.parametrize("slug", DISTILL_SLUGS)
def test_templates_grant_the_skills_proposal_surface(slug: str):
    """propose to write, list/get to read-before-write — a proposer that
    cannot see the catalog re-proposes what already exists."""
    tools = set(_by_slug(slug).content.tools)
    missing = SKILL_TOOLS - tools
    assert not missing, f"{slug}: skills tools not granted: {sorted(missing)}"


# The distill stratum is a content revision, so each carrier bumps its
# SystemTemplate version — the established convention (coding-loop moved
# 3→4 when the ladder landed) for signalling drift to bound boards.
# coding-loop and coding-loop-standard bumped again when bundle E removed the
# definition-write instruction (see test_loop_templates_no_definition_writes).
DISTILL_VERSIONS = {
    "coding-loop": 8,
    "coding-loop-easy": 3,
    "coding-loop-standard": 4,
    "revision-loop": 4,
}


@pytest.mark.parametrize("slug", DISTILL_SLUGS)
def test_distill_carriers_bumped_their_version(slug: str):
    assert _by_slug(slug).version == DISTILL_VERSIONS[slug]
