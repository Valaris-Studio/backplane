# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pipeline-config validator rejects unknown precondition names with 422."""

from app.services.pipeline_config_validation import validate_pipeline_config


def _stage(role: str, preconditions: list[str] | None = None) -> dict:
    discover: dict = {
        "strategy": "unassigned_or_rework",
        "column_type": "",
        "column_type_exclude": "done",
        "filters": {"require_git_repo": True},
    }
    if preconditions is not None:
        discover["preconditions"] = preconditions
    return {
        "role": role,
        "discover": discover,
        "claim": {"participant_role": "hero", "execution_action": "implement_card"},
        "git": {"action": "create_branch", "create_pr": True},
        "llm": {"enabled": True, "stage": "implement"},
        "on_success": {"move_to_column_type": "review", "wake_roles": []},
    }


def test_known_precondition_is_valid():
    cfg = {"stages": [_stage("orchestrator", ["repo_has_no_open_pr"])]}
    errors = validate_pipeline_config(cfg)
    assert [e for e in errors if e.get("code") == "unknown_precondition"] == []


def test_pr_is_open_precondition_is_valid():
    """Cluster II Gap 1: pr_is_open is a registered precondition."""
    cfg = {"stages": [_stage("rework_mediator", ["pr_is_open"])]}
    errors = validate_pipeline_config(cfg)
    assert [e for e in errors if e.get("code") == "unknown_precondition"] == []


def test_unknown_precondition_is_rejected():
    cfg = {"stages": [_stage("orchestrator", ["something_made_up"])]}
    errors = validate_pipeline_config(cfg)
    matching = [e for e in errors if e.get("code") == "unknown_precondition"]
    assert len(matching) == 1
    assert "something_made_up" in matching[0]["message"]


def test_preconditions_must_be_a_list():
    cfg = {"stages": [_stage("orchestrator")]}
    cfg["stages"][0]["discover"]["preconditions"] = "repo_has_no_open_pr"
    errors = validate_pipeline_config(cfg)
    matching = [e for e in errors if e.get("code") == "invalid_preconditions"]
    assert len(matching) == 1


def test_empty_preconditions_list_is_valid():
    cfg = {"stages": [_stage("orchestrator", [])]}
    errors = validate_pipeline_config(cfg)
    assert [e for e in errors if e.get("code", "").startswith(("unknown_precondition", "invalid_preconditions"))] == []
