# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

from mcp.server.fastmcp import FastMCP


def test_server_loads_all_tools():
    from valaris_mcp.server import mcp

    assert isinstance(mcp, FastMCP)
    assert mcp.name == "Valaris"

    tools = list(mcp._tool_manager._tools.keys())
    assert len(tools) >= 20

    expected_tools = [
        "list_workspaces",
        "get_workspace",
        "list_boards",
        "get_board",
        "create_board",
        "list_cards",
        "get_card",
        "create_card",
        "update_card",
        "delete_card",
        "move_card",
        "add_card_participant",
        "remove_card_participant",
        "list_notes",
        "create_note",
        "update_note",
        "append_note",
        "replace_note_section",
        "delete_note",
        "list_activity",
        "get_definition",
        "update_definition",
        "list_resources",
        "get_resource",
        "create_resource",
        "delete_resource",
        "list_channels",
        "create_channel",
        "update_channel",
        "delete_channel",
        "list_git_repos",
        "create_git_repo",
        "update_git_repo",
        "delete_git_repo",
        "get_project_context",
        "search_cards",
        "get_board_health",
        "bulk_create_cards",
    ]
    for tool_name in expected_tools:
        assert tool_name in tools, f"Missing tool: {tool_name}"


# -- Prompts ------------------------------------------------------------------


def test_server_loads_all_prompts():
    from valaris_mcp.server import mcp

    prompts = list(mcp._prompt_manager._prompts.keys())
    assert len(prompts) == 10

    expected_prompts = [
        "init_project",
        "standup",
        "triage",
        "status",
        "plan_work",
        "decompose_card",
        "sprint",
        "pickup",
        "implement",
        "ship",
    ]
    for prompt_name in expected_prompts:
        assert prompt_name in prompts, f"Missing prompt: {prompt_name}"


def test_prompt_init_project_embeds_parameters():
    from valaris_mcp.prompts import init_project

    result = init_project("my-workspace", "Build a TODO app with React and FastAPI")
    assert "my-workspace" in result
    assert "Build a TODO app with React and FastAPI" in result
    assert "create_board" in result
    assert "create_column" in result
    assert "update_definition" in result
    assert "create_channel" in result
    assert "create_note" in result
    assert "create_card" in result
    assert "PHASE 1" in result
    assert "PHASE 4" in result


def test_prompt_init_project_definition_schema_matches_frontend():
    """Definition content keys must match frontend DefinitionContent, or the
    structured view won't render. See frontend/src/types/definition.ts."""
    from valaris_mcp.prompts import init_project

    result = init_project("ws", "brief")

    for key in (
        "objectives",
        "exclusions",
        "milestones",
        "tech_stack",
        "stakeholders",
        "constraints",
        "decisions",
        "references",
        "custom_fields",
    ):
        assert f'"{key}"' in result, f"Missing definition key: {key}"

    for stale_key in ("no_gos", "timeline", "team", "acceptance_criteria"):
        assert f'"{stale_key}"' not in result, (
            f"Stale key still present in definition schema: {stale_key}"
        )


def test_prompt_standup_embeds_parameters():
    from valaris_mcp.prompts import standup

    result = standup("my-ws", "board-123")
    assert "my-ws" in result
    assert "board-123" in result
    assert "get_board" in result
    assert "list_activity" in result
    assert "get_definition" in result
    assert "create_note" in result
    assert "GATHER" in result
    assert "ANALYZE" in result
    assert "REPORT" in result


def test_prompt_triage_embeds_parameters():
    from valaris_mcp.prompts import triage

    result = triage("my-ws", "board-456")
    assert "my-ws" in result
    assert "board-456" in result
    assert "HEALTH SCORE" in result
    assert "CRITICAL" in result
    assert "WARNING" in result
    assert "update_card" in result


def test_prompt_status_embeds_parameters():
    from valaris_mcp.prompts import status

    result = status("my-ws")
    assert "my-ws" in result
    assert "list_boards" in result
    assert "get_board" in result
    assert "get_definition" in result
    assert "get_workspace_summary" in result
    assert "TOP 3 ACTIONS" in result


