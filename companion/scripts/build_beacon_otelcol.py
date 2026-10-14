#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""Build the checksum-pinned Beacon OpenTelemetry collector (beacon-otelcol).

The collector is assembled from the same pinned Beacon source archive as
beacon-hooks, using its collector-builder/builder.yaml and the OpenTelemetry
Collector Builder version that file targets. builder.yaml stays unmodified;
the module it generates is lifted to the declared floors below before it is
compiled, and the linked result is disclosed in otelcol.json beside the
binary with its checksum and license notices."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

import licenses
from build_beacon import BeaconBuildError, collect_dependency_notices, download_source, require_go_toolchain, run, sha256

# builder.yaml pins every collector component to v0.121.0; the builder must match.
BUILDER_VERSION = "v0.121.0"
BUILDER_CONFIG = "collector-builder/builder.yaml"

_OTLP = "go.opentelemetry.io/otel/exporters/otlp/"
# Requirement floors for the module the builder generates: each lifts a module
# that builder.yaml resolves into a published Go advisory range, or one such
# lift needs to compile. Exact versions, so the resolved graph is reproducible.
DEPENDENCY_FLOORS = {
    "github.com/klauspost/compress": ("v1.18.7", ["GO-2026-5841"]),
    "go.opentelemetry.io/contrib/bridges/otelzap": ("v0.20.0", ["first collector zap bridge built for go.opentelemetry.io/otel/log v0.21.0"]),
    _OTLP + "otlplog/otlploggrpc": ("v0.21.0", ["GO-2026-6508"]),
    _OTLP + "otlplog/otlploghttp": ("v0.21.0", ["GO-2026-4985", "built for go.opentelemetry.io/otel/log v0.21.0"]),
    _OTLP + "otlpmetric/otlpmetrichttp": ("v1.45.0", ["GO-2026-4985"]),
    _OTLP + "otlptrace": ("v1.45.0", ["GO-2026-6505"]),
    _OTLP + "otlptrace/otlptracegrpc": ("v1.45.0", ["GO-2026-6505"]),
    _OTLP + "otlptrace/otlptracehttp": ("v1.45.0", ["GO-2026-4985", "GO-2026-6505"]),
    "go.opentelemetry.io/otel/sdk": ("v1.45.0", ["GO-2026-6505"]),
    "golang.org/x/net": ("v0.60.0", ["GO-2026-6603", "GO-2026-6610", "GO-2026-6611", "GO-2026-6612", "GO-2026-6617"]),
}
# builder.yaml replaces the log API family with v0.19.0, which a requirement
# floor cannot lift; sdk/log v0.21.0 is the first outside GO-2026-6615 and the
# rest of the family moves with it. (builder.yaml's version, override)
REPLACE_OVERRIDES = {module: ("v0.19.0", "v0.21.0") for module in (
    "go.opentelemetry.io/otel/exporters/stdout/stdoutlog",
    "go.opentelemetry.io/otel/log",
    "go.opentelemetry.io/otel/log/logtest",
    "go.opentelemetry.io/otel/sdk/log",
    "go.opentelemetry.io/otel/sdk/log/logtest",
)}


class OverrideError(BeaconBuildError):
    pass


def _semver(version):
    core, _, prerelease = version.removeprefix("v").partition("-")
    # A release sorts after every prerelease of the same version.
    return tuple(int(part) for part in core.split(".")), prerelease == ""


def version_at_least(version, floor):
    return _semver(version) >= _semver(floor)


def builder_replacements(go_mod_text):
    """Version replacements (module => module version) in a go.mod."""
    found = re.findall(r"^\s*(?:replace\s+)?(\S+)\s+=>\s+\1\s+(v\S+)\s*$", go_mod_text, flags=re.MULTILINE)
    return dict(found)


def apply_generated_module_overrides(module_dir, environment):
    """Lift the generated module to the declared floors. Replacements go first:
    a replace pins its module whatever go get asks for."""
    generated = builder_replacements((module_dir / "go.mod").read_text(encoding="utf-8"))
    for module, (declared, _) in REPLACE_OVERRIDES.items():
        if generated.get(module) != declared:
            raise OverrideError(f"builder.yaml now replaces {module} with {generated.get(module) or 'nothing'}, not {declared}; "
                                "review the Beacon collector overrides")
    for module, (_, override) in REPLACE_OVERRIDES.items():
        run("go", "mod", "edit", f"-replace={module}={module}@{override}", cwd=module_dir, env=environment)
    run("go", "get", *(f"{module}@{floor}" for module, (floor, _) in DEPENDENCY_FLOORS.items()), cwd=module_dir, env=environment)
    run("go", "mod", "tidy", cwd=module_dir, env=environment)


def linked_overrides(info):
    """The overrides as linked into the otelcol binary described by info, for
    its manifest; a floor or replacement that did not take effect fails."""
    linked = {module.path: module.source[1] for module in info.modules}
    floors = []
    for module, (floor, reasons) in sorted(DEPENDENCY_FLOORS.items()):
        version = linked.get(module)
        if version is not None and not version_at_least(version, floor):
            raise OverrideError(f"{module} {version} is below its floor {floor}")
        floors.append({"module": module, "floor": floor, "linked": version, "reasons": reasons})
    replaces = []
    for module, (declared, override) in sorted(REPLACE_OVERRIDES.items()):
        version = linked.get(module)
        if module in linked and version != override:
            raise OverrideError(f"{module} links {version}, not the override {override}")
        replaces.append({"module": module, "builder_config": declared, "override": override, "linked": version})
    return {"builder_config": f"{BUILDER_CONFIG} (unmodified)", "dependency_floors": floors, "replace_overrides": replaces}


def build(output):
    spec = json.loads((Path(__file__).resolve().parents[1] / "beacon-source.json").read_text(encoding="utf-8"))
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="backplane-otelcol-build-") as directory:
        temporary = Path(directory)
        environment = dict(os.environ, CGO_ENABLED="0", GOTOOLCHAIN="local", GOBIN=str(temporary / "bin"))
        platform = json.loads(run("go", "env", "-json", "GOOS", "GOARCH", "GOVERSION", env=environment))
        require_go_toolchain(platform["GOVERSION"])
        binary_name = "beacon-otelcol.exe" if platform["GOOS"] == "windows" else "beacon-otelcol"
        source_root = download_source(spec, temporary)
        run("go", "install", "go.opentelemetry.io/collector/cmd/builder@" + BUILDER_VERSION, env=environment)
        builder_root = source_root / "collector-builder"
        (builder_root / "dist").mkdir(exist_ok=True)
        builder = str(temporary / "bin" / "builder")
        distribution = builder_root / "dist" / "beacon-otelcol"
        run(builder, "--config", "builder.yaml", "--skip-compilation", cwd=builder_root, env=environment)
        apply_generated_module_overrides(distribution, environment)
        run(builder, "--config", "builder.yaml", "--skip-generate", "--skip-get-modules", cwd=builder_root, env=environment)
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
            "cgo_enabled": False, "builder_version": BUILDER_VERSION, "builder_config": BUILDER_CONFIG,
            "generated_module_overrides": linked_overrides(licenses.read_build_info(output / binary_name)),
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
