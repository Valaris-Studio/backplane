#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""Build unsigned x86_64 Linux packages of Backplane Companion (deb, rpm and
AppImage) for internal QA. Nothing is signed and no updater artifact is made;
the build refuses to start while signing material is in its environment.

The Go companion and Beacon are cross-built here; the Tauri shell is built
and bundled in the linux-builder container (Ubuntu 22.04, the glibc floor)
from a private copy of the desktop source, with Cargo's target directory,
registry and the pnpm store in named volumes.

deb and rpm install everything into /usr/lib/backplane-companion, the root-owned
location the app trusts, with /usr/bin/backplane-companion-desktop a launcher
that runs the GUI from there. The AppImage carries the companion beside the
GUI with its sha256, which the app checks before staging it out of the mount.

    docker build --platform linux/amd64 -t backplane-linux-builder:amd64 scripts/linux-builder
    python3 scripts/build_desktop_linux.py --output dist/linux
"""

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

import build_bundle
import build_desktop
import desktop_payload
import licenses
from build_beacon import download_source, run
from build_beacon_otelcol import BUILDER_VERSION

BuildError = build_desktop.BuildError
GOOS, GOARCH = "linux", "amd64"
TARGET = "x86_64-unknown-linux-gnu"
PACKAGE_SUFFIXES = (".deb", ".rpm", ".AppImage")
INSTALL_ROOT = "/usr/lib/backplane-companion"
GUI = "backplane-companion-desktop"
BUILDER_IMAGE = "backplane-linux-builder:amd64"
# Named volumes: a bind-mounted target directory would put Linux build output
# into the checkout and makes emulated builds far slower.
CONTAINER_VOLUMES = {"backplane-desktop-linux-cargo-target": "/cargo-target",
                     "backplane-desktop-linux-cargo-registry": "/usr/local/cargo/registry",
                     "backplane-desktop-linux-pnpm-store": "/pnpm-store"}
CONTAINER_CONTEXT, CONTAINER_OUTPUT = Path("/context"), Path("/out")
OVERLAY = "tauri.linux.bundle.json"
RPM_POST_REMOVE = "rpm-postun.sh"
# Tauri downloads this plugin from the moving `continuous` tag when its cache
# has none, and zeroes the AppImage magic bytes of linuxdeploy but not of the
# plugin; under Docker's amd64 emulation an AppImage with its magic intact
# fails with "Exec format error". So a pinned, checked release is cached first.
APPIMAGE_PLUGIN = "linuxdeploy-plugin-appimage.AppImage"
APPIMAGE_PLUGIN_URL = ("https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/1-alpha-20250213-1/"
                       "linuxdeploy-plugin-appimage-x86_64.AppImage")
APPIMAGE_PLUGIN_SHA256 = "992d502a248e14ab185448ddf6f6e7d25558cb84d4623c354c3af350c25fccb3"
RPM_TARGET_DIR = Path("/work/rpm-target")
_TAURI_APPIMAGE_PLUGIN = '"${XDG_CACHE_HOME:-$HOME/.cache}/tauri/linuxdeploy-plugin-appimage.AppImage"'
# Excluded from the private source copy: host builds and host node_modules.
SOURCE_EXCLUDES = ("node_modules", "target", "dist", "test-results", "playwright-report")
_TAURI_DEPENDENCY = re.compile(r'^(tauri = \{ version = "[^"]+", features = \[)([^\]]*)(\] \})$', re.MULTILINE)
_POSITIONER_ENABLES_TRAY = re.compile(r'^tauri-plugin-positioner = \{[^\n]*features = \[[^\]]*"tray-icon"', re.MULTILINE)


def parse_arguments(argv=None):
    parser = desktop_payload.parse_arguments(__doc__, argv)
    parser.add_argument("--no-container", action="store_true", help="run Tauri on this Linux host instead of the builder container")
    parser.add_argument("--image", default=BUILDER_IMAGE, help=f"the linux-builder image (default: {BUILDER_IMAGE})")
    return desktop_payload.refuse_updater_artifacts(parser, parser.parse_args(argv))


def preflight_toolchain(system, container):
    if not container and system != "Linux":
        raise BuildError(f"the Linux packages build in the linux-builder container on a {system} host; drop --no-container")
    tools = ("go", "pnpm", "cargo", "docker") if container else ("go", "pnpm", "cargo", "dpkg-deb")
    for tool in tools:
        if not shutil.which(tool):
            raise BuildError(f"{tool} is not on PATH")


def without_cli_tray_probe(cargo_toml):
    """The Cargo manifest the Tauri CLI reads in the private copy. On Linux
    the CLI (2.12) treats a literal `tray-icon` feature on the tauri dependency
    as a libappindicator tray: it adds libayatana-appindicator to the deb and
    rpm dependencies and the AppImage, and panics when pkg-config cannot find
    it. The tray is ksni over D-Bus (D1), so the copy leaves that feature to
    tauri-plugin-positioner, which enables tauri/tray-icon itself: the
    compiled crate graph is unchanged."""
    if not _POSITIONER_ENABLES_TRAY.search(cargo_toml):
        raise BuildError("tauri-plugin-positioner no longer enables tray-icon; the tray feature cannot be moved off the tauri dependency")
    match = _TAURI_DEPENDENCY.search(cargo_toml)
    if not match:
        raise BuildError("the tauri dependency line in Cargo.toml is not in the expected form")
    features = [feature.strip() for feature in match.group(2).split(",") if feature.strip() and feature.strip() != '"tray-icon"']
    return cargo_toml[:match.start()] + match.group(1) + ", ".join(features) + match.group(3) + cargo_toml[match.end():]


def copy_desktop_source(target):
    shutil.copytree(build_desktop.DESKTOP, target, ignore=shutil.ignore_patterns(*SOURCE_EXCLUDES))
    manifest = target / "src-tauri" / "Cargo.toml"
    manifest.write_text(without_cli_tray_probe(manifest.read_text(encoding="utf-8")), encoding="utf-8")
    return target


def write_launcher(path):
    # exec keeps the GUI's own path as its executable, which is what the
    # install-location check reads; a copy in /usr/bin would be untrusted.
    path.write_text(f'#!/bin/sh\nexec {INSTALL_ROOT}/{GUI} "$@"\n', encoding="utf-8")
    path.chmod(0o755)
    return path


def write_rpm_post_remove(path, install_root=INSTALL_ROOT):
    # Tauri's rpm lists files but no directories, so rpm leaves every
    # directory of the install behind. rpm passes %postun the count of this
    # package still installed: 0 on erase, 1 during an upgrade.
    path.write_text(f'#!/bin/sh\n# Deliberately no set -e: a failing find must never block the package erase.\n'
                    f'if [ "$1" = 0 ] && [ -d "{install_root}" ]; then\n'
                    f'  find "{install_root}" -depth -type d -empty -delete\nfi\nexit 0\n', encoding="utf-8")
    path.chmod(0o755)
    return path


def tauri_overlay(context, target_dir, version):
    payload = str(context / "payload")
    installed = {INSTALL_ROOT: payload, f"{INSTALL_ROOT}/{GUI}": str(target_dir / TARGET / "release" / GUI)}
    # The deb's files are copied over Tauri's /usr/bin copy of the GUI; the rpm
    # gets the launcher as its main binary instead (container_script).
    return {"version": version, "bundle": {"createUpdaterArtifacts": False, "linux": {
        "deb": {"files": {**installed, f"/usr/bin/{GUI}": str(context / "launcher")}},
        "rpm": {"files": installed, "postRemoveScript": str(context / RPM_POST_REMOVE)},
        "appimage": {"files": {"/usr/bin": payload}},
    }}}


def tauri_command(overlay_path):
    return ["pnpm", "tauri", "build", "--target", TARGET, "--bundles", "deb,appimage", "--config", str(overlay_path), "--ci",
            "--", "--locked"]


def rpm_bundle_command(overlay_path):
    return ["pnpm", "tauri", "bundle", "--target", TARGET, "--bundles", "rpm", "--config", str(overlay_path), "--ci"]


def fetch_appimage_plugin(target, urlopen=urllib.request.urlopen):
    with urlopen(APPIMAGE_PLUGIN_URL, timeout=60) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != APPIMAGE_PLUGIN_SHA256:
        raise BuildError(f"{APPIMAGE_PLUGIN_URL} does not match its pinned sha256")
    target.write_bytes(data)
    return target


def container_script(context, output, target_dir, pnpm_store, work=Path("/work/desktop"), rpm_target_dir=RPM_TARGET_DIR):
    bundle_dir = target_dir / TARGET / "release" / "bundle"
    # The rpm builder keeps Tauri's /usr/bin copy of the main binary over any
    # `files` entry for that path, so the rpm is bundled from a private target
    # dir whose main binary is the launcher; the GUI comes from `files`.
    rpm_release = rpm_target_dir / TARGET / "release"
    store = f" --store-dir {pnpm_store}" if pnpm_store else ""
    return "\n".join([
        "set -euo pipefail",
        f"if [ -d {bundle_dir} ]; then find {bundle_dir} -delete; fi",
        f"cp -a {context}/desktop {work}",
        f"cd {work}",
        f"pnpm install --frozen-lockfile{store}",
        'mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}/tauri"',
        f"install -m 755 {context}/{APPIMAGE_PLUGIN} {_TAURI_APPIMAGE_PLUGIN}",
        f"dd if=/dev/zero bs=1 count=3 seek=8 conv=notrunc of={_TAURI_APPIMAGE_PLUGIN}",
        f"CARGO_TARGET_DIR={target_dir} " + " ".join(tauri_command(context / OVERLAY)),
        f"install -D -m 755 {context}/launcher {rpm_release}/{GUI}",
        f"CARGO_TARGET_DIR={rpm_target_dir} " + " ".join(rpm_bundle_command(context / OVERLAY)),
        f"cp {bundle_dir}/deb/*.deb {rpm_release}/bundle/rpm/*.rpm {bundle_dir}/appimage/*.AppImage {output}/",
    ]) + "\n"


def docker_command(context, output, script, image=BUILDER_IMAGE):
    command = ["docker", "run", "--rm", "--platform", "linux/amd64",
               "-v", f"{context}:{CONTAINER_CONTEXT}:ro", "-v", f"{output}:{CONTAINER_OUTPUT}"]
    for volume, inside in CONTAINER_VOLUMES.items():
        command += ["-v", f"{volume}:{inside}"]
    return command + [image, "bash", "-c", script]


def package(context, output, runner):
    """Checks the payload, then has Tauri build the three packages into output."""
    desktop_payload.require_payload(context / "payload", GOOS)
    output.mkdir(parents=True, exist_ok=True)
    runner(context, output)


def container_runner(image):
    def run_in_container(context, output):
        script = container_script(CONTAINER_CONTEXT, CONTAINER_OUTPUT, Path(CONTAINER_VOLUMES["backplane-desktop-linux-cargo-target"]),
                                  Path(CONTAINER_VOLUMES["backplane-desktop-linux-pnpm-store"]))
        subprocess.run(docker_command(context, output, script, image), check=True)
    return run_in_container


def local_runner(context, output):
    target_dir = build_desktop.TAURI / "target"
    script = container_script(context, output, target_dir, None, work=context / "work", rpm_target_dir=context / "rpm-target")
    subprocess.run(["bash", "-c", script], check=True, env=dict(os.environ, CI="true"))


def check_depends(depends):
    names = [dependency.strip().split(" ")[0] for dependency in depends.split(",") if dependency.strip()]
    if any("appindicator" in name for name in names):
        raise BuildError(f"the deb depends on an appindicator library ({depends}); the tray is ksni (D1)")
    if "libwebkit2gtk-4.1-0" not in names:
        raise BuildError(f"the deb does not depend on WebKitGTK 4.1 ({depends})")


def debian_depends(deb, container, image):
    if container:
        command = ["docker", "run", "--rm", "--platform", "linux/amd64", "-v", f"{deb.parent}:{CONTAINER_OUTPUT}:ro", image,
                   "dpkg-deb", "-f", str(CONTAINER_OUTPUT / deb.name), "Depends"]
    else:
        command = ["dpkg-deb", "-f", str(deb), "Depends"]
    return run(*command)


def build(arguments):
    build_desktop.refuse_signing_environment(os.environ)
    container = not arguments.no_container
    preflight_toolchain(platform.system(), container)
    version = arguments.version or json.loads((build_desktop.TAURI / "tauri.conf.json").read_text(encoding="utf-8"))["version"]
    spec = build_bundle.pinned_spec()
    commit, dirty = build_bundle.source_revision()
    host = json.loads(run("go", "env", "-json", "GOMODCACHE", "GOROOT"))
    output = arguments.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="backplane-desktop-linux-") as directory:
        temporary = Path(directory)
        context = temporary / "context"
        source = download_source(spec, temporary, arguments.beacon_archive.resolve() if arguments.beacon_archive else None)
        run("go", "install", "go.opentelemetry.io/collector/cmd/builder@" + BUILDER_VERSION,
            env=dict(os.environ, CGO_ENABLED="0", GOTOOLCHAIN="local", GOBIN=str(temporary / "bin")))
        binaries, infos = desktop_payload.build_go_binaries(temporary / "go", GOOS, GOARCH, version, commit, source, temporary / "bin" / "builder")
        go_version = infos["backplane-companion"].go_version
        payload = desktop_payload.stage_payload(context / "payload", binaries, spec, go_version, GOOS, GOARCH)
        go_entries = licenses.inventory(infos, Path(host["GOMODCACHE"]), beacon_license=source / "LICENSE")
        run("pnpm", "install", "--frozen-lockfile", "--offline", cwd=build_desktop.DESKTOP)
        rust = build_desktop.rust_entries([build_desktop.cargo_metadata(TARGET)])
        npm = build_desktop.npm_entries(json.loads(run("pnpm", "list", "--prod", "--json", "--depth", "Infinity", cwd=build_desktop.DESKTOP)))
        build_desktop.write_notices(payload, desktop_payload.LINUX_LAYOUT, version=version, commit=commit, dirty=dirty, spec=spec,
                                    go_version=go_version, go_root=Path(host["GOROOT"]), beacon_license=source / "LICENSE",
                                    go_entries=go_entries, rust=rust, npm=npm, signed=False)
        write_launcher(context / "launcher")
        write_rpm_post_remove(context / RPM_POST_REMOVE)
        fetch_appimage_plugin(context / APPIMAGE_PLUGIN)
        copy_desktop_source(context / "desktop")
        overlay_context = CONTAINER_CONTEXT if container else context
        target_dir = Path(CONTAINER_VOLUMES["backplane-desktop-linux-cargo-target"]) if container else build_desktop.TAURI / "target"
        (context / OVERLAY).write_text(json.dumps(tauri_overlay(overlay_context, target_dir, version), indent=2), encoding="utf-8")
        package(context, output, container_runner(arguments.image) if container else local_runner)
    artifacts = desktop_payload.collect_artifacts(output, PACKAGE_SUFFIXES)
    deb = next(output / artifact["file"] for artifact in artifacts if artifact["file"].endswith(".deb"))
    depends = debian_depends(deb, container, arguments.image)
    check_depends(depends)
    return {"output": str(output), "version": version, "commit": commit, "source_dirty": dirty, "signing": "none",
            "deb_depends": depends, "artifacts": artifacts,
            "third_party": {"go": len(go_entries), "rust": len(rust), "npm": len(npm)}}


def main(argv=None):
    print(json.dumps(build(parse_arguments(argv)), indent=2))


if __name__ == "__main__":
    build_bundle.exit_on_termination()
    try:
        main()
    except (BuildError, build_bundle.BuildError, licenses.LicenseError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"build_desktop_linux: {error}")
