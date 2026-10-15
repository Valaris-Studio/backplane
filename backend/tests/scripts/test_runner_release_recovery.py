# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
import fnmatch
import importlib.util
from pathlib import Path
import subprocess

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[3]
BASE_CONFIG = "dockers_v2:\n  - id: runner\n    dockerfile: Dockerfile\n    images: [example]\n"
FIXED_CONFIG = BASE_CONFIG.replace("    dockerfile: Dockerfile\n", "    dockerfile: Dockerfile\n    extra_files:\n      - go.mod\n      - go.sum\n      - cmd\n      - internal\n")


def test_normal_runner_release_excludes_recovery_tooling_tags():
    workflow = yaml.load((ROOT / ".github/workflows/release-runner.yml").read_text(), Loader=yaml.BaseLoader)
    def matches(tag):
        selected = False
        for pattern in workflow["on"]["push"]["tags"]:
            if fnmatch.fnmatchcase(tag, pattern.lstrip("!")):
                selected = not pattern.startswith("!")
        return selected
    assert matches("v0.8.8")
    assert matches("v0.9.0-beta.1")
    assert not matches("v0.8.8-recovery.1")
    assert not matches("platform-v0.1.4-preview.2")


@pytest.fixture
def recovery(tmp_path):
    spec = importlib.util.spec_from_file_location("runner_release_recovery", ROOT / "scripts/runner-release-recovery.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    tooling = tmp_path / "tooling"
    tooling.mkdir()
    def git(repo, *args):
        return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()
    git(tooling, "init", "-q", "-b", "main")
    git(tooling, "config", "user.name", "Release Test")
    git(tooling, "config", "user.email", "release@example.invalid")
    (tooling / "runner").mkdir()
    (tooling / "runner/.goreleaser.yaml").write_text(BASE_CONFIG)
    (tooling / "runner/main.go").write_text("package main\n")
    git(tooling, "add", ".")
    git(tooling, "commit", "-qm", "Source")
    source_sha = git(tooling, "rev-parse", "HEAD")
    git(tooling, "tag", "-a", "v0.8.8", "-m", "Source")
    source = tmp_path / "source"
    subprocess.run(["git", "clone", "-q", str(tooling), str(source)], check=True, timeout=10)
    (tooling / "runner/.goreleaser.yaml").write_text(FIXED_CONFIG)
    git(tooling, "commit", "-qam", "Packaging only")
    tooling_sha = git(tooling, "rev-parse", "HEAD")
    git(tooling, "tag", "-a", "v0.8.8-recovery.1", "-m", "Tooling")
    git(tooling, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(source, "update-ref", "refs/remotes/origin/main", "HEAD")
    options = dict(repository="Valaris-Studio/backplane", ref="refs/tags/v0.8.8-recovery.1", tooling_sha=tooling_sha,
                   source_tag="v0.8.8", source_sha=source_sha, tooling_tag="v0.8.8-recovery.1")
    return module, tooling, source, git, options


def test_recovery_preserves_source_and_binds_audited_config(recovery):
    module, tooling, source, git, options = recovery
    before = git(source, "status", "--porcelain")
    receipt = module.prepare(tooling, source, **options)
    assert receipt["source_commit"] == options["source_sha"]
    assert receipt["tooling_commit"] == options["tooling_sha"]
    assert receipt["config"] == str(tooling / "runner/.goreleaser.yaml")
    assert (source / "runner/.goreleaser.yaml").read_text() == BASE_CONFIG
    assert git(source, "status", "--porcelain") == before == ""


@pytest.mark.parametrize("field,value", [("repository", "other/fork"), ("ref", "refs/heads/main"),
    ("tooling_sha", "0" * 40), ("source_sha", "0" * 40), ("source_tag", "v0.8.7")])
def test_recovery_refuses_wrong_identity(recovery, field, value):
    module, tooling, source, _, options = recovery
    options[field] = value
    with pytest.raises(module.RecoveryError):
        module.prepare(tooling, source, **options)


@pytest.mark.parametrize("change", ["runtime", "config", "source_dirty", "tooling_unmerged", "source_unmerged"])
def test_recovery_refuses_unreviewed_inputs(recovery, change):
    module, tooling, source, git, options = recovery
    if change == "source_dirty":
        (source / "runner/main.go").write_text("changed\n")
    elif change.endswith("unmerged"):
        repo = tooling if change == "tooling_unmerged" else source
        git(repo, "checkout", "--orphan", "unrelated")
        git(repo, "commit", "--allow-empty", "-qm", "Unrelated main")
        git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
        git(repo, "checkout", "--detach", options["tooling_sha" if repo == tooling else "source_sha"])
    else:
        path = tooling / ("runner/main.go" if change == "runtime" else "runner/.goreleaser.yaml")
        path.write_text(path.read_text() + "unreviewed change\n")
        git(tooling, "commit", "-qam", "Unreviewed change")
        options["tooling_sha"] = git(tooling, "rev-parse", "HEAD")
        git(tooling, "tag", "-fa", options["tooling_tag"], "-m", "Unreviewed tooling")
        git(tooling, "update-ref", "refs/remotes/origin/main", "HEAD")
    with pytest.raises(module.RecoveryError):
        module.prepare(tooling, source, **options)
