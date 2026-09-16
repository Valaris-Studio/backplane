# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Self-service runner-config generation: pre-fill runner.yaml + mcp-config.json
+ a host-prerequisites checklist from a board's live backend state, so an
operator pointing the runner at a new board doesn't hand-author (and mis-author)
the config pair.

The generator is the single source of truth: it derives api_url, workspace_slug,
board_ids, the per-stage providers the pipeline names, the forge driver (from the
board's git provider), default/integration branch, and the cost-aware budget
floor from the workspace pipeline_config + the board's git repo. Secrets are NEVER
embedded — the agent key stays a ${VALARIS_API_KEY} placeholder.
"""

from __future__ import annotations

import copy
import json

import yaml

from app.services.runner_config import build_runner_config


PREREQUISITE_MESSAGE_CODES = {
    "agent_key_create",
    "agent_key_export_or_rotate",
    "team_binding",
    "coding_agents_on_path",
    "mcp_uv",
    "github_auth",
    "forge_auth",
    "visual_testing",
    "git_repo_missing",
}
PREREQUISITE_PARAM_KEYS = {
    "agent_name",
    "workspace_slug",
    "provider_ids",
    "forge",
}


def _default_config() -> dict:
    from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG

    return copy.deepcopy(DEFAULT_PIPELINE_CONFIG)


def test_default_config_fixture_never_mutates_the_production_default():
    from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG

    original = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    candidate = _default_config()
    candidate["stages"][0]["llm"]["provider"] = "fixture-only-provider"

    try:
        assert DEFAULT_PIPELINE_CONFIG == original
    finally:
        DEFAULT_PIPELINE_CONFIG.clear()
        DEFAULT_PIPELINE_CONFIG.update(original)


def _pipeline_config(*providers: str, ui_validator: bool = False) -> dict:
    stages = [
        {"role": f"role_{index}", "llm": {"provider": provider}}
        for index, provider in enumerate(providers)
    ]
    if ui_validator:
        stages.append(
            {
                "role": "ui_validator",
                "llm": {"provider": providers[0] if providers else "claude-cli"},
            }
        )
    return {"stages": stages}


def _assert_structured_prerequisite_contract(out: dict) -> None:
    messages = out["prerequisite_messages"]
    assert len(messages) == len(out["prerequisites"])

    for message in messages:
        assert set(message) == {"code", "params"}
        assert message["code"] in PREREQUISITE_MESSAGE_CODES
        assert set(message["params"]) <= PREREQUISITE_PARAM_KEYS
        serialized_params = json.dumps(message["params"]).lower()
        assert "valaris_api_key" not in serialized_params
        assert "vlr_" not in serialized_params
        assert "token" not in serialized_params
        assert "secret" not in serialized_params
        assert "password" not in serialized_params


def test_build_runner_config_prefills_identity_from_board():
    out = build_runner_config(
        api_url="https://backend.example.run.app",
        workspace_slug="acme",
        board_id="e1a1b2ee-3282-4064-b304-a5f6ef593fb1",
        pipeline_config=_default_config(),
        repos=[
            {"provider": "github", "default_branch": "main", "integration_branch": "integration"}
        ],
    )
    cfg = yaml.safe_load(out["runner_yaml"])

    assert cfg["valaris"]["api_url"] == "https://backend.example.run.app"
    assert cfg["valaris"]["workspace_slug"] == "acme"
    assert cfg["valaris"]["board_ids"] == ["e1a1b2ee-3282-4064-b304-a5f6ef593fb1"]


def test_build_runner_config_never_embeds_the_api_key():
    out = build_runner_config(
        api_url="https://backend.example.run.app",
        workspace_slug="acme",
        board_id="board-1",
        pipeline_config=_default_config(),
        repos=[{"provider": "github", "default_branch": "main"}],
    )
    cfg = yaml.safe_load(out["runner_yaml"])
    mcp = json.loads(out["mcp_config_json"])

    # The placeholder, not a real vlr_ token, in BOTH files.
    assert cfg["valaris"]["api_key"] == "${VALARIS_API_KEY}"
    env = mcp["mcpServers"]["valaris"]["env"]
    assert "vlr_" not in env["VALARIS_API_KEY"]
    assert "${VALARIS_API_KEY}" in env["VALARIS_API_KEY"] or env["VALARIS_API_KEY"] == "${VALARIS_API_KEY}"
    assert env["VALARIS_API_URL"] == "https://backend.example.run.app"


def test_build_runner_config_forge_follows_board_git_provider():
    github = build_runner_config(
        api_url="u", workspace_slug="w", board_id="b",
        pipeline_config=_default_config(),
        repos=[{"provider": "github", "default_branch": "main"}],
    )
    gitea = build_runner_config(
        api_url="u", workspace_slug="w", board_id="b",
        pipeline_config=_default_config(),
        repos=[{"provider": "gitea", "default_branch": "main"}],
    )
    assert yaml.safe_load(github["runner_yaml"])["git"]["forge"] == "github"
    assert yaml.safe_load(gitea["runner_yaml"])["git"]["forge"] == "gitea"


def test_build_runner_config_declares_every_provider_the_pipeline_names():
    """A pipeline that mixes claude-cli + codex-cli per stage must surface BOTH
    in extra_providers so the runner builds every binary a stage can select."""
    cfg = _default_config()
    # Force a mixed-provider pipeline: implementer on codex, rest on claude.
    for stage in cfg["stages"]:
        if stage.get("role") == "implementer":
            stage.setdefault("llm", {})["provider"] = "codex-cli"

    out = build_runner_config(
        api_url="u", workspace_slug="w", board_id="b",
        pipeline_config=cfg,
        repos=[{"provider": "github", "default_branch": "main"}],
    )
    parsed = yaml.safe_load(out["runner_yaml"])
    declared = {parsed["llm"]["provider"], *(parsed["llm"].get("extra_providers") or [])}
    assert "claude-cli" in declared
    assert "codex-cli" in declared


def test_build_runner_config_prerequisites_cover_the_environment():
    out = build_runner_config(
        api_url="u", workspace_slug="acme", board_id="b",
        pipeline_config=_default_config(),
        repos=[{"provider": "github", "default_branch": "main"}],
    )
    prereqs = " ".join(out["prerequisites"]).lower()
    # The four things the operator must do that the YAML can't do for them.
    assert "valaris_api_key" in prereqs  # the agent key
    assert "team" in prereqs            # team binding carries the roles
    assert "claude" in prereqs          # the coding-agent CLI on PATH
    assert "gh auth" in prereqs         # github forge auth


def test_build_runner_config_for_existing_agent_drops_create_and_bind_prereqs():
    """When the config is fetched for an already-created runner (the launch
    wizard / per-runner launch panel), the 'create an agent' and 'team binding'
    prerequisites are redundant — the runner exists and was bound here. They
    confused operators. The runner-scoped variant drops both; the survivors are
    the host-environment steps the platform genuinely can't do (CLI, forge)."""
    out = build_runner_config(
        api_url="u", workspace_slug="acme", board_id="b",
        pipeline_config=_default_config(),
        repos=[{"provider": "github", "default_branch": "main"}],
        for_agent="frogger",
    )
    prereqs = " ".join(out["prerequisites"]).lower()
    # The now-redundant steps are gone.
    assert "post /api/agents" not in prereqs
    assert "create an agent" not in prereqs
    assert not any("team binding" in p.lower() for p in out["prerequisites"])
    # The host-environment steps that still matter remain.
    assert "claude" in prereqs   # coding-agent CLI on PATH
    assert "gh auth" in prereqs   # forge auth
    # The key story is still surfaced, but as "you already have it / rotate",
    # keyed to this runner — not "go create an agent".
    assert "valaris_api_key" in prereqs
    assert "frogger" in prereqs


def test_build_runner_config_board_generic_keeps_create_and_bind_prereqs():
    """The board git-page (no agent context) still lists create+bind — there,
    the operator genuinely hasn't made a runner yet."""
    out = build_runner_config(
        api_url="u", workspace_slug="acme", board_id="b",
        pipeline_config=_default_config(),
        repos=[{"provider": "github", "default_branch": "main"}],
    )
    prereqs = " ".join(out["prerequisites"]).lower()
    assert "create an agent" in prereqs
    assert any("team binding" in p.lower() for p in out["prerequisites"])


def test_build_runner_config_flags_visual_testing_skill_when_ui_validator_enabled():
    """ui_validator (enabled in the default) mandates the Claude visual-testing
    skill, so the checklist must tell the operator about ~/.claude context_dirs."""
    out = build_runner_config(
        api_url="u", workspace_slug="w", board_id="b",
        pipeline_config=_default_config(),
        repos=[{"provider": "github", "default_branch": "main"}],
    )
    prereqs = " ".join(out["prerequisites"]).lower()
    assert "visual" in prereqs or "context_dirs" in prereqs


def test_build_runner_config_handles_board_without_a_repo():
    """No git repo yet → still produce a valid skeleton (forge defaults to
    github) and a prerequisite telling the operator to add a repo."""
    out = build_runner_config(
        api_url="u", workspace_slug="w", board_id="b",
        pipeline_config=_default_config(),
        repos=[],
    )
    cfg = yaml.safe_load(out["runner_yaml"])
    assert cfg["git"]["forge"] == "github"
    assert any("repo" in p.lower() for p in out["prerequisites"])


def test_prerequisite_messages_preserve_generic_legacy_order_and_text():
    out = build_runner_config(
        api_url="u",
        workspace_slug="acme",
        board_id="b",
        pipeline_config=_pipeline_config(
            "claude-cli", "codex-cli", ui_validator=True
        ),
        repos=[{"provider": "github", "default_branch": "main"}],
    )

    assert out["prerequisites"] == [
        "Agent key: create an agent (POST /api/agents) and export its vlr_… "
        "token as VALARIS_API_KEY before launch. Both config files read it "
        "from the env.",
        "Team binding: the agent MUST belong to a team in 'acme' whose "
        "team_roles cover the pipeline roles — otherwise "
        "/api/agents/me/config returns no workspace_config and the runner "
        "refuses to start.",
        "Coding agent(s) on PATH: this pipeline runs on the `claude` CLI, "
        "the `codex` CLI. Install and authenticate each one the runner will "
        "launch.",
        "MCP server: the mcp-config's `uvx backplane-mcp` needs `uv` on PATH — "
        "it resolves and runs the published PyPI package on launch, no local "
        "checkout required.",
        "GitHub auth: run `gh auth login` (the github forge shells the gh CLI "
        "for PR open/merge). The clone host needs push access to the repo.",
        "Visual testing: ui_validator is enabled — keep context_dirs pointed at "
        "~/.claude so the headless agent discovers the valaris-visual-testing "
        "skill.",
    ]
    assert out["prerequisite_messages"] == [
        {"code": "agent_key_create", "params": {}},
        {"code": "team_binding", "params": {"workspace_slug": "acme"}},
        {
            "code": "coding_agents_on_path",
            "params": {"provider_ids": ["claude-cli", "codex-cli"]},
        },
        {"code": "mcp_uv", "params": {}},
        {"code": "github_auth", "params": {}},
        {"code": "visual_testing", "params": {}},
    ]
    _assert_structured_prerequisite_contract(out)


def test_prerequisite_messages_scope_existing_agent_and_generic_forge():
    out = build_runner_config(
        api_url="u",
        workspace_slug="acme",
        board_id="b",
        pipeline_config=_pipeline_config("custom-provider"),
        repos=[{"provider": "gitea", "default_branch": "main"}],
        for_agent="frogger",
    )

    assert out["prerequisite_messages"] == [
        {
            "code": "agent_key_export_or_rotate",
            "params": {"agent_name": "frogger"},
        },
        {
            "code": "coding_agents_on_path",
            "params": {"provider_ids": ["custom-provider"]},
        },
        {"code": "mcp_uv", "params": {}},
        {"code": "forge_auth", "params": {"forge": "gitea"}},
    ]
    assert len(out["prerequisite_messages"]) == 4
    assert "frogger" in out["prerequisites"][0]
    assert "Rotate the key" in out["prerequisites"][0]
    assert "Team binding" not in " ".join(out["prerequisites"])
    _assert_structured_prerequisite_contract(out)


def test_prerequisite_messages_keep_binding_for_existing_unbound_agent():
    out = build_runner_config(
        api_url="u",
        workspace_slug="acme",
        board_id="b",
        pipeline_config=_pipeline_config("claude-cli"),
        repos=[{"provider": "github", "default_branch": "main"}],
        for_agent="frogger",
        has_workspace_binding=False,
    )

    assert out["prerequisite_messages"][:2] == [
        {
            "code": "agent_key_export_or_rotate",
            "params": {"agent_name": "frogger"},
        },
        {"code": "team_binding", "params": {"workspace_slug": "acme"}},
    ]
    assert "create an agent" not in " ".join(out["prerequisites"]).lower()
    assert "team binding" in " ".join(out["prerequisites"]).lower()
    _assert_structured_prerequisite_contract(out)


def test_prerequisite_messages_cover_missing_repo_without_exposing_secrets():
    out = build_runner_config(
        api_url="u",
        workspace_slug="sandbox",
        board_id="b",
        pipeline_config=_pipeline_config(),
        repos=[],
    )

    assert out["prerequisite_messages"] == [
        {"code": "agent_key_create", "params": {}},
        {"code": "team_binding", "params": {"workspace_slug": "sandbox"}},
        {
            "code": "coding_agents_on_path",
            "params": {"provider_ids": ["claude-cli"]},
        },
        {"code": "mcp_uv", "params": {}},
        {"code": "github_auth", "params": {}},
        {"code": "git_repo_missing", "params": {}},
    ]
    _assert_structured_prerequisite_contract(out)


def test_prerequisite_message_parity_holds_for_every_input_variant():
    provider_sets = [(), ("claude-cli",), ("codex-cli", "custom-provider")]

    for for_agent in (None, "frogger"):
        for providers in provider_sets:
            for repo_provider in ("github", "gitea"):
                for ui_validator in (False, True):
                    for has_repo in (False, True):
                        repos = (
                            [{"provider": repo_provider, "default_branch": "main"}]
                            if has_repo
                            else []
                        )
                        out = build_runner_config(
                            api_url="u",
                            workspace_slug="sandbox",
                            board_id="b",
                            pipeline_config=_pipeline_config(
                                *providers, ui_validator=ui_validator
                            ),
                            repos=repos,
                            for_agent=for_agent,
                        )

                        _assert_structured_prerequisite_contract(out)
