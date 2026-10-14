#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""Build the checksum-pinned Beacon hook component and collect its license notices."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request


# The oldest release with the 2026-10-08 security fixes to net/http, crypto/tls,
# net/textproto, html/template and os; every shipped Go binary links its stdlib.
MINIMUM_GO_VERSION = (1, 26, 9)


class BeaconBuildError(RuntimeError):
    pass


class ToolchainError(BeaconBuildError):
    pass


def require_go_toolchain(go_version, built=None):
    """built names the binary whose build info carried go_version; without it
    the version is the toolchain about to build. Devel and unparsable versions
    are refused."""
    match = re.fullmatch(r"go(\d+)\.(\d+)(?:\.(\d+)|(?:rc|beta)\d+)", go_version)
    minimum = "go{}.{}.{}".format(*MINIMUM_GO_VERSION)
    subject = f"{built} was built with" if built else "the Go toolchain is"
    patch = -1 if match and match.group(3) is None else int(match.group(3)) if match else None
    if not match or (int(match.group(1)), int(match.group(2)), patch) < MINIMUM_GO_VERSION:
        raise ToolchainError(f"{subject} {go_version or 'unknown'}; release builds need {minimum} or later")


def run(*command, cwd=None, env=None):
    return subprocess.check_output(command, cwd=cwd, env=env, encoding="utf-8").strip()


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def json_objects(text):
    decoder = json.JSONDecoder()
    remaining = text.lstrip()
    while remaining:
        value, end = decoder.raw_decode(remaining)
        yield value
        remaining = remaining[end:].lstrip()


def collect_dependency_notices(module, output, notices, environment):
    """Copy the license notices of every non-Beacon module linked into module."""
    modules = {}
    for package in json_objects(run("go", "list", "-mod=readonly", "-deps", "-json", ".", cwd=module, env=environment)):
        dependency = package.get("Module")
        if not dependency or dependency.get("Main") or dependency["Path"].startswith("github.com/asymptote-labs/agent-beacon/"):
            continue
        modules[dependency["Path"]] = dependency
    dependencies = []
    for name, dependency in sorted(modules.items()):
        license_paths = []
        dependency_root = Path(dependency["Dir"])
        for license_file in sorted(dependency_root.iterdir()):
            if license_file.is_file() and license_file.name.upper().startswith(("LICENSE", "NOTICE", "COPYING")):
                target = notices / (name.replace("/", "_") + "-" + license_file.name)
                shutil.copyfile(license_file, target)
                license_paths.append({"path": str(target.relative_to(output)), "sha256": sha256(target)})
        if not license_paths:
            raise RuntimeError("No license notice found for " + name)
        dependencies.append({"module": name, "version": dependency["Version"], "notices": license_paths})
    return dependencies


def download_source(spec, temporary, archive=None):
    """Extract the pinned source, from a local copy of the archive when given;
    either way it must match the pinned checksum."""
    if archive is None:
        archive = temporary / "source.tar.gz"
        with urllib.request.urlopen(spec["archive_url"], timeout=60) as response, archive.open("wb") as target:
            shutil.copyfileobj(response, target)
    if sha256(archive) != spec["archive_sha256"]:
        raise RuntimeError("Beacon source archive checksum mismatch")
    with tarfile.open(archive) as source:
        source.extractall(temporary, filter="data")
    return temporary / ("agent-beacon-" + spec["commit"])


def build(output):
    spec = json.loads((Path(__file__).resolve().parents[1] / "beacon-source.json").read_text(encoding="utf-8"))
    output.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ, CGO_ENABLED="0", GOTOOLCHAIN="local")
    platform = json.loads(run("go", "env", "-json", "GOOS", "GOARCH", "GOVERSION", "GOROOT", env=environment))
    require_go_toolchain(platform["GOVERSION"])
    binary_name = "beacon-hooks.exe" if platform["GOOS"] == "windows" else "beacon-hooks"
    with tempfile.TemporaryDirectory(prefix="backplane-beacon-build-") as directory:
        temporary = Path(directory)
        source_root = download_source(spec, temporary)
        module = source_root / spec["component"]
        binary = temporary / binary_name
        run("go", "build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-ldflags=-buildid=", "-o", str(binary), ".", cwd=module, env=environment)
        notices = output / "licenses"
        notices.mkdir(exist_ok=True)
        shutil.copyfile(source_root / "LICENSE", notices / "beacon-MIT.txt")
        go_root = Path(platform["GOROOT"])
        go_license = next((path for path in (go_root / "LICENSE", go_root.parent / "LICENSE") if path.is_file()), None)
        if go_license is None:
            raise RuntimeError("Go toolchain license notice not found")
        shutil.copyfile(go_license, notices / "go-LICENSE.txt")
        dependencies = collect_dependency_notices(module, output, notices, environment)
        shutil.copyfile(binary, output / binary_name)
        (output / binary_name).chmod(0o755)
        artifact = {
            "path": binary_name, "sha256": sha256(output / binary_name),
            "source_commit": spec["commit"], "source_archive_sha256": spec["archive_sha256"],
            "goos": platform["GOOS"], "goarch": platform["GOARCH"], "go_version": platform["GOVERSION"],
            "cgo_enabled": False, "build_flags": ["-mod=readonly", "-trimpath", "-buildvcs=false", "-ldflags=-buildid="],
            "dependencies": dependencies,
            "notices": [{"path": "licenses/beacon-MIT.txt", "sha256": sha256(notices / "beacon-MIT.txt")}, {"path": "licenses/go-LICENSE.txt", "sha256": sha256(notices / "go-LICENSE.txt")}],
        }
        (output / "artifact.json").write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    print(output / "artifact.json")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    # The printed path may hold characters a cp1252 console cannot encode.
    sys.stdout.reconfigure(errors="backslashreplace")
    build(arguments.output.resolve())
