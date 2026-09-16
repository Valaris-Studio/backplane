# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import copy
import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.workspace import Workspace
from app.models.workspace_config import WorkspaceConfig
from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG


async def test_get_workspace_config_defaults(client: AsyncClient, test_workspace: Workspace):
    """No config row exists -- should return platform defaults."""
    response = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert response.status_code == 200
    data = response.json()

    assert data["max_rework_attempts"] == 3
    assert data["card_cooldown_hours"] == 1.0
    assert data["commit_message_template"] == "feat({{.CardID}}): {{.Title}}"
    assert data["pr_description_template"] == ""
    assert data["model_pricing"] is None
    assert data["version"] == 1


async def test_update_workspace_config(client: AsyncClient, test_workspace: Workspace):
    """PATCH creates config when none exists and returns updated values."""
    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"max_rework_attempts": 5, "card_cooldown_hours": 2.5},
    )
    assert response.status_code == 200
    data = response.json()

    assert data["max_rework_attempts"] == 5
    assert data["card_cooldown_hours"] == 2.5
    # Defaults for fields not sent
    assert data["commit_message_template"] == "feat({{.CardID}}): {{.Title}}"
    assert data["pr_description_template"] == ""
    assert data["model_pricing"] is None
    assert data["version"] == 1


async def test_workspace_config_version_bump(client: AsyncClient, test_workspace: Workspace):
    """Each update bumps the version number."""
    # First update creates the config (version 1)
    await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"max_rework_attempts": 2},
    )

    # Second update bumps to version 2
    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"card_cooldown_hours": 0.5},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["version"] == 2
    assert data["max_rework_attempts"] == 2
    assert data["card_cooldown_hours"] == 0.5


async def test_update_workspace_config_empty_body(client: AsyncClient, test_workspace: Workspace):
    """PATCH with no fields returns current config without changes."""
    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["version"] == 1  # No config created, returns platform defaults (v1)


async def test_update_workspace_config_model_pricing(
    client: AsyncClient, test_workspace: Workspace
):
    """PATCH can set model_pricing JSON field."""
    pricing = {"claude-sonnet-4-20250514": {"input": 3.0, "output": 15.0}}
    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"model_pricing": pricing},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["model_pricing"] == pricing


async def test_get_workspace_config_nonmember(
    client: AsyncClient, db_session: AsyncSession, test_user: User
):
    """Non-member gets 404 for workspace config."""
    response = await client.get("/api/workspaces/nonexistent/config")
    assert response.status_code == 404


async def test_agent_config_includes_workspace_config(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_agent,
    test_user: User,
    test_workspace: Workspace,
    test_board,
):
    """GET /agents/me/config includes workspace_config dict."""
    from app.models.agents.team import AgentTeam, AgentTeamMember

    # Set up team so the agent has a workspace_id
    team = AgentTeam(
        name="Config Team",
        description="",
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        created_by_id=test_user.id,
    )
    db_session.add(team)
    await db_session.flush()

    member = AgentTeamMember(
        team_id=team.id,
        agent_id=test_agent.id,
        roles=["orchestrator"],
    )
    db_session.add(member)
    await db_session.flush()

    # Create a workspace config (pipeline_config set to avoid lazy-seed version bump)
    from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG

    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        max_rework_attempts=7,
        card_cooldown_hours=0.25,
        pipeline_config=DEFAULT_PIPELINE_CONFIG,
    )
    db_session.add(config)
    await db_session.flush()

    response = await agent_client.get("/api/agents/me/config")
    assert response.status_code == 200
    data = response.json()

    assert "workspace_config" in data
    ws_config = data["workspace_config"]
    assert ws_config["max_rework_attempts"] == 7
    assert ws_config["card_cooldown_hours"] == 0.25
    assert ws_config["version"] == 1


async def test_agent_config_workspace_config_defaults_when_no_config(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_agent,
    test_user: User,
    test_workspace: Workspace,
    test_board,
):
    """GET /agents/me/config returns platform defaults when no workspace config exists."""
    from app.models.agents.team import AgentTeam, AgentTeamMember

    team = AgentTeam(
        name="Default Team",
        description="",
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        created_by_id=test_user.id,
    )
    db_session.add(team)
    await db_session.flush()

    member = AgentTeamMember(
        team_id=team.id,
        agent_id=test_agent.id,
        roles=["orchestrator"],
    )
    db_session.add(member)
    await db_session.flush()

    response = await agent_client.get("/api/agents/me/config")
    assert response.status_code == 200
    data = response.json()

    assert "workspace_config" in data
    ws_config = data["workspace_config"]
    assert ws_config["max_rework_attempts"] == 3
    assert ws_config["card_cooldown_hours"] == 1.0
    assert ws_config["version"] == 1


async def test_get_workspace_config_includes_pipeline_config(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    """GET returns pipeline_config when set on the config row."""
    pipeline = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        pipeline_config=pipeline,
    )
    db_session.add(config)
    await db_session.flush()

    response = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert response.status_code == 200
    data = response.json()
    assert data["pipeline_config"] == pipeline


