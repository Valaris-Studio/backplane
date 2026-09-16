# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tests for scripts/smoke.py — the integration-smoke pipeline gate.

The smoke script enforces seam coverage that per-card pipelines miss:
migrations coherence, backend boot, CORS, env-var documentation, MCP
imports, frontend build, end-to-end workspace round-trip. Each check is
a function on `scripts.smoke` returning a CheckResult; tests verify each
passes on a clean tree and fails loudly with an actionable message when
the seam it owns is broken.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


@pytest.fixture
def smoke_module():
    import smoke  # type: ignore
    return smoke


def test_check_migrations_single_head(smoke_module):
    result = smoke_module.check_migrations()
    assert result.passed, f"Expected single-head migrations on clean main, got: {result.details}"


def test_check_migrations_fails_on_branched_heads(smoke_module, monkeypatch):
    monkeypatch.setattr(
        smoke_module,
        "_alembic_heads",
        lambda: ["abc123 (head)", "def456 (head)"],
    )
    result = smoke_module.check_migrations()
    assert not result.passed
    assert "head" in result.details.lower()


@pytest.mark.slow
def test_check_backend_boots_returns_pass(smoke_module):
    result = smoke_module.check_backend_boots()
    assert result.passed, f"Backend should boot in-process: {result.details}"


@pytest.mark.slow
def test_check_cors_passes_for_prod_origin(smoke_module):
    result = smoke_module.check_cors(origin="http://localhost:5173")
    assert result.passed, f"CORS for known dev origin should pass: {result.details}"


@pytest.mark.slow
def test_check_cors_fails_for_unknown_origin(smoke_module):
    result = smoke_module.check_cors(origin="https://evil.example.com")
    assert not result.passed
    assert "evil.example.com" in result.details or "origin" in result.details.lower()


def test_check_required_env_vars_passes_when_all_declared(smoke_module):
    result = smoke_module.check_required_env_vars()
    assert result.passed, (
        f"Cloudbuild env vars must be declared in app.config.Settings: {result.details}"
    )


def test_check_required_env_vars_fails_when_missing(smoke_module):
    fake_required = {"DATABASE_URL", "TOTALLY_FAKE_VAR_THAT_DOES_NOT_EXIST"}
    with patch.object(smoke_module, "_cloudbuild_env_vars", return_value=fake_required):
        result = smoke_module.check_required_env_vars()
    assert not result.passed
    assert "TOTALLY_FAKE_VAR_THAT_DOES_NOT_EXIST" in result.details


def test_check_mcp_imports_cleanly(smoke_module):
    # The MCP probe shells out to mcp-server/.venv (the only place mcp[cli] is
    # installed). That venv is created locally by `make mcp-install` but does
    # NOT exist in cloudbuild's `test-backend` step (which only sets up the
    # backend venv). Skip the happy-path probe when the precondition is absent
    # — the failure path is independently covered by the next test, which
    # patches `_import_module` and proves the error surface.
    mcp_python = smoke_module.MCP_DIR / ".venv" / "bin" / "python"
    if not mcp_python.exists():
        pytest.skip(f"mcp-server venv not present at {mcp_python}; local-dev-only check")
    result = smoke_module.check_mcp_imports()
    assert result.passed, f"MCP server module should import cleanly: {result.details}"


def test_check_mcp_imports_fails_on_import_error(smoke_module, monkeypatch):
    def boom(_module_name):
        raise ImportError("simulated bad MCP wiring")

    monkeypatch.setattr(smoke_module, "_import_module", boom)
    result = smoke_module.check_mcp_imports()
    assert not result.passed
    assert "simulated bad MCP wiring" in result.details


@pytest.mark.slow
def test_check_round_trip_api_creates_and_reads_workspace(smoke_module):
    result = smoke_module.check_round_trip_api()
    assert result.passed, f"Round-trip workspace create+read failed: {result.details}"


def test_check_result_repr_includes_name_and_status(smoke_module):
    passing = smoke_module.CheckResult(name="x", passed=True, details="ok")
    failing = smoke_module.CheckResult(name="y", passed=False, details="boom")
    assert "PASS" in passing.format_line()
    assert "x" in passing.format_line()
    assert "FAIL" in failing.format_line()
    assert "y" in failing.format_line()


def test_run_all_returns_zero_when_all_pass(smoke_module):
    def fake_check():
        return smoke_module.CheckResult(name="fake", passed=True, details="ok")

    exit_code = smoke_module.run_checks([("fake", fake_check)])
    assert exit_code == 0


