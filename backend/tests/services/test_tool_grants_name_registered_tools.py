# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Every tool grant the backend ships must name something that can be called.

A grant is an allowlist entry: `mcp__valaris__<name>` for an MCP tool, or a
Claude built-in / `Name(prefix:*)` permission. An entry naming an MCP PROMPT,
a deprecated alias, or a typo never lists and never gates — it rides along
silently and surfaces only as `allowlist_unknown` on a live runner (card
d5e97b40: the planner granted `decompose_card`, a prompt). These guards walk
every grant site and check each entry against the MCP server's own decorators,
the same registry `test_mcp_catalog_drift` uses.
"""

import ast
import re
from collections.abc import Iterator

import pytest

from app.services.agents.context_source_lint import lint_context_source_wiring
from app.services.agents.prompt_defaults import (
    get_prompt_defaults,
    get_prompt_defaults_with_synthesis,
)
from app.services.loop_templates import LOOP_TEMPLATES
from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG
from tests.test_mcp_catalog_drift import (
    MCP_PROMPTS_FILE,
    REPO_ROOT,
    collect_decorated_names,
    collect_mcp_tool_names,
)

MCP_PREFIX = "mcp__valaris__"
MCP_CATALOG_FILE = REPO_ROOT / "mcp-server" / "src" / "valaris_mcp" / "catalog.py"

CLAUDE_BUILTIN_TOOLS = frozenset({
    "Bash", "Read", "Write", "Edit", "Grep", "Glob", "Skill",
    "WebSearch", "WebFetch", "TodoWrite", "Task",
})
# Claude CLI permission syntax, e.g. `Bash(git push:*)`: the name before the
# parenthesis must itself be a built-in, or a typo like `Bassh(git:*)` would
# read as a valid rule.
PERMISSION_RULE_RE = re.compile(r"^([A-Z][A-Za-z]*)\(.+\)$")


def _is_builtin_permission_rule(entry: str) -> bool:
    match = PERMISSION_RULE_RE.match(entry)
    return bool(match) and match.group(1) in CLAUDE_BUILTIN_TOOLS


def iter_default_pipeline_grants() -> Iterator[tuple[str, list[str]]]:
    """Yield `(site_label, tools)` for every stage `llm.tools` and every
    lifecycle step `params.tools` in the default pipeline."""
    for stage in DEFAULT_PIPELINE_CONFIG["stages"]:
        role = stage["role"]
        llm_tools = (stage.get("llm") or {}).get("tools")
        if llm_tools is not None:
            yield f"stage[{role}].llm.tools", llm_tools
        for step in stage.get("lifecycle") or []:
            step_tools = (step.get("params") or {}).get("tools")
            if step_tools is not None:
                yield f"stage[{role}].lifecycle[{step['name']}].params.tools", step_tools


def iter_loop_template_grants(slug: str) -> Iterator[tuple[str, list[str]]]:
    """Yield `(site_label, tools)` for a template's `content.tools` and every
    slot variant's `tools_extra`."""
    template = next(t for t in LOOP_TEMPLATES if t.slug == slug)
    yield f"{slug}.content.tools", template.content.tools
    for slot in template.content.slots:
        for variant in slot.variants:
            yield f"{slug}.slots[{slot.name}].variants[{variant.id}].tools_extra", variant.tools_extra


def iter_all_grants() -> Iterator[tuple[str, list[str]]]:
    yield from iter_default_pipeline_grants()
    for template in LOOP_TEMPLATES:
        yield from iter_loop_template_grants(template.slug)


def collect_deprecated_alias_names() -> set[str]:
    """Keys of `TOOL_META` in catalog.py whose `ToolMeta(...)` carries
    `deprecated_for=`. AST rather than import: the catalog pulls in the `mcp`
    package, which the backend venv does not ship."""
    tree = ast.parse(MCP_CATALOG_FILE.read_text(), filename=str(MCP_CATALOG_FILE))
    for node in ast.walk(tree):
        if not (
            isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and node.target.id == "TOOL_META"
            and isinstance(node.value, ast.Dict)
        ):
            continue
        return {
            key.value
            for key, value in zip(node.value.keys, node.value.values)
            if isinstance(key, ast.Constant)
            and isinstance(value, ast.Call)
            and any(kw.arg == "deprecated_for" for kw in value.keywords)
        }
    raise AssertionError(f"TOOL_META dict literal not found in {MCP_CATALOG_FILE}")


def _unregistered_entries(tools: list[str], registered: set[str]) -> list[str]:
    offending: list[str] = []
    for entry in tools:
        if entry.startswith(MCP_PREFIX):
            if entry.removeprefix(MCP_PREFIX) not in registered:
                offending.append(entry)
        elif entry not in CLAUDE_BUILTIN_TOOLS and not _is_builtin_permission_rule(entry):
            offending.append(entry)
    return offending