async def test_update_workspace_config_pipeline_config(
    client: AsyncClient, test_workspace: Workspace
):
    """PATCH can set pipeline_config JSON field with a valid config."""
    pipeline = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": pipeline},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["pipeline_config"] == pipeline
    assert data["version"] == 1


async def test_pipeline_config_default_populated(
    client: AsyncClient, test_workspace: Workspace
):
    """No config row -> returns platform defaults with pipeline_config populated."""
    response = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert response.status_code == 200
    data = response.json()
    assert data["pipeline_config"] is not None
    assert data["pipeline_config"]["version"] == 1
    # 7 roles: planner/implementer/reviewer/rework_mediator/documentator/
    # ui_validator/board_reconciler (the 7th, added by the A1b cure 32ec343).
    assert len(data["pipeline_config"]["stages"]) == 7


# ---------------------------------------------------------------------------
# Pipeline config validation (Phase I.1.b)
#
# Each test asserts that an invalid pipeline config returns 422 with an error
# payload that names the offending field and explains what's wrong.
# ---------------------------------------------------------------------------


def _mutated_default(**mutations):
    """Clone DEFAULT_PIPELINE_CONFIG and apply shallow mutations to stages[0] or top-level."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    return cfg


def _assert_validation_error(response, expected_code: str, expected_field_fragment: str):
    """Assert a 422 response carrying the expected code and a field path fragment."""
    assert response.status_code == 422, response.text
    body = response.json()
    assert "detail" in body
    errors = body["detail"]
    assert isinstance(errors, list), f"expected list of errors, got {errors!r}"
    matched = [e for e in errors if e.get("code") == expected_code]
    assert matched, f"no error with code={expected_code!r} in {errors!r}"
    assert any(
        expected_field_fragment in (e.get("field") or "")
        for e in matched
    ), f"no error with field containing {expected_field_fragment!r} in {matched!r}"


async def test_update_pipeline_config_default_is_valid(
    client: AsyncClient, test_workspace: Workspace
):
    """Baseline: the default pipeline config must pass validation."""
    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": copy.deepcopy(DEFAULT_PIPELINE_CONFIG)},
    )
    assert response.status_code == 200, response.text


async def test_update_pipeline_config_missing_stage_key(
    client: AsyncClient, test_workspace: Workspace
):
    """Stage missing a required key returns 422 with field path."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    del cfg["stages"][0]["discover"]

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(response, "missing_stage_key", "stages[0].discover")


async def test_pipeline_config_validation_uses_standard_error_envelope(
    client: AsyncClient, test_workspace: Workspace
):
    """Validation failure emits the app's standard error envelope with error_code.

    The service must raise app.exceptions.ValidationError (not
    fastapi.HTTPException) so the centralized valaris_error_handler produces a
    consistent shape: {"detail": [...], "error_code": "validation_error"}.
    """
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["discover"]["strategy"] = "label_scan"

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    assert response.status_code == 422
    body = response.json()
    assert body.get("error_code") == "validation_error"
    assert body.get("error_params") == {}
    assert isinstance(body.get("detail"), list)
    finding = next(
        item
        for item in body["detail"]
        if item["code"] == "unknown_discover_strategy"
    )
    assert finding["params"] == {
        "field": "stages[0].discover.strategy",
        "value": "label_scan",
    }


async def test_update_pipeline_config_empty_role(
    client: AsyncClient, test_workspace: Workspace
):
    """Stage with empty role returns 422."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["role"] = ""

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(response, "missing_stage_key", "stages[0].role")


async def test_update_pipeline_config_duplicate_roles(
    client: AsyncClient, test_workspace: Workspace
):
    """Two stages with the same role returns 422."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    # Force a duplicate by renaming one stage to match another's role. Pick
    # any two by name so the test doesn't depend on positional order.
    first, second = cfg["stages"][0], cfg["stages"][1]
    duplicate_role = first["role"]
    original_role = second["role"]
    second["role"] = duplicate_role
    # Keep priority_order consistent — drop the rename target so it doesn't
    # trip the priority_order_unknown_role guard before the duplicate check.
    cfg["scheduling"]["priority_order"] = [
        r for r in cfg["scheduling"]["priority_order"] if r != original_role
    ]

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(response, "duplicate_stage_role", "stages[1].role")


async def test_update_pipeline_config_wake_role_unknown(
    client: AsyncClient, test_workspace: Workspace
):
    """on_success.wake_roles containing an unknown role returns 422.

    Post-redesign DEFAULT no longer emits on_success blocks (the lifecycle
    DSL owns the contract). The validator still checks them when present on
    persisted legacy configs — attach an on_success block to the first stage
    explicitly so the rule fires.
    """
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["on_success"] = {"wake_roles": ["reveiwer"]}  # typo

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(response, "invalid_wake_role", "stages[0].on_success.wake_roles")


