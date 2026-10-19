# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import os
import re
import shlex
import subprocess
from dataclasses import dataclass
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


def _frontend_copy_baseline_preflight() -> list[tuple[str, str]]:
    workflow = yaml.load((WORKFLOWS / "ci.yml").read_text(), Loader=yaml.BaseLoader)
    steps = workflow["jobs"]["frontend"]["steps"]
    test_index = next(index for index, step in enumerate(steps) if step.get("name") == "Tests")
    test_step = steps[test_index]
    expression = test_step["env"]["I18N_COPY_BASE_SHA"]
    scripts = []
    for step in steps[:test_index]:
        if "I18N_COPY_BASE_SHA" in step.get("env", {}):
            assert step["env"]["I18N_COPY_BASE_SHA"] == expression
            scripts.append((step.get("working-directory", "."), step["run"]))

    # Run only the workflow's preflight, never pnpm or the frontend test suite.
    # An absent preflight remains a no-op so the regression reaches real Git.
    test_lines = test_step["run"].splitlines()
    suite_lines = [index for index, line in enumerate(test_lines) if line.strip() == "pnpm vitest run"]
    assert len(suite_lines) == 1
    scripts.append((test_step.get("working-directory", "."), "\n".join(test_lines[:suite_lines[0]])))
    return scripts


def _git_environment() -> dict[str, str]:
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment.update({
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_ALLOW_PROTOCOL": "file",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_AUTHOR_NAME": "Baseline fixture",
        "GIT_AUTHOR_EMAIL": "baseline@example.invalid",
        "GIT_COMMITTER_NAME": "Baseline fixture",
        "GIT_COMMITTER_EMAIL": "baseline@example.invalid",
        "BASH_ENV": os.devnull,
        "LC_ALL": "C",
    })
    return environment


def _git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args], cwd=cwd, env=_git_environment(), text=True,
        capture_output=True, check=check,
    )


@dataclass(frozen=True)
class RewrittenPushCheckout:
    path: Path
    remote: Path
    before: str
    parent: str


@pytest.fixture
def rewritten_push_checkout(tmp_path: Path) -> RewrittenPushCheckout:
    remote = tmp_path / "origin.git"
    seed = tmp_path / "seed"
    checkout = tmp_path / "checkout"
    branch = "codex/preview-baseline"
    _git(tmp_path, "init", "--bare", "--template=", str(remote))
    # This fixture permits an exact unadvertised-object fetch. It does not
    # assert that a hosted origin retains or permits fetching every old SHA.
    _git(remote, "config", "uploadpack.allowAnySHA1InWant", "true")
    _git(tmp_path, "init", "--template=", "-b", branch, str(seed))
    (seed / "frontend").mkdir()
    (seed / "frontend" / "fixture.txt").write_text("parent\n")
    _git(seed, "add", ".")
    _git(seed, "commit", "-qm", "Parent")
    parent = _git(seed, "rev-parse", "HEAD").stdout.strip()
    (seed / "frontend" / "fixture.txt").write_text("unchanged exported bytes\n")
    _git(seed, "commit", "-qam", "Original public identity")
    before = _git(seed, "rev-parse", "HEAD").stdout.strip()
    tree = _git(seed, "rev-parse", "HEAD^{tree}").stdout.strip()
    _git(seed, "remote", "add", "origin", remote.as_uri())
    _git(seed, "push", "origin", f"HEAD:refs/heads/{branch}")
    rewritten = _git(seed, "commit-tree", tree, "-p", parent, "-m", "Sanitized public identity").stdout.strip()
    _git(seed, "push", "--force", "origin", f"{rewritten}:refs/heads/{branch}")

    # A local clone optimization would copy unreachable objects and conceal
    # the full-fetch/current-refs failure reproduced here.
    _git(tmp_path, "clone", "--no-local", "--branch", branch, remote.as_uri(), str(checkout))
    assert _git(remote, "cat-file", "-e", f"{before}^{{commit}}").returncode == 0
    assert _git(remote, "for-each-ref", f"--contains={before}").stdout == ""
    assert _git(checkout, "rev-parse", "HEAD").stdout.strip() == rewritten
    assert _git(checkout, "rev-parse", "HEAD^{tree}").stdout.strip() == tree
    assert _git(checkout, "rev-parse", "--is-shallow-repository").stdout.strip() == "false"
    assert _git(checkout, "cat-file", "-e", f"{before}^{{commit}}", check=False).returncode != 0
    return RewrittenPushCheckout(checkout, remote, before, parent)


