# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Author-time cross-check between a stage's declared context_sources and the
prompt that consumes them.

A context source only reaches the LLM when the role's prompt references its
alias as `{{ index .ContextSources "<alias>" }}` (the Go runner's
text/template index form). That wiring is invisible in the config alone and
fails silently both directions, so this lint emits non-blocking warnings:

  - context_source_declared_but_unreferenced: a source is declared on a stage
    but its alias never appears in that stage's prompt — the rendered string is
    silently dropped.
  - context_source_referenced_but_undeclared: a prompt references an alias the
    stage doesn't declare — it renders to empty string with no error.

The cross-check spans two entities (pipeline_config + AgentPromptConfig rows)
that the pure config validator can't see together, so it lives here and is
called from both save paths.
"""

import re

from app.services.pipeline_config_validation import ValidationError

# Two kinds reach prompts through legacy struct fields rather than the index
# form: board_definition -> {{.ProjectDirectives}}, review_history ->
# {{.ReviewHistory}} (runner/internal/workloop/prompt_template.go). Declaring
# either while only using the legacy field is correct wiring, not an inert
# source, so the lint must not warn on it. They are also always reachable, so
# referencing them via the index form without declaring is not an error.
_LEGACY_BRIDGE_FIELD = {
    "board_definition": "ProjectDirectives",
    "review_history": "ReviewHistory",
}

# Mirrors the Go index form, tolerating whitespace variants:
#   {{ index .ContextSources "alias" }}  and  {{index .ContextSources "alias"}}
_INDEX_REF = re.compile(
    r'\{\{\s*index\s+\.ContextSources\s+"([^"]+)"\s*\}\}'
)


def _referenced_aliases(prompt: str) -> set[str]:
    return set(_INDEX_REF.findall(prompt))


def _references_legacy_field(prompt: str, field: str) -> bool:
    # Matches {{.Field}} / {{ .Field }} and conditional forms like
    # {{if .Field}}, which is how the shipped prompts gate these blocks.
    pattern = re.compile(r"\.%s\b" % re.escape(field))
    return bool(pattern.search(prompt))


def lint_context_source_wiring(
    pipeline_config: dict,
    prompt_contents: dict[tuple[str, str], str],
) -> list[ValidationError]:
    """Return severity="warning" findings for declared↔referenced mismatches.

    `prompt_contents` maps (role, stage) -> prompt content. Stages with no
    authored prompt are skipped (they fall back to a hardcoded prompt whose
    content this layer can't inspect).
    """
    findings: list[ValidationError] = []
    stages = pipeline_config.get("stages")
    if not isinstance(stages, list):
        return findings

    for idx, stage in enumerate(stages):
        if not isinstance(stage, dict):
            continue
        role = stage.get("role")
        llm = stage.get("llm") or {}
        stage_name = llm.get("stage")
        if not role or not stage_name:
            continue

        prompt = prompt_contents.get((role, stage_name))
        if prompt is None:
            continue

        path = f"stages[{idx}].llm.context_sources"
        sources = llm.get("context_sources") or []
        declared: dict[str, str] = {}  # alias -> kind
        for source in sources:
            if not isinstance(source, dict):
                continue
            kind = source.get("kind")
            if not isinstance(kind, str) or not kind:
                continue
            alias = source.get("as") or kind
            if not isinstance(alias, str) or not alias:
                continue
            declared[alias] = kind

        referenced = _referenced_aliases(prompt)

        for alias, kind in declared.items():
            if alias in referenced:
                continue
            legacy_field = _LEGACY_BRIDGE_FIELD.get(kind)
            if legacy_field and _references_legacy_field(prompt, legacy_field):
                continue
            findings.append(
                ValidationError(
                    code="context_source_declared_but_unreferenced",
                    field=f"{path} ({role}.{stage_name})",
                    message=(
                        f"context source {alias!r} is declared on stage "
                        f"{role}.{stage_name} but its prompt never references "
                        f'{{{{ index .ContextSources "{alias}" }}}} — the '
                        f"rendered context is silently dropped"
                    ),
                    value=alias,
                    severity="warning",
                )
            )

        for alias in referenced:
            if alias in declared:
                continue
            if alias in _LEGACY_BRIDGE_FIELD:
                continue
            findings.append(
                ValidationError(
                    code="context_source_referenced_but_undeclared",
                    field=f"{path} ({role}.{stage_name})",
                    message=(
                        f"prompt for stage {role}.{stage_name} references "
                        f'{{{{ index .ContextSources "{alias}" }}}} but no '
                        f"context source declares that alias — it renders to "
                        f"empty string"
                    ),
                    value=alias,
                    severity="warning",
                )
            )

    return findings