async def test_update_pipeline_config_wake_role_unknown_on_failure(
    client: AsyncClient, test_workspace: Workspace
):
    """on_failure.wake_roles containing an unknown role returns 422 (legacy block path)."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["on_failure"] = {"wake_roles": ["ghost"]}

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(response, "invalid_wake_role", "stages[0].on_failure.wake_roles")


async def test_update_pipeline_config_wake_role_unknown_in_branch(
    client: AsyncClient, test_workspace: Workspace
):
    """Branch wake_roles must also resolve to a real role (legacy block path)."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["on_success"] = {
        "conditional": True,
        "branches": {
            "approve": {
                "wake_roles": ["nobody"],
                "move_to_column_type": "done",
            }
        },
    }

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "invalid_wake_role",
        "stages[0].on_success.branches.approve.wake_roles",
    )


async def test_update_pipeline_config_priority_order_unknown_role(
    client: AsyncClient, test_workspace: Workspace
):
    """scheduling.priority_order referencing an unknown role returns 422."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["scheduling"]["priority_order"] = ["reviewer", "gremlin"]

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "priority_order_unknown_role",
        "scheduling.priority_order",
    )


async def test_update_pipeline_config_priority_order_auto_appends_new_stage_role(
    client: AsyncClient, test_workspace: Workspace
):
    """Adding a new stage role auto-appends it to scheduling.priority_order.

    B2: operators add stages via the pipeline editor; they don't also hand-edit
    priority_order. The persisted config must include every stage role so the
    runner's scheduler can select it (see audits/runner-launch-walkthrough-2026-04-18.md).
    """
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"].append(
        {
            "role": "secretario",
            "discover": {"strategy": "column_scan", "column_type": "done"},
            "claim": {"participant_role": "helper"},
            "git": {"action": "none"},
            "llm": {
                "enabled": True,
                "stage": "secretario_summarize",
                "post_process_kind": "produces_note",
            },
            "on_success": {"add_label": "summarized"},
        }
    )

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    assert response.status_code == 200, response.text
    persisted = response.json()["pipeline_config"]
    # Existing redesign priority order is preserved; the new role appends.
    expected_order = list(DEFAULT_PIPELINE_CONFIG["scheduling"]["priority_order"]) + ["secretario"]
    assert persisted["scheduling"]["priority_order"] == expected_order


async def test_update_pipeline_config_priority_order_created_when_missing(
    client: AsyncClient, test_workspace: Workspace
):
    """Config without a scheduling block gets priority_order synthesized from stage order."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg.pop("scheduling", None)

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    assert response.status_code == 200, response.text
    persisted = response.json()["pipeline_config"]
    # Synthesised from stage definition order (canonicalize_pipeline_config).
    assert persisted["scheduling"]["priority_order"] == [
        s["role"] for s in DEFAULT_PIPELINE_CONFIG["stages"]
    ]


async def test_update_pipeline_config_priority_order_preserves_operator_ordering(
    client: AsyncClient, test_workspace: Workspace
):
    """Existing priority_order ordering is preserved; new roles append at the end."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    reversed_order = list(reversed(DEFAULT_PIPELINE_CONFIG["scheduling"]["priority_order"]))
    cfg["scheduling"]["priority_order"] = reversed_order
    cfg["stages"].append(
        {
            "role": "auditor",
            "discover": {"strategy": "column_scan", "column_type": "done"},
            "claim": {"participant_role": "helper"},
            "git": {"action": "none"},
            "llm": {
                "enabled": True,
                "stage": "auditor_check",
                "post_process_kind": "produces_note",
            },
            "on_success": {"add_label": "audited"},
        }
    )

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    assert response.status_code == 200, response.text
    persisted = response.json()["pipeline_config"]
    assert persisted["scheduling"]["priority_order"] == reversed_order + ["auditor"]


async def test_update_pipeline_config_unknown_discover_strategy(
    client: AsyncClient, test_workspace: Workspace
):
    """discover.strategy not in the allow-list returns 422."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["discover"]["strategy"] = "label_scan"  # not implemented

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "unknown_discover_strategy",
        "stages[0].discover.strategy",
    )


async def test_update_pipeline_config_unknown_claim_role(
    client: AsyncClient, test_workspace: Workspace
):
    """claim.participant_role must be hero or helper."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["claim"]["participant_role"] = "villain"

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "unknown_claim_role",
        "stages[0].claim.participant_role",
    )


async def test_update_pipeline_config_unknown_git_action(
    client: AsyncClient, test_workspace: Workspace
):
    """git.action must be one of the known values."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["git"]["action"] = "magic_merge"

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "unknown_git_action",
        "stages[0].git.action",
    )


