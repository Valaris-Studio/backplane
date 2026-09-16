# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Loop prompt template catalog — static, code-defined, versioned with the app.

Templates are method skeletons, not finished prompts. Each ships the
board-agnostic METHOD stratum (orient → pick → work → record → stop) distilled
from field-proven loop configs, leaving the project-specific strata to be
filled per board.

Two generations live here. The maintained lineage — three rungs of one coding
ladder (guided, standard, advanced) plus four board-ops sweeps (triage,
revision, documentator, secretary) — expresses every project-specific stratum as a
real `<<SLOT>>` the bind step fills and validates. The `-v1` lineage is the
original free-text `[CUSTOMIZE:` marker form, retired now that the bind step
made the legacy chooser unreachable: its entries carry ``listed=False``, so the
catalog stops OFFERING them while `get_system_template` still RESOLVES them —
a board bound to a `-v1` slug during the transition reports drift rather than
404ing.

The tool allowlist is PART of each template: a coding loop that cannot call
enqueue_pr_for_merge cannot finish a card, so filling prompts without tools
would ship a broken loop. Template vars are the runner's Go-template contract;
the authoritative list is ``LOOP_RUNNER_VARS`` in loop_config_validation (five:
Workspace, BoardID, AgentID, ExecutionID, Iteration) — never restate it here.
"""

from app.services.loop_templates import (
    coding_loop_easy,
    coding_loop_standard,
    coding_loop_v1,
    coding_loop_v2,
    documentator_loop,
    revision_loop_v1,
    revision_loop_v2,
    secretary_loop,
    triage_loop_v1,
    triage_loop_v2,
)
from app.services.loop_templates._types import SystemTemplate

_MAINTAINED = (
    coding_loop_v2.TEMPLATE,
    coding_loop_easy.TEMPLATE,
    coding_loop_standard.TEMPLATE,
    revision_loop_v2.TEMPLATE,
    triage_loop_v2.TEMPLATE,
    documentator_loop.TEMPLATE,
    secretary_loop.TEMPLATE,
)
_LEGACY = (
    coding_loop_v1.TEMPLATE,
    revision_loop_v1.TEMPLATE,
    triage_loop_v1.TEMPLATE,
)

# Maintained templates first, each generation alphabetical by display name: the
# catalog renders in response order, so an operator meets the slotted lineage
# before the deprecated one.
LOOP_TEMPLATES: list[SystemTemplate] = [
    *sorted(_MAINTAINED, key=lambda t: t.name),
    *sorted(_LEGACY, key=lambda t: t.name),
]

_BY_SLUG = {template.slug: template for template in LOOP_TEMPLATES}


def get_system_template(slug: str) -> SystemTemplate | None:
    """The code-defined template with this exact slug, or None.

    Exact match only: `revision-loop` and `revision-loop-v1` are different
    templates, and a loose lookup would bind a board to the wrong lineage.
    """
    return _BY_SLUG.get(slug)


def listed_templates() -> list[SystemTemplate]:
    """The catalog entries a chooser may OFFER — retired lineages excluded.

    `LOOP_TEMPLATES` stays complete so `get_system_template` keeps resolving
    retired slugs for bound boards; only the offer surface narrows.
    """
    return [template for template in LOOP_TEMPLATES if template.listed]


def list_loop_templates() -> list[dict]:
    """The listed catalog projected onto the `LoopTemplateRead` wire shape.

    `has_slots` is derived from each template's prompt text rather than
    authored, so a template that gains a `<<SLOT>>` can never ship with a stale
    hand-written flag that lets the raw dialog offer an unappliable template.
    """
    return [
        {
            "id": template.slug,
            "name": template.name,
            "description": template.description,
            "system_prompt": template.content.system_prompt,
            "loop_prompt": template.content.loop_prompt,
            "tools": list(template.content.tools),
            "has_slots": template.has_slots,
        }
        for template in listed_templates()
    ]


__all__ = [
    "LOOP_TEMPLATES",
    "SystemTemplate",
    "get_system_template",
    "list_loop_templates",
    "listed_templates",
]
