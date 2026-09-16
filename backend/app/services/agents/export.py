# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Runner config export bundle.

The export endpoint returns a ZIP containing the two files an operator
needs to launch a runner, plus a README:

  runner-{name}.yaml         — the runner binary's config
  mcp-config-{name}.json     — the runner's per-process MCP server config
  README.txt                 — where to download the runner binary + launch steps

The YAML references the JSON as `./mcp-config-{name}.json`. The YAML expands
`VALARIS_API_KEY`, while the JSON intentionally retains the literal
`${VALARIS_API_KEY}` sentinel so the downloaded archive contains no secret.
The runner passes the JSON to the coding-agent CLI verbatim, so an operator
must materialize a private MCP JSON copy with the real key before launch. The
api_url is injected from `settings.API_URL`; no URL edit is required.
"""

from __future__ import annotations

import io
import json
import shlex
import zipfile


def build_runner_yaml(
    *,
    name: str,
    agent_id: str,
    workspace_slug: str,
    budget_usd: float,
    api_url: str,
) -> str:
    """Render the runner YAML for an agent.

    `role:` is intentionally omitted — the runner's roles come from its
    team membership at startup (runner/internal/config/config.go:45).
    Exporting a `role:` field misleads operators who assume changing it
    retargets the runner.
    """
    launch = f"  VALARIS_API_KEY=$VALARIS_API_KEY ./backplane-runner -config {shlex.quote(f'runner-{name}.yaml')}"
    launch_comment = "\n".join(f"# {line}" for line in launch.splitlines())
    return f"""# Valaris Runner Configuration
# Generated for: {json.dumps(name, ensure_ascii=False)}
# Agent ID: {agent_id}
# No runner binary yet? See README.txt in this bundle for the download URL.
#
# Launch:
{launch_comment}
#
# The runner reads {json.dumps(f'mcp-config-{name}.json', ensure_ascii=False)} at the path below, relative to
# this YAML file. Keep both files in the same directory.

valaris:
  api_url: {json.dumps(api_url, ensure_ascii=False)}
  api_key: "${{VALARIS_API_KEY}}"
  workspace_slug: {json.dumps(workspace_slug, ensure_ascii=False)}

llm:
  model: "sonnet"
  mcp_config_path: {json.dumps(f'./mcp-config-{name}.json', ensure_ascii=False)}
  max_budget_usd: {budget_usd}
  dangerously_skip_permissions: true

git:
  base_dir: "~/.valaris/repos"
  default_remote: "origin"
  branch_prefix: "runner/"
  auto_pr: true

work_loop:
  poll_interval: 2m
  card_timeout: 30m
  max_idle_interval: 16m

# telemetry:
#   enabled: false
#   exporter: "otlp"
#   endpoint: "localhost:4317"
#   service_name: "backplane-runner"
"""


def build_mcp_json(*, api_url: str) -> str:
    """Render the per-runner MCP config JSON.

    The API key stays as the literal `${VALARIS_API_KEY}` sentinel. Unlike the
    YAML, the runner does not expand environment variables inside this JSON;
    the operator must create a private materialized copy before launch. We
    never bake a live key into the downloaded artifact.
    """
    cfg = {
        "mcpServers": {
            "valaris": {
                # uvx resolves the published PyPI artifact — the README's
                # documented install. Requires uv on PATH; no repo-local path.
                "command": "uvx",
                "args": ["backplane-mcp"],
                "env": {
                    "VALARIS_API_URL": api_url,
                    "VALARIS_API_KEY": "${VALARIS_API_KEY}",
                    "VALARIS_AGENT_EMAIL": "runner@valaris.studio",
                },
            }
        }
    }
    return json.dumps(cfg, indent=2) + "\n"


def build_readme_txt(*, name: str, docs_url: str) -> str:
    """Render the bundle README.

    Points at the `latest/` alias on purpose — the backend carries no
    runner-version pin; versioned folders and the LATEST marker live
    alongside it in the bucket.
    """
    return f"""Backplane Runner — config bundle for "{name}"
=============================================={"=" * len(name)}

This bundle contains everything except the runner binary itself:

  runner-{name}.yaml       the runner's config (expands VALARIS_API_KEY from env)
  mcp-config-{name}.json   the MCP server config the runner hands to the coding
                           agent — keeps the ${{VALARIS_API_KEY}} placeholder, so
                           materialize a private copy with the real key first

Download the runner
-------------------
Binaries are published at:

  https://storage.googleapis.com/backplane-artifacts/runner/latest/

named backplane-runner-<os>-<arch> (e.g. backplane-runner-darwin-arm64,
backplane-runner-linux-amd64; Windows builds end in .exe). A SHA256SUMS file
sits alongside the binaries — verify your download's checksum against it.
Versioned releases live in sibling vX.Y.Z/ folders; the LATEST file in
runner/ holds the current version number.

Launch
------
Load the saved API key without putting it in shell history (bash/zsh):

  read -s VALARIS_API_KEY && export VALARIS_API_KEY

Preflight check (validates config, connectivity, credentials):

  ./backplane-runner -doctor -config {shlex.quote(f"runner-{name}.yaml")}

Run:

  VALARIS_API_KEY=$VALARIS_API_KEY ./backplane-runner -config {shlex.quote(f"runner-{name}.yaml")}

Keep both config files in the same directory — the YAML references the JSON
by relative path.

Full documentation: {docs_url}/documentation
"""


def build_export_zip(
    *,
    name: str,
    agent_id: str,
    workspace_slug: str,
    budget_usd: float,
    api_url: str,
    docs_url: str,
) -> bytes:
    """Return the ZIP bytes of the export bundle.

    api_url is what the runner talks to; docs_url is the frontend origin —
    /documentation is a frontend route, so the two differ in prod.
    """
    yaml_content = build_runner_yaml(
        name=name,
        agent_id=agent_id,
        workspace_slug=workspace_slug,
        budget_usd=budget_usd,
        api_url=api_url,
    )
    mcp_content = build_mcp_json(api_url=api_url)
    readme_content = build_readme_txt(name=name, docs_url=docs_url)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"runner-{name}.yaml", yaml_content)
        zf.writestr(f"mcp-config-{name}.json", mcp_content)
        zf.writestr("README.txt", readme_content)
    return buf.getvalue()