async def test_update_pipeline_config_git_action_empty_allowed(
    client: AsyncClient, test_workspace: Workspace
):
    """git.action may be empty string (means 'none')."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["git"]["action"] = ""
    # create_pr is meaningless when git is skipped — drop so the T0.1
    # create_pr_requires_branch check doesn't fire.
    cfg["stages"][0]["git"]["create_pr"] = False

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    assert response.status_code == 200, response.text


async def test_update_pipeline_config_rejects_create_pr_with_git_action_none(
    client: AsyncClient, test_workspace: Workspace
):
    """create_pr=true is nonsensical when git.action=none (no branch, no repo).

    T0.1 parity: Go side now short-circuits git setup for action=none, which
    makes any create_pr flag unreachable. Reject the config at write time so
    operators discover the mistake before the agent silently skips the PR.
    """
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["git"]["action"] = "none"
    cfg["stages"][0]["git"]["create_pr"] = True

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "create_pr_requires_branch",
        "stages[0].git.create_pr",
    )


async def test_update_pipeline_config_unknown_llm_stage(
    client: AsyncClient, test_workspace: Workspace
):
    """llm.stage must be implement/review/document when no post_process_kind set."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["llm"]["stage"] = "ponder"
    # Without post_process_kind the legacy stage-name allow-list applies.
    cfg["stages"][0]["llm"].pop("post_process_kind", None)

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "unknown_llm_stage",
        "stages[0].llm.stage",
    )


async def test_update_pipeline_config_llm_disabled_allows_empty_stage(
    client: AsyncClient, test_workspace: Workspace
):
    """When llm.enabled is false, llm.stage may be empty."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["llm"]["enabled"] = False
    cfg["stages"][0]["llm"]["stage"] = ""
    # Approval is only meaningful for legacy implement — drop when stage is empty
    # so the approval-footgun check (Fix 2) doesn't fire.
    cfg["stages"][0]["llm"]["approval_enabled"] = False

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    assert response.status_code == 200, response.text


async def test_update_pipeline_config_llm_enabled_requires_stage(
    client: AsyncClient, test_workspace: Workspace
):
    """When llm.enabled is true, llm.stage must be non-empty."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["llm"]["enabled"] = True
    cfg["stages"][0]["llm"]["stage"] = ""

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "unknown_llm_stage",
        "stages[0].llm.stage",
    )


async def test_update_pipeline_config_unknown_move_to_column_type(
    client: AsyncClient, test_workspace: Workspace
):
    """on_success.move_to_column_type must be a known column_type (legacy-block path)."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["on_success"] = {"move_to_column_type": "nirvana"}

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "invalid_move_to_column_type",
        "stages[0].on_success.move_to_column_type",
    )


async def test_update_pipeline_config_move_to_column_type_empty_allowed(
    client: AsyncClient, test_workspace: Workspace
):
    """Empty move_to_column_type means 'stay in column' — allowed (legacy-block path)."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["on_success"] = {"move_to_column_type": ""}

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    assert response.status_code == 200, response.text


async def test_update_pipeline_config_invalid_move_to_column_in_branch(
    client: AsyncClient, test_workspace: Workspace
):
    """move_to_column_type inside on_success.branches is also validated (legacy-block path)."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["on_success"] = {
        "conditional": True,
        "branches": {"approve": {"move_to_column_type": "limbo"}},
    }

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "invalid_move_to_column_type",
        "stages[0].on_success.branches.approve.move_to_column_type",
    )


async def test_update_pipeline_config_multiple_errors_all_reported(
    client: AsyncClient, test_workspace: Workspace
):
    """Validation should report all errors in one 422 response, not fail-fast."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["discover"]["strategy"] = "bogus"
    cfg["stages"][0]["claim"]["participant_role"] = "bogus"

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    assert response.status_code == 422
    codes = {e.get("code") for e in response.json()["detail"]}
    assert "unknown_discover_strategy" in codes
    assert "unknown_claim_role" in codes


async def test_update_pipeline_config_null_passes_through(
    client: AsyncClient, test_workspace: Workspace
):
    """Passing null pipeline_config is allowed (means 'use default')."""
    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": None},
    )
    assert response.status_code == 200, response.text


# ---------------------------------------------------------------------------
# Sensor-name validation (Phase I.1.c)
#
# When the workspace has agents reporting a sensor catalog, an unknown sensor
# name in pipeline_config.stages[*].sensors[*].name must be rejected. Without
# agents reporting catalogs, sensor-name validation is skipped — the platform
# doesn't pretend to know what sensors exist.
# ---------------------------------------------------------------------------


async def test_update_pipeline_config_unknown_sensor_rejected_when_catalog_available(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    from app.models.agents.agent import Agent, AgentType

    agent = Agent(
        name="sensor-reporter",
        agent_type=AgentType.coding,
        description="",
        created_by_id=test_user.id,
        is_active=True,
        allowed_workspaces=[test_workspace.slug],
        sensor_catalog=[
            {"name": "go-test", "kind": "computational", "default_config": {}},
        ],
    )
    db_session.add(agent)
    await db_session.flush()

    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["sensors"] = [{"name": "phantom-linter", "config": {}}]

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "unknown_sensor_name",
        "stages[0].sensors[0].name",
    )


