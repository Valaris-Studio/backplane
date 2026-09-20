# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The artifact acceptance matrix must run in both public CI and local verify."""

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


def test_artifact_gate_is_mandatory_in_public_ci_and_local_verify():
    workflow = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
    jobs = workflow["jobs"]
    artifact = jobs["runner-artifact"]
    assert artifact["timeout-minutes"] <= 20
    commands = "\n".join(step.get("run", "") for step in artifact["steps"])
    assert "./scripts/runner-artifact-gate.sh" in commands
    verify = (ROOT / "scripts/verify-all.sh").read_text()
    assert "run_job runner-artifact job_runner_artifact" in verify
    assert "scripts/runner-artifact-gate.sh" in verify
    gate = ROOT / "scripts/runner-artifact-gate.sh"
    assert gate.is_file() and gate.stat().st_mode & 0o111
    assert "test_runner_readiness_artifact.py" in gate.read_text()
    assert "BACKPLANE_RUNNER_BIN" in gate.read_text()


def _run_controlled_gate(tmp_path, *, complete, excluded=()):
    import json
    import os
    import subprocess
    import sys

    scenarios = (
        (
            "pr-denied",
            "review",
            "validation",
            "missing-runtime",
            "budget-history",
            "recovery",
            "failed-review-rework",
            "interactive",
            "interactive-fresh",
        )
        if complete
        else ()
    )
    names = [
        "test_built_runner_real_api_readiness_and_preserved_completion[" + item + "]"
        for item in scenarios
        if item not in excluded
    ] + ["test_fixture_cleanup"]
    xml = '<testsuites><testsuite tests="' + str(len(names)) + '" skipped="0">'
    xml += "".join('<testcase name="' + name + '"/>' for name in names)
    xml += "</testsuite></testsuites>"
    observed = tmp_path / "pytest-invocation.json"
    launcher = tmp_path / "fixture-python"
    launcher.write_text(
        f"#!{sys.executable}\nimport json,os,sys\nfrom pathlib import Path\n"
        "if sys.argv[1:3] == ['-m','pytest']:\n"
        f" Path({str(observed)!r}).write_text(json.dumps({{'args':sys.argv[1:],'addopts':os.environ.get('PYTEST_ADDOPTS')}}))\n"
        " receipt=next(arg.split('=',1)[1] for arg in sys.argv if arg.startswith('--junitxml='))\n"
        f" Path(receipt).write_text({xml!r})\n raise SystemExit(0)\n"
        f"os.execv({sys.executable!r}, [{sys.executable!r}, *sys.argv[1:]])\n"
    )
    launcher.chmod(0o755)
    uvx = tmp_path / "uvx"
    uvx.write_text("#!/bin/sh\nexit 78\n")
    uvx.chmod(0o755)
    result = subprocess.run(
        [str(ROOT / "scripts/runner-artifact-gate.sh")],
        env={
            **os.environ,
            "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"],
            "BACKPLANE_RUNNER_BIN": sys.executable,
            "BACKPLANE_TEST_PYTHON": str(launcher),
            "PYTEST_ADDOPTS": '-m "not slow" -k fixture',
        },
        capture_output=True,
        text=True,
        timeout=15,
    )
    return result, json.loads(observed.read_text())


def test_artifact_gate_rejects_receipt_without_required_scenarios(tmp_path):
    result, _ = _run_controlled_gate(tmp_path, complete=False)
    assert result.returncode != 0, "helpers alone falsely qualified the artifact"
    assert "missing required artifact scenarios" in result.stderr


def test_artifact_gate_ignores_inherited_pytest_selection(tmp_path):
    result, invocation = _run_controlled_gate(tmp_path, complete=True)
    assert result.returncode == 0, result.stderr
    assert invocation["addopts"] is None
    assert "addopts=" in invocation["args"]


def test_artifact_gate_rejects_missing_failed_review_rework(tmp_path):
    result, _ = _run_controlled_gate(
        tmp_path, complete=True, excluded=("failed-review-rework",)
    )
    assert (
        result.returncode != 0
    ), "artifact skipped failed-review correction qualification"
    assert "failed-review-rework" in result.stderr


def _run_source_gate(tmp_path, *, dirty=False, symlink=False):
    import os
    import shutil
    import subprocess
    import sys

    from tests.runner_fixture_git import fixture_git_environment

    git_env = fixture_git_environment()
    checkout = tmp_path / "checkout"
    (checkout / "scripts").mkdir(parents=True)
    (checkout / "runner").mkdir()
    shutil.copy2(ROOT / "scripts/runner-artifact-gate.sh", checkout / "scripts")
    source = checkout / "runner/main.go"
    source.write_text("package main\nfunc main() {}\n")
    subprocess.run(["git", "init", "-q", str(checkout)], env=git_env, check=True)
    subprocess.run(["git", "-C", str(checkout), "add", "."], env=git_env, check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(checkout),
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "fixture",
        ],
        env=git_env,
        check=True,
    )
    if dirty:
        source.write_text('package main\nfunc main() { panic("dirty") }\n')
    commands = tmp_path / "commands"
    commands.mkdir()
    build_marker = tmp_path / "build-started"
    for name, body in (("uvx", "exit 78"), ("go", f"touch '{build_marker}'; exit 79")):
        path = commands / name
        path.write_text("#!/bin/sh\n" + body + "\n")
        path.chmod(0o755)
    env = {
        **os.environ,
        "PATH": str(commands) + os.pathsep + os.environ["PATH"],
        "BACKPLANE_TEST_PYTHON": sys.executable,
    }
    env.pop("BACKPLANE_RUNNER_BIN", None)
    invocation_root = checkout
    if symlink:
        invocation_root = tmp_path / "linked-checkout"
        invocation_root.symlink_to(checkout, target_is_directory=True)
    result = subprocess.run(
        [str(invocation_root / "scripts/runner-artifact-gate.sh")],
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
    )
    return result, build_marker


def test_source_gate_rejects_dirty_runner_before_build(tmp_path):
    result, build_marker = _run_source_gate(tmp_path, dirty=True)
    assert result.returncode != 0
    assert not build_marker.exists(), "dirty runner source was labeled with clean HEAD"
    assert "runner source has uncommitted changes" in result.stderr


def test_source_gate_accepts_own_clean_checkout_through_symlink(tmp_path):
    result, build_marker = _run_source_gate(tmp_path, symlink=True)
    assert build_marker.exists(), "physical and symlink paths name the same checkout"
    assert result.returncode == 79  # Controlled builder reached, no actual build.
    assert "requires its own Git checkout" not in result.stderr
