# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import re
import shlex
from fnmatch import fnmatchcase
from pathlib import Path

import pytest
import yaml

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"


def test_companion_packaging_gate_includes_module_identity_contract():
    script = (WORKFLOWS.parents[1] / "scripts" / "companion-source-gate.sh").read_text()
    packaging = script.split("check_packaging() (", 1)[1].split("\n)", 1)[0]
    command = next(line for line in packaging.replace("\\\n", "").splitlines() if "-m unittest" in line)
    arguments = shlex.split(command, comments=True)
    modules = arguments[arguments.index("unittest") + 1 :]
    assert modules.count("test_module_identity") == 1


@pytest.mark.parametrize("filename", ["ci.yml", "quickstart-gate.yml"])
def test_required_checks_run_on_eligible_promotion_and_contributor_events(filename):
    # Manual dispatch reports green jobs but cannot satisfy branch protection.
    workflow = yaml.load((WORKFLOWS / filename).read_text(), Loader=yaml.BaseLoader)
    events = workflow["on"]
    assert "pull_request" in events
    assert not events["pull_request"], "required PR checks must not use path filters"
    branches = events["push"]["branches"]
    for branch in ("main", "codex/preview-security-ci"):
        assert any(fnmatchcase(branch, pattern) for pattern in branches)
    assert workflow["permissions"] == {"contents": "read"}


def test_frontend_release_gate_handles_the_zero_before_sha_on_new_tags():
    workflow = yaml.load((WORKFLOWS / "ci.yml").read_text(), Loader=yaml.BaseLoader)
    test_step = next(step for step in workflow["jobs"]["frontend"]["steps"] if step.get("name") == "Tests")
    expression = test_step["env"]["I18N_COPY_BASE_SHA"]
    assert "github.event.before != '" + "0" * 40 + "'" in expression
    assert "|| 'HEAD^'" in expression


PUBLIC_REPOSITORY_GUARD = "github.repository == 'Valaris-Studio/backplane'"
WORKFLOW_FILES = sorted([*WORKFLOWS.glob("*.yml"), *WORKFLOWS.glob("*.yaml")])


@pytest.mark.parametrize("workflow_file", WORKFLOW_FILES, ids=lambda path: path.name)
def test_job_environment_does_not_reference_runner_context(workflow_file):
    # GitHub resolves job env before assigning a runner; step env may use it.
    workflow = yaml.load(workflow_file.read_text(), Loader=yaml.BaseLoader)
    invalid = [
        f"{job_id}.env.{name}"
        for job_id, job in workflow["jobs"].items()
        for name, value in job.get("env", {}).items()
        if re.search(r"\$\{\{[^}]*\brunner\s*[.\[]", value, re.IGNORECASE)
    ]
    assert not invalid, f"{workflow_file.name}: runner context is unavailable in job env: {invalid}"


def test_companion_go_report_directory_matches_retained_artifacts():
    workflow = yaml.load((WORKFLOWS / "ci.yml").read_text(), Loader=yaml.BaseLoader)
    steps = workflow["jobs"]["companion"]["steps"]
    go_step = next(step for step in steps if step.get("run") == "./scripts/companion-source-gate.sh go")
    report_parent = go_step.get("env", {}).get("COMPANION_GATE_REPORT_DIR")
    assert report_parent == "${{ runner.temp }}"
    upload = next(step for step in steps if step.get("uses", "").startswith("actions/upload-artifact@"))
    assert upload["with"]["path"] == f"{report_parent}/companion-go.*/*"
    assert upload["if"] == "always()"
    assert upload["with"]["if-no-files-found"] == "error"
    assert upload["with"]["retention-days"] == "14"


def _is_public_repository_guarded(condition: str) -> bool:
    # A top-level `||` could make the guard vacuous, so extra conditions may
    # only be AND-ed onto it.
    if condition == PUBLIC_REPOSITORY_GUARD:
        return True
    extra = condition.removeprefix(PUBLIC_REPOSITORY_GUARD + " && ")
    return extra != condition and "||" not in extra


def test_workflow_inventory_is_not_empty():
    assert len(WORKFLOW_FILES) >= 5


@pytest.mark.parametrize("workflow_file", WORKFLOW_FILES, ids=lambda path: path.name)
def test_every_job_runs_only_in_the_public_repository(workflow_file):
    # Owner rule: Actions never run on the private source repo. A job-level
    # `if:` (not a removed job) keeps the public repo's required-check names:
    # a skipped job reports a passing conclusion, an absent one stays pending.
    workflow = yaml.load(workflow_file.read_text(), Loader=yaml.BaseLoader)
    unguarded = [
        job_id
        for job_id, job in workflow["jobs"].items()
        if not _is_public_repository_guarded(job.get("if", "").strip())
    ]
    assert not unguarded, f"{workflow_file.name}: jobs without the public-repository guard: {unguarded}"