async def test_update_pipeline_config_known_sensor_accepted(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    from app.models.agents.agent import Agent, AgentType

    agent = Agent(
        name="sensor-reporter",
        agent_type=AgentType.coding,
        description="",
        created_by_id=test_user.id,
        is_active=True,
        allowed_workspaces=[test_workspace.slug],
        sensor_catalog=[
            {"name": "go-test", "kind": "computational", "default_config": {}},
        ],
    )
    db_session.add(agent)
    await db_session.flush()

    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["sensors"] = [{"name": "go-test", "config": {}}]

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    assert response.status_code == 200, response.text


async def test_update_pipeline_config_sensor_name_unchecked_when_no_agents(
    client: AsyncClient,
    test_workspace: Workspace,
):
    # No agents -> no catalog -> sensor-name validation is skipped.
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["sensors"] = [{"name": "phantom-linter", "config": {}}]

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    assert response.status_code == 200, response.text


# ---------------------------------------------------------------------------
# Phase I.1.g — PostProcessKind discriminator.
#
# `llm.post_process_kind` opens the `llm.stage` enum to arbitrary names. The
# kind (writes_code / produces_decision / produces_note / mutates_backlog)
# decides how the engine handles the LLM output; the stage becomes a pure
# prompt-template key. Back-compat: when post_process_kind is absent, the
# legacy closed-enum check on stage names still applies.
# ---------------------------------------------------------------------------


async def test_post_process_kind_known_accepted(
    client: AsyncClient, test_workspace: Workspace
):
    """Each of the four valid kinds passes validation with a custom stage name."""
    for kind in ("writes_code", "produces_decision", "produces_note", "mutates_backlog"):
        cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
        cfg["stages"][0]["llm"]["stage"] = "any_custom_stage"
        cfg["stages"][0]["llm"]["post_process_kind"] = kind
        # Clear approval_enabled when switching away from "implement" — Fix 2
        # rejects approval on custom stages.
        cfg["stages"][0]["llm"]["approval_enabled"] = False

        response = await client.patch(
            f"/api/workspaces/{test_workspace.slug}/config",
            json={"pipeline_config": cfg},
        )
        assert response.status_code == 200, f"kind={kind} rejected: {response.text}"


async def test_post_process_kind_unknown_rejected(
    client: AsyncClient, test_workspace: Workspace
):
    """An unknown post_process_kind is rejected with a structured error."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["llm"]["stage"] = "research"
    cfg["stages"][0]["llm"]["post_process_kind"] = "garbage"

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "unknown_post_process_kind",
        "stages[0].llm.post_process_kind",
    )


async def test_custom_llm_stage_with_kind_ok(
    client: AsyncClient, test_workspace: Workspace
):
    """A custom stage name with a known post_process_kind no longer errors."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["llm"]["stage"] = "research"
    cfg["stages"][0]["llm"]["post_process_kind"] = "produces_note"
    cfg["stages"][0]["llm"]["approval_enabled"] = False

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    assert response.status_code == 200, response.text


async def test_custom_llm_stage_without_kind_rejected(
    client: AsyncClient, test_workspace: Workspace
):
    """Without post_process_kind, the legacy stage-name allow-list still applies."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["llm"]["stage"] = "research"
    cfg["stages"][0]["llm"].pop("post_process_kind", None)

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "unknown_llm_stage",
        "stages[0].llm.stage",
    )


# ---------------------------------------------------------------------------
# Fix 2 — approval_enabled must only land on legacy "implement" stages.
#
# The engine wires approval only into the l.implement path; every other stage
# (review, document, custom) silently ignores approval_enabled=true and
# proceeds as if approved. Catch this at validation time.
# ---------------------------------------------------------------------------


async def test_approval_on_legacy_stage_accepted(
    client: AsyncClient, test_workspace: Workspace
):
    """Default orchestrator (stage=implement, approval_enabled=true) must pass."""
    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": copy.deepcopy(DEFAULT_PIPELINE_CONFIG)},
    )
    assert response.status_code == 200, response.text


async def test_approval_on_custom_stage_rejected(
    client: AsyncClient, test_workspace: Workspace
):
    """Custom stage with approval_enabled=true must be rejected."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["llm"]["stage"] = "research"
    cfg["stages"][0]["llm"]["post_process_kind"] = "produces_note"
    cfg["stages"][0]["llm"]["approval_enabled"] = True

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "approval_not_supported_for_custom_stage",
        "stages[0].llm.approval_enabled",
    )


