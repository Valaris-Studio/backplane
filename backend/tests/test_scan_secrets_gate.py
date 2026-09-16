# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fail-closed contract for `scripts/scan-secrets.sh` (default worktree mode).

The gate shells out to gitleaks and filters its JSON report down to
git-tracked files. A scanner that crashes, or never writes a report, must
surface as a SCANNER ERROR (exit 2) — never as "no secrets". Otherwise a
broken install silently green-lights the public export.

Exit-code contract:
  0 — scan ran, no findings in tracked files (untracked noise is ignored)
  1 — findings in tracked files
  2 — scanner error: gitleaks exit not in {0, 1}, report missing, empty,
      not JSON, JSON that is not a list, a malformed report entry, or
      `git ls-files` failing (an empty tracked set would filter every
      finding away and read as clean)

Each shim test drives the script with a fake `gitleaks` placed first on
PATH, so the observed exit codes are the script's own, not the scanner's.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

# Ships in the public export, so it must not import the export-only gate helpers.
REPO_ROOT = Path(__file__).resolve().parents[2]

SCAN_SCRIPT = REPO_ROOT / "scripts" / "scan-secrets.sh"

# The tracked-file filter shells out to git; cloudbuild's test-backend step
# runs in python:3.12-slim, which has no git, so the cases that reach the
# filter skip there and `test_git_absent_from_path_is_error_not_clean` covers
# that environment instead.
requires_git = pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
# Everything the script needs besides git and gitleaks, for a PATH without git.
SCRIPT_RUNTIME_BINARIES = ("bash", "python3", "dirname", "sed", "mktemp", "rm", "cat")
CLEAN_MESSAGE = "no secrets in git-tracked files"
FINDINGS_MESSAGE = "secrets found in git-tracked files"
SHIM_STDERR = "synthetic scanner failure"
SCANNER_ERROR_EXIT = 2

# Both keys the gate prints must be present alongside the tracked-file filter key.
TRACKED_FINDING = {"File": "README.md", "StartLine": 1, "RuleID": "shim-rule"}
UNTRACKED_FINDING = {"File": "definitely-not-tracked-zzz.txt", "StartLine": 1, "RuleID": "shim-rule"}


@dataclass(frozen=True)
class ScanRun:
    returncode: int
    stdout: str
    stderr: str

    @property
    def output(self) -> str:
        return self.stdout + self.stderr