def test_prompt_plan_work_embeds_parameters():
    from valaris_mcp.prompts import plan_work

    result = plan_work("my-ws", "board-789", "Add user authentication with JWT")
    assert "my-ws" in result
    assert "board-789" in result
    assert "Add user authentication with JWT" in result
    assert "create_card" in result
    assert "DECOMPOSE" in result
    assert "SEQUENCE" in result


def test_prompt_decompose_card_embeds_parameters():
    from valaris_mcp.prompts import decompose_card

    result = decompose_card("my-ws", "board-1", "card-abc")
    assert "my-ws" in result
    assert "board-1" in result
    assert "card-abc" in result
    assert "get_card" in result
    assert "create_card" in result
    assert "SPLIT" in result
    assert "CLEANUP" in result


def test_prompt_sprint_embeds_parameters():
    from valaris_mcp.prompts import sprint

    result = sprint("my-ws", "board-2")
    assert "my-ws" in result
    assert "board-2" in result
    assert "move_card" in result
    assert "update_card" in result
    assert "create_note" in result
    assert "REVIEW" in result
    assert "SELECT" in result


def test_prompt_pickup_embeds_parameters():
    from valaris_mcp.prompts import pickup

    result = pickup("my-ws", "board-3", "card-xyz")
    assert "my-ws" in result
    assert "board-3" in result
    assert "card-xyz" in result
    assert "get_card" in result
    assert "move_card" in result
    assert "IMPLEMENTATION BRIEF" in result


def test_prompt_pickup_auto_select_when_no_card():
    from valaris_mcp.prompts import pickup

    result = pickup("my-ws", "board-3")
    assert "my-ws" in result
    assert "board-3" in result
    assert "auto-select" in result
    assert "highest-priority unassigned" in result


def test_prompt_implement_embeds_parameters():
    from valaris_mcp.prompts import implement

    result = implement("my-ws", "board-4", "card-impl")
    assert "my-ws" in result
    assert "board-4" in result
    assert "card-impl" in result
    assert "TDD" in result
    assert "move_card" in result
    assert "update_card" in result
    assert "create_note" in result
    assert "PICKUP" in result
    assert "VERIFY" in result
    assert "SUBMIT" in result


def test_prompt_ship_embeds_parameters():
    from valaris_mcp.prompts import ship

    result = ship("my-ws", "board-5", "card-ship")
    assert "my-ws" in result
    assert "board-5" in result
    assert "card-ship" in result
    assert "move_card" in result
    assert "update_card" in result
    assert "create_note" in result
    assert "UNBLOCK" in result
    assert "SUGGESTED NEXT" in result


def test_client_default_config():
    from valaris_mcp.config import AGENT_EMAIL, API_BASE_URL

    assert API_BASE_URL == "http://localhost:8000"
    assert AGENT_EMAIL == "agent@valaris.dev"


def test_client_has_auth_header():
    from valaris_mcp.client import ValarisClient

    client = ValarisClient()
    assert client._http.headers["X-User-Email"] == "agent@valaris.dev"


def test_client_iap_mode_no_email_header(monkeypatch):
    monkeypatch.setattr("valaris_mcp.client.IAP_AUDIENCE", "/projects/123/test")

    from unittest.mock import MagicMock, patch

    mock_request_class = MagicMock()
    monkeypatch.setattr(
        "google.auth.transport.requests.Request", mock_request_class
    )

    mock_creds = MagicMock()
    with patch("google.auth.default", return_value=(mock_creds, "project-id")):
        from valaris_mcp.client import ValarisClient

        client = ValarisClient()
        assert "X-User-Email" not in client._http.headers


