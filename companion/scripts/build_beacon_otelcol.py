#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""Build the checksum-pinned Beacon OpenTelemetry collector (beacon-otelcol).

The collector is assembled from the same pinned Beacon source archive as
beacon-hooks, using its collector-builder/builder.yaml and the OpenTelemetry
Collector Builder version that file targets. It writes otelcol.json beside
the binary with its checksum and license notices."""

import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

from build_beacon import collect_dependency_notices, download_source, run, sha256

# builder.yaml pins every collector component to v0.121.0; the builder must match.
BUILDER_VERSION = "v0.121.0"


def build(output):
    spec = json.loads((Path(__file__).resolve().parents[1] / "beacon-source.json").read_text(encoding="utf-8"))
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="backplane-otelcol-build-") as directory:
        temporary = Path(directory)
        environment = dict(os.environ, CGO_ENABLED="0", GOTOOLCHAIN="local", GOBIN=str(temporary / "bin"))
        platform = json.loads(run("go", "env", "-json", "GOOS", "GOARCH", "GOVERSION", env=environment))
        binary_name = "beacon-otelcol.exe" if platform["GOOS"] == "windows" else "beacon-otelcol"
        source_root = download_source(spec, temporary)
        run("go", "install", "go.opentelemetry.io/collector/cmd/builder@" + BUILDER_VERSION, env=environment)
        builder_root = source_root / "collector-builder"
        (builder_root / "dist").mkdir(exist_ok=True)
        run(str(temporary / "bin" / "builder"), "--config", "builder.yaml", cwd=builder_root, env=environment)
        distribution = builder_root / "dist" / "beacon-otelcol"
        produced = distribution / "beacon-otelcol"
        if not produced.is_file() and produced.with_suffix(".exe").is_file():
            produced = produced.with_suffix(".exe")
        notices = output / "licenses"
        notices.mkdir(exist_ok=True)
        shutil.copyfile(source_root / "LICENSE", notices / "beacon-MIT.txt")
        dependencies = collect_dependency_notices(distribution, output, notices, environment)
        shutil.copyfile(produced, output / binary_name)
        (output / binary_name).chmod(0o755)
        artifact = {
            "path": binary_name, "sha256": sha256(output / binary_name),
            "source_commit": spec["commit"], "source_archive_sha256": spec["archive_sha256"],
            "goos": platform["GOOS"], "goarch": platform["GOARCH"], "go_version": platform["GOVERSION"],
            "cgo_enabled": False, "builder_version": BUILDER_VERSION, "builder_config": "collector-builder/builder.yaml",
            "dependencies": dependencies,
            "notices": [{"path": "licenses/beacon-MIT.txt", "sha256": sha256(notices / "beacon-MIT.txt")}],
        }
        (output / "otelcol.json").write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    print(output / "otelcol.json")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    # The printed path may hold characters a cp1252 console cannot encode.
    sys.stdout.reconfigure(errors="backslashreplace")
    build(arguments.output.resolve())
