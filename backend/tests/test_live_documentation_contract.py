# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Guards for public documentation that must describe the current product."""

import ast
import json
import re

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (ROOT / path).read_text()


def _module_event_constants(path: str) -> set[str]:
    tree = ast.parse(_read(path), filename=path)
    constants: set[str] = set()
    for node in tree.body:
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        if not any(
            isinstance(target, ast.Name) and target.id.isupper() for target in targets
        ):
            continue
        if (
            isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
            and "." in node.value.value
        ):
            constants.add(node.value.value)
    return constants


def test_public_entrypoints_do_not_freeze_the_retired_mcp_tool_count():
    for path in ("README.md", "mcp-server/README.md"):
        assert "102 tools" not in _read(path), path


def test_preview_entrypoint_discloses_optional_experimental_runner_without_sandbox_promise():
    readme = _read("README.md")
    opening = readme.split("## Quickstart", maxsplit=1)[0]
    assert "Open Source Preview" in opening
    assert "Runners are experimental" in opening
    assert "[Self-hosting](#self-hosting)" in opening
    assert "sandboxed" not in opening.lower()
    assert "Status: pre-launch" not in opening


def test_security_support_does_not_promise_response_deadlines():
    security = _read("SECURITY.md")
    assert "best-effort" in security
    assert "no guaranteed response time" in security
    assert not re.search(r"within \d+ business days", security)
    assert "Please do not open a public issue" in security


def test_feedback_routes_do_not_advertise_unavailable_discussions():
    contributing = _read("CONTRIBUTING.md")
    assert "backplane/issues/new/choose" in contributing
    assert "backplane/discussions" not in contributing
    issue_config = _read(".github/ISSUE_TEMPLATE/config.yml")
    assert "backplane/discussions" not in issue_config
    assert "backplane/issues/new" in issue_config


def test_mcp_readme_describes_agent_email_as_development_fallback():
    readme = _read("mcp-server/README.md")
    assert "development fallback identity" in readme
    assert "pytest            # 304 tests" not in readme


def test_contributing_lint_commands_are_executable_from_repo_root():
    contributing = _read("CONTRIBUTING.md")
    for command in (
        "cd backend && ruff check app/",
        "cd frontend && pnpm lint",
        "cd runner && go vet ./...",
    ):
        assert command in contributing


def test_legacy_operator_documents_are_unambiguously_non_authoritative():
    for path in (
        "docs/platform-source-of-truth.md",
        "docs/pipeline-config-reference.md",
        "docs/runner-runtime.md",
        "docs/auto-merge-loop.md",
        "docs/onboarding.md",
    ):
        opening = "\n".join(_read(path).splitlines()[:12]).lower()
        assert "superseded" in opening, path
        assert "non-authoritative" in opening, path

    platform_history = _read("docs/platform-source-of-truth.md").lower()
    assert "end of historical synthesis" in platform_history
    assert "end of source-of-truth document" not in platform_history


def test_checked_in_openapi_snapshot_is_not_presented_as_the_live_schema():
    api_surfaces = _read("docs/api-surfaces.md")
    assert "checked-in snapshot" in api_surfaces
    assert "may lag the live schema" in api_surfaces


def test_checked_in_openapi_snapshot_matches_the_current_application():
    from app.main import app

    checked_in = json.loads(_read("docs/api/openapi.json"))
    assert checked_in == app.openapi()


def test_runner_export_openapi_declares_zip_and_the_literal_mcp_placeholder():
    from app.main import app

    operation = app.openapi()["paths"]["/api/agents/{agent_id}/export-config"]["get"]
    response = operation["responses"]["200"]
    assert set(response["content"]) == {"application/zip"}
    description = operation["description"]
    assert "literal `${VALARIS_API_KEY}`" in description
    assert "materialize a private MCP JSON copy" in description


def test_compose_image_comments_match_the_build_based_stack():
    env_example = _read(".env.example")
    assert "do not select artifacts in docker-compose.prod.yml" in env_example


