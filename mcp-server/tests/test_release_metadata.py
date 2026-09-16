# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Release metadata and preserved upgrade contracts for published MCP versions."""
from __future__ import annotations

import ast
import inspect
import json
import re
import tomllib
from pathlib import Path

MCP_SERVER_DIR = Path(__file__).resolve().parents[1]
PYPROJECT_PATH = MCP_SERVER_DIR / "pyproject.toml"
CHANGELOG_PATH = MCP_SERVER_DIR / "CHANGELOG.md"
README_PATH = MCP_SERVER_DIR / "README.md"

TOOLSETS_RELEASE = "0.6.0"
TOOLSETS_RELEASE_DATE = "2026-09-03"
PREVIOUS_RELEASE = "0.5.0"
# MCP #4 (card 1d128057): near-duplicate tools folded behind deprecation aliases.
CONSOLIDATION_RELEASE = "0.7.0"
CONSOLIDATION_RELEASE_DATE = "2026-09-04"
# MCP #6: `enable_toolsets` widens a running session's hand (tools.listChanged).
ENABLE_TOOLSETS_RELEASE = "0.7.1"
# Cards 6a25bc2f / 8ddbedac: tracker reads FastMCP's converted result, records
# raised calls as failed, installs once per tool manager.
TRACKER_RELEASE = "0.7.2"
# Audit T03 (card b24a2fb8): streamable-http never started — host/port were
# passed to FastMCP.run() instead of mcp.settings.
HTTP_TRANSPORT_RELEASE = "0.7.3"
CURRENT_RELEASE = "0.8.0"
CURRENT_RELEASE_DATE = "2026-09-13"
# One line that restores the pre-0.6.0 full surface for an unchanged config.
FULL_SURFACE_ONE_LINER = '"VALARIS_MCP_TOOLSETS": "all"'


def _release_heading_re(version: str) -> re.Pattern[str]:
    # Keep-a-Changelog `## [0.6.0]` or the bare `## 0.6.0` form.
    return re.compile(rf"^## \[?{re.escape(version)}\]?", re.MULTILINE)


def _changelog_text() -> str:
    assert CHANGELOG_PATH.exists(), f"{CHANGELOG_PATH.name} is missing next to pyproject.toml"
    return CHANGELOG_PATH.read_text()


def test_pyproject_version_is_the_current_release():
    project = tomllib.loads(PYPROJECT_PATH.read_text())["project"]
    assert project["version"] == CURRENT_RELEASE


def test_changelog_newest_heading_is_the_dated_current_release_above_the_consolidation_one():
    text = _changelog_text()
    heading = _release_heading_re(CURRENT_RELEASE).search(text)
    assert heading, f"CHANGELOG.md has no `## [{CURRENT_RELEASE}]` heading"
    first_heading = re.search(r"^## \[?\d+\.\d+\.\d+", text, re.MULTILINE)
    assert first_heading.start() == heading.start(), "a newer release heading sits above it"
    assert heading.start() < _release_heading_re(CONSOLIDATION_RELEASE).search(text).start()
    heading_line = text[heading.start() : text.index("\n", heading.start())]
    assert CURRENT_RELEASE_DATE in heading_line, heading_line


def test_changelog_http_transport_entry_remains_a_fixed_only_patch():
    text = _changelog_text()
    start = _release_heading_re(HTTP_TRANSPORT_RELEASE).search(text).start()
    end = _release_heading_re(TRACKER_RELEASE).search(text).start()
    section = text[start:end]
    subsections = re.findall(r"^### (.+)$", section, re.MULTILINE)
    assert subsections == ["Fixed"], subsections
    assert "streamable-http" in section
    assert "MCP_HOST" in section and "MCP_PORT" in section


def test_readme_upgrade_section_covers_the_current_release():
    text = README_PATH.read_text()
    assert f"### Upgrading from {HTTP_TRANSPORT_RELEASE}" in text
    section = text.split(f"### Upgrading from {HTTP_TRANSPORT_RELEASE}", 1)[1].split("### Upgrading", 1)[0]
    for term in (CURRENT_RELEASE, "Breaking", "list_notes", "next_offset", "summary_only", "backend", "restart", "ProseMirror"):
        assert term in section


