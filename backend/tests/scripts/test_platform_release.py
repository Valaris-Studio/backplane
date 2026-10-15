# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
import hashlib
import importlib.util
import json
from pathlib import Path
import re
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


@pytest.mark.parametrize("annotated", [False, True], ids=["lightweight", "annotated"])
def test_runner_history_fetch_excludes_other_component_tags(release, tmp_path, annotated):
    _, repo, git = release
    tags = ("v0.8.3", "v0.8.4", "platform-v0.1.1-preview.1", "mcp-server-v0.8.0", "v-recovery-runner-20261015")
    for tag in tags:
        if annotated:
            git("tag", "-a", tag, "-m", f"Release {tag}")
        else:
            git("tag", tag)
    remote_tags = {tag: git("rev-parse", f"refs/tags/{tag}") for tag in tags}
    checkout = tmp_path / "checkout"
    subprocess.run(["git", "init", "-q", str(checkout)], check=True)
    def checkout_git(*args):
        return subprocess.check_output(["git", "-C", str(checkout), *args], text=True).strip()
    checkout_git("remote", "add", "origin", repo.as_uri())
    # actions/checkout fetches the event commit into a local lightweight tag.
    source_commit = git("rev-parse", "HEAD")
    checkout_git("fetch", "--no-tags", "--depth=1", "origin", f"+{source_commit}:refs/tags/v0.8.4")
    assert checkout_git("cat-file", "-t", "refs/tags/v0.8.4") == "commit"
    checkout_git("checkout", "--detach", "v0.8.4")
    workflow = yaml.load((ROOT / ".github/workflows/release-runner.yml").read_text(), Loader=yaml.BaseLoader)
    step = next(s for s in workflow["jobs"]["goreleaser"]["steps"] if s.get("name") == "Fetch runner release history")
    subprocess.run(["bash", "-euo", "pipefail", "-c", step["run"]], cwd=checkout, check=True, timeout=30)
    assert checkout_git("tag", "--list").splitlines() == ["v0.8.3", "v0.8.4"]
    for tag in ("v0.8.3", "v0.8.4"):
        assert checkout_git("rev-parse", f"refs/tags/{tag}") == remote_tags[tag]
    assert {tag: git("rev-parse", f"refs/tags/{tag}") for tag in tags} == remote_tags
    assert checkout_git("rev-parse", "HEAD") == git("rev-parse", "HEAD")
    assert checkout_git("rev-parse", "origin/main") == git("rev-parse", "HEAD")


CHANGELOG = """# Changelog

<a id="unreleased"></a>

## Unreleased

### Runner 0.8.6

`runner` `planned`

#### Changed

- Pending.

---

<a id="platform-v0.1.2-preview.2"></a>

## Platform 0.1.2-preview.2 — 2026-09-21

`platform` `preview` · Qualified with runner 0.8.5

> Skills keep an auditable history.

#### Added

- Skill history, see [Self-hosting](README.md#self-hosting) and [runner](#v0.8.5).

[Release](https://github.com/Valaris-Studio/backplane/releases/tag/platform-v0.1.2-preview.2)

<a id="platform-v0.1.2-preview.1"></a>

> **`platform-v0.1.2-preview.1` was tagged but never published.**

---

<a id="v0.8.5"></a>

## Runner 0.8.5 — 2026-09-21

`runner` `experimental`

#### Fixed

- Recovery.

---

<a id="platform-v0.1.1-preview.1"></a>

## Platform 0.1.1-preview.1 — TODO(publish-date)

`platform` `preview`

#### Fixed

- Uploads.
"""


@pytest.fixture
def changelog_repo(release):
    module, repo, git = release
    (repo / "CHANGELOG.md").write_text(CHANGELOG)
    (repo / "docs/releases").mkdir(parents=True)
    (repo / "docs/releases/footer-platform.md").write_text("Install {version} from [the archive](../../README.md#self-hosting) at `{tag}`.\n")
    (repo / "docs/releases/footer-runner.md").write_text("Verify runner {version} with SHA256SUMS.\n")
    return module, repo


def test_changelog_entries_are_keyed_by_tag_with_unpublished_tags_kept_apart(changelog_repo):
    module, repo = changelog_repo
    changelog = module.parse_changelog((repo / "CHANGELOG.md").read_text())
    assert list(changelog.entries) == ["platform-v0.1.2-preview.2", "v0.8.5", "platform-v0.1.1-preview.1"]
    entry = changelog.entries["platform-v0.1.2-preview.2"]
    assert (entry.component, entry.version, entry.date) == ("platform", "0.1.2-preview.2", "2026-09-21")
    assert changelog.unpublished_tags == {"platform-v0.1.2-preview.1"}
    assert changelog.unreleased == {"runner": "0.8.6"}
    # The cancelled-tag note belongs to no release body.
    assert "never published" not in entry.body


@pytest.mark.parametrize("tag", ["platform-v0.1.2-preview.2", "v0.8.5"])
def test_check_changelog_accepts_a_dated_entry(changelog_repo, tag):
    module, repo = changelog_repo
    module.check_changelog(repo, tag)


