# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Loop template composition — the pure core every caller shares (spec §3.1).

Bind, preview, fit and the MCP twins all reduce to one question: given a
template's kernel and an operator's slot values, what exact strings does the
runner receive? Answering it in one pure module (no DB, no session, no request)
is what lets preview show the truth and render-at-save keep render failures in
front of a human instead of inside a paid iteration.

The rules below are numbered as in the spec and each was paid for in a real
corruption: a cosmetic regex once rewrote ``python3 -m venv .venv``; prompts
legitimately contain ``cat <<EOF`` and ``2>>log``; repo prose contains ``{{``.
Hence: an exact slot grammar, a single substitution pass, and NO cosmetic
cleanup of any kind.
"""

import hashlib
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.services.loop_config_validation import (
    LOOP_RUNNER_VARS,
    OFF_SWITCH_TOOL,
    PROMPT_MAX_BYTES,
    RUNNER_VAR_PATTERN,
    SLOT_PATTERN,
)
from app.services.pipeline_config_validation import ValidationError

# One slot value and one whole render. The per-value cap keeps a pasted logfile
# out of a prompt; the total cap bounds what the runner ships every iteration.
SLOT_VALUE_MAX_BYTES = 16 * 1024
RENDER_MAX_BYTES = 128 * 1024

SLOT_NAME_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]*$")

# The two kernel fields a template renders, in the order the profile page and
# the `used_in` derivation report them.
PROMPT_FIELDS = ("system_prompt", "loop_prompt")

SlotKind = Literal["scalar", "block", "enum", "variant", "list"]


class RenderError(Exception):
    """Carries the full finding list so a 422 can name every problem at once."""

    def __init__(self, errors: list[ValidationError]):
        super().__init__(f"{len(errors)} render error(s)")
        self.errors = errors


class SlotVariant(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    fills: dict[str, Any] = Field(default_factory=dict)
    tools_extra: list[str] = Field(default_factory=list)
    rails: dict[str, Any] = Field(default_factory=dict)


class SlotSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    kind: SlotKind
    required: bool = False
    label: str = ""
    help: str = ""
    example: str = ""
    default: Any = None
    enum_values: list[str] = Field(default_factory=list)
    items: dict[str, Any] | None = None
    join: str = "\n"
    variants: list[SlotVariant] = Field(default_factory=list)
    autofill: str | None = None
    # Stays catalogued so a bound board's stored value never hits unknown_slot,
    # but no prompt reads it; exempt from unused_slot, never required.
    deprecated: bool = False
    # Derived by scanning the prompts during validation. Accepting it from input
    # would let a hand-kept list drift from the text it claims to describe, so
    # any supplied value is discarded rather than trusted.
    used_in: list[str] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _name_matches_slot_grammar(cls, value: str) -> str:
        if not SLOT_NAME_PATTERN.match(value):
            raise ValueError(f"slot name must match {SLOT_NAME_PATTERN.pattern}")
        return value

    @field_validator("used_in")
    @classmethod
    def _used_in_is_derived(cls, _value: list[str]) -> list[str]:
        return []


class TemplateContent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    system_prompt: str = ""
    loop_prompt: str = ""
    slots: list[SlotSpec] = Field(default_factory=list)
    rails_defaults: dict[str, Any] = Field(default_factory=dict)
    tools: list[str] = Field(default_factory=list)
    setup_contract: dict[str, Any] = Field(default_factory=dict)
    derived_rails: dict[str, Any] = Field(default_factory=dict)


class RenderResult(BaseModel):
    system_prompt: str
    loop_prompt: str
    tools: list[str]
    rails: dict[str, Any]
    hash: str


class PreviewResult(BaseModel):
    """What render() would produce, plus everything it would have refused over.

    `used_values` answers "where did each value come from?" — the bind form
    colours a field by its source, so the label is part of the contract, not
    decoration. `missing_required` is the subset a human still has to fill.
    """

    # ValidationError is a dict subclass with attribute access, not a pydantic
    # model, so it is carried as-is rather than through a schema that would
    # flatten it back to a plain dict and lose `.code` for every caller.
    model_config = ConfigDict(arbitrary_types_allowed=True)

    system_prompt: str
    loop_prompt: str
    loop_prompt_with_tools_manifest: str
    tools: list[str]
    rails: dict[str, Any]
    findings: list[ValidationError]
    missing_required: list[str]
    used_values: dict[str, dict[str, Any]]


def _error(
    code: str,
    field: str,
    message: str,
    value: Any = None,
    params: dict[str, Any] | None = None,
) -> ValidationError:
    """A render finding. `params` names the interpolated pieces a localized
    message needs beyond the `field`/`value` ValidationError always carries."""
    return ValidationError(
        code=code, field=field, message=message, value=value, params=params
    )


def _slot_names_in(text: str) -> list[str]:
    """Slot NAMES appearing in `text`, in source order, deduplicated."""
    seen: dict[str, None] = {}
    for match in SLOT_PATTERN.findall(text):
        seen.setdefault(match[2:-2], None)
    return list(seen)


def _derived_rail_slots(expression: Any) -> set[str]:
    """Slot names referenced anywhere inside a derived_rails expression."""
    if isinstance(expression, str):
        return set(_slot_names_in(expression))
    if isinstance(expression, dict):
        return set().union(*(map(_derived_rail_slots, expression.values())) or [set()])
    if isinstance(expression, list):
        return set().union(*(map(_derived_rail_slots, expression)) or [set()])
    return set()


def validate_template(content: TemplateContent) -> list[ValidationError]:
    """Every way a template can be unpublishable, in ONE pass.

    Returns findings rather than raising: the caller decides between a 422 and
    a UI warning list, and an operator fixing a template should see the whole
    list instead of peeling one error per round-trip.

    Side effect by design: `used_in` is refreshed on each slot from the actual
    prompt text, which is the only place that fact can be computed correctly.
    """
    errors: list[ValidationError] = []
    catalogued = {slot.name: slot for slot in content.slots}

    seen: set[str] = set()
    for slot in content.slots:
        if slot.name in seen:
            errors.append(
                _error(
                    "duplicate_slot_name",
                    f"slots.{slot.name}",
                    f"slot {slot.name} is catalogued more than once",
                )
            )
        seen.add(slot.name)

    used_by_slot: dict[str, list[str]] = {name: [] for name in catalogued}
    for field in PROMPT_FIELDS:
        text = getattr(content, field)
        for name in _slot_names_in(text):
            if name in catalogued:
                used_by_slot[name].append(field)
            else:
                errors.append(
                    _error(
                        "uncatalogued_slot",
                        field,
                        f"<<{name}>> appears in {field} but is not in the slot catalog",
                        name,
                    )
                )
    for slot in content.slots:
        slot.used_in = used_by_slot.get(slot.name, [])

    # A variant's fills never appear in the prompts by NAME, so the slots they
    # target are legitimately "unused" — flagging them would make every variant
    # template unpublishable.
    fill_targets: set[str] = set()
    for slot in content.slots:
        for variant in slot.variants:
            for target in variant.fills:
                fill_targets.add(target)
                if target not in catalogued:
                    errors.append(
                        _error(
                            "variant_fills_unknown_slot",
                            f"slots.{slot.name}.variants.{variant.id}",
                            f"variant {variant.id} fills unknown slot {target}",
                            target,
                        )
                    )

    derived_slots = _derived_rail_slots(content.derived_rails)
    for slot in content.slots:
        if slot.deprecated:
            if slot.required:
                errors.append(
                    _error(
                        "deprecated_slot_required",
                        f"slots.{slot.name}",
                        f"deprecated slot {slot.name} may not be required",
                        slot.name,
                    )
                )
            if slot.used_in:
                errors.append(
                    _error(
                        "deprecated_slot_referenced",
                        f"slots.{slot.name}",
                        f"deprecated slot {slot.name} is still read by a prompt",
                        slot.name,
                    )
                )
            continue
        if (
            slot.kind == "variant"
            or slot.used_in
            or slot.name in fill_targets
            or slot.name in derived_slots
        ):
            continue
        errors.append(
            _error(
                "unused_slot",
                f"slots.{slot.name}",
                f"slot {slot.name} is catalogued but no prompt uses it",
                slot.name,
            )
        )

    for field in PROMPT_FIELDS:
        text = getattr(content, field)
        unknown = sorted(set(RUNNER_VAR_PATTERN.findall(text)) - set(LOOP_RUNNER_VARS))
        for name in unknown:
            errors.append(
                _error(
                    "unknown_runner_var",
                    field,
                    f"{{{{.{name}}}}} is not a runner variable; the runner fills "
                    f"only {', '.join(LOOP_RUNNER_VARS)}",
                    name,
                )
            )
        if len(text.encode()) > PROMPT_MAX_BYTES:
            errors.append(
                _error(
                    "prompt_too_large",
                    field,
                    f"{field} exceeds {PROMPT_MAX_BYTES} bytes",
                    len(text.encode()),
                )
            )

    # derived_rails are substituted like prompts but are NOT prompts, so the
    # rule-8 leftover check never sees them. An uncatalogued slot here would
    # ship a literal `<<X>>` into completion_query.label — the rail that decides
    # when the run is complete — and the loop would simply never finish.
    for name in sorted(_derived_rail_slots(content.derived_rails)):
        if name not in catalogued:
            errors.append(
                _error(
                    "uncatalogued_slot",
                    "derived_rails",
                    f"<<{name}>> appears in derived_rails but is not in the "
                    f"slot catalog",
                    name,
                )
            )

    if OFF_SWITCH_TOOL not in content.tools:
        errors.append(
            _error(
                "off_switch_missing",
                "tools",
                f"tools must include {OFF_SWITCH_TOOL} or the loop has no off switch",
            )
        )

    return errors


def resolve_variants(
    content: TemplateContent, slot_values: dict[str, Any]
) -> tuple[dict[str, Any], list[str], dict[str, Any]]:
    """Expand variant selections into plain slot values (rule 2's one level).

    An explicitly supplied value always wins over a variant's fill: the operator
    typed it on purpose, and a variant is a starting point, not an override.

    An omitted selection falls back to the slot's `default`. Without that
    fallback a template whose default option carries fills, tools_extra AND
    rails would render as if the operator had chosen nothing at all — a silent
    hole exactly where the template author declared a safe answer.
    """
    values = dict(slot_values)
    tools_extra: list[str] = []
    rails: dict[str, Any] = {}
    errors: list[ValidationError] = []

    for slot in content.slots:
        if slot.kind != "variant":
            continue
        selected_id = slot_values.get(slot.name)
        if selected_id in (None, ""):
            selected_id = slot.default
        if selected_id in (None, ""):
            if slot.required:
                errors.append(
                    _error(
                        "required_slot_missing",
                        f"slot_values.{slot.name}",
                        f"{slot.name} is required and was not supplied",
                    )
                )
            continue
        variant = next((v for v in slot.variants if v.id == selected_id), None)
        if variant is None:
            errors.append(
                _error(
                    "variant_not_found",
                    f"slot_values.{slot.name}",
                    f"{selected_id} is not a variant of {slot.name}",
                    selected_id,
                )
            )
            continue
        for target, filled in variant.fills.items():
            if slot_values.get(target) in (None, ""):
                values[target] = filled
        for tool in variant.tools_extra:
            if tool not in tools_extra:
                tools_extra.append(tool)
        rails.update(variant.rails)

    if errors:
        raise RenderError(errors)
    return values, tools_extra, rails


def effective_slot_values(
    content: TemplateContent, slot_values: dict[str, Any]
) -> dict[str, Any]:
    """The values `render` will actually substitute, without rendering.

    Variant fills and slot defaults are resolved INSIDE `render`, so a caller
    that inspects `slot_values` alone sees a template as unfilled where the
    render would have succeeded. Callers that must decide "will this render?"
    before running it — the new-required-slot guard — ask here instead, so
    there is one resolution rather than two that can drift.

    Only slot values come back: variant selection also yields `tools_extra`
    and `rails`, and leaking those would let a caller seed board rails from a
    question that was only ever about which slots have values.

    Never raises. It runs in FRONT of `render`, whose per-slot errors are the
    contract a caller is about to receive; a template this cannot resolve is
    simply reported as having fewer effective values.
    """
    try:
        resolved, _tools_extra, _rails = resolve_variants(content, slot_values)
    except RenderError:
        resolved = dict(slot_values)

    effective: dict[str, Any] = {}
    for slot in content.slots:
        if slot.kind == "variant":
            continue
        # Mirrors render()'s own fallback: `""`/`[]`/None are not answers, so
        # they fall through to the default exactly as a substitution would.
        value = resolved.get(slot.name)
        if value in (None, "", []):
            value = slot.default
        if value in (None, "", []):
            continue
        effective[slot.name] = value
    return effective


def _escape_go_template(value: str) -> str:
    """Rule 6: `{{` in a VALUE becomes a text/template literal that renders back
    to `{{`. A `}}` outside an action is already plain text to text/template, so
    escaping it would corrupt the value rather than protect it."""
    return value.replace("{{", '{{"{{"}}')


def _list_items(
    slot: SlotSpec, field: str, value: Any
) -> tuple[list[Any], list[ValidationError]]:
    """The items a `list` slot renders, or one finding saying why it cannot.

    A non-list value used to render as the empty string, which shipped the
    runner a prompt silently missing a whole section — no error, no drift, no
    signal. Two shapes are answers rather than mistakes:

      * a list, obviously — including `[]`, which means "no items";
      * a STRING, split on newlines, because that is what an operator typing
        into a textarea means and what every binding stored before this
        contract already holds. Blank lines are dropped so a trailing newline
        does not become an empty item.

    Everything else (int, dict, float, bool) is a caller bug the operator can
    fix, so it becomes a finding naming the slot instead of a blank section.
    """
    if isinstance(value, list):
        return value, []
    if isinstance(value, str):
        return [line for line in value.splitlines() if line.strip()], []
    return [], [
        _error(
            "list_slot_expects_array",
            field,
            f"{slot.name} is a list slot and expects an array of strings",
            value,
            params={"slot": slot.name},
        )
    ]


def _stringify(slot: SlotSpec, value: Any) -> tuple[str, list[ValidationError]]:
    """Rule 7 — kind semantics, and the only place a value becomes text."""
    errors: list[ValidationError] = []
    field = f"slot_values.{slot.name}"

    if slot.kind == "list":
        items, list_errors = _list_items(slot, field, value)
        errors.extend(list_errors)
        return slot.join.join(str(item) for item in items), errors

    text = "" if value is None else str(value)

    if slot.kind == "scalar" and "\n" in text:
        errors.append(
            _error(
                "scalar_must_be_single_line",
                field,
                f"{slot.name} is a scalar slot and cannot contain a newline",
            )
        )
    if slot.kind == "enum" and text and text not in slot.enum_values:
        errors.append(
            _error(
                "enum_value_not_allowed",
                field,
                f"{slot.name} must be one of {slot.enum_values}",
                text,
            )
        )
    return text, errors


def _substitute(text: str, values: dict[str, str]) -> str:
    """Rules 1-5: one pass, indent-aware, empty-value aware, cleanup-free.

    Walks line by line because rules 3 and 4 are both line-scoped: a block value
    re-indents to ITS line's indentation, and an empty value's blast radius is
    at most that one line.
    """
    output: list[str] = []

    for line in text.split("\n"):
        names = _slot_names_in(line)
        rendered = [name for name in names if name in values]
        if not rendered:
            output.append(line)
            continue

        # Rule 4a: the placeholder is the only non-whitespace on the line and
        # its value is empty -> the whole line goes.
        stripped = line.strip()
        if (
            len(rendered) == 1
            and len(names) == 1
            and stripped == f"<<{rendered[0]}>>"
            and values[rendered[0]] == ""
        ):
            continue

        indent = line[: len(line) - len(line.lstrip())]
        # Rule 2: ONE left-to-right pass over the ORIGINAL line. Substituted
        # text is appended to the output and never re-scanned, so a value
        # containing `<<X>>` stays literal instead of reaching into the catalog.
        parts: list[str] = []
        cursor = 0
        for match in SLOT_PATTERN.finditer(line):
            name = match.group()[2:-2]
            if name not in values:
                continue
            before = line[cursor : match.start()]
            value = values[name]
            if value == "":
                # Rule 4b: drop a wrapping `(...)`, else exactly ONE adjacent
                # space — the one before, else the one after. Nothing more.
                after_is_paren = line[match.end() : match.end() + 1] == ")"
                if before.endswith("(") and after_is_paren:
                    before = before[:-1]
                    cursor = match.end() + 1
                    if before.endswith(" "):
                        before = before[:-1]
                    elif line[cursor : cursor + 1] == " ":
                        cursor += 1
                elif before.endswith(" "):
                    before = before[:-1]
                    cursor = match.end()
                elif line[match.end() : match.end() + 1] == " ":
                    cursor = match.end() + 1
                else:
                    cursor = match.end()
                parts.append(before)
                continue
            # Rule 3: every line after the first gets the placeholder line's
            # indentation, so a block value lands inside the structure that
            # introduced it.
            parts.append(before)
            parts.append(value.replace("\n", "\n" + indent) if indent else value)
            cursor = match.end()
        parts.append(line[cursor:])
        output.append("".join(parts))

    return "\n".join(output)


def prompts_hash(system_prompt: str, loop_prompt: str) -> str:
    """The identity of one rendered prompt PAIR.

    Named rather than inlined because drift recomputes it over the prompts a
    board serves now and compares against the stored render — two formulas that
    silently diverged would turn every bound board into a false positive. The
    NUL separator keeps ("ab", "c") and ("a", "bc") apart.
    """
    return hashlib.sha256(
        f"{system_prompt}\x00{loop_prompt}".encode()
    ).hexdigest()


def render(content: TemplateContent, slot_values: dict[str, Any]) -> RenderResult:
    """Kernel + values -> the exact strings the runner will receive.

    Raises RenderError with every finding, because this runs at SAVE time in
    front of a human: a partial answer would cost another round-trip.
    """
    values, tools_extra, variant_rails = resolve_variants(content, slot_values)
    catalogued = {slot.name: slot for slot in content.slots}
    errors: list[ValidationError] = []
    # Two views of the same values. Only prompts are handed to the runner's Go
    # text/template, so only THEY get rule 6's `{{` escape; derived_rails are
    # platform config read verbatim, and an escaped completion_query label would
    # simply stop matching. Sorted so a caller sees a deterministic finding list.
    raw_values: dict[str, str] = {}
    prompt_values: dict[str, str] = {}

    # Spec §2.2: a key the catalog does not know is a typo, and dropping it
    # silently lets a binding persist a value no prompt will ever read.
    for name in sorted(set(slot_values) - set(catalogued)):
        errors.append(
            _error(
                "unknown_slot",
                f"slot_values.{name}",
                f"{name} is not a slot of this template",
                name,
            )
        )

    for slot in content.slots:
        if slot.kind == "variant":
            continue
        supplied = values.get(slot.name, slot.default)
        if supplied in (None, "", []) and slot.required:
            errors.append(
                _error(
                    "required_slot_missing",
                    f"slot_values.{slot.name}",
                    f"{slot.name} is required and was not supplied",
                )
            )
            continue
        text, kind_errors = _stringify(slot, supplied)
        errors.extend(kind_errors)
        if len(text.encode()) > SLOT_VALUE_MAX_BYTES:
            errors.append(
                _error(
                    "slot_value_too_large",
                    f"slot_values.{slot.name}",
                    f"{slot.name} exceeds {SLOT_VALUE_MAX_BYTES} bytes",
                    len(text.encode()),
                )
            )
        raw_values[slot.name] = text
        prompt_values[slot.name] = _escape_go_template(text)

    if errors:
        raise RenderError(errors)

    rendered = {
        field: _substitute(getattr(content, field), prompt_values)
        for field in PROMPT_FIELDS
    }

    # Rule 8: anything still matching the slot grammar was never catalogued, so
    # it would reach the runner as literal `<<X>>` noise.
    for field, text in rendered.items():
        for name in _slot_names_in(text):
            if name not in catalogued:
                errors.append(
                    _error(
                        "unrendered_slot",
                        field,
                        f"<<{name}>> is not a catalogued slot and was left "
                        f"unrendered in {field}",
                        name,
                    )
                )

    total = sum(len(text.encode()) for text in rendered.values())
    if total > RENDER_MAX_BYTES:
        errors.append(
            _error(
                "render_too_large",
                "template",
                f"rendered prompts total {total} bytes, over {RENDER_MAX_BYTES}",
                total,
            )
        )

    if errors:
        raise RenderError(errors)

    tools = list(content.tools)
    for tool in tools_extra:
        if tool not in tools:
            tools.append(tool)

    rails = {**content.rails_defaults, **variant_rails}
    for path, expression in content.derived_rails.items():
        rails[path] = _apply_derived(expression, raw_values)

    digest = prompts_hash(rendered["system_prompt"], rendered["loop_prompt"])

    return RenderResult(
        system_prompt=rendered["system_prompt"],
        loop_prompt=rendered["loop_prompt"],
        tools=tools,
        rails=rails,
        hash=digest,
    )


def render_runner_tools_manifest(tools: list[str]) -> str:
    """The block the runner appends to every loop prompt, byte for byte.

    Transcribed from `toolManifest` in runner/internal/workloop/loopmode.go
    (called at `loopPrompt += toolManifest(cfg.Tools)`). A preview that omitted
    it would misrepresent what the agent actually reads, and the empty branch
    is the load-bearing one: it TELLS the agent no allowlist was granted, which
    is the opposite of showing nothing.

    Deliberately a duplicated string, not an import: Python cannot call Go, and
    the Go suite is the thing that would notice a drift on its side. If that
    function changes, change this one and its golden test together.
    """
    lines = [
        "\n\n## Tools available\n\n",
        "(the board granted no explicit allowlist)\n" if not tools else "",
        *(f"{tool}\n" for tool in tools),
        "\nIf keyword search misses a tool listed here, load it with "
        'ToolSearch("select:<name>").\n',
    ]
    return "".join(lines)


# Where a preview's value for a slot came from, best first. `supplied` is the
# operator's own keystroke, `autofill` a fact read off the board, and the last
# two are the template author's fallbacks.
VALUE_SOURCE_ORDER = ("supplied", "autofill", "default", "example")


def preview(
    content: TemplateContent,
    slot_values: dict[str, Any],
    autofill: dict[str, dict[str, Any]],
) -> PreviewResult:
    """render(), but findings are COLLECTED rather than raised.

    Preview exists to show an operator what they are about to commit to, so
    every condition render() refuses over is something preview must display:
    a missing required slot, a typo'd slot name, a bogus variant id. The
    prompts render as far as the available values allow, which keeps an unfilled
    `<<SLOT>>` visible exactly where the hole is.

    This is why it cannot simply call render() and catch: render() raises before
    substituting, so a caught error yields no prompts at all.
    """
    findings: list[ValidationError] = list(validate_template(content))
    catalogued = {slot.name: slot for slot in content.slots}

    for name in sorted(set(slot_values) - set(catalogued)):
        findings.append(
            _error(
                "unknown_slot",
                f"slot_values.{name}",
                f"{name} is not a slot of this template",
                name,
            )
        )

    resolved, variant_tools, variant_rails, variant_findings = _resolve_variants_soft(
        content, slot_values
    )
    findings.extend(variant_findings)

    used_values: dict[str, dict[str, Any]] = {}
    missing_required: list[str] = []
    raw_values: dict[str, str] = {}
    prompt_values: dict[str, str] = {}

    for slot in content.slots:
        if slot.kind == "variant":
            continue
        value, source = _first_available(slot, resolved, autofill)
        if source is None:
            if slot.required:
                missing_required.append(slot.name)
                findings.append(
                    _error(
                        "required_slot_missing",
                        f"slot_values.{slot.name}",
                        f"{slot.name} is required and was not supplied",
                    )
                )
            continue
        text, kind_findings = _stringify(slot, value)
        findings.extend(kind_findings)
        if len(text.encode()) > SLOT_VALUE_MAX_BYTES:
            findings.append(
                _error(
                    "slot_value_too_large",
                    f"slot_values.{slot.name}",
                    f"{slot.name} exceeds {SLOT_VALUE_MAX_BYTES} bytes",
                    len(text.encode()),
                )
            )
        used_values[slot.name] = {"value": value, "source": source}
        raw_values[slot.name] = text
        prompt_values[slot.name] = _escape_go_template(text)

    rendered = {
        field: _substitute(getattr(content, field), prompt_values)
        for field in PROMPT_FIELDS
    }

    # A slot left in the text is either one this preview could not fill (already
    # reported as missing_required) or a typo the catalog never knew about.
    for field, text in rendered.items():
        for name in _slot_names_in(text):
            if name not in catalogued:
                findings.append(
                    _error(
                        "unrendered_slot",
                        field,
                        f"<<{name}>> is not a catalogued slot and was left "
                        f"unrendered in {field}",
                        name,
                    )
                )

    tools = list(content.tools)
    for tool in variant_tools:
        if tool not in tools:
            tools.append(tool)

    rails = {**content.rails_defaults, **variant_rails}
    for path, expression in content.derived_rails.items():
        rails[path] = _apply_derived(expression, raw_values)

    return PreviewResult(
        system_prompt=rendered["system_prompt"],
        loop_prompt=rendered["loop_prompt"],
        loop_prompt_with_tools_manifest=(
            rendered["loop_prompt"] + render_runner_tools_manifest(tools)
        ),
        tools=tools,
        rails=rails,
        findings=findings,
        missing_required=missing_required,
        used_values=used_values,
    )


def _first_available(
    slot: SlotSpec,
    resolved: dict[str, Any],
    autofill: dict[str, dict[str, Any]],
) -> tuple[Any, str | None]:
    """The winning value for one slot and the rung it came from.

    `None` as the source means every rung was empty — the caller decides
    whether that is a missing requirement or simply an optional slot.
    """
    candidates = (
        ("supplied", resolved.get(slot.name)),
        ("autofill", (autofill.get(slot.name) or {}).get("value")),
        ("default", slot.default),
        ("example", slot.example),
    )
    for source, value in candidates:
        # An optional empty default is intentional omission, not sample content.
        if source == "default" and value == "" and not slot.required:
            return value, source
        if value not in (None, "", []):
            return value, source
    return None, None


def _resolve_variants_soft(
    content: TemplateContent, slot_values: dict[str, Any]
) -> tuple[dict[str, Any], list[str], dict[str, Any], list[ValidationError]]:
    """resolve_variants() with its two raises downgraded to findings.

    Kept beside the strict version rather than parameterised into it: bind
    depends on that function's all-or-nothing contract, and a `soft=True` flag
    on a save-time primitive is one wrong default away from persisting a
    half-resolved template.
    """
    try:
        values, tools_extra, rails = resolve_variants(content, slot_values)
        return values, tools_extra, rails, []
    except RenderError as exc:
        # Re-run with the offending selections dropped, so everything the
        # operator got RIGHT still renders behind the finding.
        bad = {
            error["field"].split(".", 1)[1]
            for error in exc.errors
            if error["field"].startswith("slot_values.")
        }
        salvaged = {k: v for k, v in slot_values.items() if k not in bad}
        relaxed = content.model_copy(
            update={
                "slots": [
                    slot.model_copy(update={"required": False})
                    if slot.kind == "variant"
                    else slot
                    for slot in content.slots
                ]
            }
        )
        values, tools_extra, rails = resolve_variants(relaxed, salvaged)
        return values, tools_extra, rails, list(exc.errors)


def _apply_derived(expression: Any, values: dict[str, str]) -> Any:
    """Substitute slots inside a derived_rails expression, at any depth.

    `completion_query: {label: "<<RUN_LABEL>>"}` is the motivating case: the
    rail that decides when the run is COMPLETE is derived from the same slot
    the prompts use, so the two can never disagree.

    Takes RAW values, never the Go-escaped ones: rails are platform config, not
    runner prompts, and text/template never sees them.
    """
    if isinstance(expression, str):
        return _substitute(expression, values)
    if isinstance(expression, dict):
        return {key: _apply_derived(item, values) for key, item in expression.items()}
    if isinstance(expression, list):
        return [_apply_derived(item, values) for item in expression]
    return expression