def test_changelog_tracker_entry_is_a_fixed_only_patch_naming_the_tracker_fixes():
    text = _changelog_text()
    start = _release_heading_re(TRACKER_RELEASE).search(text).start()
    end = _release_heading_re(ENABLE_TOOLSETS_RELEASE).search(text).start()
    section = text[start:end]
    subsections = re.findall(r"^### (.+)$", section, re.MULTILINE)
    assert subsections == ["Fixed"], subsections
    assert "CallToolResult" in section
    assert "install_tracking" in section
    assert "PermissionError" in section


def test_changelog_enable_toolsets_entry_names_the_tool_and_the_list_changed_capability():
    text = _changelog_text()
    start = _release_heading_re(ENABLE_TOOLSETS_RELEASE).search(text).start()
    end = _release_heading_re(CONSOLIDATION_RELEASE).search(text).start()
    section = text[start:end]
    assert "enable_toolsets" in section
    assert "tools.listChanged" in section
    assert "Upgrade note" in section


def _consolidation_release_section() -> str:
    text = _changelog_text()
    start = _release_heading_re(CONSOLIDATION_RELEASE).search(text).start()
    end = _release_heading_re(TOOLSETS_RELEASE).search(text).start()
    return text[start:end]


def test_changelog_has_the_dated_consolidation_release_before_the_toolsets_one():
    text = _changelog_text()
    heading = _release_heading_re(CONSOLIDATION_RELEASE).search(text)
    assert heading, f"CHANGELOG.md has no `## [{CONSOLIDATION_RELEASE}]` heading"
    assert heading.start() < _release_heading_re(TOOLSETS_RELEASE).search(text).start()
    heading_line = text[heading.start() : text.index("\n", heading.start())]
    assert CONSOLIDATION_RELEASE_DATE in heading_line, heading_line


def test_changelog_consolidation_entry_maps_every_deprecated_alias_to_its_replacement():
    from valaris_mcp.catalog import deprecated_aliases

    section = _consolidation_release_section()
    assert "Upgrade note" in section
    assert "0.8.0" in section  # Preserve the original published removal announcement.
    for alias in deprecated_aliases():
        assert f"| `{alias}` |" in section, f"{alias} missing from the upgrade table"


def test_changelog_has_the_toolsets_release_entry():
    text = _changelog_text()
    assert _release_heading_re(TOOLSETS_RELEASE).search(text), (
        f"CHANGELOG.md has no `## [{TOOLSETS_RELEASE}]` heading"
    )


def test_changelog_toolsets_entry_names_the_feature_and_env_var():
    text = _changelog_text()
    assert "toolsets" in text
    assert "VALARIS_MCP_TOOLSETS" in text


def test_changelog_keeps_the_previous_release_entry():
    assert _release_heading_re(PREVIOUS_RELEASE).search(_changelog_text())


def test_changelog_lists_the_toolsets_release_before_the_previous_one():
    text = _changelog_text()
    toolsets_at = _release_heading_re(TOOLSETS_RELEASE).search(text).start()
    previous_at = _release_heading_re(PREVIOUS_RELEASE).search(text).start()
    assert toolsets_at < previous_at


def _toolsets_release_section() -> str:
    text = _changelog_text()
    start = _release_heading_re(TOOLSETS_RELEASE).search(text).start()
    end = _release_heading_re(PREVIOUS_RELEASE).search(text).start()
    return text[start:end]


def test_changelog_toolsets_release_is_dated():
    heading = _toolsets_release_section().splitlines()[0]
    assert TOOLSETS_RELEASE_DATE in heading, heading


def test_changelog_toolsets_entry_leads_with_a_breaking_section():
    # Unchanged configs stop seeing the full surface: that is the first thing
    # an upgrading operator must read, before any Added/Changed items.
    subsections = re.findall(r"^### (.+)$", _toolsets_release_section(), re.MULTILINE)
    assert subsections and subsections[0] == "Breaking", subsections