def _checkout_identity(checkout: Path) -> tuple[str, ...]:
    return tuple(_git(checkout, *args).stdout for args in (
        ("rev-parse", "HEAD", "HEAD^{tree}"),
        ("for-each-ref", "--format=%(refname) %(objectname)"),
        ("log", "--all", "--format=%H %P"),
        ("status", "--porcelain"),
    ))


def _run_copy_baseline_preflight(
    checkout: Path, selected_base: str, trace: Path,
) -> subprocess.CompletedProcess[str]:
    environment = _git_environment() | {
        "I18N_COPY_BASE_SHA": selected_base,
        "GIT_TRACE2_EVENT": str(trace),
    }
    for directory, script in _frontend_copy_baseline_preflight():
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script or ":"],
            cwd=checkout / directory, env=environment, text=True,
            capture_output=True, check=False,
        )
        if result.returncode != 0:
            return result
    return result


def _fetch_commands(trace: Path) -> list[list[str]]:
    events = [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
    return [event["argv"] for event in events if event.get("event") == "start" and "fetch" in event["argv"]]


def test_frontend_copy_baseline_preserves_pr_push_and_zero_before_selection():
    workflow = yaml.load((WORKFLOWS / "ci.yml").read_text(), Loader=yaml.BaseLoader)
    steps = workflow["jobs"]["frontend"]["steps"]
    test_step = next(step for step in steps if step.get("name") == "Tests")
    expression = " ".join(test_step["env"]["I18N_COPY_BASE_SHA"].split())
    assert expression == (
        "${{ github.event.pull_request.base.sha || "
        "(github.event.before != '" + "0" * 40 + "' && github.event.before) || 'HEAD^' }}"
    )
    _frontend_copy_baseline_preflight()


def test_frontend_preflight_fetches_exact_before_removed_from_advertised_history(
    rewritten_push_checkout: RewrittenPushCheckout, tmp_path: Path,
):
    checkout = rewritten_push_checkout
    original_identity = _checkout_identity(checkout.path)
    trace = tmp_path / "workflow-preflight-trace.jsonl"
    result = _run_copy_baseline_preflight(checkout.path, checkout.before, trace)

    assert result.returncode == 0, result.stdout + result.stderr
    resolved = _git(checkout.path, "rev-parse", "--verify", f"{checkout.before}^{{commit}}", check=False)
    assert resolved.returncode == 0, (
        "The actual workflow preflight left its selected before commit unavailable "
        "after a full clone of rewritten current refs.\n" + resolved.stderr
    )
    assert resolved.stdout.strip() == checkout.before
    assert any(checkout.before in command for command in _fetch_commands(trace))
    assert _checkout_identity(checkout.path) == original_identity


@pytest.mark.parametrize("selected_base", ["parent_sha", "HEAD^"])
def test_frontend_preflight_keeps_existing_base_without_fetch(
    rewritten_push_checkout: RewrittenPushCheckout, tmp_path: Path, selected_base: str,
):
    checkout = rewritten_push_checkout
    selected = checkout.parent if selected_base == "parent_sha" else selected_base
    original_identity = _checkout_identity(checkout.path)
    trace = tmp_path / "workflow-preflight-trace.jsonl"
    result = _run_copy_baseline_preflight(checkout.path, selected, trace)

    assert result.returncode == 0, result.stdout + result.stderr
    assert _git(checkout.path, "rev-parse", "--verify", f"{selected}^{{commit}}").stdout.strip() == checkout.parent
    assert _fetch_commands(trace) == []
    assert _checkout_identity(checkout.path) == original_identity


def test_frontend_preflight_fails_closed_when_selected_base_is_unavailable(
    rewritten_push_checkout: RewrittenPushCheckout, tmp_path: Path,
):
    checkout = rewritten_push_checkout
    unavailable = "f" * 40
    assert _git(checkout.remote, "cat-file", "-e", f"{unavailable}^{{commit}}", check=False).returncode != 0
    original_identity = _checkout_identity(checkout.path)
    trace = tmp_path / "workflow-preflight-trace.jsonl"
    result = _run_copy_baseline_preflight(checkout.path, unavailable, trace)

    assert result.returncode != 0, "An unavailable selected baseline must stop before frontend tests."
    assert _git(checkout.path, "rev-parse", "--verify", f"{unavailable}^{{commit}}", check=False).returncode != 0
    assert _checkout_identity(checkout.path) == original_identity
