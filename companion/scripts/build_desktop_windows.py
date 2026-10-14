#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""Build an unsigned x64 Windows installer of Backplane Companion (NSIS,
per-user) for internal QA, cross-built on this host with cargo-xwin. Nothing
is signed and no updater artifact is made; the build refuses to start while
signing material is in its environment, and refuses to finish if any
executable it produced carries an Authenticode signature.

The installer puts backplane-companion.exe, backplane-companiond.exe (the
same program for the GUI subsystem, run by the logon task) and beacon\\ beside
the GUI, under %LOCALAPPDATA%\\Programs\\Backplane Companion, the location
the app trusts, and embeds the WebView2 bootstrapper.

    PATH="$(brew --prefix llvm)/bin:$PATH" python3 scripts/build_desktop_windows.py --output dist/windows
"""

import json
import os
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

import build_bundle
import build_desktop
import desktop_payload
import licenses
from build_beacon import BeaconBuildError, download_source, run
from build_beacon_otelcol import BUILDER_VERSION, linked_overrides

BuildError = build_desktop.BuildError
GOOS, GOARCH = "windows", "amd64"
TARGET = "x86_64-pc-windows-msvc"
PACKAGE_SUFFIXES = ("-setup.exe",)
CROSS_TOOLS = ("cargo-xwin", "makensis", "clang-cl", "lld-link")
GUI = "backplane-companion-desktop.exe"
# IMAGE_DIRECTORY_ENTRY_SECURITY: the Authenticode certificate table.
_CERTIFICATE_TABLE = 4
_PE32_PLUS = 0x20B


def parse_arguments(argv=None):
    parser = desktop_payload.parse_arguments(__doc__, argv)
    return desktop_payload.refuse_updater_artifacts(parser, parser.parse_args(argv))


def preflight_toolchain():
    for tool in ("go", "pnpm", "cargo", "rustup", *CROSS_TOOLS):
        if not shutil.which(tool):
            raise BuildError(f"{tool} is not on PATH (clang-cl comes with Homebrew's llvm, lld-link with its separate lld formula)")
    if TARGET not in run("rustup", "target", "list", "--installed").split():
        raise BuildError(f"missing Rust target {TARGET} (rustup target add {TARGET})")


def tauri_overlay(payload, version):
    resources = {str(path): path.relative_to(payload).as_posix() for path in sorted(payload.rglob("*")) if path.is_file()}
    return {"version": version, "bundle": {"createUpdaterArtifacts": False, "resources": resources}}


def tauri_command(overlay_path):
    return ["pnpm", "tauri", "build", "--runner", "cargo-xwin", "--target", TARGET, "--bundles", "nsis", "--config", str(overlay_path),
            "--ci", "--", "--locked", "--offline"]


def tauri_environment(inherited):
    environment = {name: value for name, value in inherited.items() if not build_desktop._is_signing_variable(name)}
    environment["CI"] = "true"
    return environment


def package(payload, overlay_path, runner):
    """Checks the payload, then has Tauri build the installer."""
    desktop_payload.require_payload(payload, GOOS)
    runner(overlay_path)


def run_tauri(overlay_path):
    subprocess.run(tauri_command(overlay_path), cwd=build_desktop.DESKTOP, env=tauri_environment(os.environ), check=True)


def _authenticode_signed(path):
    with path.open("rb") as stream:
        headers = stream.read(4096)
    try:
        if headers[:2] != b"MZ":
            raise ValueError
        pe_header = struct.unpack_from("<I", headers, 0x3C)[0]
        if headers[pe_header:pe_header + 4] != b"PE\0\0":
            raise ValueError
        optional_header = pe_header + 4 + 20
        magic = struct.unpack_from("<H", headers, optional_header)[0]
        directories = optional_header + (112 if magic == _PE32_PLUS else 96)
        _, size = struct.unpack_from("<II", headers, directories + _CERTIFICATE_TABLE * 8)
    except (ValueError, struct.error):
        raise BuildError(f"{path.name} is not a Windows executable") from None
    return size != 0


def require_unsigned(paths):
    signed = [path.name for path in paths if _authenticode_signed(path)]
    if signed:
        raise BuildError(f"signed executables in an unsigned build: {', '.join(signed)}")


def build(arguments):
    build_desktop.refuse_signing_environment(os.environ)
    preflight_toolchain()
    version = arguments.version or json.loads((build_desktop.TAURI / "tauri.conf.json").read_text(encoding="utf-8"))["version"]
    spec = build_bundle.pinned_spec()
    commit, dirty = build_bundle.source_revision()
    host = json.loads(run("go", "env", "-json", "GOMODCACHE", "GOROOT"))
    output = arguments.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    release = build_desktop.TAURI / "target" / TARGET / "release"
    with tempfile.TemporaryDirectory(prefix="backplane-desktop-windows-") as directory:
        temporary = Path(directory)
        source = download_source(spec, temporary, arguments.beacon_archive.resolve() if arguments.beacon_archive else None)
        run("go", "install", "go.opentelemetry.io/collector/cmd/builder@" + BUILDER_VERSION,
            env=dict(os.environ, CGO_ENABLED="0", GOTOOLCHAIN="local", GOBIN=str(temporary / "bin")))
        binaries, infos = desktop_payload.build_go_binaries(temporary / "go", GOOS, GOARCH, version, commit, source, temporary / "bin" / "builder")
        go_version = infos["backplane-companion"].go_version
        payload = desktop_payload.stage_payload(temporary / "payload", binaries, spec, go_version, GOOS, GOARCH,
                                                otelcol_overrides=linked_overrides(infos["beacon-otelcol"]))
        go_entries = licenses.inventory(infos, Path(host["GOMODCACHE"]), beacon_license=source / "LICENSE")
        run("pnpm", "install", "--frozen-lockfile", "--offline", cwd=build_desktop.DESKTOP)
        rust = build_desktop.rust_entries([build_desktop.cargo_metadata(TARGET)])
        npm = build_desktop.npm_entries(json.loads(run("pnpm", "list", "--prod", "--json", "--depth", "Infinity", cwd=build_desktop.DESKTOP)))
        build_desktop.write_notices(payload, desktop_payload.WINDOWS_LAYOUT, version=version, commit=commit, dirty=dirty, spec=spec,
                                    go_version=go_version, go_root=Path(host["GOROOT"]), beacon_license=source / "LICENSE",
                                    go_entries=go_entries, rust=rust, npm=npm, signed=False)
        overlay_path = temporary / "tauri.windows.bundle.json"
        overlay_path.write_text(json.dumps(tauri_overlay(payload, version), indent=2), encoding="utf-8")
        package(payload, overlay_path, run_tauri)
        installer = release / "bundle" / "nsis" / f"{build_desktop.PRODUCT}_{version}_x64-setup.exe"
        if not installer.is_file():
            raise BuildError(f"Tauri did not produce {installer}")
        updater = [path.name for path in installer.parent.iterdir() if path.name.endswith(desktop_payload.UPDATER_SUFFIXES)]
        if updater:
            raise BuildError(f"updater artifacts were produced: {', '.join(updater)}")
        require_unsigned([installer, release / GUI, *sorted(payload.rglob("*.exe"))])
        shutil.copyfile(installer, output / installer.name)
    return {"output": str(output), "version": version, "commit": commit, "source_dirty": dirty, "signing": "none",
            "artifacts": desktop_payload.collect_artifacts(output, PACKAGE_SUFFIXES),
            "third_party": {"go": len(go_entries), "rust": len(rust), "npm": len(npm)}}


def main(argv=None):
    print(json.dumps(build(parse_arguments(argv)), indent=2))


if __name__ == "__main__":
    build_bundle.exit_on_termination()
    try:
        main()
    except (BuildError, build_bundle.BuildError, BeaconBuildError, licenses.LicenseError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"build_desktop_windows: {error}")