def test_changelog_breaking_section_gives_the_full_surface_one_liner():
    section = _toolsets_release_section()
    breaking = section[section.index("### Breaking"):]
    breaking = breaking[: breaking.index("### ", len("### Breaking"))]
    assert FULL_SURFACE_ONE_LINER in breaking
    assert "runner" in breaking.lower()


def test_changelog_toolsets_entry_notes_when_the_first_items_landed():
    assert "2026-09-02" in _toolsets_release_section()


def test_changelog_toolsets_entry_does_not_claim_the_handshake_version_stamp():
    # That shipped in 0.1.1; repeating it under 0.6.0 misdates the change.
    assert "advertises the Backplane release" not in _toolsets_release_section()


def test_readme_has_an_upgrade_note_with_the_full_surface_one_liner():
    text = README_PATH.read_text()
    assert f"Upgrading from {PREVIOUS_RELEASE}" in text
    upgrade_at = text.index(f"Upgrading from {PREVIOUS_RELEASE}")
    assert FULL_SURFACE_ONE_LINER in text[upgrade_at:]


def test_readme_documents_resolved_tool_count_as_pre_allowlist():
    text = README_PATH.read_text()
    assert "resolved_tool_count" in text
    sentence_at = text.index("resolved_tool_count")
    assert "allowlist" in text[sentence_at : sentence_at + 400]


def _readme_section(heading: str) -> str:
    text = README_PATH.read_text()
    start = text.index(heading) + len(heading)
    end = re.search(r"^#{1,3} ", text[start:], re.MULTILINE)
    return text[start : start + end.start()] if end else text[start:]


def test_readme_maps_human_presets_and_preserves_runner_allowlist_composition():
    text = README_PATH.read_text()
    rows = text.splitlines()
    assert any(re.search(r"everyday", row, re.I) and "`default`" in row for row in rows)
    assert any(re.search(r"loops", row, re.I) and "default,autonomous-operations" in row for row in rows)
    assert any(re.search(r"everything", row, re.I) and "`all`" in row for row in rows)
    assert re.search(r"interactive.{0,150}(?:prepar|manag).{0,80}loops", text, re.I | re.S)
    assert re.search(r"runner.{0,250}\ball\b.{0,250}allowlist", text, re.I | re.S)
    assert re.search(r"custom.{0,100}(?:compos|toolset|select)", text, re.I | re.S)


def test_readme_first_local_config_explicitly_selects_compact_default():
    examples = re.findall(r"```json\n(.*?)```", README_PATH.read_text(), re.S)
    configs = [json.loads(example) for example in examples if '"mcpServers"' in example]
    assert configs, "Missing local MCP configuration"
    local = configs[0]["mcpServers"]["valaris"]
    assert local["command"] == "uvx"
    assert local["args"] == ["backplane-mcp"]
    assert local["env"]["VALARIS_API_URL"] == "https://your-backplane-host"
    assert local["env"].get("VALARIS_MCP_TOOLSETS") == "default"


def test_readme_has_no_private_onboarding_evidence_or_frozen_catalog_count():
    text = README_PATH.read_text()
    assert not re.search(r"intern\.valaris\.studio|runner-laptop-seba", text)
    assert not re.search(r"\b\d+\s+tools\b", text)


def test_readme_local_stdio_can_use_remote_api_without_becoming_remote_mcp():
    text = README_PATH.read_text()
    assert re.search(r"local.{0,70}stdio.{0,160}remote.{0,70}(?:API|Backplane)", text, re.I | re.S)
    assert re.search(r"client.{0,50}environment.{0,80}(?:does not|cannot).{0,60}remote", text, re.I | re.S)