async def test_approval_on_reviewer_rejected(
    client: AsyncClient, test_workspace: Workspace
):
    """Legacy reviewer stage with approval_enabled=true must be rejected."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    reviewer_idx = next(
        i for i, s in enumerate(cfg["stages"]) if s["role"] == "reviewer"
    )
    cfg["stages"][reviewer_idx]["llm"]["approval_enabled"] = True

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "approval_not_supported_for_custom_stage",
        f"stages[{reviewer_idx}].llm.approval_enabled",
    )


# ---------------------------------------------------------------------------
# Fix 3 — mismatched post_process_kind on legacy stage names.
#
# stage="implement" with post_process_kind="produces_note" routes into the
# l.implement path (writes files), but the post-LLM gate sees the kind and
# skips gitCommitAndPush. Files are written and silently lost. Catch this
# at validation time before the agent ever loads the config.
# ---------------------------------------------------------------------------


async def test_legacy_stage_explicit_matching_kind_accepted(
    client: AsyncClient, test_workspace: Workspace
):
    """Explicit kind equal to the legacy mapping is redundant but harmless."""
    matches = [
        ("implement", "writes_code"),
        ("review", "produces_decision"),
        ("document", "writes_code"),
    ]
    for stage_name, kind in matches:
        cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
        cfg["stages"][0]["llm"]["stage"] = stage_name
        cfg["stages"][0]["llm"]["post_process_kind"] = kind
        # approval only wired for implement — keep in step with Fix 2.
        cfg["stages"][0]["llm"]["approval_enabled"] = stage_name == "implement"

        response = await client.patch(
            f"/api/workspaces/{test_workspace.slug}/config",
            json={"pipeline_config": cfg},
        )
        assert response.status_code == 200, (
            f"stage={stage_name} kind={kind}: {response.text}"
        )


async def test_legacy_stage_mismatched_kind_rejected(
    client: AsyncClient, test_workspace: Workspace
):
    """stage=implement, kind=produces_note is a silent data-loss config."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["llm"]["stage"] = "implement"
    cfg["stages"][0]["llm"]["post_process_kind"] = "produces_note"

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "mismatched_post_process_kind",
        "stages[0].llm.post_process_kind",
    )


async def test_legacy_review_with_writes_code_rejected(
    client: AsyncClient, test_workspace: Workspace
):
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    reviewer_idx = next(
        i for i, s in enumerate(cfg["stages"]) if s["role"] == "reviewer"
    )
    cfg["stages"][reviewer_idx]["llm"]["stage"] = "review"
    cfg["stages"][reviewer_idx]["llm"]["post_process_kind"] = "writes_code"

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "mismatched_post_process_kind",
        f"stages[{reviewer_idx}].llm.post_process_kind",
    )


