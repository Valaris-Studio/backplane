# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Exercise the local MCP gate without installing packages or accessing the network."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

VERIFY_SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "verify-all.sh"

SHIM = r'''
import json
import os
from pathlib import Path
import sys

name = Path(sys.argv[0]).name
args = sys.argv[1:]
if name == "uv":
    stage = {"sync": "sync", "export": "export", "build": "build", "run": "tests"}[args[0]]
elif name == "uvx":
    stage = "audit"
else:
    stage = "legacy"
with open(os.environ["COMMAND_LOG"], "a") as log:
    log.write(json.dumps({"name": name, "args": args, "stage": stage, "cwd": os.getcwd()}) + "\n")
if stage == os.environ.get("FAIL_STAGE"):
    sys.exit(23)
if stage == "export":
    requirements = "locked-package==1.2.3\n"
    if "-o" in args:
        Path(args[args.index("-o") + 1]).write_text(requirements)
    elif "--output-file" in args:
        Path(args[args.index("--output-file") + 1]).write_text(requirements)
    else:
        print(requirements, end="")
if stage == "audit":
    assert Path(args[args.index("-r") + 1]).read_text() == "locked-package==1.2.3\n"
if name == "python" and args[:1] == ["-c"]:
    sys.exit(1)  # The old optional-build path must not qualify a candidate.
'''


@pytest.fixture
def run_gate(tmp_path):
    repo = tmp_path / "checkout with spaces"
    (repo / "scripts").mkdir(parents=True)
    (repo / "mcp-server").mkdir()
    script = repo / "scripts" / "verify-all.sh"
    shutil.copyfile(VERIFY_SCRIPT, script)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name in ("dirname", "mktemp", "rm"):
        (bin_dir / name).symlink_to(shutil.which(name))
    for name in ("uv", "uvx", "python"):
        executable = bin_dir / name
        executable.write_text(f"#!{sys.executable}\n" + SHIM)
        executable.chmod(0o755)
    log = tmp_path / "commands.jsonl"
    caller = tmp_path / "unrelated caller"
    caller.mkdir()

    def run(*, fail_stage="", missing=None, existing_venv=True):
        if existing_venv:
            activate = repo / "mcp-server" / ".venv" / "bin" / "activate"
            activate.parent.mkdir(parents=True)
            activate.write_text("")
        if missing:
            (bin_dir / missing).unlink()
        env = {**os.environ, "PATH": str(bin_dir), "COMMAND_LOG": str(log), "FAIL_STAGE": fail_stage}
        result = subprocess.run(
            ["/bin/bash", str(script), "mcp"], cwd=caller, env=env,
            capture_output=True, text=True, timeout=10,
        )
        commands = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return result, commands, repo

    return run


@pytest.mark.parametrize("existing_venv", [True, False])
def test_mcp_gate_qualifies_locked_dependencies_tests_audit_and_wheel(run_gate, existing_venv):
    result, commands, repo = run_gate(existing_venv=existing_venv)
    assert result.returncode == 0, result.stdout + result.stderr
    assert [command["stage"] for command in commands] == ["sync", "tests", "export", "audit", "build"]
    assert all(Path(command["cwd"]).resolve() == (repo / "mcp-server").resolve() for command in commands)
    sync, tests, export, audit, build = [command["args"] for command in commands]
    assert sync == ["sync", "--frozen", "--extra", "dev"]
    assert tests[0] == "run"
    assert {"--frozen", "--no-sync"} & set(tests)
    assert tests[-6:] == ["python", "-m", "pytest", "tests/", "--tb=short", "-q"]
    assert {"--frozen", "--no-hashes", "--no-emit-project", "--extra", "dev"} <= set(export)
    assert audit[:3] == ["pip-audit", "--strict", "--no-deps"]
    assert build[:2] == ["build", "--wheel"]
    assert "All gates passed" in result.stdout


@pytest.mark.parametrize("stage", ["sync", "tests", "export", "audit", "build"])
def test_mcp_gate_failure_cannot_report_success_or_run_later_stages(run_gate, stage):
    result, commands, _ = run_gate(fail_stage=stage)
    assert result.returncode != 0, result.stdout
    expected = ["sync", "tests", "export", "audit", "build"]
    assert [command["stage"] for command in commands] == expected[:expected.index(stage) + 1]
    assert "All gates passed" not in result.stdout
    assert "1 job(s) failed" in result.stdout


@pytest.mark.parametrize("missing", ["uv", "uvx"])
def test_mcp_gate_missing_prerequisite_fails_instead_of_skipping(run_gate, missing):
    result, _, _ = run_gate(missing=missing)
    assert result.returncode != 0, result.stdout
    assert missing in result.stdout + result.stderr
    assert "All gates passed" not in result.stdout