def test_readme_recovery_contains_remote_operator_service_env_and_protected_use():
    text = _readme_section("### When enabled tools are still missing")
    examples = re.findall(r"```(?:bash|sh|env|dotenv)\n(.*?)```", text, re.S)
    env = next((example for example in examples if "MCP_TRANSPORT" in example), "")
    assert re.search(r"MCP_TRANSPORT=[\"']?streamable-http", env), "Missing remote operator service env"
    assert re.search(r"MCP_HOST=[\"']?0\.0\.0\.0", env)
    assert re.search(r"VALARIS_MCP_TOOLSETS=[\"']?default,autonomous-operations", env)
    assert not re.search(r"gcloud|kubectl|aws |az ", env)
    assert re.search(r"protect|authenticated|authentication", text, re.I)
    assert re.search(r"restart.{0,150}server/connection.{0,100}(?:new|fresh) agent session", text, re.I | re.S)
    assert re.search(r"new chat alone.{0,100}(?:reuse|cached|stale)", text, re.I | re.S)


def test_readme_exact_restart_env_keeps_every_enabled_group_and_allowlist():
    text = _readme_section("### When enabled tools are still missing")
    assert re.search(r"(?:exact|unchanged).{0,70}restart_env|restart_env.{0,70}(?:exact|unchanged)", text, re.I | re.S)
    assert re.search(r"(?:all|every).{0,50}enabled.{0,50}(?:group|toolset)", text, re.I | re.S)
    assert "VALARIS_MCP_ALLOWLIST" in text
    assert re.search(r"(?:preserv|keep).{0,100}allowlist.{0,30}unchanged", text, re.I | re.S)
    assert re.search(r"(?:fresh|example).{0,60}connection|connection.{0,60}(?:fresh|example)", text, re.I | re.S)


def test_readme_native_check_examples_bind_to_current_read_only_tool_signatures():
    from valaris_mcp.tools.agents import list_agents, list_executions
    from valaris_mcp.tools.boards import list_boards
    from valaris_mcp.tools.context import get_project_context
    from valaris_mcp.tools.loop_templates import list_loop_templates
    from valaris_mcp.tools.workspaces import list_workspaces, whoami

    text = README_PATH.read_text()
    code_fragments = re.findall(r"```[^\n]*\n(.*?)```|`([^`\n]+)`", text, re.S)
    examples = "\n".join(block or inline for block, inline in code_fragments)
    required = {
        "whoami": whoami,
        "list_workspaces": list_workspaces,
        "list_boards": list_boards,
        "get_project_context": get_project_context,
        "list_agents": list_agents,
        "list_loop_templates": list_loop_templates,
    }
    optional = {"list_executions": list_executions}
    for name, tool in (required | optional).items():
        calls = re.findall(rf"\b{name}\([^)]*\)", examples)
        if name in required:
            assert calls, f"Missing read-only native example: {name}"
        for source in calls:
            call = ast.parse(source, mode="eval").body
            assert isinstance(call, ast.Call)
            args = [ast.literal_eval(arg) for arg in call.args]
            kwargs = {arg.arg: ast.literal_eval(arg.value) for arg in call.keywords}
            # FastMCP injects ctx; it is not an agent-supplied argument.
            assert "ctx" not in kwargs
            inspect.signature(tool).bind(*args, **kwargs, ctx=None)
            if name == "list_agents":
                assert not args and "workspace_slug" not in kwargs
            if name in {"list_boards", "get_project_context", "list_loop_templates", "list_executions"}:
                assert kwargs.get("workspace_slug"), "Use the selected authorized workspace"
            if name == "get_project_context":
                assert kwargs.get("board_id"), "Use an existing returned board ID"
            if name == "list_executions":
                assert kwargs.get("limit") == 1
    assert not re.search(r"\b(?:propose_skill|register_agent|bind_loop|start_loop|create_card)\(", examples)
    assert re.search(r"propose_skill.{0,120}(?:presence|without|do not|never)|(?:presence|without|do not|never).{0,120}propose_skill", text, re.I | re.S)


