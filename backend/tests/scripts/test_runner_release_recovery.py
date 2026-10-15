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
    assert not matches("v-recovery-runner-20261015")
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
    git(source, "config", "user.name", "Release Test")
    git(source, "config", "user.email", "release@example.invalid")
    (tooling / "runner/.goreleaser.yaml").write_text(FIXED_CONFIG)
    git(tooling, "commit", "-qam", "Packaging only")
    tooling_sha = git(tooling, "rev-parse", "HEAD")
    git(tooling, "tag", "-a", "v-recovery-runner-20261015", "-m", "Tooling")
    git(tooling, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(source, "update-ref", "refs/remotes/origin/main", "HEAD")
    options = dict(repository="Valaris-Studio/backplane", ref="refs/tags/v-recovery-runner-20261015", tooling_sha=tooling_sha,
                   source_tag="v0.8.8", source_sha=source_sha, tooling_tag="v-recovery-runner-20261015")
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


@pytest.mark.parametrize("release_status,image_status,expected", [(404, 404, True), (200, 404, False),
    (404, 200, False), (403, 404, False), (404, 403, False), (500, 404, False)])
def test_recovery_publication_requires_authenticated_absence(recovery, monkeypatch, release_status, image_status, expected):
    import io
    import json
    import urllib.error
    module, _, _, _, _ = recovery
    requests = []
    def respond(request, timeout):
        requests.append(request)
        assert timeout == 30
        if request.full_url.startswith("https://api.github.com/"):
            status, data = release_status, {"id": 123}
            assert request.get_header("Authorization") == "Bearer synthetic-token"
        elif request.full_url.startswith("https://ghcr.io/token?"):
            status, data = 200, {"token": "synthetic-registry-token"}
            assert request.get_header("Authorization").startswith("Basic ")
        else:
            assert request.full_url.endswith("/manifests/0.8.8")
            assert request.get_header("Authorization") == "Bearer synthetic-registry-token"
            status, data = image_status, {"schemaVersion": 2}
        if status != 200:
            raise urllib.error.HTTPError(request.full_url, status, "synthetic response", {}, None)
        return io.BytesIO(json.dumps(data).encode())
    monkeypatch.setattr(module.urllib.request, "urlopen", respond)
    if expected:
        assert module.require_unpublished("synthetic-user", "synthetic-token") == {
            "github_release": "absent", "versioned_container": "absent"}
        assert len(requests) == 3
    else:
        with pytest.raises(module.RecoveryError):
            module.require_unpublished("synthetic-user", "synthetic-token")
        assert len(requests) == (1 if release_status != 404 else 3)


def test_recovery_dispatch_has_fixed_source_and_normal_protection():
    workflow = yaml.load((ROOT / ".github/workflows/recover-runner.yml").read_text(), Loader=yaml.BaseLoader)
    assert set(workflow["on"]) == {"workflow_dispatch"}
    assert not workflow["on"]["workflow_dispatch"]
    assert workflow["permissions"] == {"contents": "read"}
    assert "refs/tags/v-recovery-runner-20261015" in workflow["jobs"]["validate"]["if"]
    job = workflow["jobs"]["recover"]
    assert job["environment"] == "runner-release"
    assert job["needs"] == ["validate", "qualify"]
    assert "vars.PUBLIC_RELEASES_ENABLED == 'true'" in job["if"]
    checkouts = [step for step in job["steps"] if step.get("uses") == "actions/checkout@v4"]
    assert checkouts[1]["with"]["ref"] == "82375d7e62d7f4e31e7e3258cdba2b08f67dce39"
    preflight = next(i for i, step in enumerate(job["steps"]) if "--check-publication" in step.get("run", ""))
    publish = next(i for i, step in enumerate(job["steps"]) if step.get("uses") == "goreleaser/goreleaser-action@v6")
    assert preflight < publish
    assert job["steps"][publish]["env"]["GORELEASER_CURRENT_TAG"] == "v0.8.8"
    assert "--skip" not in job["steps"][publish]["with"]["args"]
    assert "--config ../../release-tooling/runner/.goreleaser.yaml" in job["steps"][publish]["with"]["args"]