async def test_custom_stage_not_subject_to_mismatch(
    client: AsyncClient, test_workspace: Workspace
):
    """A custom stage (not in {implement,review,document}) is unaffected."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["llm"]["stage"] = "research"
    cfg["stages"][0]["llm"]["post_process_kind"] = "writes_code"
    cfg["stages"][0]["llm"]["approval_enabled"] = False

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    assert response.status_code == 200, response.text


# ---------------------------------------------------------------------------
# Optimistic concurrency — expected_version guard (plan.md §3.7).
#
# When a client sends `expected_version`, the server must reject the update
# if the persisted config has moved on (409 stale_version). When omitted,
# behavior is unchanged (last-write-wins back-compat).
# ---------------------------------------------------------------------------


async def test_update_config_with_matching_expected_version_succeeds(
    client: AsyncClient, test_workspace: Workspace
):
    first = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"max_rework_attempts": 4},
    )
    assert first.status_code == 200
    current_version = first.json()["version"]

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"max_rework_attempts": 9, "expected_version": current_version},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["max_rework_attempts"] == 9
    assert body["version"] == current_version + 1


async def test_update_config_with_stale_expected_version_returns_409(
    client: AsyncClient, test_workspace: Workspace
):
    first = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"max_rework_attempts": 2},
    )
    assert first.status_code == 200
    stale_version = first.json()["version"]

    bump = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"max_rework_attempts": 3},
    )
    assert bump.status_code == 200
    current_version = bump.json()["version"]
    assert current_version != stale_version

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"max_rework_attempts": 99, "expected_version": stale_version},
    )
    assert response.status_code == 409, response.text
    body = response.json()
    # Canonical taxonomy shape: the branch signal is `error_code`, and both
    # versions stay legible in the human-readable detail.
    assert body["error_code"] == "stale_version"
    assert str(current_version) in body["detail"]
    assert str(stale_version) in body["detail"]

    # Stale write must not have applied
    after = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert after.json()["max_rework_attempts"] == 3
    assert after.json()["version"] == current_version


async def test_update_config_without_expected_version_is_unchanged_back_compat(
    client: AsyncClient, test_workspace: Workspace
):
    """Legacy clients omitting expected_version still get last-write-wins semantics."""
    first = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"max_rework_attempts": 4},
    )
    assert first.status_code == 200

    second = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"max_rework_attempts": 8},
    )
    assert second.status_code == 200, second.text
    assert second.json()["max_rework_attempts"] == 8
    assert second.json()["version"] == first.json()["version"] + 1


async def test_export_pipeline_with_existing_config(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    pipeline = {"version": 1, "stages": [{"role": "orchestrator"}]}
    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        pipeline_config=pipeline,
        version=4,
    )
    db_session.add(config)
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/{test_workspace.slug}/config/pipeline/export"
    )
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["entity_type"] == "pipeline"
    assert body["source_workspace_slug"] == test_workspace.slug
    assert body["source_board_slug"] is None
    assert body["data"]["pipeline_config"] == pipeline
    assert body["data"]["version"] == 4
    assert body["data"]["empty"] is False

    disposition = response.headers["content-disposition"]
    assert f'filename="{test_workspace.slug}.valaris.pipeline.json"' in disposition
    assert response.headers["content-type"].startswith("application/json")


async def test_export_pipeline_when_config_missing_returns_empty_envelope(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(
        f"/api/workspaces/{test_workspace.slug}/config/pipeline/export"
    )
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["entity_type"] == "pipeline"
    assert body["data"]["empty"] is True
    assert body["data"]["pipeline_config"] == {}
    assert body["data"]["version"] == 0


async def test_export_pipeline_unknown_workspace(client: AsyncClient):
    response = await client.get("/api/workspaces/nonexistent/config/pipeline/export")
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Cost circuit breaker config (card e244867f)
# ---------------------------------------------------------------------------


async def test_cost_circuit_breaker_default_disabled(
    client: AsyncClient, test_workspace: Workspace
):
    """Fresh workspace: cost_circuit_breaker is None (== disabled)."""
    response = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert response.status_code == 200
    data = response.json()
    assert data.get("cost_circuit_breaker") is None


async def test_cost_circuit_breaker_round_trip(
    client: AsyncClient, test_workspace: Workspace
):
    """Set, persist, and read back a cost breaker config via PATCH/GET."""
    payload = {
        "cost_circuit_breaker": {
            "enabled": True,
            "threshold_usd_per_15min": 20.0,
            "action": "pause",
        }
    }
    update = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json=payload,
    )
    assert update.status_code == 200, update.text
    body = update.json()
    breaker = body["cost_circuit_breaker"]
    assert breaker["enabled"] is True
    assert breaker["threshold_usd_per_15min"] == 20.0
    assert breaker["action"] == "pause"

    fetch = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert fetch.status_code == 200
    assert fetch.json()["cost_circuit_breaker"] == breaker


# ---------------------------------------------------------------------------
# Resume route: clears in-process breaker dedupe so the next signal re-fires
# (card e244867f). Admin-only.
# ---------------------------------------------------------------------------


async def test_cost_breaker_resume_succeeds(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        f"/api/workspaces/{test_workspace.slug}/cost-breaker/resume"
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body.get("status") == "resumed"


async def test_cost_breaker_resume_unknown_workspace(client: AsyncClient):
    response = await client.post("/api/workspaces/nonexistent/cost-breaker/resume")
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# CTX-1: malformed llm.context_sources rejected at the config edit boundary
# ---------------------------------------------------------------------------


async def test_update_pipeline_config_rejects_unknown_context_source_kind(
    client: AsyncClient, test_workspace: Workspace
):
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["llm"]["context_sources"] = [
        {"kind": "definitely_not_a_real_context_kind"}
    ]

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "unknown_context_source_kind",
        "stages[0].llm.context_sources[0].kind",
    )


async def test_update_pipeline_config_rejects_duplicate_context_source_alias(
    client: AsyncClient, test_workspace: Workspace
):
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["llm"]["context_sources"] = [
        {"kind": "card_notes", "filter": {"kind": "user_note"}, "as": "ctx"},
        {"kind": "pinned_notes", "as": "ctx"},
    ]

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "duplicate_context_source_alias",
        "stages[0].llm.context_sources[1].as",
    )


async def test_update_pipeline_config_rejects_reserved_context_source_alias(
    client: AsyncClient, test_workspace: Workspace
):
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["llm"]["context_sources"] = [
        {"kind": "pinned_notes", "as": "card_id"},
    ]

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(
        response,
        "reserved_context_source_alias",
        "stages[0].llm.context_sources[0].as",
    )


async def test_update_pipeline_config_accepts_three_starter_context_sources(
    client: AsyncClient, test_workspace: Workspace
):
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    cfg["stages"][0]["llm"]["context_sources"] = [
        {"kind": "card_notes", "filter": {"kind": "user_note"}, "as": "notes"},
        {"kind": "board_definition"},
        {"kind": "pinned_notes"},
    ]

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    assert response.status_code == 200, response.text


# ---------------------------------------------------------------------------
# PAR-3a: conflict_consolidator config round-trip.
#
# Permissive dict shape (validated at use-time by PAR-3c, not here).
# ---------------------------------------------------------------------------


async def test_conflict_consolidator_default_disabled(
    client: AsyncClient, test_workspace: Workspace
):
    """Fresh workspace: conflict_consolidator is None (== disabled)."""
    response = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert response.status_code == 200
    assert response.json().get("conflict_consolidator") is None


async def test_conflict_consolidator_round_trip(
    client: AsyncClient, test_workspace: Workspace
):
    """Set, persist, and read back a conflict_consolidator config via PATCH/GET."""
    payload = {
        "conflict_consolidator": {
            "enabled": True,
            "board_id": str(uuid.uuid4()),
            "column_id": str(uuid.uuid4()),
            "label": "consolidate-merge-conflict",
        }
    }
    update = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json=payload,
    )
    assert update.status_code == 200, update.text
    persisted = update.json()["conflict_consolidator"]
    assert persisted == payload["conflict_consolidator"]

    fetch = await client.get(f"/api/workspaces/{test_workspace.slug}/config")
    assert fetch.status_code == 200
    assert fetch.json()["conflict_consolidator"] == payload["conflict_consolidator"]


async def test_update_pipeline_config_unknown_llm_model_tier(
    client: AsyncClient, test_workspace: Workspace
):
    """A model value outside the tier vocabulary ("high") is rejected at save
    with 422 instead of persisting and failing at dispatch (card e019244b)."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    for step in cfg["stages"][0]["lifecycle"]:
        if step.get("kind") == "llm":
            step["params"]["model"] = "high"
            break
    else:
        raise AssertionError("default planner stage has no lifecycle llm step")

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    _assert_validation_error(response, "unknown_llm_model_tier", "params.model")


