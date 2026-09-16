# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Unit tests for runner export bundle builders.

B13: api_url must be injected from settings, not a hardcoded
`https://your-backend-url.run.app` placeholder operators have to hand-edit.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest
import yaml

from app.services.agents.export import (
    build_export_zip,
    build_mcp_json,
    build_runner_yaml,
)


PLACEHOLDER_URL = "https://your-backend-url.run.app"


@pytest.mark.parametrize("name", ['bad"quote runner', r"back\slash runner", "Sam's runner", "line\nbreak runner"])
def test_export_bundle_preserves_unusual_names_in_parseable_yaml(name):
    bundle = build_export_zip(
        name=name,
        agent_id="abc-123",
        workspace_slug="default",
        budget_usd=10.0,
        api_url="https://valaris.example.com",
        docs_url="https://app.valaris.example.com",
    )
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        config = yaml.safe_load(archive.read(f"runner-{name}.yaml"))
        assert config["llm"]["mcp_config_path"] == f"./mcp-config-{name}.json"
        assert config["valaris"]["workspace_slug"] == "default"
        assert config["valaris"]["api_key"] == "${VALARIS_API_KEY}"
        assert config["llm"]["mcp_config_path"][2:] in archive.namelist()


def test_build_runner_yaml_uses_api_url():
    yaml_body = build_runner_yaml(
        name="coder",
        agent_id="abc-123",
        workspace_slug="default",
        budget_usd=10.0,
        api_url="http://localhost:8000",
    )
    assert 'api_url: "http://localhost:8000"' in yaml_body
    assert PLACEHOLDER_URL not in yaml_body


def test_build_runner_yaml_honors_custom_api_url():
    yaml_body = build_runner_yaml(
        name="coder",
        agent_id="abc-123",
        workspace_slug="default",
        budget_usd=10.0,
        api_url="https://valaris.example.com",
    )
    assert 'api_url: "https://valaris.example.com"' in yaml_body
    assert PLACEHOLDER_URL not in yaml_body


def test_build_mcp_json_uses_api_url():
    raw = build_mcp_json(api_url="http://localhost:8000")
    cfg = json.loads(raw)
    env = cfg["mcpServers"]["valaris"]["env"]
    assert env["VALARIS_API_URL"] == "http://localhost:8000"
    assert PLACEHOLDER_URL not in raw


def test_build_export_zip_threads_api_url_into_both_files():
    zip_bytes = build_export_zip(
        name="coder",
        agent_id="abc-123",
        workspace_slug="default",
        budget_usd=10.0,
        api_url="https://valaris.example.com",
        docs_url="https://app.valaris.example.com",
    )
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        yaml_body = zf.read("runner-coder.yaml").decode()
        mcp_body = zf.read("mcp-config-coder.json").decode()
        readme_body = zf.read("README.txt").decode()

    assert 'api_url: "https://valaris.example.com"' in yaml_body
    assert PLACEHOLDER_URL not in yaml_body

    mcp_cfg = json.loads(mcp_body)
    assert (
        mcp_cfg["mcpServers"]["valaris"]["env"]["VALARIS_API_URL"]
        == "https://valaris.example.com"
    )
    assert PLACEHOLDER_URL not in mcp_body

    assert "https://app.valaris.example.com/documentation" in readme_body


def test_export_commands_quote_config_path_and_load_key_before_doctor():
    import shlex

    from app.services.agents.export import build_readme_txt, build_runner_yaml

    name = "Sam's runner"
    readme = build_readme_txt(name=name, docs_url="https://example.test")
    command_lines = [line.strip() for line in readme.splitlines() if "./backplane-runner -" in line]
    assert len(command_lines) == 2
    for command in command_lines:
        args = shlex.split(command)
        assert args[args.index("-config") + 1] == f"runner-{name}.yaml"
    assert readme.index("read -s VALARIS_API_KEY") < readme.index("./backplane-runner -doctor")
    yaml = build_runner_yaml(name=name, agent_id="a", workspace_slug="w", budget_usd=1, api_url="https://example.test")
    assert "VALARIS_API_KEY=vlr_..." not in yaml
