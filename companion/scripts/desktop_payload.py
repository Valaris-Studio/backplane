# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""The part of the Linux and Windows desktop packages that is not the Tauri
shell: the Go companion and the pinned Beacon binaries with their manifests
and every license, laid out as they are installed beside the GUI binary.
The companion looks for Beacon in `beacon/` beside itself on both systems."""

import argparse
import json
import shutil
from pathlib import Path

import build_bundle
import build_desktop
import bundle
import licenses
from build_beacon import require_go_toolchain
from build_beacon_otelcol import BUILDER_CONFIG, BUILDER_VERSION

BuildError = build_desktop.BuildError
BEACON = "beacon"
# `sha256sum` output for the companion: an AppImage stages the companion out
# of its mount only when the copy matches it (desktop platform/appimage.rs).
COMPANION_DIGEST = "backplane-companion.sha256"
# Updater archives and their minisign signatures; none may be produced while
# the updater is off on Linux and Windows (D6) and nothing is signed.
UPDATER_SUFFIXES = (".sig", ".tar.gz", ".zip")


def _layout(platform, goos, companions):
    return build_desktop.PayloadLayout(platform, goos, "amd64", "", companions, f"{BEACON}/{build_bundle.exe(goos, 'beacon-hooks')}",
                                       f"{BEACON}/{build_bundle.exe(goos, 'beacon-otelcol')}")


LINUX_LAYOUT = _layout("Linux (x86_64)", "linux", ("backplane-companion",))
WINDOWS_LAYOUT = _layout("Windows (x64)", "windows", ("backplane-companion.exe", "backplane-companiond.exe"))
LAYOUTS = {"linux": LINUX_LAYOUT, "windows": WINDOWS_LAYOUT}


def parse_arguments(description, argv):
    parser = argparse.ArgumentParser(description=description, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--version", help="app and companion version (default: tauri.conf.json's)")
    parser.add_argument("--beacon-archive", type=Path, help="a local copy of the pinned Beacon source archive")
    # Accepted only to refuse it by name rather than as an unknown flag.
    parser.add_argument("--updater-artifacts", action="store_true", help=argparse.SUPPRESS)
    return parser


def refuse_updater_artifacts(parser, arguments):
    if arguments.updater_artifacts:
        parser.error("--updater-artifacts: there is no updater on Linux or Windows (D6) and this build is never signed")
    return arguments


def build_go_binaries(stage, goos, goarch, version, commit, source, builder):
    """The companion and Beacon binaries by file name, and each component's
    build info for the license inventory."""
    (stage / BEACON).mkdir(parents=True, exist_ok=True)
    companions = build_bundle.build_companion(stage, goos, goarch, version, commit)
    hooks = build_bundle.build_hooks(source, stage, goos, goarch)
    otelcol = build_bundle.build_otelcol(source, stage, goos, goarch, builder)
    binaries = {name: stage / name for name in companions}
    binaries.update({hooks.name: hooks, otelcol.name: otelcol})
    infos = {"backplane-companion": licenses.read_build_info(stage / companions[0]),
             "beacon-hooks": licenses.read_build_info(hooks), "beacon-otelcol": licenses.read_build_info(otelcol)}
    for name, info in infos.items():
        if build_bundle.links_beacon_updater(info):
            raise BuildError(f"{name} links Beacon's self-updater ({build_bundle.BEACON_UPDATER_MODULE})")
        require_go_toolchain(info.go_version, built=name)
    return binaries, infos


def stage_payload(payload, binaries, spec, go_version, goos, goarch, *, otelcol_overrides):
    layout = LAYOUTS[goos]
    placements = {Path(path).name: path for path in (*layout.companions, layout.beacon_hooks, layout.beacon_otelcol)}
    missing = sorted(set(placements) - set(binaries))
    if missing:
        raise BuildError(f"missing {goos} binaries: {', '.join(missing)}")
    for name, relative in placements.items():
        target = payload / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(binaries[name], target)
        target.chmod(0o755)
    hooks, otelcol = payload / layout.beacon_hooks, payload / layout.beacon_otelcol
    (payload / BEACON / "artifact.json").write_text(json.dumps(
        build_bundle.artifact_manifest(hooks, spec, goos, goarch, go_version), indent=2) + "\n", encoding="utf-8")
    (payload / BEACON / "otelcol.json").write_text(json.dumps(build_bundle.artifact_manifest(
        otelcol, spec, goos, goarch, go_version, builder_version=BUILDER_VERSION, builder_config=BUILDER_CONFIG,
        generated_module_overrides=otelcol_overrides), indent=2) + "\n", encoding="utf-8")
    if goos == "linux":
        companion = payload / layout.companions[0]
        (payload / COMPANION_DIGEST).write_text(f"{bundle.sha256(companion)}  {companion.name}\n", encoding="utf-8")
    return payload


def required_files(goos):
    layout = LAYOUTS[goos]
    required = [*layout.companions, layout.beacon_hooks, layout.beacon_otelcol, f"{BEACON}/artifact.json", f"{BEACON}/otelcol.json",
                "LICENSES/backplane-companion-MIT.txt", "LICENSES/beacon-MIT.txt", "THIRD_PARTY_NOTICES.txt", bundle.MANIFEST]
    if goos == "linux":
        required.append(COMPANION_DIGEST)
    return required


def require_payload(payload, goos):
    missing = [relative for relative in required_files(goos) if not (payload / relative).is_file()]
    if missing:
        raise BuildError(f"the {goos} payload is incomplete, missing: {', '.join(missing)}")


def collect_artifacts(directory, suffixes):
    """Each package with its size and sha256; exactly one per suffix, and
    never an updater archive or signature."""
    files = sorted(path for path in directory.iterdir() if path.is_file())
    updater = [path.name for path in files if path.name.endswith(UPDATER_SUFFIXES)]
    if updater:
        raise BuildError(f"updater artifacts were produced: {', '.join(updater)}")
    artifacts = []
    for suffix in suffixes:
        matches = [path for path in files if path.name.endswith(suffix)]
        if len(matches) != 1:
            raise BuildError(f"expected one {suffix} package in {directory}, found {len(matches)}")
        artifacts.append({"file": matches[0].name, "bytes": matches[0].stat().st_size, "sha256": bundle.sha256(matches[0])})
    return artifacts