def test_unregistered_entries_accepts_builtins_and_rejects_misspelled_permission_rules():
    """The helper is the guard's teeth: a permission rule is only valid when
    the name before the parenthesis is a real built-in."""
    probe = ["WebSearch", "Bash(git push:*)", "Bassh(git:*)", "Bash"]
    assert _unregistered_entries(probe, registered=set()) == ["Bassh(git:*)"]


def test_walker_covers_every_default_pipeline_role():
    """A grant site the walker misses is a grant nothing guards."""
    covered_roles = {label.split("[")[1].split("]")[0] for label, _ in iter_default_pipeline_grants()}
    assert covered_roles == {s["role"] for s in DEFAULT_PIPELINE_CONFIG["stages"]}


def test_default_pipeline_planner_grants_no_prompt_names():
    """`decompose_card` is an `@mcp.prompt`, not a tool: the grant never lists,
    never gates, and the planner (`produces_note`) creates no cards anyway."""
    planner = next(s for s in DEFAULT_PIPELINE_CONFIG["stages"] if s["role"] == "planner")
    llm_tools = planner["llm"].get("tools") or []
    assert "mcp__valaris__decompose_card" not in llm_tools, (
        f"planner llm.tools must drop the decompose_card prompt, got {llm_tools!r}"
    )
    produce_plan = next(
        s for s in planner.get("lifecycle") or [] if s.get("name") == "produce_plan"
    )
    step_tools = (produce_plan.get("params") or {}).get("tools") or []
    assert "mcp__valaris__decompose_card" not in step_tools, (
        f"planner lifecycle produce_plan.params.tools must drop the decompose_card "
        f"prompt, got {step_tools!r}"
    )


def test_default_pipeline_grants_name_registered_mcp_tools_only():
    registered = collect_mcp_tool_names()
    offending = {
        site: entries
        for site, tools in iter_default_pipeline_grants()
        if (entries := _unregistered_entries(tools, registered))
    }
    assert not offending, (
        "Default pipeline grants name entries that are neither an @mcp.tool() nor "
        f"a Claude built-in / permission rule: {offending!r}"
    )


@pytest.mark.parametrize("slug", [t.slug for t in LOOP_TEMPLATES])
def test_loop_template_grants_name_registered_mcp_tools_only(slug: str):
    registered = collect_mcp_tool_names()
    offending = {
        site: entries
        for site, tools in iter_loop_template_grants(slug)
        if (entries := _unregistered_entries(tools, registered))
    }
    assert not offending, (
        f"Template {slug} grants entries that are neither an @mcp.tool() nor a "
        f"Claude built-in / permission rule: {offending!r}"
    )


def test_prompt_names_are_never_granted_as_tools():
    prompt_grants = {f"{MCP_PREFIX}{name}" for name in collect_decorated_names(MCP_PROMPTS_FILE, "prompt")}
    assert prompt_grants, "no @mcp.prompt names collected — registry walk is broken"
    offending = {
        site: sorted(set(tools) & prompt_grants)
        for site, tools in iter_all_grants()
        if set(tools) & prompt_grants
    }
    assert not offending, f"Grants name MCP prompts as if they were tools: {offending!r}"


def test_deprecated_aliases_are_never_granted():
    alias_grants = {f"{MCP_PREFIX}{name}" for name in collect_deprecated_alias_names()}
    assert alias_grants, "no deprecated aliases collected — catalog walk is broken"
    offending = {
        site: sorted(set(tools) & alias_grants)
        for site, tools in iter_all_grants()
        if set(tools) & alias_grants
    }
    assert not offending, f"Grants name deprecated aliases: {offending!r}"


# --- planner handoff context (card d5e97b40, second half) --------------------
#
# The seeded planner prompt told the agent to `list_notes(...)` for researcher
# findings and prior plans, but the planner grant never carried list_notes and
# the stage declared no context source: the same "role cannot read its input"
# class tests/services/test_default_pipeline_handoff_context.py pins for the
# implementer and reviewer. The fix pre-renders every note on the card via a
# kind-less `card_notes` source aliased `CardNotes`, on the stage AND the
# mirrored `produce_plan` step, and the prompt reads it from ContextSources.

CARD_NOTES_ALIAS = "CardNotes"
CONTEXT_SOURCE_INDEX_RE = re.compile(r'\{\{\s*index\s+\.ContextSources\s+"([^"]+)"\s*\}\}')
# A line carrying one of these tells the agent what NOT to call; a tool named
# there is a prohibition, not an instruction, so it must not count as one.
NEGATED_LINE_RE = re.compile(r"\b(MUST NOT|NOT call|never|do not|don't)\b", re.IGNORECASE)


def _stage_by_role(role: str) -> dict:
    return next(s for s in DEFAULT_PIPELINE_CONFIG["stages"] if s["role"] == role)


def _lifecycle_step(stage: dict, name: str) -> dict:
    return next(s for s in stage.get("lifecycle") or [] if s.get("name") == name)


def _card_notes_source(sources: list[dict]) -> dict | None:
    return next((s for s in sources if s.get("kind") == "card_notes"), None)


