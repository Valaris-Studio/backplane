# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
"""CHANGELOG.md is the public record every release renders its notes from."""

import importlib.util
from pathlib import Path
import re
import subprocess
import tomllib

import pytest

ROOT = Path(__file__).resolve().parents[3]
CHANGELOG_PATH = ROOT / "CHANGELOG.md"
ALLOWED_GROUPS = {"Added", "Changed", "Deprecated", "Removed", "Fixed", "Security",
                  "Known limitations", "Upgrade notes"}


@pytest.fixture(scope="module")
def release():
    spec = importlib.util.spec_from_file_location("platform_release", ROOT / "scripts/platform-release.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def text():
    return CHANGELOG_PATH.read_text()


@pytest.fixture(scope="module")
def changelog(release, text):
    return release.parse_changelog(text)


def test_current_platform_version_has_a_dated_entry(release):
    version = (ROOT / "VERSION").read_text().strip()
    release.check_changelog(ROOT, f"platform-v{version}")


def test_current_mcp_version_is_recorded_in_both_changelogs(changelog):
    version = tomllib.loads((ROOT / "mcp-server/pyproject.toml").read_text())["project"]["version"]
    assert f"mcp-server-v{version}" in changelog.entries or changelog.unreleased.get("mcp") == version
    assert re.search(rf"^## \[{re.escape(version)}\]", (ROOT / "mcp-server/CHANGELOG.md").read_text(), re.MULTILINE)


def test_mcp_entries_share_the_package_changelog_dates(changelog):
    package = dict(re.findall(r"^## \[([^\]]+)\] - (\S+)$", (ROOT / "mcp-server/CHANGELOG.md").read_text(), re.MULTILINE))
    for tag, entry in changelog.entries.items():
        if entry.component == "mcp":
            assert package.get(entry.version) == entry.date, tag


def test_current_runner_release_has_a_dated_entry(release):
    # Runners publish to downloads before their public tag lands, so the entry
    # (not the tag) is what "current" requires.
    readme = (ROOT / "runner/README.md").read_text()
    version = re.search(r"current release pair is \*\*runner ([^*]+)\*\*", readme).group(1)
    release.check_changelog(ROOT, f"v{version}")


def test_every_entry_heading_matches_its_tag_anchor(release, changelog):
    for tag, entry in changelog.entries.items():
        assert release.TAG_PREFIXES[entry.component] + entry.version == tag


def test_every_release_anchor_opens_an_entry_or_records_an_unpublished_tag(release, text, changelog):
    anchors = release.ANCHOR_LINE.findall(text)
    assert len(anchors) == len(set(anchors))
    tags = [anchor for anchor in anchors if anchor not in ("unreleased", "public-launch")]
    assert set(tags) == set(changelog.entries) | changelog.unpublished_tags
    for tag in tags:
        release.tag_component(tag)


def test_entries_run_newest_first(release, changelog):
    dates = [entry.date for entry in changelog.entries.values() if entry.date != release.UNPUBLISHED_DATE]
    assert dates == sorted(dates, reverse=True)


def test_entries_group_changes_under_known_headings(changelog):
    for tag, entry in changelog.entries.items():
        groups = re.findall(r"^#### (.+)$", entry.body, re.MULTILINE)
        assert groups and set(groups) <= ALLOWED_GROUPS, tag


@pytest.mark.parametrize("tag", ["platform-v0.1.2-preview.2", "v0.8.5"])
def test_published_releases_render_notes_with_absolute_links(release, tag):
    notes = release.release_notes(ROOT, tag)
    assert not re.search(r"\]\((?!https://)", notes)
    assert f"blob/{tag}/CHANGELOG.md#{tag}" in notes


def test_links_stay_inside_the_public_repository(text):
    tracked = set(subprocess.check_output(["git", "-C", str(ROOT), "ls-files"], text=True).splitlines())
    for target in re.findall(r"\]\(([^)\s]+)\)", text):
        if target.startswith("https://github.com/"):
            assert target.startswith("https://github.com/Valaris-Studio/backplane/"), target
        elif not target.startswith(("https://", "#")):
            assert target.split("#")[0] in tracked, target
    assert not re.search(r"/Users/|/home/[a-z]|file://", text)
