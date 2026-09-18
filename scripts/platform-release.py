#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Validate component release refs and package a reproducible platform source bundle."""

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tomllib

ROOT = Path(__file__).resolve().parents[1]
SEMVER = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?"


class ReleaseError(RuntimeError):
    pass


def git(repo, *args):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True)
    if result.returncode:
        raise ReleaseError(result.stderr.decode(errors="replace").strip())
    return result.stdout


def validate_tag(repo, component, tag):
    prefix = {"platform": "platform-v", "mcp": "mcp-server-v", "runner": "v"}[component]
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
                    source_repository="https://github.com/Valaris-Studio/backplane",
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
    args = parser.parse_args()
    if args.command == "check-ref":
        check_ref(ROOT, args.component, os.environ.get("GITHUB_REPOSITORY", ""), os.environ.get("GITHUB_REF", ""))
    else:
        print(json.dumps(package(ROOT, args.output, args.tag), indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ReleaseError, OSError, ValueError) as exc:
        raise SystemExit(f"Release refused: {exc}") from exc