def test_readme_scopes_gitlab_support_to_runner_forge_operations():
    readme = _read("README.md")
    assert "GitLab PAT connections are supported" in readme
    assert "runner forge driver for GitLab" in readme


def test_platform_history_describes_all_live_authentication_verifiers():
    reference = _read("docs/platform-source-of-truth.md")

    assert "Three-tier authentication" not in reference
    assert "Three-tier auth that degrades sensibly" not in reference
    for verifier in (
        "API key",
        "Session cookie",
        "Dev mode",
        "IAP",
        "Trusted proxy",
    ):
        assert verifier in reference


def test_card_type_and_priority_reference_tracks_the_live_contract():
    from app.models.kanban.card import CardType, Priority
    from app.schemas.kanban.card import CardCreate

    reference = _read(
        "frontend/src/pages/documentation/sections/"
        "reference-card-type-and-priority.tsx"
    )

    for value in (*CardType, *Priority):
        assert f"<code>{value.value}</code>" in reference, value.value

    assert CardCreate.model_fields["card_type"].default is CardType.task
    assert CardCreate.model_fields["priority"].default is Priority.none
    assert "API schema" in reference
    assert "default to" in reference
    assert "<code>none</code>" in reference


def test_environment_reference_lists_every_live_backend_setting():
    from app.config import Settings

    reference = _read(
        "frontend/src/pages/documentation/sections/"
        "reference-environment-variables.tsx"
    )

    missing = [
        field_name
        for field_name in Settings.model_fields
        if f"<code>{field_name}</code>" not in reference
    ]
    assert missing == []


def test_event_taxonomy_tracks_every_webhook_event_value():
    from app.models.webhooks.webhook import WebhookEvent

    reference = _read(
        "frontend/src/pages/documentation/sections/reference-event-taxonomy.tsx"
    )
    table_rows = re.findall(r"<tr[^>]*>(.*?)</tr>", reference, re.DOTALL)
    missing: list[str] = []

    for event in WebhookEvent:
        value = event.value
        if not value.startswith("activity."):
            if value not in reference:
                missing.append(value)
            continue

        _, entity, action = value.split(".", maxsplit=2)
        row = next(
            (
                candidate
                for candidate in table_rows
                if f"<code>activity.{entity}.*</code>" in candidate
            ),
            None,
        )
        if row is None or f"<code>{action}</code>" not in row:
            missing.append(value)

    assert missing == []


def test_event_documentation_tracks_all_direct_event_constants():
    reference = _read(
        "frontend/src/pages/documentation/sections/reference-event-taxonomy.tsx"
    )
    external_reference = _read("docs/events.md")

    core_events = {
        value
        for value in _module_event_constants("backend/app/core/events.py")
        if not value.startswith("activity.")
    }
    notification_events = _module_event_constants(
        "backend/app/services/notifications/live_push.py"
    )
    queue_events = _module_event_constants("backend/app/services/merge_queue.py")
    queue_events |= _module_event_constants(
        "backend/app/services/conflict_consolidator.py"
    )

    assert sorted(value for value in core_events if value not in reference) == []
    assert (
        sorted(value for value in notification_events if value not in reference) == []
    )
    assert (
        sorted(value for value in queue_events if value not in external_reference) == []
    )


def test_product_introduction_describes_git_separation_without_a_sandbox_promise():
    section = _read("frontend/src/pages/documentation/sections/introduction-what-backplane-is.tsx")
    assert "separate Git branch" in section
    assert "sandboxed branch" not in section
    for locale, translation in (("es", "rama de Git separada"), ("pt-BR", "branch Git separada")):
        catalog = _read(f"frontend/src/pages/documentation/content/sections/{locale}/introduction.ts")
        assert "separate Git branch" in catalog
        assert "sandboxed branch" not in catalog
        assert translation in catalog
