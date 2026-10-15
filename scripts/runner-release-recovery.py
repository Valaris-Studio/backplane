#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Recover runner 0.8.8 with audited packaging tooling and unchanged source."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.request

SOURCE_TAG = "v0.8.8"
SOURCE_COMMIT = "82375d7e62d7f4e31e7e3258cdba2b08f67dce39"
TOOLING_TAG = "v-recovery-runner-20261015"
REPOSITORY = "Valaris-Studio/backplane"
EXTRA_FILES = b"    extra_files:\n      - go.mod\n      - go.sum\n      - cmd\n      - internal\n"


class RecoveryError(RuntimeError):
    pass


def git(repo, *args):
    try:
        return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.PIPE, timeout=30)
    except subprocess.CalledProcessError as exc:
        raise RecoveryError("Git source identity check failed") from exc


def prepare(tooling, source, *, repository, ref, tooling_sha, source_tag, source_sha, tooling_tag):
    tooling, source = Path(tooling).resolve(), Path(source).resolve()
    if repository != REPOSITORY or ref != f"refs/tags/{tooling_tag}":
        raise RecoveryError("recovery requires the public tooling tag")
    if not re.fullmatch(r"[0-9a-f]{40}", source_sha) or not re.fullmatch(r"[0-9a-f]{40}", tooling_sha):
        raise RecoveryError("recovery requires full source and tooling commits")
    for repo, sha, tag in ((tooling, tooling_sha, tooling_tag), (source, source_sha, source_tag)):
        if git(repo, "rev-parse", "HEAD").decode().strip() != sha:
            raise RecoveryError("checkout does not match the expected commit")
        if git(repo, "cat-file", "-t", f"refs/tags/{tag}").strip() != b"tag":
            raise RecoveryError("recovery requires annotated immutable tags")
        if git(repo, "rev-parse", f"refs/tags/{tag}^{{}}").decode().strip() != sha:
            raise RecoveryError("tag does not match the expected commit")
        git(repo, "merge-base", "--is-ancestor", sha, "refs/remotes/origin/main")
        if git(repo, "status", "--porcelain"):
            raise RecoveryError("recovery requires clean source and tooling checkouts")
    changed = git(tooling, "diff", "--name-only", source_sha, tooling_sha, "--", "runner").decode().splitlines()
    if changed != ["runner/.goreleaser.yaml"]:
        raise RecoveryError("recovery tooling changes runner code or other build inputs")
    original = (source / "runner/.goreleaser.yaml").read_bytes()
    needle = b"    dockerfile: Dockerfile\n"
    if original.count(needle) != 1 or b"extra_files:" in original:
        raise RecoveryError("source configuration is not the expected pre-repair shape")
    config = tooling / "runner/.goreleaser.yaml"
    if config.read_bytes() != original.replace(needle, needle + EXTRA_FILES):
        raise RecoveryError("recovery configuration exceeds the audited context-only repair")
    return {"source_tag": source_tag, "source_commit": source_sha,
            "source_tree": git(source, "rev-parse", "HEAD^{tree}").decode().strip(),
            "tooling_tag": tooling_tag, "tooling_commit": tooling_sha,
            "tooling_tree": git(tooling, "rev-parse", "HEAD^{tree}").decode().strip(),
            "config": str(config), "config_sha256": hashlib.sha256(config.read_bytes()).hexdigest(),
            "source_config_sha256": hashlib.sha256(original).hexdigest()}


def http_json(url, headers, *, missing_ok=False):
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read(1024 * 1024 + 1)
    except urllib.error.HTTPError as exc:
        if missing_ok and exc.code == 404:
            return None
        raise RecoveryError(f"publication preflight refused HTTP {exc.code}") from None
    if len(data) > 1024 * 1024:
        raise RecoveryError("publication preflight response exceeded its bound")
    result = json.loads(data)
    if not isinstance(result, dict):
        raise RecoveryError("publication preflight returned a non-object response")
    return result


def require_unpublished(actor, token):
    if not actor or not token:
        raise RecoveryError("authenticated publication preflight is required")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
               "User-Agent": "Backplane-runner-recovery"}
    release = http_json(f"https://api.github.com/repos/{REPOSITORY}/releases/tags/{SOURCE_TAG}", headers, missing_ok=True)
    if release is not None:
        raise RecoveryError("runner release already exists; review its artifacts before recovery")
    credentials = base64.b64encode(f"{actor}:{token}".encode()).decode()
    auth = http_json("https://ghcr.io/token?service=ghcr.io&scope=repository:valaris-studio/backplane-runner:pull",
                     {"Authorization": f"Basic {credentials}"})
    registry_token = auth.get("token") if isinstance(auth, dict) else None
    if not isinstance(registry_token, str) or not registry_token:
        raise RecoveryError("registry authorization did not return a token")
    manifest = http_json("https://ghcr.io/v2/valaris-studio/backplane-runner/manifests/0.8.8",
                         {"Authorization": f"Bearer {registry_token}",
                          "Accept": "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json"},
                         missing_ok=True)
    if manifest is not None:
        raise RecoveryError("versioned runner image already exists; review its digest before recovery")
    return {"github_release": "absent", "versioned_container": "absent"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tooling", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--check-publication", action="store_true")
    args = parser.parse_args()
    receipt = prepare(args.tooling, args.source, repository=os.environ.get("GITHUB_REPOSITORY", ""),
                      ref=os.environ.get("GITHUB_REF", ""), tooling_sha=os.environ.get("GITHUB_SHA", ""),
                      source_tag=SOURCE_TAG, source_sha=SOURCE_COMMIT, tooling_tag=TOOLING_TAG)
    if args.check_publication:
        receipt["publication_preflight"] = require_unpublished(os.environ.get("GITHUB_ACTOR", ""), os.environ.get("GH_TOKEN", ""))
    with args.receipt.open("x") as output:
        json.dump(receipt, output, indent=2)
        output.write("\n")
    print(json.dumps({key: receipt[key] for key in ("source_commit", "tooling_commit", "config_sha256")}))


if __name__ == "__main__":
    try:
        main()
    except (RecoveryError, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        raise SystemExit(f"Runner recovery refused: {exc}") from None
