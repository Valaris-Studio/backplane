#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""Build installable companion bundles: the companion with the pinned
beacon-hooks and beacon-otelcol, license notices, SHA256SUMS and manifest.json.

Every binary is built from source with CGO disabled, -trimpath, no VCS stamp
and an empty build id, so the same inputs (this checkout, the pinned Beacon
archive, the Go toolchain) give the same bytes. With --sign-macos the darwin
binaries are Developer ID signed and notarized (see macos_signing.py) before
anything records their checksums; the secure timestamp makes signed bytes
differ per run, so reproducibility holds for the unsigned build.

    python3 scripts/build_bundle.py --output dist --version 0.1.0
    python3 scripts/build_bundle.py --output dist --target host --beacon-archive beacon.tar.gz
    python3 scripts/build_bundle.py --output dist --version 0.1.0 --sign-macos
"""

import argparse
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

import bundle
import licenses
import macos_signing
from build_beacon import BeaconBuildError, download_source, require_go_toolchain, run
from build_beacon_otelcol import BUILDER_CONFIG, BUILDER_VERSION, apply_generated_module_overrides, linked_overrides

COMPANION = Path(__file__).resolve().parents[1]
TARGETS = ["darwin/arm64", "darwin/amd64", "linux/amd64", "linux/arm64", "windows/amd64"]
BUILDINFO = "github.com/Valaris-Studio/backplane/companion/internal/buildinfo"
COMPANION_LICENSE = "MIT"
COMPANION_LICENSE_FILE = COMPANION / "LICENSE"
# Beacon's self-updater lives in this module (cli/beacon, internal/ so no other
# module can import it); it must never be linked into a bundled binary.
BEACON_UPDATER_MODULE = licenses.BEACON_PREFIX + "cli/beacon"


class BuildError(RuntimeError):
    pass


def exe(goos, name):
    return name + ".exe" if goos == "windows" else name


def go_environment(goos, goarch, **overrides):
    environment = dict(os.environ, CGO_ENABLED="0", GOOS=goos, GOARCH=goarch, GOTOOLCHAIN="local", GOFLAGS="-mod=readonly")
    environment.update(overrides)
    return environment


def pinned_spec():
    spec = json.loads((COMPANION / "beacon-source.json").read_text(encoding="utf-8"))
    compiled = re.search(r'const Commit = "([0-9a-f]{40})"', (COMPANION / "internal" / "beacon" / "beacon.go").read_text(encoding="utf-8"))
    if not compiled or compiled.group(1) != spec["commit"]:
        raise BuildError("beacon-source.json and internal/beacon.Commit name different Beacon commits")
    return spec


def source_revision():
    commit = run("git", "-C", str(COMPANION), "rev-parse", "HEAD")
    dirty = bool(run("git", "-C", str(COMPANION), "status", "--porcelain", "--", "."))
    return commit, dirty


def links_beacon_updater(info):
    return info.main == BEACON_UPDATER_MODULE or any(module.path == BEACON_UPDATER_MODULE for module in info.modules)


def build_companion(stage, goos, goarch, version, commit):
    flags = f"-buildid= -X {BUILDINFO}.Version={version} -X {BUILDINFO}.Commit={commit}"
    binaries = [(exe(goos, "backplane-companion"), flags)]
    if goos == "windows":
        # Same program for the GUI subsystem: the logon task opens no console.
        binaries.append(("backplane-companiond.exe", flags + " -H=windowsgui"))
    for name, ldflags in binaries:
        run("go", "build", "-trimpath", "-buildvcs=false", "-ldflags=" + ldflags, "-o", str(stage / name), "./cmd/backplane-companion",
            cwd=COMPANION, env=go_environment(goos, goarch))
    return [name for name, _ in binaries]


def build_hooks(source, stage, goos, goarch):
    target = stage / "beacon" / exe(goos, "beacon-hooks")
    run("go", "build", "-trimpath", "-buildvcs=false", "-ldflags=-buildid=", "-o", str(target), ".",
        cwd=source / "cli" / "beacon-hooks", env=go_environment(goos, goarch))
    return target


def build_otelcol(source, stage, goos, goarch, builder):
    builder_root = source / "collector-builder"
    distribution = builder_root / "dist" / "beacon-otelcol"
    shutil.rmtree(distribution, ignore_errors=True)
    distribution.mkdir(parents=True)
    # The builder only generates the module; compiling it here gives it the
    # same reproducibility flags as the other binaries (-s -w matches the
    # builder's own non-debug build).
    run(str(builder), "--config", "builder.yaml", "--skip-compilation", cwd=builder_root,
        env=go_environment(goos, goarch, GOFLAGS=""))
    relative_local_replacements(distribution / "go.mod", distribution)
    apply_generated_module_overrides(distribution, go_environment(goos, goarch, GOFLAGS=""))
    target = stage / "beacon" / exe(goos, "beacon-otelcol")
    run("go", "build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w -buildid=", "-o", str(target), ".",
        cwd=distribution, env=go_environment(goos, goarch))
    return target


def relative_local_replacements(go_mod, module_dir):
    """The builder writes local replacements as absolute paths, which would
    embed this build's temporary directory in the binary's build info."""
    def relative(match):
        return match.group(1) + os.path.relpath(Path(match.group(2)).resolve(), module_dir.resolve())
    go_mod.write_text(re.sub(r"^(replace .+ => )(/\S+)$", relative, go_mod.read_text(encoding="utf-8"), flags=re.MULTILINE), encoding="utf-8")


def go_license(go_root):
    # Some distributions (e.g. Homebrew) keep it beside GOROOT, not in it.
    for candidate in (go_root / "LICENSE", go_root.parent / "LICENSE"):
        if candidate.is_file():
            return candidate
    raise BuildError("Go toolchain license notice not found")


def artifact_manifest(binary, spec, goos, goarch, go_version, **extra):
    """The manifest the companion verifies before running a Beacon binary."""
    return {
        "path": binary.name, "sha256": bundle.sha256(binary), "source_commit": spec["commit"],
        "source_archive_sha256": spec["archive_sha256"], "goos": goos, "goarch": goarch,
        "go_version": go_version, "cgo_enabled": False, "license": "MIT", "notices": ["../LICENSES/beacon-MIT.txt"], **extra,
    }


def build_target(target, output, source, builder, spec, version, commit, dirty, gomodcache, go_root, signing=None):
    goos, goarch = target.split("/")
    stage = output / f"backplane-companion-{version}-{goos}-{goarch}"
    shutil.rmtree(stage, ignore_errors=True)
    # A build that fails (e.g. notarization) must not leave an earlier archive
    # under the name this one would have taken.
    for suffix in (".tar.gz", ".zip"):
        (output / (stage.name + suffix)).unlink(missing_ok=True)
    (stage / "beacon").mkdir(parents=True)
    companions = build_companion(stage, goos, goarch, version, commit)
    hooks = build_hooks(source, stage, goos, goarch)
    otelcol = build_otelcol(source, stage, goos, goarch, builder)
    # Before anything reads or records the binaries: the Beacon manifests must
    # hold the signed bytes' sha256 or the companion refuses to run them.
    notarization = None
    if signing and goos == "darwin":
        notarization = macos_signing.release([stage / name for name in companions] + [hooks, otelcol], signing)
    infos = {"backplane-companion": licenses.read_build_info(stage / companions[0]),
             "beacon-hooks": licenses.read_build_info(hooks), "beacon-otelcol": licenses.read_build_info(otelcol)}
    for name, info in infos.items():
        if links_beacon_updater(info):
            raise BuildError(f"{name} links Beacon's self-updater ({BEACON_UPDATER_MODULE})")
        require_go_toolchain(info.go_version, built=name)
    go_version = infos["backplane-companion"].go_version
    (stage / "beacon" / "artifact.json").write_text(json.dumps(artifact_manifest(hooks, spec, goos, goarch, go_version), indent=2) + "\n", encoding="utf-8")
    (stage / "beacon" / "otelcol.json").write_text(json.dumps(artifact_manifest(
        otelcol, spec, goos, goarch, go_version, builder_version=BUILDER_VERSION, builder_config=BUILDER_CONFIG,
        generated_module_overrides=linked_overrides(infos["beacon-otelcol"])), indent=2) + "\n", encoding="utf-8")

    notices_dir = stage / "LICENSES"
    notices_dir.mkdir()
    own = {"LICENSES/backplane-companion-MIT.txt": COMPANION_LICENSE_FILE,
           "LICENSES/beacon-MIT.txt": source / "LICENSE", "LICENSES/go-BSD-3-Clause.txt": go_license(go_root)}
    for name, source_file in own.items():
        shutil.copyfile(source_file, stage / name)
    entries = licenses.inventory(infos, gomodcache, beacon_license=source / "LICENSE")
    placed = bundle.copy_licenses(entries, stage, {source / "LICENSE": "LICENSES/beacon-MIT.txt"})
    header = [
        f"Backplane companion {version} for {goos}/{goarch}: third-party notices",
        "",
        f"backplane-companion: {COMPANION_LICENSE} (LICENSES/backplane-companion-MIT.txt)",
        f"beacon-hooks, beacon-otelcol: MIT, Asymptote Labs agent-beacon {spec['commit']} (LICENSES/beacon-MIT.txt)",
        f"Go standard library and runtime {go_version}: BSD-3-Clause (LICENSES/go-BSD-3-Clause.txt)",
        "",
        "Every Go module linked into these binaries follows, with its license text.",
    ]
    (stage / "THIRD_PARTY_NOTICES.txt").write_text(bundle.notices(header, entries, placed), encoding="utf-8")
    companion_notices = ["LICENSES/backplane-companion-MIT.txt", "LICENSES/go-BSD-3-Clause.txt"]
    beacon_notices = ["LICENSES/beacon-MIT.txt", "LICENSES/go-BSD-3-Clause.txt"]
    components = [bundle.component(stage, name, name, COMPANION_LICENSE, companion_notices, version=version, commit=commit) for name in companions]
    components += [
        bundle.component(stage, "beacon-hooks", "beacon/" + hooks.name, "MIT", beacon_notices, source_commit=spec["commit"]),
        bundle.component(stage, "beacon-otelcol", "beacon/" + otelcol.name, "MIT", beacon_notices, source_commit=spec["commit"], builder_version=BUILDER_VERSION),
    ]
    macos_signing_state = {"signed": signing is not None, "notarization": notarization} if goos == "darwin" else None
    manifest = bundle.manifest(version=version, commit=commit, source_dirty=dirty, goos=goos, goarch=goarch, go_version=go_version,
                               components=components, entries=entries, placed=placed, macos_signing=macos_signing_state)
    (stage / bundle.MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    bundle.write_checksums(stage)
    return stage, manifest, notarization


def macos_signing_for(targets, *, notarize):
    if not any(target.startswith("darwin/") for target in targets):
        raise BuildError("--sign-macos needs a darwin target")
    signing = macos_signing.from_environment(os.environ, notarize=notarize, system=platform.system())
    macos_signing.scrub_notary_environment(os.environ)
    macos_signing.preflight(signing)
    return signing


def exit_on_termination():
    # The default SIGTERM action skips `with` cleanup, which would leave the
    # decoded notary key on disk.
    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(128 + signum))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--target", action="append", help="goos/goarch or 'host'; repeatable (default: all release targets)")
    parser.add_argument("--version", default="0.0.0-dev")
    parser.add_argument("--beacon-archive", type=Path, help="a local copy of the pinned Beacon source archive")
    parser.add_argument("--no-archive", action="store_true", help="leave the bundle directories unarchived")
    parser.add_argument("--sign-macos", action="store_true", help="Developer ID sign and notarize the darwin binaries (macOS host)")
    parser.add_argument("--skip-notarize", action="store_true", help="with --sign-macos: sign only, for a local test")
    arguments = parser.parse_args()
    if arguments.skip_notarize and not arguments.sign_macos:
        parser.error("--skip-notarize needs --sign-macos")
    host = json.loads(run("go", "env", "-json", "GOOS", "GOARCH", "GOMODCACHE", "GOROOT"))
    targets = [f"{host['GOOS']}/{host['GOARCH']}" if target == "host" else target for target in (arguments.target or TARGETS)]
    unknown = [target for target in targets if target not in TARGETS]
    if unknown:
        raise BuildError(f"unsupported targets: {', '.join(unknown)}")
    signing = macos_signing_for(targets, notarize=not arguments.skip_notarize) if arguments.sign_macos else None
    spec = pinned_spec()
    commit, dirty = source_revision()
    output = arguments.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    results = {}
    with tempfile.TemporaryDirectory(prefix="backplane-bundle-") as directory:
        temporary = Path(directory)
        source = download_source(spec, temporary, arguments.beacon_archive.resolve() if arguments.beacon_archive else None)
        run("go", "install", "go.opentelemetry.io/collector/cmd/builder@" + BUILDER_VERSION,
            env=dict(os.environ, CGO_ENABLED="0", GOTOOLCHAIN="local", GOBIN=str(temporary / "bin")))
        for target in targets:
            stage, manifest, notarization = build_target(target, output, source, temporary / "bin" / "builder", spec, arguments.version,
                                                         commit, dirty, Path(host["GOMODCACHE"]), Path(host["GOROOT"]), signing)
            archived = None if arguments.no_archive else bundle.archive(stage, output, manifest["target"]["goos"])
            results[target] = {"bundle": str(stage), "archive": str(archived) if archived else None,
                               "third_party_modules": len(manifest["third_party"]), "license_flags": manifest["license_flags"]}
            if signing and manifest["target"]["goos"] == "darwin":
                results[target]["notarization"] = notarization or "skipped"

    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    exit_on_termination()
    try:
        main()
    except (BuildError, BeaconBuildError, licenses.LicenseError, macos_signing.SigningError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"build_bundle: {error}")