def test_client_iap_impersonated_credentials(monkeypatch):
    from unittest.mock import MagicMock, patch

    monkeypatch.setattr("valaris_mcp.client.IAP_AUDIENCE", "/projects/123/test")

    mock_request_class = MagicMock()
    monkeypatch.setattr(
        "google.auth.transport.requests.Request", mock_request_class
    )

    from google.auth import impersonated_credentials

    mock_creds = MagicMock(spec=impersonated_credentials.Credentials)

    with patch("google.auth.default", return_value=(mock_creds, "project-id")), \
         patch(
             "google.auth.impersonated_credentials.IDTokenCredentials"
         ) as mock_id_token_cls:
        mock_id_token_creds = MagicMock()
        mock_id_token_cls.return_value = mock_id_token_creds

        from valaris_mcp.client import ValarisClient

        client = ValarisClient()

        mock_id_token_cls.assert_called_once_with(
            target_credentials=mock_creds,
            target_audience="/projects/123/test",
        )
        assert client._id_token_credentials is mock_id_token_creds


def test_client_iap_service_account_credentials(monkeypatch):
    from unittest.mock import MagicMock, patch

    monkeypatch.setattr("valaris_mcp.client.IAP_AUDIENCE", "/projects/123/test")

    mock_request_class = MagicMock()
    monkeypatch.setattr(
        "google.auth.transport.requests.Request", mock_request_class
    )

    from google.oauth2 import service_account

    mock_creds = MagicMock(spec=service_account.Credentials)
    mock_id_token_creds = MagicMock()
    # with_target_audience is inherited; add it explicitly for the mock
    mock_creds.with_target_audience = MagicMock(return_value=mock_id_token_creds)

    with patch("google.auth.default", return_value=(mock_creds, "project-id")):
        from valaris_mcp.client import ValarisClient

        client = ValarisClient()

        mock_creds.with_target_audience.assert_called_once_with("/projects/123/test")
        assert client._id_token_credentials is mock_id_token_creds


def test_client_iap_metadata_server_fallback(monkeypatch):
    from unittest.mock import MagicMock, patch

    monkeypatch.setattr("valaris_mcp.client.IAP_AUDIENCE", "/projects/123/test")

    mock_request_class = MagicMock()
    monkeypatch.setattr(
        "google.auth.transport.requests.Request", mock_request_class
    )

    # Use a plain MagicMock that won't match any isinstance check
    mock_creds = MagicMock(spec=[])

    with patch("google.auth.default", return_value=(mock_creds, "project-id")):
        from valaris_mcp.client import ValarisClient

        client = ValarisClient()
        assert client._id_token_credentials is None


def test_client_iap_get_headers_with_id_token_credentials(monkeypatch):
    from unittest.mock import MagicMock, patch

    monkeypatch.setattr("valaris_mcp.client.IAP_AUDIENCE", "/projects/123/test")

    mock_request_class = MagicMock()
    monkeypatch.setattr(
        "google.auth.transport.requests.Request", mock_request_class
    )

    mock_creds = MagicMock(spec=[])

    with patch("google.auth.default", return_value=(mock_creds, "project-id")):
        from valaris_mcp.client import ValarisClient

        client = ValarisClient()

    # Manually set up id_token_credentials
    mock_id_token_creds = MagicMock()
    mock_id_token_creds.token = "test-oidc-token"
    client._id_token_credentials = mock_id_token_creds

    headers = client._get_iap_headers()

    mock_id_token_creds.refresh.assert_called_once_with(client._google_request)
    assert headers == {"Authorization": "Bearer test-oidc-token"}


def test_client_iap_get_headers_fallback_fetch_id_token(monkeypatch):
    from unittest.mock import MagicMock, patch

    monkeypatch.setattr("valaris_mcp.client.IAP_AUDIENCE", "/projects/123/test")

    mock_request_class = MagicMock()
    monkeypatch.setattr(
        "google.auth.transport.requests.Request", mock_request_class
    )

    mock_creds = MagicMock(spec=[])

    with patch("google.auth.default", return_value=(mock_creds, "project-id")):
        from valaris_mcp.client import ValarisClient

        client = ValarisClient()

    assert client._id_token_credentials is None

    with patch(
        "google.oauth2.id_token.fetch_id_token", return_value="fallback-token"
    ) as mock_fetch:
        headers = client._get_iap_headers()

        mock_fetch.assert_called_once_with(client._google_request, "/projects/123/test")
        assert headers == {"Authorization": "Bearer fallback-token"}


