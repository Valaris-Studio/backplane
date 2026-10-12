#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Validate component release refs, package a reproducible platform source bundle,
and render release notes from CHANGELOG.md."""

import argparse
from dataclasses import dataclass, field
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import posixpath
import re
import subprocess
import tomllib

ROOT = Path(__file__).resolve().parents[1]
SEMVER = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?"


PUBLIC_REPOSITORY = "https://github.com/Valaris-Studio/backplane"
TAG_PREFIXES = {"platform": "platform-v", "mcp": "mcp-server-v", "runner": "v"}
CHANGELOG_COMPONENTS = {"Platform": "platform", "Runner": "runner", "MCP server": "mcp"}
RELEASE_TITLES = {"platform": "Platform", "runner": "Runner", "mcp": "MCP server"}
# A tagged release whose GitHub release is still a draft carries this instead of a date.
UNPUBLISHED_DATE = "TODO(publish-date)"
ANCHOR_LINE = re.compile(r'<a id="([^"]+)"></a>')
RELEASE_HEADING = re.compile(r"## (Platform|Runner|MCP server) (\S+) — (\d{4}-\d{2}-\d{2}|TODO\(publish-date\))")
UNRELEASED_HEADING = re.compile(r"### (Platform|Runner|MCP server) (\S+)")
MARKDOWN_LINK_TARGET = re.compile(r"\]\(([^)\s]+)\)")


class ReleaseError(RuntimeError):
    pass


@dataclass
class ChangelogEntry:
    component: str
    version: str
    date: str
    body: str


@dataclass
class Changelog:
    entries: dict = field(default_factory=dict)
    # Tags that exist but were never published (a cancelled workflow): a note, no release.
    unpublished_tags: set = field(default_factory=set)
    unreleased: dict = field(default_factory=dict)


def parse_changelog(text):
    changelog = Changelog()
    pending_anchor = body_tag = None
    body_lines = []
    in_unreleased = False

    def close_body():
        if body_tag:
            changelog.entries[body_tag].body = "\n".join(body_lines).strip()
        body_lines.clear()

    for line in text.splitlines():
        anchor = ANCHOR_LINE.fullmatch(line.strip())
        if anchor:
            close_body()
            body_tag = None
            pending_anchor = anchor.group(1)
            if pending_anchor in changelog.entries or pending_anchor in changelog.unpublished_tags:
                raise ReleaseError(f"CHANGELOG.md repeats the anchor {pending_anchor}")
            continue
        if line.startswith("## ") or line.strip() == "---":
            close_body()
            body_tag = None
        if line.startswith("## "):
            in_unreleased = line == "## Unreleased"
        if in_unreleased and (unreleased := UNRELEASED_HEADING.fullmatch(line)):
            changelog.unreleased[CHANGELOG_COMPONENTS[unreleased.group(1)]] = unreleased.group(2)
        if pending_anchor and line.strip():
            heading = RELEASE_HEADING.fullmatch(line)
            if heading:
                component, version, date = heading.groups()
                changelog.entries[pending_anchor] = ChangelogEntry(CHANGELOG_COMPONENTS[component], version, date, "")
                body_tag = pending_anchor
                pending_anchor = None
                continue
            if not line.startswith("## "):
                changelog.unpublished_tags.add(pending_anchor)
            pending_anchor = None
        if body_tag:
            body_lines.append(line)
    close_body()
    return changelog


def tag_component(tag):
    for component in ("platform", "mcp", "runner"):
        if re.fullmatch(re.escape(TAG_PREFIXES[component]) + SEMVER, tag):
            return component
    raise ReleaseError(f"invalid release tag {tag}")


def check_changelog(repo, tag):
    repo = Path(repo)
    component = tag_component(tag)
    entry = parse_changelog((repo / "CHANGELOG.md").read_text()).entries.get(tag)
    if entry is None:
        raise ReleaseError(f"{tag} has no CHANGELOG.md entry")
    if TAG_PREFIXES[entry.component] + entry.version != tag:
        raise ReleaseError(f"the CHANGELOG.md heading under {tag} names {entry.component} {entry.version}")
    if entry.date == UNPUBLISHED_DATE:
        raise ReleaseError(f"the {tag} CHANGELOG.md entry still needs its publish date")
    if component == "mcp":
        package_changelog = (repo / "mcp-server/CHANGELOG.md").read_text()
        if not re.search(rf"^## \[{re.escape(entry.version)}\]", package_changelog, re.MULTILINE):
            raise ReleaseError(f"mcp-server/CHANGELOG.md has no [{entry.version}] entry")
    return entry


def pin_links(markdown, tag, base=""):
    """Absolute, tag-pinned links; relative targets resolve from `base`, the file's repo directory."""
    blob = f"{PUBLIC_REPOSITORY}/blob/{tag}"

    def absolute(match):
        target = match.group(1)
        if target.startswith(("https://", "http://")):
            return match.group(0)
        if target.startswith("#"):
            return f"]({blob}/CHANGELOG.md{target})"
        return f"]({blob}/{posixpath.normpath(posixpath.join(base, target))})"

    return MARKDOWN_LINK_TARGET.sub(absolute, markdown)


