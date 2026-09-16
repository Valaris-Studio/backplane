# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""CI must install from `mcp-server/uv.lock`, so the lock cannot rot while CI stays green.

Audit T05 (card 4c2f238c): every CI leg installed by pyproject RANGES
(`pip install -e ".[dev]"`) while the shipped lock pinned a stale, advisory-laden
resolution (mcp 1.26.0 vs 1.29.1 everywhere else; 47 advisories across 13
packages). Only `make mcp-test` / `make mcp-dev` (`uv run`) used the lock, so
nothing automated ever exercised what the lock installs.

Policy pinned here:
  1. The lock resolves every audit-named package at or above its fix floor.
  2. The lock is consistent with pyproject (`uv lock --check`).
  3. Every CI leg installs via `uv sync --frozen|--locked --extra dev` and runs
     tests via `uv run`; the GitHub CI job also pip-audits the frozen export.
  4. The Makefile targets keep going through `uv run`.

The `build`/`publish` jobs of the publish workflow are deliberately NOT
asserted on: PyPI consumers install the wheel by ranges, that is inherent.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import time
import tomllib
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MCP_SERVER_DIR = REPO_ROOT / "mcp-server"
UV_LOCK = MCP_SERVER_DIR / "uv.lock"
CI_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "ci.yml"
PUBLISH_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "publish-mcp-server.yml"
CLOUDBUILD = REPO_ROOT / "cloudbuild.yaml"  # export-gated
MAKEFILE = REPO_ROOT / "Makefile"

# Lowest version that closes every advisory pip-audit reported on the HEAD lock.
ADVISORY_FIX_FLOORS: dict[str, str] = {
    "mcp": "1.28.1",
    "click": "8.3.3",
    "cryptography": "46.0.7",
    "idna": "3.15",
    "pyasn1": "0.6.4",
    "pydantic-settings": "2.14.2",
    "pygments": "2.20.0",
    "pyjwt": "2.13.0",
    "pytest": "9.0.3",
    "python-multipart": "0.0.26",
    "requests": "2.33.0",
    "starlette": "1.0.1",
    "urllib3": "2.7.0",
}

# `uv sync --frozen` and `--locked` both refuse to re-resolve; either is acceptable.
# The flag ORDER is pinned on purpose: one spelling across every surface keeps
# the three install lines greppable and diffable against each other.
UV_SYNC_LOCKED = re.compile(r"uv sync --(?:frozen|locked) --extra dev\b")
UV_RUN_TESTS = re.compile(r"uv run (?:python -m )?pytest\b")
PIP_INSTALL_EDITABLE = "pip install -e"


def _parse_version(raw: str):
    try:
        from packaging.version import Version

        return Version(raw)
    except ImportError:  # pragma: no cover - packaging is present in the mcp venv
        return tuple(int(part) for part in re.findall(r"\d+", raw))


def _locked_versions() -> dict[str, str]:
    lock = tomllib.loads(UV_LOCK.read_text(encoding="utf-8"))
    return {pkg["name"]: pkg["version"] for pkg in lock["package"]}


def _block(text: str, header: str, next_header_pattern: str) -> str:
    """Slice `text` from `header` up to the next line matching `next_header_pattern`."""
    start = text.index(header)
    tail = text[start + len(header):]
    match = re.search(next_header_pattern, tail, flags=re.MULTILINE)
    return text[start:start + len(header) + (match.start() if match else len(tail))]


def _workflow_job_block(workflow: Path, job_name: str) -> str:
    # A job header is exactly two-space indented; the next such header ends the block.
    return _block(workflow.read_text(encoding="utf-8"), f"\n  {job_name}:\n", r"^  [A-Za-z0-9_-]+:\n")


def _cloudbuild_step_block(step_id: str) -> str:
    return _block(CLOUDBUILD.read_text(encoding="utf-8"), f"  - id: {step_id}\n", r"^  - id: ")


def _makefile_target_block(target: str) -> str:
    return _block(MAKEFILE.read_text(encoding="utf-8"), f"\n{target}:\n", r"^[A-Za-z0-9_-]+:")


def _assert_installs_from_lock(block: str, label: str) -> None:
    assert PIP_INSTALL_EDITABLE not in block, f"{label} still installs by ranges: `{PIP_INSTALL_EDITABLE}`"
    assert UV_SYNC_LOCKED.search(block), f"{label} must `uv sync --frozen --extra dev` (or --locked)"
    assert UV_RUN_TESTS.search(block), f"{label} must run pytest through `uv run`"