@pytest.mark.parametrize("tag,reason", [
    ("platform-v0.1.3-preview.1", "no CHANGELOG.md entry"),
    ("platform-v0.1.2-preview.1", "no CHANGELOG.md entry"),
    ("platform-v0.1.1-preview.1", "publish date"),
    ("v0.8.6", "no CHANGELOG.md entry"),
])
def test_check_changelog_refuses_a_release_without_a_dated_entry(changelog_repo, tag, reason):
    module, repo = changelog_repo
    with pytest.raises(module.ReleaseError, match=reason):
        module.check_changelog(repo, tag)


def test_check_changelog_refuses_a_heading_that_disagrees_with_its_anchor(changelog_repo):
    module, repo = changelog_repo
    text = CHANGELOG.replace("## Runner 0.8.5 — 2026-09-21", "## Runner 0.8.4 — 2026-09-21")
    (repo / "CHANGELOG.md").write_text(text)
    with pytest.raises(module.ReleaseError, match="v0.8.5"):
        module.check_changelog(repo, "v0.8.5")


def test_mcp_release_also_needs_the_package_changelog(changelog_repo):
    module, repo = changelog_repo
    (repo / "CHANGELOG.md").write_text(CHANGELOG.replace(
        "---\n\n<a id=\"v0.8.5\">",
        "---\n\n<a id=\"mcp-server-v0.9.0\"></a>\n\n## MCP server 0.9.0 — 2026-10-04\n\n`mcp-server`\n\n#### Changed\n\n- Queue.\n\n---\n\n<a id=\"v0.8.5\">"))
    (repo / "mcp-server/CHANGELOG.md").write_text("# Changelog\n\n## [0.8.0] - 2026-09-15\n")
    with pytest.raises(module.ReleaseError, match="mcp-server/CHANGELOG.md"):
        module.check_changelog(repo, "mcp-server-v0.9.0")
    (repo / "mcp-server/CHANGELOG.md").write_text("# Changelog\n\n## [0.9.0] - 2026-10-04\n")
    module.check_changelog(repo, "mcp-server-v0.9.0")


def test_release_notes_render_the_entry_with_tag_pinned_links_and_the_component_footer(changelog_repo):
    module, repo = changelog_repo
    notes = module.release_notes(repo, "platform-v0.1.2-preview.2")
    blob = "https://github.com/Valaris-Studio/backplane/blob/platform-v0.1.2-preview.2"
    assert notes.startswith("# Backplane Platform 0.1.2-preview.2\n\n> Skills keep an auditable history.")
    assert "`platform` `preview`" not in notes
    assert "### Added" in notes and "#### Added" not in notes
    assert f"[Self-hosting]({blob}/README.md#self-hosting)" in notes
    assert f"[runner]({blob}/CHANGELOG.md#v0.8.5)" in notes
    assert f"Install 0.1.2-preview.2 from [the archive]({blob}/README.md#self-hosting) at `platform-v0.1.2-preview.2`." in notes
    assert f"[Full changelog]({blob}/CHANGELOG.md#platform-v0.1.2-preview.2)" in notes
    assert "never published" not in notes
    assert not re.search(r"\]\((?!https://|#)", notes), "every link must be absolute"
    runner = module.release_notes(repo, "v0.8.5")
    assert runner.startswith("# Backplane Runner 0.8.5\n") and "Verify runner 0.8.5 with SHA256SUMS." in runner


def test_release_notes_cli_writes_a_fresh_file_only(changelog_repo, tmp_path):
    module, repo = changelog_repo
    output = tmp_path / "notes.md"
    module.write_release_notes(repo, "v0.8.5", output)
    assert output.read_text() == module.release_notes(repo, "v0.8.5")
    with pytest.raises(module.ReleaseError, match="exists"):
        module.write_release_notes(repo, "v0.8.5", output)


@pytest.mark.parametrize("filename,job", [
    ("release-platform.yml", "validate"),
    ("release-runner.yml", "validate"),
    ("publish-mcp-server.yml", "test"),
])
def test_every_release_workflow_refuses_a_tag_without_a_changelog_entry(filename, job):
    workflow = yaml.load((ROOT / ".github/workflows" / filename).read_text(), Loader=yaml.BaseLoader)
    runs = [step.get("run", "") for step in workflow["jobs"][job]["steps"]]
    assert any("platform-release.py check-changelog" in run for run in runs)


@pytest.mark.parametrize("filename,job", [
    ("release-platform.yml", "publish"),
    ("release-runner.yml", "goreleaser"),
])
def test_published_release_notes_are_rendered_from_the_changelog(filename, job):
    text = (ROOT / ".github/workflows" / filename).read_text()
    workflow = yaml.load(text, Loader=yaml.BaseLoader)
    steps = workflow["jobs"][job]["steps"]
    assert any("platform-release.py release-notes" in step.get("run", "") for step in steps)
    assert "platform-release-notes.md" not in text
