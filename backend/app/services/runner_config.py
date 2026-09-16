# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Self-service runner-config generation.

Pre-fills the host-side runner config pair (`runner.yaml` + `mcp-config.json`)
plus a host-prerequisites checklist from a board's live backend state, so an
operator pointing the runner at a new board does NOT hand-author — and
mis-author — the config. The generator is the single source of truth for the
DERIVABLE fields (api_url, workspace_slug, board_ids, the providers the pipeline
names per stage, the forge driver from the board's git provider); everything the
backend can't know (the agent key, the team binding, the local CLI/auth) becomes
a checklist item instead of a guessed value.

Secrets are NEVER embedded: the agent key stays a `${VALARIS_API_KEY}`
placeholder in both files (env-substituted at launch). The runner's config
defaults (see runner/internal/config/config.go `defaults()`) own everything not
emitted here, so the generated YAML is intentionally MINIMAL — only the
board-specific overrides plus a few load-bearing comments.
"""

from __future__ import annotations

from typing import Literal, TypedDict

API_KEY_PLACEHOLDER = "${VALARIS_API_KEY}"

# Per-card budget floor (USD) when the workspace has no cost circuit breaker to
# anchor against. The runner's own default is 1.0 — too low for a foundation
# card — so we lift it to a sane build budget while staying well under a typical
# breaker. An operator tunes this; the comment in the YAML says so.
_DEFAULT_BUDGET_USD = 10.0

PrerequisiteCode = Literal[
    "agent_key_create",
    "agent_key_export_or_rotate",
    "team_binding",
    "coding_agents_on_path",
    "mcp_uv",
    "github_auth",
    "forge_auth",
    "visual_testing",
    "git_repo_missing",
]
PrerequisiteParamValue = str | list[str]


class PrerequisiteMessage(TypedDict):
    code: PrerequisiteCode
    params: dict[str, PrerequisiteParamValue]


PrerequisiteEntry = tuple[str, PrerequisiteMessage]


def _stages(pipeline_config: dict) -> list[dict]:
    stages = pipeline_config.get("stages")
    return [s for s in stages if isinstance(s, dict)] if isinstance(stages, list) else []


def _stage_llm(stage: dict) -> dict:
    llm = stage.get("llm")
    return llm if isinstance(llm, dict) else {}


def _enabled(stage: dict) -> bool:
    # A stage with no `enabled` key is on by default (matches the runner).
    return _stage_llm(stage).get("enabled", True) is not False


def _named_providers(pipeline_config: dict) -> list[str]:
    """Distinct coding-agent providers the pipeline's ENABLED stages name, in
    first-seen order. Drives the runner's default Provider + extra_providers so
    every binary a stage can select is built and preflighted at startup."""
    out: list[str] = []
    for stage in _stages(pipeline_config):
        if not _enabled(stage):
            continue
        provider = _stage_llm(stage).get("provider")
        if isinstance(provider, str) and provider and provider not in out:
            out.append(provider)
    return out or ["claude-cli"]


def _has_enabled_role(pipeline_config: dict, role: str) -> bool:
    return any(
        s.get("role") == role and _enabled(s) for s in _stages(pipeline_config)
    )


def _forge_for(provider: str | None) -> str:
    """Map a board git provider to the runner's forge driver selector. Only
    gitea/forgejo speak the non-CLI HTTP driver; everything else (github) uses
    the `gh`-CLI driver."""
    return "gitea" if (provider or "").lower() in ("gitea", "forgejo") else "github"


def _integration_branch(repos: list[dict]) -> str | None:
    for repo in repos:
        ib = repo.get("integration_branch")
        if isinstance(ib, str) and ib:
            return ib
    return None


def build_runner_config(
    *,
    api_url: str,
    workspace_slug: str,
    board_id: str,
    pipeline_config: dict,
    repos: list[dict],
    agent_email: str = "runner@valaris.studio",
    for_agent: str | None = None,
    has_workspace_binding: bool | None = None,
) -> dict:
    """Build the pre-filled runner-config pair + prerequisites checklist.

    `repos` is the board's git repos as plain dicts with `provider`,
    `default_branch`, and optional `integration_branch` — enough to pick the
    forge driver and surface the branch model without coupling to the ORM.

    `for_agent` is the runner name when the config is fetched for an existing
    runner. It drops only the "create an agent" prerequisite and rewords the key
    step to point at rotation. `has_workspace_binding` controls whether the team
    binding prerequisite can also be omitted. Its None default preserves the
    historical direct-call contract where a named runner implied a completed
    binding; HTTP callers pass an explicit, backend-verified value.
    """
    providers = _named_providers(pipeline_config)
    default_provider, extra_providers = providers[0], providers[1:]
    primary_repo = repos[0] if repos else {}
    forge = _forge_for(primary_repo.get("provider"))
    integration_branch = _integration_branch(repos)
    ui_validator = _has_enabled_role(pipeline_config, "ui_validator")

    runner_yaml = _render_runner_yaml(
        api_url=api_url,
        workspace_slug=workspace_slug,
        board_id=board_id,
        default_provider=default_provider,
        extra_providers=extra_providers,
        forge=forge,
        integration_branch=integration_branch,
        ui_validator=ui_validator,
    )
    mcp_config_json = _render_mcp_config(api_url=api_url, agent_email=agent_email)
    prerequisite_entries = _prerequisite_entries(
        workspace_slug=workspace_slug,
        providers=providers,
        forge=forge,
        ui_validator=ui_validator,
        has_repo=bool(repos),
        for_agent=for_agent,
        has_workspace_binding=has_workspace_binding,
    )
    return {
        "runner_yaml": runner_yaml,
        "mcp_config_json": mcp_config_json,
        "prerequisites": [text for text, _ in prerequisite_entries],
        "prerequisite_messages": [message for _, message in prerequisite_entries],
    }


def _render_runner_yaml(
    *,
    api_url: str,
    workspace_slug: str,
    board_id: str,
    default_provider: str,
    extra_providers: list[str],
    forge: str,
    integration_branch: str | None,
    ui_validator: bool,
) -> str:
    extra_block = ""
    if extra_providers:
        extra_lines = "\n".join(f'    - "{p}"' for p in extra_providers)
        extra_block = (
            "\n  # The pipeline mixes coding agents per stage; the runner must\n"
            "  # build EVERY binary a stage can select. Ensure each is on PATH.\n"
            f"  extra_providers:\n{extra_lines}\n"
        )

    context_block = ""
    if ui_validator:
        context_block = (
            "\n  # The ui_validator stage mandates the Claude visual-testing skill.\n"
            "  # --add-dir ~/.claude makes headless `-p` discover ~/.claude/skills/.\n"
            "  # Point this at YOUR home, or drop it if ui_validator is disabled.\n"
            "  context_dirs:\n"
            '    - "~/.claude"\n'
        )

    integration_comment = ""
    if integration_branch:
        integration_comment = (
            f"  # Repo integration branch is '{integration_branch}'; the implementer\n"
            f"  # branches off it and ui_validator audits its head post-merge.\n"
        )

    return f"""# Backplane — runner config for workspace '{workspace_slug}'.
# Generated from the board's backend state. Fill the AGENT KEY at launch
# (export VALARIS_API_KEY=vlr_...); do NOT hardcode it. Roles, per-stage models,
# and the cost circuit breaker come from the workspace pipeline_config — they are
# intentionally NOT in this file. Everything not set here uses the runner's
# documented defaults (runner/configs/runner.example.yaml).
#
# NEVER commit a filled copy of this file — it carries the run identity.

valaris:
  # Backend URL — used ONLY for the startup identity check (GET /api/me).
  api_url: "{api_url}"
  # Agent key — env VALARIS_API_KEY takes precedence; keep the placeholder here.
  api_key: "{API_KEY_PLACEHOLDER}"
  workspace_slug: "{workspace_slug}"
  # This board only. Empty list = all boards in the workspace.
  board_ids: ["{board_id}"]

llm:
  provider: "{default_provider}"
  # Top-level model is the FALLBACK floor; per-stage models come from the
  # pipeline_config tiers (premium/mid/low → resolved by the backend).
  model: "sonnet"
  # Per-card ceiling (USD). Set BELOW the workspace cost circuit breaker so the
  # breaker is the runaway backstop, not the per-card cap. Tune for the board.
  max_budget_usd: {_DEFAULT_BUDGET_USD}
  mcp_config_path: "./mcp-config.json"
  dangerously_skip_permissions: true
  session_persistence: true{extra_block}{context_block}
git:
  base_dir: "/tmp/backplane-runner-repos"
  # Forge driver follows the board's git provider.
  forge: "{forge}"
{integration_comment}  auto_pr: true
  merge_strategy: "squash"
  # platform = comment-only single-identity review (NO second gh identity needed).
  review_mode: "platform"

log_level: "info"
"""


def _render_mcp_config(*, api_url: str, agent_email: str) -> str:
    import json

    config = {
        "mcpServers": {
            "valaris": {
                # uvx resolves the published PyPI artifact — the README's
                # documented install. Requires uv on PATH; no repo-local path.
                "command": "uvx",
                "args": ["backplane-mcp"],
                "env": {
                    "VALARIS_API_URL": api_url,
                    # Placeholder — the runner injects the real key from
                    # VALARIS_API_KEY at launch. Never paste a vlr_ token here.
                    "VALARIS_API_KEY": API_KEY_PLACEHOLDER,
                    "VALARIS_AGENT_EMAIL": agent_email,
                },
            }
        }
    }
    return json.dumps(config, indent=2)


def _prerequisite_entries(
    *,
    workspace_slug: str,
    providers: list[str],
    forge: str,
    ui_validator: bool,
    has_repo: bool,
    for_agent: str | None = None,
    has_workspace_binding: bool | None = None,
) -> list[PrerequisiteEntry]:
    """The host-environment steps the backend can't do for the operator.

    Each item is one actionable thing to check BEFORE launch — the failures that
    otherwise surface as cryptic startup errors ("platform returned no
    pipeline_config", "codex: command not found", forge auth 401).

    When `for_agent` is set, the key step becomes "export the key you saved /
    rotate if lost" instead of "go create an agent". Team binding remains until
    the caller explicitly verifies it. None retains the historical direct-call
    assumption that a named runner is already bound."""
    entries: list[PrerequisiteEntry] = []
    if for_agent is None:
        entries.append(
            (
                "Agent key: create an agent (POST /api/agents) and export its vlr_… "
                "token as VALARIS_API_KEY before launch. Both config files read it "
                "from the env.",
                {"code": "agent_key_create", "params": {}},
            )
        )
    else:
        entries.append(
            (
                f"Agent key: export '{for_agent}'s key as VALARIS_API_KEY before "
                "launch — the vlr_… token shown once when this runner was created. "
                "Lost it? Rotate the key from the runner's page. Both config files "
                "read it from the env.",
                {
                    "code": "agent_key_export_or_rotate",
                    "params": {"agent_name": for_agent},
                },
            )
        )

    if for_agent is None or has_workspace_binding is False:
        entries.append(
            (
                f"Team binding: the agent MUST belong to a team in '{workspace_slug}' "
                "whose team_roles cover the pipeline roles — otherwise "
                "/api/agents/me/config returns no workspace_config and the runner "
                "refuses to start.",
                {
                    "code": "team_binding",
                    "params": {"workspace_slug": workspace_slug},
                },
            )
        )

    cli_names = {
        "claude-cli": "the `claude` CLI",
        "codex-cli": "the `codex` CLI",
    }
    named = ", ".join(cli_names.get(p, f"`{p}`") for p in providers)
    entries.append(
        (
            f"Coding agent(s) on PATH: this pipeline runs on {named}. Install and "
            "authenticate each one the runner will launch.",
            {
                "code": "coding_agents_on_path",
                "params": {"provider_ids": providers},
            },
        )
    )
    entries.append(
        (
            "MCP server: the mcp-config's `uvx backplane-mcp` needs `uv` on PATH — "
            "it resolves and runs the published PyPI package on launch, no local "
            "checkout required.",
            {"code": "mcp_uv", "params": {}},
        )
    )

    if forge == "github":
        entries.append(
            (
                "GitHub auth: run `gh auth login` (the github forge shells the gh CLI "
                "for PR open/merge). The clone host needs push access to the repo.",
                {"code": "github_auth", "params": {}},
            )
        )
    else:
        entries.append(
            (
                f"Forge auth: the '{forge}' forge driver speaks HTTP — set git.forge_base_url "
                "and git.forge_token in the YAML (a forge access token with PR/MR scope).",
                {"code": "forge_auth", "params": {"forge": forge}},
            )
        )

    if ui_validator:
        entries.append(
            (
                "Visual testing: ui_validator is enabled — keep context_dirs pointed at "
                "~/.claude so the headless agent discovers the valaris-visual-testing skill.",
                {"code": "visual_testing", "params": {}},
            )
        )

    if not has_repo:
        entries.append(
            (
                "Git repo: this board has no git repo yet — add one (provider + url + "
                "default branch) so the implementer has somewhere to clone and push.",
                {"code": "git_repo_missing", "params": {}},
            )
        )

    return entries
