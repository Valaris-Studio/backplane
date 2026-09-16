# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Canonicalize + validate board loop-mode config (docs/loop-mode-contract.md).

Same posture as pipeline_config_validation: canonicalize applies defaults on
every save path so GET always serves a COMPLETE object (the runner does a plain
json.Unmarshal — a missing numeric decodes as 0 and silently trips a safety
rail), and validate is non-throwing; the service raises the 422 with the
findings as detail.
"""

import re

from app.services.pipeline_config_validation import ValidationError

# The runner's Go-template vocabulary for loop prompts — the ONLY names loop
# mode fills (runner/internal/workloop/loopmode.go builds PromptContext with
# exactly these for every iteration). Order is the contract: the catalog serves
# this list verbatim on GET /loop-templates meta.runner_vars and the palette
# renders the chips in it.
#
# This module owns it because the validator, the raw-prompt guard and the
# template tests all need one import point. Drift is fenced from both sides:
# runner/internal/workloop/testdata/loop_runner_vars.json must equal this tuple
# (tests/routers/test_loop_templates.py) and loop mode must FILL every name in
# that file (TestLoopMode_RunnerVarsFixtureAllFilled). Before this constant the
# vocabulary was stated in five places and three of them disagreed.
LOOP_RUNNER_VARS: tuple[str, ...] = (
    "Workspace",
    "BoardID",
    "AgentID",
    "ExecutionID",
    "Iteration",
)

# `{{.Iteration}}`, `{{- .BoardID}}`, `{{ .Workspace }}` — the leading-dash trim
# marker and inner whitespace are both legal Go template syntax, so a guard that
# only matched the bare form would wave through a typo written either way.
RUNNER_VAR_PATTERN = re.compile(r"\{\{-?\s*\.([A-Za-z_][A-Za-z0-9_]*)")

# Template slot grammar (spec §3.1) — deliberately NOT Go-template syntax, so a
# slot and a runner var can never be confused, and deliberately uppercase-only
# and bracketed, because prompts legitimately contain `cat <<EOF` and `2>>log`.
# The renderer reuses this exact constant: one grammar, one definition.
SLOT_PATTERN = re.compile(r"<<[A-Z][A-Z0-9_]*>>")

# The MCP tool a loop session uses to stop itself. An enabled loop whose tool
# allowlist omits it has no off switch — the rails (max_iterations, budget) are
# then the only way the run ever ends.
OFF_SWITCH_TOOL = "mcp__valaris__set_board_loop"

# The MCP tool an agent session uses to propose a skill. When a board's
# `skills_proposal_enabled` is False the served config strips it from a
# non-empty tools allowlist — an empty allowlist grants the full surface and
# stays empty; the proposals ENDPOINT gate is the enforcement there.
SKILLS_PROPOSAL_TOOL = "mcp__valaris__propose_skill"

# The runner ships both prompts over the wire on every iteration and feeds them
# to the agent session verbatim. The cap is a sanity bound against a paste
# accident or a template that concatenated itself, not a token budget.
PROMPT_MAX_BYTES = 64 * 1024

_PROMPT_FIELDS = ("system_prompt", "loop_prompt")


def unrendered_slots(text: str) -> list[str]:
    """Slot NAMES still present in `text`, in source order, deduplicated.

    Source order (not sorted) because the finding message names the FIRST slot
    an operator has to fix.
    """
    seen: dict[str, None] = {}
    for match in SLOT_PATTERN.findall(text):
        seen.setdefault(match[2:-2], None)
    return list(seen)


def unknown_runner_vars(text: str) -> list[str]:
    """Go-template var names in `text` the runner does not define, sorted.

    A `{{.Board}}` typo is invisible until a real iteration renders it — Go
    errors on an unknown field of a struct context, and the runner treats that
    render failure as a failed iteration. Catching it at save time turns a
    burned session into a 422.
    """
    return sorted(set(RUNNER_VAR_PATTERN.findall(text)) - set(LOOP_RUNNER_VARS))


# Operator-owned fields with their documented defaults. `disabled_reason`,
# `version`, and `updated_at` are server-owned and never accepted from clients.
LOOP_CONFIG_DEFAULTS: dict = {
    "enabled": False,
    "provider": "",  # free string, never an enum (white-label)
    "model": "mid",  # tier alias or concrete id, stored verbatim
    "system_prompt": "",
    "loop_prompt": "",
    "tools": [],
    "max_iterations": 25,
    "iteration_delay_seconds": 30,
    "iteration_timeout_seconds": 3600,
    "budget_usd": 20.0,
    "max_consecutive_failures": 3,
    # Consecutive sessions reporting outcome=blocked_on_human before the runner
    # stops the loop with a truthful reason naming the blocker. 0 opts out —
    # blocked_on_human then only parks, the pre-card-102dc48e behavior.
    "max_blocked_on_human": 3,
    # park: pre-flight GET /loop/readiness each cycle, sleep instead of paying
    # for a session when nothing is actionable. always_run: v1 behavior, for
    # loop boards whose prompt does non-card work (docs/triage loops).
    "starvation_policy": "park",
    # human: cards land when a person merges (the reconciler moves them).
    # merge_queue: loop agents may enqueue_for_merge and the platform's own
    # executor lands the PR — per-board OPT-IN (owner decision 2026-08-07).
    # self_merge: the loop agent merges its own PR into the integration branch
    # with plain git and moves the card itself. No platform actor is involved,
    # so it grants nothing and opts into nothing — it is the honest NAME for
    # what a self-merging prompt already does, which is how Loops #6-#8 ran.
    "loop_landing": "human",
    # May this board's agents file skill proposals? Default OPEN. The Go
    # runner json.Unmarshal's the served config and a missing bool decodes
    # false — canonicalize must inject this into every legacy stored config;
    # a Go-side default would silently flip the feature off for boards saved
    # before the field existed.
    "skills_proposal_enabled": True,
    # forge_ci: the merge queue requires forge CI green before landing a PR.
    # none: land without reading CI — forge CI is a desirable, never a
    # platform dependency (repos where CI cannot run, e.g. free-plan orgs;
    # the review flow is the gate there).
    "merge_gate": "forge_ci",
    # Declarative run-complete condition, evaluated by the RUNNER in code
    # before it pays for a session ({label, exclude_column_type}, the
    # cards-search contract). None = off, today's behavior: completion is then
    # only ever a session's self-report. See docs/loop-mode-contract.md.
    "completion_query": None,
}

_STARVATION_POLICIES = ("park", "always_run")
# completion_query is deliberately NOT an arbitrary query language: the runner
# evaluates it against the cards-search endpoint, and every key it accepts must
# map to a filter that endpoint actually applies. An unknown key would be
# silently dropped, turning "still work left" into a false run-complete.
_COMPLETION_QUERY_KEYS = ("label", "exclude_column_type")
_LOOP_LANDINGS = ("human", "merge_queue", "self_merge")
_MERGE_GATES = ("forge_ci", "none")

# (field, minimum, inclusive) — budget_usd is the only strict bound.
_NUMERIC_BOUNDS: tuple[tuple[str, float, bool], ...] = (
    ("max_iterations", 1, True),
    ("iteration_delay_seconds", 0, True),
    ("iteration_timeout_seconds", 1, True),
    ("budget_usd", 0, False),
    ("max_consecutive_failures", 1, True),
    # 0 is the documented opt-out, so the floor is 0 rather than 1.
    ("max_blocked_on_human", 0, True),
)


def canonicalize_loop_config(config: dict, stored: dict | None = None) -> dict:
    """Overlay the provided operator fields on `stored` (an existing board's
    canonical config) if given, else on the full defaults.

    This is the PUT merge rule (docs/loop-mode-contract.md): omitted fields on
    a subsequent PUT inherit the board's current value rather than resetting
    to defaults — only the first-ever PUT for a board sees true defaults.
    `LoopConfigPut` fields are all Optional, so an explicit JSON null and an
    omitted key both decode to None here and are treated identically as
    "unchanged".

    Lists are copied so canonical configs never share mutable state with the
    request body, the defaults table, or `stored`.
    """
    # Overlaying stored onto the defaults backfills fields added AFTER the
    # stored row was written (e.g. starvation_policy) — the runner
    # json.Unmarshals the served object, so a missing field must never survive
    # a save.
    base = {**LOOP_CONFIG_DEFAULTS, **stored} if stored is not None else LOOP_CONFIG_DEFAULTS
    canonical = {**base, "tools": list(base["tools"])}
    for key in LOOP_CONFIG_DEFAULTS:
        value = config.get(key)
        if value is not None:
            canonical[key] = list(value) if isinstance(value, list) else value
    # An empty completion_query object is the CLEAR lever: omitted and explicit
    # null both decode to None ("unchanged") on LoopConfigPut, so turning the
    # feature back off needs a value that survives the None filter above.
    if config.get("completion_query") == {}:
        canonical["completion_query"] = None
    elif isinstance(canonical.get("completion_query"), dict):
        query = dict(canonical["completion_query"])
        # Validation accepts a label-only query by assuming "done"; the stored
        # dict must carry that assumption. The runner treats a missing key as
        # NO exclusion, so an uncanonicalized label-only save can never reach
        # zero matches — the run becomes uncompletable in code.
        query.setdefault("exclude_column_type", "done")
        canonical["completion_query"] = query
    return canonical


def _completion_query_errors(query: object) -> list[ValidationError]:
    """A completion_query is load-bearing on RUN TERMINATION, so every way it
    can be wrong is a 422 rather than a silently narrower filter."""

    def invalid(message: str, value: object) -> ValidationError:
        return ValidationError(
            code="invalid_completion_query",
            field="completion_query",
            message=message,
            value=value,
        )

    if not isinstance(query, dict):
        return [invalid("completion_query must be an object or null", query)]

    errors: list[ValidationError] = []
    unknown = sorted(set(query) - set(_COMPLETION_QUERY_KEYS))
    if unknown:
        errors.append(
            invalid(
                f"completion_query accepts only {_COMPLETION_QUERY_KEYS}",
                unknown,
            )
        )

    label = query.get("label")
    if not isinstance(label, str) or not label.strip():
        errors.append(invalid("completion_query.label must be a non-empty string", label))

    # The one supported condition is "cards outside Done"; a narrower or
    # absent exclusion would report a run complete while cards sit in progress.
    exclude = query.get("exclude_column_type", "done")
    if exclude != "done":
        errors.append(
            invalid('completion_query.exclude_column_type must be "done"', exclude)
        )

    return errors


def validate_loop_config(config: dict) -> list[ValidationError]:
    """Return validation findings for a CANONICAL config. Empty list = valid."""
    errors: list[ValidationError] = []

    if config["enabled"] and not config["loop_prompt"]:
        errors.append(
            ValidationError(
                code="loop_prompt_required",
                field="loop_prompt",
                message="enabled=true requires a non-empty loop_prompt",
            )
        )

    # Prompt-content guards run on every save, enabled or not: what is STORED
    # today is what the next enable ships. .get for the same reason as every
    # field below — set_loop_state validates {**stored, enabled} uncanonicalized.
    for field in _PROMPT_FIELDS:
        prompt = config.get(field, LOOP_CONFIG_DEFAULTS[field])
        slots = unrendered_slots(prompt)
        if slots:
            errors.append(
                ValidationError(
                    code="unrendered_slot",
                    field=field,
                    message=(
                        f"{field} still contains the unrendered template slot "
                        f"<<{slots[0]}>>"
                    ),
                    value=slots,
                )
            )
        # Half of these would NOT fail loudly: a pipeline-only PromptContext
        # field ({{.CardID}}, {{.Branch}}, {{.PRURL}}) exists on the shared Go
        # struct, so loop mode leaves it at its zero value and Go renders it as
        # an empty string — the prompt silently loses a sentence and the
        # iteration burns anyway. Only a name absent from the struct errors at
        # render time. Neither has a valid loop-mode meaning, so both are
        # rejected here, where an operator can still see the typo.
        unknown = unknown_runner_vars(prompt)
        if unknown:
            errors.append(
                ValidationError(
                    code="unknown_runner_var",
                    field=field,
                    message=(
                        f"{field} uses {{{{.{unknown[0]}}}}}, which loop mode does "
                        f"not fill — only {', '.join(LOOP_RUNNER_VARS)} are available"
                    ),
                    value=unknown,
                )
            )
        # utf-8 bytes, not characters: the cap bounds what crosses the wire, and
        # a multi-byte prompt is up to 4x its character count.
        size = len(prompt.encode("utf-8"))
        if size > PROMPT_MAX_BYTES:
            errors.append(
                ValidationError(
                    code="prompt_too_large",
                    field=field,
                    message=f"{field} must be at most {PROMPT_MAX_BYTES} bytes",
                    value=size,
                )
            )

    # An EMPTY allowlist grants the full platform surface (docs/loop-mode-
    # contract.md), off switch included — only a non-empty list can drop it.
    # No override flag exists, by owner decision: a loop that cannot stop
    # itself is never what the operator meant.
    tools = config.get("tools", LOOP_CONFIG_DEFAULTS["tools"])
    if config["enabled"] and tools and OFF_SWITCH_TOOL not in tools:
        errors.append(
            ValidationError(
                code="off_switch_removed",
                field="tools",
                message=(
                    f"an enabled loop's tools allowlist must include {OFF_SWITCH_TOOL} "
                    "— the loop could not otherwise stop itself"
                ),
                value=tools,
            )
        )

    # .get: set_loop_state validates {**stored, enabled} without canonicalizing,
    # and a pre-starvation_policy stored row has no key to index.
    policy = config.get("starvation_policy", LOOP_CONFIG_DEFAULTS["starvation_policy"])
    if policy not in _STARVATION_POLICIES:
        errors.append(
            ValidationError(
                code="invalid_starvation_policy",
                field="starvation_policy",
                message=f"starvation_policy must be one of {_STARVATION_POLICIES}",
                value=policy,
            )
        )

    landing = config.get("loop_landing", LOOP_CONFIG_DEFAULTS["loop_landing"])
    if landing not in _LOOP_LANDINGS:
        errors.append(
            ValidationError(
                code="invalid_loop_landing",
                field="loop_landing",
                message=f"loop_landing must be one of {_LOOP_LANDINGS}",
                value=landing,
            )
        )

    # A non-bool here would survive canonicalize's is-not-None overlay and
    # reach the runner's json.Unmarshal as a type error mid-run.
    proposal_flag = config.get(
        "skills_proposal_enabled", LOOP_CONFIG_DEFAULTS["skills_proposal_enabled"]
    )
    if not isinstance(proposal_flag, bool):
        errors.append(
            ValidationError(
                code="invalid_skills_proposal_enabled",
                field="skills_proposal_enabled",
                message="skills_proposal_enabled must be a boolean",
                value=proposal_flag,
            )
        )

    gate = config.get("merge_gate", LOOP_CONFIG_DEFAULTS["merge_gate"])
    if gate not in _MERGE_GATES:
        errors.append(
            ValidationError(
                code="invalid_merge_gate",
                field="merge_gate",
                message=f"merge_gate must be one of {_MERGE_GATES}",
                value=gate,
            )
        )

    # .get for the same reason as every field above: set_loop_state validates
    # {**stored, enabled} without canonicalizing.
    completion_query = config.get("completion_query")
    if completion_query is not None:
        errors.extend(_completion_query_errors(completion_query))

    for field, minimum, inclusive in _NUMERIC_BOUNDS:
        # .get, same reason as the string fields above: set_loop_state validates
        # {**stored, enabled} without canonicalizing, so a row written before a
        # numeric field existed has no key to index. The default stands in.
        value = config.get(field, LOOP_CONFIG_DEFAULTS[field])
        if (value < minimum) if inclusive else (value <= minimum):
            bound = f">= {minimum}" if inclusive else f"> {minimum}"
            errors.append(
                ValidationError(
                    code="out_of_bounds",
                    field=field,
                    message=f"{field} must be {bound}",
                    value=value,
                )
            )

    return errors