async def test_update_pipeline_config_mirrors_lifecycle_model_into_flat(
    client: AsyncClient, test_workspace: Workspace
):
    """Card b8024b15 write side: a save whose lifecycle llm-step model diverges
    from the flat stage.llm.model persists with the two reconciled (the
    lifecycle value — the one the UI edits and dispatch prefers — wins)."""
    cfg = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    stage = cfg["stages"][0]
    stage["llm"]["model"] = "mid"
    for step in stage["lifecycle"]:
        if step.get("kind") == "llm":
            step["params"]["model"] = "premium"
            break

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"pipeline_config": cfg},
    )
    assert response.status_code == 200, response.text
    saved_stage = response.json()["pipeline_config"]["stages"][0]
    assert saved_stage["llm"]["model"] == "premium"


# --- workspace-level done-merge gate vs agent keys (card 83602fbf round 2) ---
#
# Boards default their gate override to NULL and fall back to this workspace
# flag, so an agent key whose creating user is admin/owner could un-arm the
# done-merge gate for EVERY board in one PATCH. The ban is FIELD-scoped (the
# runner legitimately reads and writes other config), mirroring the
# relax_done_merge_gate agent check in app/services/kanban/board.py — not a
# route-level forbid_agent_callers like board PATCH.


async def test_update_workspace_config_gate_refuses_agent_key(
    agent_client: AsyncClient, test_workspace: Workspace,
):
    """The hole: agent key (creating user = workspace owner) un-arms the gate
    workspace-wide. Must 403 and leave the flag at its armed default."""
    response = await agent_client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"enforce_done_merge_gate": False},
    )
    assert response.status_code == 403, (
        "agent key un-armed the workspace-wide done-merge gate: "
        f"{response.status_code}: {response.text}"
    )

    readback = await agent_client.get(
        f"/api/workspaces/{test_workspace.slug}/config"
    )
    assert readback.json()["enforce_done_merge_gate"] is True


async def test_update_workspace_config_gate_refuses_agent_key_re_arm(
    agent_client: AsyncClient, test_workspace: Workspace,
    db_session: AsyncSession,
):
    """The ban is the FIELD, not one value of it: re-arming (true) from an
    agent key is refused the same as un-arming — mirrors board PATCH."""
    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        max_rework_attempts=3,
        card_cooldown_hours=1.0,
        enforce_done_merge_gate=False,
    )
    db_session.add(config)
    await db_session.flush()

    response = await agent_client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"enforce_done_merge_gate": True},
    )
    assert response.status_code == 403, (
        "agent key wrote the done-merge gate field (re-arm direction): "
        f"{response.status_code}: {response.text}"
    )

    await db_session.refresh(config)
    assert config.enforce_done_merge_gate is False


async def test_update_workspace_config_gate_refuses_agent_key_mixed_payload(
    agent_client: AsyncClient, test_workspace: Workspace,
    db_session: AsyncSession,
):
    """A gate write hidden among legitimate fields is refused atomically:
    nothing from the payload lands, not just the gate field."""
    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        max_rework_attempts=4,
        card_cooldown_hours=1.0,
    )
    db_session.add(config)
    await db_session.flush()

    response = await agent_client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"enforce_done_merge_gate": False, "max_rework_attempts": 9},
    )
    assert response.status_code == 403, (
        "agent key smuggled a gate write in a mixed payload: "
        f"{response.status_code}: {response.text}"
    )

    await db_session.refresh(config)
    assert config.enforce_done_merge_gate is True
    assert config.max_rework_attempts == 4


async def test_update_workspace_config_agent_key_keeps_other_fields(
    agent_client: AsyncClient, test_workspace: Workspace,
):
    """GREEN guard: the ban is field-scoped, not a route ban — the runner
    legitimately writes config, so a gate-free PATCH keeps working."""
    response = await agent_client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"max_rework_attempts": 5, "card_cooldown_hours": 2.5},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["max_rework_attempts"] == 5
    assert data["card_cooldown_hours"] == 2.5


async def test_update_workspace_config_gate_human_admin_can_set(
    client: AsyncClient, test_workspace: Workspace,
):
    """GREEN guard: a human admin (X-User-Email tier, no agent identity)
    keeps full control of the workspace-wide gate, both directions."""
    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"enforce_done_merge_gate": False},
    )
    assert response.status_code == 200, response.text
    assert response.json()["enforce_done_merge_gate"] is False

    response = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"enforce_done_merge_gate": True},
    )
    assert response.status_code == 200, response.text
    assert response.json()["enforce_done_merge_gate"] is True