def test_run_all_short_circuits_on_first_failure(smoke_module):
    calls: list[str] = []

    def passing():
        calls.append("first")
        return smoke_module.CheckResult(name="first", passed=True, details="")

    def failing():
        calls.append("second")
        return smoke_module.CheckResult(name="second", passed=False, details="broken")

    def never_called():
        calls.append("third")
        return smoke_module.CheckResult(name="third", passed=True, details="")

    exit_code = smoke_module.run_checks(
        [("first", passing), ("second", failing), ("third", never_called)]
    )
    assert exit_code != 0
    assert calls == ["first", "second"]


def test_skip_via_env_skips_named_checks(smoke_module, monkeypatch):
    monkeypatch.setenv("SMOKE_SKIP", "second,third")
    calls: list[str] = []

    def make_check(name: str):
        def _inner():
            calls.append(name)
            return smoke_module.CheckResult(name=name, passed=True, details="")
        return _inner

    exit_code = smoke_module.run_checks(
        [("first", make_check("first")), ("second", make_check("second")), ("third", make_check("third"))]
    )
    assert exit_code == 0
    assert calls == ["first"]


@pytest.mark.slow
@pytest.mark.timeout(120)
def test_full_smoke_passes_on_clean_tree(smoke_module):
    """Full integration: every check (except frontend, which is opt-in via fast mode)
    should pass on the current clean working tree.
    """
    os.environ["SMOKE_SKIP"] = "frontend"
    try:
        exit_code = smoke_module.main(skip_frontend=True)
    finally:
        os.environ.pop("SMOKE_SKIP", None)
    assert exit_code == 0


# ---- env-vars check must survive the public export -----------------------
#
# The public snapshot strips cloudbuild.yaml (private deploy config). A kept
# test that reads it unguarded is born red in the export tree, so the check
# must degrade to a documented skip when the file is absent — and must still
# read the file for real when it is present, so the guard is not a no-op.


def test_check_required_env_vars_passes_when_cloudbuild_absent(smoke_module, tmp_path):
    absent_cloudbuild = tmp_path / "cloudbuild.yaml"
    assert not absent_cloudbuild.exists()
    with patch.object(smoke_module, "CLOUDBUILD_PATH", absent_cloudbuild):
        result = smoke_module.check_required_env_vars()
    assert result.name == "env-vars"
    assert result.passed is True, (
        f"env-vars must pass (skip) when cloudbuild.yaml is not in the tree: {result.details}"
    )
    assert "cloudbuild.yaml" in result.details
    assert "not present" in result.details.lower()


def test_check_required_env_vars_still_reads_cloudbuild_when_present(smoke_module, tmp_path):
    present_cloudbuild = tmp_path / "cloudbuild.yaml"
    present_cloudbuild.write_text(
        'steps:\n  - args:\n      - --set-env-vars="^|^TOTALLY_FAKE_VAR_ZZZ=1"\n'
    )
    with patch.object(smoke_module, "CLOUDBUILD_PATH", present_cloudbuild):
        result = smoke_module.check_required_env_vars()
    assert result.name == "env-vars"
    assert result.passed is False, (
        "an absence guard must not turn the env-vars check into a no-op: "
        f"{result.details}"
    )
    assert "TOTALLY_FAKE_VAR_ZZZ" in result.details


def test_check_required_env_vars_patched_reader_wins_over_missing_cloudbuild(smoke_module, tmp_path):
    # The absence guard must live inside the cloudbuild READER, not before it:
    # test_check_required_env_vars_fails_when_missing patches the reader and
    # runs in the public export too, where cloudbuild.yaml is gone. A guard that
    # short-circuits before the patched reader turns that test red in the export.
    absent_cloudbuild = tmp_path / "cloudbuild.yaml"
    fake_required = {"DATABASE_URL", "TOTALLY_FAKE_VAR_THAT_DOES_NOT_EXIST"}
    with (
        patch.object(smoke_module, "CLOUDBUILD_PATH", absent_cloudbuild),
        patch.object(smoke_module, "_cloudbuild_env_vars", return_value=fake_required),
    ):
        result = smoke_module.check_required_env_vars()
    assert result.passed is False, result.details
    assert "TOTALLY_FAKE_VAR_THAT_DOES_NOT_EXIST" in result.details