# --- 1. lock resolution ------------------------------------------------------


@pytest.mark.parametrize("package", sorted(ADVISORY_FIX_FLOORS))
def test_lock_resolves_package_at_or_above_advisory_fix_floor(package: str) -> None:
    locked = _locked_versions()
    if package not in locked:
        pytest.skip(f"{package} is not in uv.lock; nothing to audit")
    floor = ADVISORY_FIX_FLOORS[package]
    assert _parse_version(locked[package]) >= _parse_version(floor), (
        f"uv.lock pins {package}=={locked[package]}, advisories fixed in {floor}"
    )


def test_lock_resolves_mcp_below_2() -> None:
    locked = _locked_versions()
    assert _parse_version(locked["mcp"]) < _parse_version("2"), (
        "mcp 2.0 removed mcp.server.fastmcp; the lock must stay on 1.x"
    )


# --- 2. lock consistency -----------------------------------------------------


def test_lock_is_consistent_with_pyproject() -> None:
    if shutil.which("uv") is None:
        pytest.skip("uv not on PATH")
    started = time.monotonic()
    result = subprocess.run(
        ["uv", "lock", "--check"],
        cwd=MCP_SERVER_DIR,
        capture_output=True,
        text=True,
        timeout=120,
    )
    elapsed = time.monotonic() - started
    assert result.returncode == 0, (
        f"`uv lock --check` failed after {elapsed:.1f}s:\n{result.stdout}\n{result.stderr}"
    )


# --- 3. install policy per CI leg --------------------------------------------


def test_github_ci_mcp_job_installs_from_lock() -> None:
    block = _workflow_job_block(CI_WORKFLOW, "mcp-server")
    assert "astral-sh/setup-uv" in block, "ci.yml mcp-server job must install uv via astral-sh/setup-uv"
    _assert_installs_from_lock(block, "ci.yml mcp-server job")


def _assert_audits_frozen_export(block: str, label: str) -> None:
    # The audit must read the FROZEN export (what the lock installs) and be
    # strict about pins it cannot resolve; a bare `pip-audit` audits nothing.
    assert "uv export --frozen" in block, f"{label} must export the frozen lock for the audit"
    assert "pip-audit --strict --no-deps -r" in block, f"{label} must run pip-audit strictly on the export"


def test_github_ci_mcp_job_audits_frozen_export() -> None:
    _assert_audits_frozen_export(_workflow_job_block(CI_WORKFLOW, "mcp-server"), "ci.yml mcp-server job")


def test_publish_workflow_test_job_audits_frozen_export() -> None:
    # The release gate must not publish a lock resolution CI would have flagged.
    _assert_audits_frozen_export(_workflow_job_block(PUBLISH_WORKFLOW, "test"), "publish test job")


def test_publish_workflow_test_job_installs_from_lock() -> None:
    block = _workflow_job_block(PUBLISH_WORKFLOW, "test")
    assert "astral-sh/setup-uv" in block, "publish test job must install uv via astral-sh/setup-uv"
    _assert_installs_from_lock(block, "publish-mcp-server.yml test job")


def test_cloudbuild_test_mcp_step_installs_from_lock() -> None:
    if not CLOUDBUILD.exists():
        pytest.skip("cloudbuild.yaml is stripped from the public export")  # export-gated
    block = _cloudbuild_step_block("test-mcp")
    _assert_installs_from_lock(block, "cloudbuild.yaml test-mcp step")  # export-gated


# --- 4. Makefile pin ---------------------------------------------------------


def test_makefile_mcp_test_target_uses_uv_run() -> None:
    block = _makefile_target_block("mcp-test")
    assert "uv run" in block
    assert PIP_INSTALL_EDITABLE not in block


def test_makefile_mcp_install_target_syncs_the_frozen_lock() -> None:
    # A fresh local venv must be the locked resolution too; ranges here would
    # give developers a different mcp than CI and the export test.
    block = _makefile_target_block("mcp-install")
    assert "uv sync --frozen --extra dev" in block
    # The by-ranges pip path may run only when uv is ABSENT, never when a
    # frozen sync merely fails (offline, unbuildable wheel): that would hand a
    # developer a venv that differs from CI without saying so.
    assert "command -v uv" in block
    assert "uv sync --frozen --extra dev 2>/dev/null" not in block, "a failing frozen sync must be loud"