def test_prompt_init_project_mandates_acceptance_card():
    """P4 (docs/pipeline-improvements-2026-06-10.md): every bootstrapped board
    must contain a final ACCEPT- acceptance card, dependency-gated on all
    sibling cards, with an artifact-level Done condition."""
    from valaris_mcp.prompts import init_project

    result = init_project("ws", "brief")
    assert "ACCEPT-" in result
    assert "SMOKE-" in result
    assert "bulk_set_card_dependencies" in result
    assert "composition root" in result


def test_prompt_init_project_uses_ui_validation_body_marker_not_label():
    """P5 companion: UI-touching cards get the body marker; the
    needs-ui-validation label is applied at review time, never pre-seeded
    (a production-incident wedge)."""
    from valaris_mcp.prompts import init_project

    result = init_project("ws", "brief")
    assert "Validation: requires-ui-validation" in result
    assert "NEVER the label" in result


def test_prompt_plan_work_mandates_acceptance_card_and_ui_marker():
    from valaris_mcp.prompts import plan_work

    result = plan_work("ws", "board-1", "objective")
    assert "ACCEPT-" in result
    assert "bulk_set_card_dependencies" in result
    assert "Validation: requires-ui-validation" in result


def test_prompt_decompose_card_chains_children_and_ui_marker():
    """P4/P5 companion: children created by decomposition must re-block the
    board's acceptance card and carry the UI marker convention."""
    from valaris_mcp.prompts import decompose_card

    result = decompose_card("ws", "board-1", "card-1")
    assert "ACCEPT-" in result
    assert "Validation: requires-ui-validation" in result


# Audit r2 finding 3 (card 13efe4ea): version identity. The PyPI distribution
# is `backplane-mcp` (D5 rename, 2026-07-30); `valaris-mcp` is the pre-rename
# dist name. Resolving only the old name made a clean wheel install report
# "unknown", and FastMCP left the low-level Server.version as None, so the
# initialize handshake advertised the MCP SDK's version as the server's.


def test_server_version_prefers_backplane_dist(monkeypatch):
    import valaris_mcp.server as server_mod

    def fake_pkg_version(dist):
        if dist == "backplane-mcp":
            return "9.9.9"
        raise server_mod.PackageNotFoundError(dist)

    monkeypatch.setattr(server_mod, "_pkg_version", fake_pkg_version)
    assert server_mod.server_version() == "9.9.9"


def test_server_version_falls_back_to_legacy_dist(monkeypatch):
    import valaris_mcp.server as server_mod

    def fake_pkg_version(dist):
        if dist == "valaris-mcp":
            return "1.2.3"
        raise server_mod.PackageNotFoundError(dist)

    monkeypatch.setattr(server_mod, "_pkg_version", fake_pkg_version)
    assert server_mod.server_version() == "1.2.3"


def test_server_version_unknown_without_any_dist(monkeypatch):
    import valaris_mcp.server as server_mod

    def fake_pkg_version(dist):
        raise server_mod.PackageNotFoundError(dist)

    monkeypatch.setattr(server_mod, "_pkg_version", fake_pkg_version)
    assert server_mod.server_version() == "unknown"


def test_initialize_handshake_advertises_backplane_version_not_sdk():
    from importlib.metadata import version as pkg_version

    from valaris_mcp.server import mcp, server_version

    opts = mcp._mcp_server.create_initialization_options()
    assert opts.server_version == server_version()
    assert opts.server_version != pkg_version("mcp")


# MCP #2 (card 176b4503): the instructions must tell a model on the default
# hand that a wider one exists and where to look for it.


def test_instructions_point_at_toolsets_and_server_info():
    from valaris_mcp.server import mcp

    instructions = mcp.instructions or ""
    assert "VALARIS_MCP_TOOLSETS" in instructions
    assert "get_server_info" in instructions
