# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tarfile

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def release(tmp_path):
    spec = importlib.util.spec_from_file_location("platform_release", ROOT / "scripts/platform-release.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    repo = tmp_path / "repo"
    repo.mkdir()
    def git(*args):
        return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()
    git("init", "-q", "-b", "main")
    git("config", "user.name", "Public Test")
    git("config", "user.email", "public@example.invalid")
    files = {"VERSION": "0.1.1-preview.1\n", "README.md": "Install instructions\n",
             "mcp-server/pyproject.toml": '[project]\nversion = "0.8.0"\n',
             "frontend/package.json": '{"version":"0.1.0"}',
             "backend/app/__init__.py": '__version__ = "0.1.0"\n'}
    for name, value in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
    git("add", ".")
    git("commit", "-qm", "Public source")
    return module, repo, git


def test_reproducible_bundle_records_public_source_and_checksums(release, tmp_path):
    module, repo, git = release
    (repo / "untracked-secret").write_text("do not ship")
    first = module.package(repo, tmp_path / "one", "platform-v0.1.1-preview.1")
    second = module.package(repo, tmp_path / "two", "platform-v0.1.1-preview.1")
    assert first == second
    assert first["source_commit"] == git("rev-parse", "HEAD")
    assert first["version"] == "0.1.1-preview.1"
    for artifact in first["artifacts"]:
        a = (tmp_path / "one" / artifact["name"]).read_bytes()
        assert a == (tmp_path / "two" / artifact["name"]).read_bytes()
        assert hashlib.sha256(a).hexdigest() == artifact["sha256"]
    with tarfile.open(tmp_path / "one" / first["artifacts"][0]["name"]) as archive:
        names = archive.getnames()
        assert not any("untracked-secret" in name or "/.git/" in name for name in names)
        assert any(name.endswith("/README.md") for name in names)
    assert json.loads((tmp_path / "one/release.json").read_text()) == first


@pytest.mark.parametrize("tag", ["v0.1.1", "platform-v9.9.9", "platform-v../escape"])
def test_wrong_tag_cannot_create_bundle(release, tmp_path, tag):
    module, repo, _ = release
    with pytest.raises(module.ReleaseError, match="tag"):
        module.package(repo, tmp_path / "out", tag)
    assert not (tmp_path / "out").exists()


def test_changed_tracked_files_cannot_be_packaged(release, tmp_path):
    module, repo, _ = release
    (repo / "README.md").write_text("uncommitted")
    with pytest.raises(module.ReleaseError, match="clean"):
        module.package(repo, tmp_path / "out", "platform-v0.1.1-preview.1")


def test_private_checkout_cannot_be_packaged(release, tmp_path):
    module, repo, git = release
    (repo / "scripts").mkdir()
    (repo / "scripts" / "export-public-snapshot.sh").write_text("private tooling")
    git("add", ".")
    git("commit", "-qm", "Private tree")
    with pytest.raises(module.ReleaseError, match="public"):
        module.package(repo, tmp_path / "out", "platform-v0.1.1-preview.1")


def test_existing_bundle_is_never_overwritten(release, tmp_path):
    module, repo, _ = release
    output = tmp_path / "out"
    output.mkdir()
    with pytest.raises(module.ReleaseError, match="exists"):
        module.package(repo, output, "platform-v0.1.1-preview.1")


@pytest.mark.parametrize("component,tag", [("platform", "platform-v0.1.1-preview.1"),
                                          ("mcp", "mcp-server-v0.8.0"), ("runner", "v0.8.4")])
def test_release_requires_exact_tag_on_public_main(release, component, tag):
    module, repo, git = release
    git("update-ref", "refs/remotes/origin/main", "HEAD")
    git("tag", tag)
    module.check_ref(repo, component, "Valaris-Studio/backplane", f"refs/tags/{tag}")
    with pytest.raises(module.ReleaseError, match="repository"):
        module.check_ref(repo, component, "someone/fork", f"refs/tags/{tag}")
    with pytest.raises(module.ReleaseError, match="tag"):
        module.check_ref(repo, component, "Valaris-Studio/backplane", "refs/heads/main")
    git("checkout", "-qb", "feature")
    (repo / "README.md").write_text("unmerged")
    git("commit", "-qam", "Not merged")
    with pytest.raises(module.ReleaseError):
        module.check_ref(repo, component, "Valaris-Studio/backplane", f"refs/tags/{tag}")
    git("tag", "-f", tag)
    with pytest.raises(module.ReleaseError, match="main"):
        module.check_ref(repo, component, "Valaris-Studio/backplane", f"refs/tags/{tag}")


@pytest.mark.parametrize("filename,job,environment", [
    ("release-platform.yml", "publish", "platform-release"),
    ("release-runner.yml", "goreleaser", "runner-release"),
    ("publish-mcp-server.yml", "publish", "pypi"),
])
def test_publish_jobs_are_opt_in_and_environment_gated(filename, job, environment):
    workflow = yaml.load((ROOT / ".github/workflows" / filename).read_text(), Loader=yaml.BaseLoader)
    assert workflow["permissions"] == {"contents": "read"}
    publish = workflow["jobs"][job]
    assert publish["environment"] == environment
    assert "vars.PUBLIC_RELEASES_ENABLED == 'true'" in publish["if"]
    assert "github.repository == 'Valaris-Studio/backplane'" in publish["if"]
    assert publish["needs"]


def test_runner_history_fetch_excludes_other_component_tags(release, tmp_path):
    _, repo, git = release
    for tag in ("v0.8.3", "v0.8.4", "platform-v0.1.1-preview.1", "mcp-server-v0.8.0"):
        git("tag", tag)
    checkout = tmp_path / "checkout"
    subprocess.run(["git", "init", "-q", str(checkout)], check=True)
    def checkout_git(*args):
        return subprocess.check_output(["git", "-C", str(checkout), *args], text=True).strip()
    checkout_git("remote", "add", "origin", repo.as_uri())
    checkout_git("fetch", "--no-tags", "--depth=1", "origin", "refs/tags/v0.8.4:refs/tags/v0.8.4")
    checkout_git("checkout", "--detach", "v0.8.4")
    workflow = yaml.load((ROOT / ".github/workflows/release-runner.yml").read_text(), Loader=yaml.BaseLoader)
    step = next(s for s in workflow["jobs"]["goreleaser"]["steps"] if s.get("name") == "Fetch runner release history")
    subprocess.run(["bash", "-euo", "pipefail", "-c", step["run"]], cwd=checkout, check=True)
    assert checkout_git("tag", "--list").splitlines() == ["v0.8.3", "v0.8.4"]
    assert checkout_git("rev-parse", "HEAD") == git("rev-parse", "HEAD")
    assert checkout_git("rev-parse", "origin/main") == git("rev-parse", "HEAD")