def release_notes(repo, tag):
    repo = Path(repo)
    entry = check_changelog(repo, tag)
    body = entry.body.splitlines()
    # The first line is the label pills (`platform` `preview` · …): changelog navigation only.
    if body and body[0].startswith("`"):
        body = body[1:]
    body = re.sub(r"(?m)^#### ", "### ", "\n".join(body).strip())
    sections = [f"# Backplane {RELEASE_TITLES[entry.component]} {entry.version}", pin_links(body, tag)]
    footer = repo / f"docs/releases/footer-{entry.component}.md"
    if footer.exists():
        footer_text = footer.read_text().replace("{tag}", tag).replace("{version}", entry.version).strip()
        sections.append(pin_links(footer_text, tag, base="docs/releases"))
    sections.append(pin_links(f"[Full changelog](#{tag})", tag))
    return "\n\n".join(sections) + "\n"


def write_release_notes(repo, tag, output):
    output = Path(output)
    if output.exists():
        raise ReleaseError("release notes output already exists; use a new path")
    output.write_text(release_notes(repo, tag))


def git(repo, *args):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True)
    if result.returncode:
        raise ReleaseError(result.stderr.decode(errors="replace").strip())
    return result.stdout


def validate_tag(repo, component, tag):
    prefix = TAG_PREFIXES[component]
    if not re.fullmatch(re.escape(prefix) + SEMVER, tag):
        raise ReleaseError(f"invalid {component} tag")
    version = tag[len(prefix):]
    expected = None
    if component == "platform":
        expected = (repo / "VERSION").read_text().strip()
    elif component == "mcp":
        expected = tomllib.loads((repo / "mcp-server/pyproject.toml").read_text())["project"]["version"]
    if expected is not None and version != expected:
        raise ReleaseError("release tag does not match the source version")
    return version


def check_ref(repo, component, repository, ref):
    if repository != "Valaris-Studio/backplane":
        raise ReleaseError("publishing requires the public repository")
    if not ref.startswith("refs/tags/"):
        raise ReleaseError("publishing requires a component version tag")
    validate_tag(repo, component, ref.removeprefix("refs/tags/"))
    head = git(repo, "rev-parse", "HEAD").strip()
    if git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}").strip() != head:
        raise ReleaseError("checkout does not match the release tag")
    try:
        git(repo, "merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main")
    except ReleaseError as exc:
        raise ReleaseError("release commit must already be included in public main") from exc


def package(repo, output, tag):
    repo, output = Path(repo), Path(output)
    version = validate_tag(repo, "platform", tag)
    if git(repo, "status", "--porcelain", "--untracked-files=no"):
        raise ReleaseError("packaging requires a clean tracked checkout")
    paths = git(repo, "ls-files", "-z").decode().split("\0")
    if any(p in paths for p in ("scripts/export-public-snapshot.sh", "scripts/prepare-public-release.py", ".mailmap.public")):
        raise ReleaseError("package only an inspected public source checkout")
    if output.exists():
        raise ReleaseError("output already exists; use a new directory")
    commit = git(repo, "rev-parse", "HEAD").decode().strip()
    prefix = f"backplane-{tag}"
    name = f"{prefix}.tar.gz"
    archive = git(repo, "archive", "--format=tar", f"--prefix={prefix}/", commit)
    # Git archives use commit timestamps; zeroing the gzip header makes repeat
    # builds of this exact commit byte-identical across output directories.
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", filename="", mtime=0) as compressor:
        compressor.write(archive)
    compressed = buffer.getvalue()
    manifest = dict(schema_version=1, component="platform", version=version, tag=tag,
                    source_repository=PUBLIC_REPOSITORY,
                    source_commit=commit, source_tree=git(repo, "rev-parse", "HEAD^{tree}").decode().strip(),
                    distribution="source-compose", artifacts=[dict(name=name, sha256=hashlib.sha256(compressed).hexdigest())])
    output.mkdir(parents=True)
    (output / name).write_bytes(compressed)
    (output / "release.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    (output / "SHA256SUMS").write_text("".join(
        f"{hashlib.sha256((output / filename).read_bytes()).hexdigest()}  {filename}\n"
        for filename in (name, "release.json")))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("check-ref")
    check.add_argument("--component", choices=("platform", "mcp", "runner"), required=True)
    pack = commands.add_parser("package")
    pack.add_argument("--tag", required=True)
    pack.add_argument("--output", type=Path, required=True)
    entry = commands.add_parser("check-changelog")
    entry.add_argument("--tag", required=True)
    notes = commands.add_parser("release-notes")
    notes.add_argument("--tag", required=True)
    notes.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "check-ref":
        check_ref(ROOT, args.component, os.environ.get("GITHUB_REPOSITORY", ""), os.environ.get("GITHUB_REF", ""))
    elif args.command == "check-changelog":
        check_changelog(ROOT, args.tag)
    elif args.command == "release-notes":
        write_release_notes(ROOT, args.tag, args.output)
    else:
        print(json.dumps(package(ROOT, args.output, args.tag), indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ReleaseError, OSError, ValueError) as exc:
        raise SystemExit(f"Release refused: {exc}") from exc