def _seeded_prompt(role: str, stage: str) -> str:
    return next(
        d.default_content for d in get_prompt_defaults() if d.role == role and d.stage == stage
    )


def instructed_tool_calls(prompt: str, catalog: set[str]) -> set[str]:
    """Catalog names a prompt presents as callable — backticked or with an
    argument list — on lines that are not prohibitions."""
    named: set[str] = set()
    for line in prompt.splitlines():
        if NEGATED_LINE_RE.search(line):
            continue
        named |= {name for name in catalog if f"`{name}`" in line or f"{name}(" in line}
    return named


def test_planner_default_declares_card_notes_source_on_both_sites():
    """Kind-less on purpose: the planner grounds itself in EVERY note linked to
    the card (research findings, prior plans), not one note kind."""
    planner = _stage_by_role("planner")
    for site, sources in (
        ("stage[planner].llm.context_sources", planner["llm"].get("context_sources") or []),
        (
            "stage[planner].lifecycle[produce_plan].params.context_sources",
            (_lifecycle_step(planner, "produce_plan").get("params") or {}).get("context_sources")
            or [],
        ),
    ):
        source = _card_notes_source(sources)
        assert source is not None, f"{site} must declare a card_notes source, got {sources!r}"
        assert source.get("as") == CARD_NOTES_ALIAS, (
            f"{site} card_notes source must be aliased {CARD_NOTES_ALIAS!r}, got {source!r}"
        )
        assert not (source.get("filter") or {}).get("kind"), (
            f"{site} card_notes source must not filter by kind, got {source!r}"
        )


PLANNER_CARD_NOTES_LIMIT = 12


def test_planner_default_card_notes_source_caps_notes_on_both_sites():
    """A long-lived card accumulates research, plans and verdicts; without a
    cap the whole history rides into every planner prompt. Both sites carry
    the same `filter.limit` so the stage and its mirrored step cannot drift."""
    planner = _stage_by_role("planner")
    for site, sources in (
        ("stage[planner].llm.context_sources", planner["llm"].get("context_sources") or []),
        (
            "stage[planner].lifecycle[produce_plan].params.context_sources",
            (_lifecycle_step(planner, "produce_plan").get("params") or {}).get("context_sources")
            or [],
        ),
    ):
        source = _card_notes_source(sources)
        assert source is not None, f"{site} must declare a card_notes source, got {sources!r}"
        assert source.get("filter") == {"limit": PLANNER_CARD_NOTES_LIMIT}, (
            f"{site} card_notes filter must be exactly {{'limit': {PLANNER_CARD_NOTES_LIMIT}}}, "
            f"got {source.get('filter')!r}"
        )


def test_planner_default_prompt_reads_card_notes_from_context_not_list_notes():
    prompt = _seeded_prompt("planner", "plan")
    assert CARD_NOTES_ALIAS in CONTEXT_SOURCE_INDEX_RE.findall(prompt), (
        f'planner prompt must read {{{{ index .ContextSources "{CARD_NOTES_ALIAS}" }}}}'
    )
    assert "list_notes(" not in prompt, (
        "planner prompt still instructs list_notes(...), a tool the planner is not granted"
    )


def test_planner_default_wiring_passes_context_source_lint():
    """Both lint directions for the planner: a declared source its prompt never
    reads, or a prompt reading an alias no source declares."""
    defaults = get_prompt_defaults_with_synthesis(DEFAULT_PIPELINE_CONFIG)
    prompt_contents = {(d.role, d.stage): d.default_content for d in defaults}
    findings = [
        f
        for f in lint_context_source_wiring(DEFAULT_PIPELINE_CONFIG, prompt_contents)
        if "(planner." in f["field"]
    ]
    assert not findings, f"planner context-source wiring has lint findings: {findings!r}"


def _stages_with_seeded_prompts() -> list[tuple[str, str]]:
    seeded = {(d.role, d.stage) for d in get_prompt_defaults()}
    return [
        (s["role"], s["llm"]["stage"])
        for s in DEFAULT_PIPELINE_CONFIG["stages"]
        if (s["role"], s["llm"]["stage"]) in seeded
    ]


@pytest.mark.parametrize(("role", "stage"), _stages_with_seeded_prompts())
def test_default_prompts_never_instruct_a_tool_the_stage_does_not_grant(role: str, stage: str):
    """Prose-to-grant direction for the default pipeline, mirroring the loop
    template guard: a prompt instructing a call the allowlist refuses costs
    the agent a failed call it then has to reason about."""
    granted = {t.removeprefix(MCP_PREFIX) for t in _stage_by_role(role)["llm"]["tools"]}
    ungranted = collect_mcp_tool_names() - granted
    instructed = instructed_tool_calls(_seeded_prompt(role, stage), ungranted)
    assert not instructed, (
        f"{role}.{stage} prompt instructs ungranted tools {sorted(instructed)} — the agent "
        "is told about calls its allowlist will refuse"
    )