def make_gitleaks_shim(tmp_path: Path, *, exit_code: int, report_body: str | None) -> Path:
    """Write a fake `gitleaks` into a fresh dir and return that dir for PATH prepending.

    `version` answers `shim` with exit 0 (the script probes it first). Any other
    invocation writes `report_body` to the `--report-path` argument (nothing at
    all when None, mirroring a real config/parse crash), prints a marker on
    stderr and exits `exit_code`.
    """
    shim_dir = tmp_path / "shim-bin"
    shim_dir.mkdir()
    report_file = shim_dir / "report-body"
    write_report = ""
    if report_body is not None:
        report_file.write_text(report_body)
        write_report = f'[ -n "$report_path" ] && cat "{report_file}" > "$report_path"\n'
    shim = shim_dir / "gitleaks"
    shim.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "version" ]; then echo shim; exit 0; fi\n'
        'report_path=""\n'
        'while [ $# -gt 0 ]; do\n'
        '  if [ "$1" = "--report-path" ]; then report_path="$2"; shift; fi\n'
        "  shift\n"
        "done\n"
        f"{write_report}"
        f'echo "{SHIM_STDERR}" >&2\n'
        f"exit {exit_code}\n"
    )
    shim.chmod(shim.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return shim_dir


# A real scan of this checkout takes ~35 s on a warm laptop; give it headroom
# on a loaded machine while staying under the test's own 180 s timeout.
REAL_SCAN_TIMEOUT_SECONDS = 170


def _run_scan(
    cwd: Path = REPO_ROOT, shim_dir: Path | None = None, timeout: int = 60
) -> ScanRun:
    env = dict(os.environ)
    if shim_dir is not None:
        env["PATH"] = f"{shim_dir}:{os.environ['PATH']}"
    proc = subprocess.run(
        ["bash", "scripts/scan-secrets.sh"],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )
    return ScanRun(proc.returncode, proc.stdout, proc.stderr)


def _assert_scanner_error(run: ScanRun, reason: str) -> None:
    assert run.returncode == SCANNER_ERROR_EXIT, f"rc={run.returncode}\n{run.output}"
    assert "no secrets" not in run.output, f"a broken scanner was reported clean:\n{run.output}"
    # Each guard names its reason so removing one guard is observable here.
    assert reason in run.output, f"expected reason {reason!r} in:\n{run.output}"


# --- scanner-error paths must fail closed ----------------------------------


def test_scanner_crash_without_report_is_not_clean(tmp_path: Path):
    shim = make_gitleaks_shim(tmp_path, exit_code=2, report_body=None)
    run = _run_scan(shim_dir=shim)
    _assert_scanner_error(run, "gitleaks exited 2")
    assert SHIM_STDERR in run.output, f"gitleaks stderr did not surface:\n{run.output}"


def test_scanner_exit1_without_report_is_error_not_findings(tmp_path: Path):
    # Real gitleaks 8.30.1 exits 1 and writes NO report on a config/parse error,
    # the same exit code it uses for findings; only the report tells them apart.
    shim = make_gitleaks_shim(tmp_path, exit_code=1, report_body=None)
    _assert_scanner_error(_run_scan(shim_dir=shim), "report missing or empty")


def test_empty_report_is_error(tmp_path: Path):
    shim = make_gitleaks_shim(tmp_path, exit_code=0, report_body="")
    _assert_scanner_error(_run_scan(shim_dir=shim), "report missing or empty")


def test_invalid_json_report_is_error(tmp_path: Path):
    shim = make_gitleaks_shim(tmp_path, exit_code=0, report_body="not json")
    _assert_scanner_error(_run_scan(shim_dir=shim), "report is not a JSON list")


def test_non_list_json_report_is_error(tmp_path: Path):
    shim = make_gitleaks_shim(tmp_path, exit_code=0, report_body='{"a":1}')
    _assert_scanner_error(_run_scan(shim_dir=shim), "report is not a JSON list")


@requires_git
def test_malformed_report_entry_is_error(tmp_path: Path):
    # A list whose entries lack the keys the filter reads must not become a
    # bare traceback with an ambiguous exit code.
    shim = make_gitleaks_shim(tmp_path, exit_code=1, report_body='[{"Secret": "REDACTED"}]')
    run = _run_scan(shim_dir=shim)
    _assert_scanner_error(run, "report entry malformed")
    assert "Traceback" not in run.output


@requires_git
def test_git_ls_files_failure_is_error_not_clean(tmp_path: Path):
    # Outside a git repository `git ls-files` fails, the tracked set would be
    # empty, and every finding would be filtered away — a false clean.
    tree = tmp_path / "not-a-repo"
    (tree / "scripts").mkdir(parents=True)
    shutil.copy(SCAN_SCRIPT, tree / "scripts" / "scan-secrets.sh")
    shutil.copy(REPO_ROOT / ".gitleaks.toml", tree / ".gitleaks.toml")
    shim = make_gitleaks_shim(tmp_path, exit_code=1, report_body=json.dumps([TRACKED_FINDING]))
    _assert_scanner_error(_run_scan(cwd=tree, shim_dir=shim), "git ls-files failed")


def test_git_absent_from_path_is_error_not_clean(tmp_path: Path):
    # A container without git (cloudbuild's python:3.12-slim) must get the same
    # named refusal as a failing `git ls-files`, not a bare traceback.
    runtime_bin = tmp_path / "runtime-bin"
    runtime_bin.mkdir()
    for binary in SCRIPT_RUNTIME_BINARIES:
        found = shutil.which(binary)
        if found is None:
            pytest.skip(f"{binary} is not installed")
        (runtime_bin / binary).symlink_to(found)
    shim = make_gitleaks_shim(tmp_path, exit_code=1, report_body=json.dumps([TRACKED_FINDING]))
    env = {**os.environ, "PATH": f"{shim}:{runtime_bin}"}
    proc = subprocess.run(
        ["bash", "scripts/scan-secrets.sh"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    run = ScanRun(proc.returncode, proc.stdout, proc.stderr)
    _assert_scanner_error(run, "git ls-files failed")
    assert "Traceback" not in run.output


# --- existing behaviour that must survive the fix --------------------------


@requires_git
def test_clean_report_passes(tmp_path: Path):
    shim = make_gitleaks_shim(tmp_path, exit_code=0, report_body="[]")
    run = _run_scan(shim_dir=shim)
    assert run.returncode == 0, f"rc={run.returncode}\n{run.output}"
    assert CLEAN_MESSAGE in run.stdout


@requires_git
def test_tracked_finding_fails_with_exit_1(tmp_path: Path):
    shim = make_gitleaks_shim(tmp_path, exit_code=1, report_body=json.dumps([TRACKED_FINDING]))
    run = _run_scan(shim_dir=shim)
    assert run.returncode == 1, f"rc={run.returncode}\n{run.output}"
    assert FINDINGS_MESSAGE in run.stdout
    assert "README.md:1: shim-rule" in run.stdout


@requires_git
def test_untracked_finding_is_ignored(tmp_path: Path):
    shim = make_gitleaks_shim(tmp_path, exit_code=1, report_body=json.dumps([UNTRACKED_FINDING]))
    run = _run_scan(shim_dir=shim)
    assert run.returncode == 0, f"rc={run.returncode}\n{run.output}"
    assert CLEAN_MESSAGE in run.stdout


# --- real-tool check -------------------------------------------------------


@pytest.mark.slow
@pytest.mark.timeout(180)
@pytest.mark.skipif(shutil.which("gitleaks") is None, reason="gitleaks is not installed")
def test_real_gitleaks_scan_of_head_is_clean():
    run = _run_scan(timeout=REAL_SCAN_TIMEOUT_SECONDS)
    assert run.returncode == 0, f"rc={run.returncode}\n{run.output}"
    assert CLEAN_MESSAGE in run.stdout
