# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The typed shape of a code-defined system template.

System templates are CODE, not seed rows (spec f52328b3, owner decision Q6):
they ship with the app, version with it, and are never written to the database.
That makes this dataclass the only definition of what a system template IS, and
the service layer unions these with DB-backed workspace templates behind one
read model.
"""

from dataclasses import dataclass, field

from app.services.loop_config_validation import SLOT_PATTERN
from app.services.loop_template_render import PROMPT_FIELDS, TemplateContent

MCP_PREFIX = "mcp__valaris__"

# Read/record core every loop needs to orient and leave memory behind.
COMMON_TOOLS = (
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
)


def mcp_tools(*extra: str) -> list[str]:
    """The common core plus `extra`, as the full MCP ids a loop config stores."""
    return [f"{MCP_PREFIX}{name}" for name in (*COMMON_TOOLS, *extra)]


# The three grants that travel with SKILLS_DISTILL_SECTION below. One constant
# instead of hand-typed trios: a template appending the section unpacks this
# into its mcp_tools(...) call, so prose and grant cannot drift per-template.
SKILLS_TOOLS = ("list_skills", "get_skill", "propose_skill")

# Appended verbatim to the system prompt of every template that does real work
# and learns from it (the coding ladder, the revision sweep). One shared
# constant rather than four copies: the block is a single stratum a reviewer
# reads once, and byte-identity across carriers is test-pinned. Grants travel
# with it — a template carrying this text must also unpack SKILLS_TOOLS into
# its grants. The prose is CONDITIONAL on tool availability because boards
# that opt out (`skills_proposal_enabled=false`) get `propose_skill` stripped
# from the served allowlist while the stored system prompt is served verbatim
# — unconditional prose would instruct a call the allowlist refuses.
SKILLS_DISTILL_SECTION = """
## Distill reusable methodology into skills

When an iteration surfaces a durable, reusable methodology — a debugging
recipe, a verification workflow, a method that would hold on OTHER boards and
OTHER repositories — distill it into a SKILL.md. If `propose_skill` is in
your tool set, submit it with `propose_skill`; if it is not, this board has
opted out of proposals — record the distilled method in your log note
instead and move on. Project trivia (this repository's paths, this board's
labels, a one-off fix) belongs in your log note, never in a skill. Check
`list_skills`/`get_skill` first and propose a new version of an existing
skill rather than a near-duplicate. A proposal is a REQUEST, nothing more:
a human reviews and decides, and publication may never happen. Record the
proposal in your log note and move on: never wait on the decision, and
never assume it was accepted.
"""


@dataclass(frozen=True)
class SystemTemplate:
    """One code-defined template: identity, display profile, and content.

    Frozen because the catalog is a process-wide singleton — a handler that
    mutated an entry would corrupt every later request in the same worker.
    """

    slug: str
    version: int
    name: str
    content: TemplateContent
    profile: dict = field(default_factory=dict)
    is_system: bool = True
    lineage_notes: str = ""
    # Whether the catalog OFFERS this template. False retires a lineage without
    # deleting it: `get_system_template` keeps resolving the slug, so a board
    # bound to a retired template reports drift instead of 404ing. Defaults to
    # True — a new seed is listed unless its author retires it.
    listed: bool = True

    @property
    def description(self) -> str:
        """The one-line catalog blurb, sourced from the profile tagline."""
        return self.profile.get("tagline", "")

    @property
    def has_slots(self) -> bool:
        """Whether the prompts carry `<<SLOT>>`s the raw loop dialog cannot fill.

        Derived from the prompt TEXT rather than the slot catalog: a hand-kept
        flag (or a slot list that drifted from the prose) would let the raw
        dialog offer a template that 422s `unrendered_slot` at save.
        """
        return any(
            SLOT_PATTERN.search(getattr(self.content, field_name) or "")
            for field_name in PROMPT_FIELDS
        )