def test_readme_everyday_checks_resolve_authorized_workspace_and_skip_absent_boards():
    text = " ".join(_readme_section("### When enabled tools are still missing").split())
    assert re.search(r"(?:everyday|default).{0,300}list_boards", text, re.I)
    assert "list_workspaces" in text and "get_project_context" in text
    assert re.search(r"(?:resolve|select|choose).{0,120}authorized workspace|authorized workspace.{0,120}(?:resolve|select|choose)", text, re.I)
    assert re.search(r"(?:ambiguous|multiple).{0,120}(?:ask|confirm)|(?:ask|confirm).{0,120}(?:ambiguous|multiple)", text, re.I)
    assert re.search(r"(?:no|without) authorized workspace.{0,140}(?:stop|skip)", text, re.I)
    assert re.search(r"(?:existing|returned).{0,70}board.{0,30}(?:ID|identifier)|board.{0,30}(?:ID|identifier).{0,70}(?:existing|returned)", text, re.I)
    assert re.search(r"(?:no boards|empty.{0,40}(?:board|list)).{0,180}skip.{0,60}(?:project.context|get_project_context)", text, re.I)


def test_readme_everything_check_is_representative_not_full_catalog_certification():
    text = " ".join(_readme_section("### When enabled tools are still missing").split())
    assert re.search(r"Everything.{0,300}(?:everyday|default).{0,150}loops|Everything.{0,300}loops.{0,150}(?:everyday|default)", text, re.I)
    assert re.search(r"Everything.{0,400}representative|representative.{0,400}Everything", text, re.I)
    assert re.search(r"(?:not|does not|do not).{0,80}(?:every tool|full.catalog)|(?:every tool|full.catalog).{0,80}(?:not verified|not certified)", text, re.I)


def test_readme_native_verification_is_distinct_from_auth_notification_and_server_count():
    text = README_PATH.read_text()
    assert "list_changed_sent" in text and "client_catalog_status" in text
    assert re.search(r"(?:API.key|authentication).{0,180}(?:does not|not proof|not verify)", text, re.I | re.S)
    assert re.search(r"empty.{0,100}(?:success|callable)|success.{0,100}empty", text, re.I | re.S)
    assert "401" in text and "403" in text
    assert re.search(r"network", text, re.I)
    assert re.search(r"schema", text, re.I)


def test_readme_install_distinguishes_unpublished_candidate_and_pins_source_revision():
    install = _readme_section("## Install")
    assert "uvx backplane-mcp" in install
    assert "@<commit>#subdirectory=mcp-server" in install
    assert re.search(r"unpublished|unreleased", install, re.I)
    assert re.search(r"candidate", install, re.I)
    assert re.search(r"wheel|checkout|source", install, re.I)


def test_current_release_documents_note_paging_and_catalog_upgrade():
    text = _changelog_text()
    start = _release_heading_re(CURRENT_RELEASE).search(text)
    assert start, "0.8.0 must have a release entry"
    end = _release_heading_re(HTTP_TRANSPORT_RELEASE).search(text).start()
    section = text[start.start():end]
    for term in ("Breaking", "list_notes", "next_offset", "summary_only", "bulk_create_cards", "startup", "ProseMirror", "get_server_info"):
        assert term in section


def test_retained_aliases_have_a_future_removal_version():
    from valaris_mcp.catalog import DEPRECATION_REMOVAL_VERSION, deprecated_aliases

    assert deprecated_aliases(), "0.8.0 retains the compatibility aliases"
    assert tuple(map(int, DEPRECATION_REMOVAL_VERSION.split("."))) > tuple(map(int, CURRENT_RELEASE.split(".")))


def test_current_release_explains_failure_receipts_and_disabled_tools():
    entry = _changelog_text().split(f"## [{CURRENT_RELEASE}]", 1)[1].split("\n## [", 1)[0]
    upgrade = README_PATH.read_text().split(f"### Upgrading from {HTTP_TRANSPORT_RELEASE}", 1)[1].split("### Upgrading", 1)[0]
    assert "isError" in entry and "disabled_reason" in entry
    assert "isError" in upgrade and "receipt" in upgrade
