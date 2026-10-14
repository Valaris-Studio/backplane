#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""Build Backplane Companion.app and its DMG: the Tauri shell carrying the
universal Go companion and the pinned Beacon artifacts, with every license.

The companion and Beacon binaries are built per architecture exactly as
build_bundle.py builds them, joined with lipo, signed (Developer ID with
--sign, ad hoc otherwise) and only then hashed into the Beacon manifests.
Tauri copies them in through bundle.macOS.files, which it never re-signs:
an externalBin sidecar would be re-signed with the webview's entitlements.

    python3 scripts/build_desktop.py --output dist/desktop
    python3 scripts/build_desktop.py --output dist/desktop --sign --skip-notarize
    python3 scripts/build_desktop.py --output dist/desktop --sign
    python3 scripts/build_desktop.py --output dist/desktop --sign --updater-artifacts

--sign reads DEVELOPER_ID_APP and, unless --skip-notarize, AC_API_KEY_ID,
AC_API_ISSUER and AC_API_KEY_P8 (see macos_signing.py). Tauri signs and
notarizes the app and staples it; this script then notarizes and staples the DMG.

--updater-artifacts also has Tauri emit the signed in-app update archive
(.app.tar.gz + .sig), with the updater key from ~/.backplane-signing
(tauri-updater.key, and tauri-updater.env for its password), which never
leaves that directory: Tauri gets the key's path, not its contents.
"""

import argparse
import contextlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import build_bundle
import bundle
import licenses
import macos_signing
from build_beacon import download_source, run
from build_beacon_otelcol import BUILDER_VERSION

COMPANION = build_bundle.COMPANION
DESKTOP = COMPANION / "desktop"
TAURI = DESKTOP / "src-tauri"
ENTITLEMENTS = TAURI / "Entitlements.plist"
PRODUCT = "Backplane Companion"
DESKTOP_PACKAGE = "backplane-companion-desktop"
UNIVERSAL_TRIPLE = "universal-apple-darwin"
COMPANION_UNIVERSAL = "backplane-companion-" + UNIVERSAL_TRIPLE
# lipo order; manifests list them sorted.
ARCHITECTURES = ("arm64", "amd64")
RUST_TARGETS = ("aarch64-apple-darwin", "x86_64-apple-darwin")
AD_HOC = "-"
# Contents-relative paths Tauri copies in verbatim (bundle.macOS.files).
PREBUILT_CONTENTS = ("MacOS/backplane-companion", "Resources/beacon", "Resources/LICENSES",
                     "Resources/THIRD_PARTY_NOTICES.txt", "Resources/manifest.json")
# Declared (SPDX) licenses of the Rust crates and npm packages; the Go
# modules keep licenses.py's stricter text-based judgement.
DECLARED_ALLOWED = licenses.ALLOWED | {"Unicode-3.0", "Unicode-DFS-2016", "Zlib", "Unlicense", "CC0-1.0", "MIT-0", "0BSD", "BSL-1.0"}
# Inherited variables that name or carry signing material; no child gets them.
# AZURE_ covers Azure Trusted Signing (the planned Windows path, D5); nothing
# in these builds reads any other Azure variable.
_SIGNING_VARIABLE_PREFIXES = ("APPLE_", "AC_API_", "SPARKLE_", "TAURI_SIGNING_", "WINDOWS_CERTIFICATE", "AZURE_", "GPG_", "SIGNTOOL")
_SIGNING_VARIABLES = {macos_signing.IDENTITY_VARIABLE, "TEAM_ID", "TAURI_WINDOWS_SIGNTOOL_PATH", "GNUPGHOME"}
UPDATER_KEY_DIR = Path.home() / ".backplane-signing"
UPDATER_KEY_FILE = "tauri-updater.key"
UPDATER_PASSWORD_FILE = "tauri-updater.env"
UPDATER_PASSWORD_VARIABLE = "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"


class BuildError(RuntimeError):
    pass


@dataclass(frozen=True)
class PayloadLayout:
    """Where the companion, Beacon and the notices sit, relative to the
    directory the manifest's paths are relative to."""
    platform: str
    goos: str
    goarch: str
    resources: str
    companions: tuple[str, ...]
    beacon_hooks: str
    beacon_otelcol: str


MACOS_LAYOUT = PayloadLayout("macOS (universal)", "darwin", "universal", "Resources", ("MacOS/backplane-companion",),
                             "Resources/beacon/beacon-hooks", "Resources/beacon/beacon-otelcol")


@dataclass(frozen=True)
class UpdaterKey:
    key_path: Path
    password: str = field(repr=False)


@dataclass(frozen=True)
class BuiltBundle:
    app: Path
    dmg: Path
    archive: Path | None = None
    signature: Path | None = None


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--version", help="app and companion version (default: tauri.conf.json's)")
    parser.add_argument("--beacon-archive", type=Path, help="a local copy of the pinned Beacon source archive")
    parser.add_argument("--sign", action="store_true", help="Developer ID sign, and notarize unless --skip-notarize")
    parser.add_argument("--skip-notarize", action="store_true", help="with --sign: sign only, for a local test")
    parser.add_argument("--updater-artifacts", action="store_true", help="also emit the signed .app.tar.gz update archive")
    arguments = parser.parse_args(argv)
    if arguments.skip_notarize and not arguments.sign:
        parser.error("--skip-notarize needs --sign")
    return arguments


def lipo(thin_by_architecture, output):
    if set(thin_by_architecture) != set(ARCHITECTURES):
        raise BuildError(f"{output.name}: universal build needs {', '.join(ARCHITECTURES)}, got {', '.join(sorted(thin_by_architecture))}")
    run("lipo", "-create", "-output", str(output), *[str(thin_by_architecture[architecture]) for architecture in ARCHITECTURES])
    return output


def beacon_manifest(binary, spec, go_version, **extra):
    manifest = build_bundle.artifact_manifest(binary, spec, "darwin", None, go_version, architectures=sorted(ARCHITECTURES), **extra)
    # The companion refuses a manifest naming another GOARCH; both slices are this build.
    del manifest["goarch"]
    return manifest


def stage_contents(contents, binaries, spec, go_version, sign):
    """Lay out the prebuilt part of the app's Contents; sign runs on the staged
    binaries before any checksum is taken."""
    missing = [name for name in ("backplane-companion", "beacon-hooks", "beacon-otelcol") if name not in binaries]
    if missing:
        raise BuildError(f"missing universal binaries: {', '.join(missing)}")
    macos, beacon = contents / "MacOS", contents / "Resources" / "beacon"
    macos.mkdir(parents=True, exist_ok=True)
    beacon.mkdir(parents=True, exist_ok=True)
    companion = macos / "backplane-companion"
    hooks, otelcol = beacon / "beacon-hooks", beacon / "beacon-otelcol"
    for source, target in ((binaries["backplane-companion"], companion), (binaries["beacon-hooks"], hooks), (binaries["beacon-otelcol"], otelcol)):
        shutil.copy2(source, target)
        target.chmod(0o755)
    sign([companion, hooks, otelcol])
    (beacon / "artifact.json").write_text(json.dumps(beacon_manifest(hooks, spec, go_version), indent=2) + "\n", encoding="utf-8")
    (beacon / "otelcol.json").write_text(json.dumps(beacon_manifest(
        otelcol, spec, go_version, builder_version=BUILDER_VERSION, builder_config="collector-builder/builder.yaml"), indent=2) + "\n", encoding="utf-8")
    return contents


def _license_tokens(expression):
    return re.findall(r"\(|\)|[^\s()]+", (expression or "").replace("/", " OR "))


def declared_license_allowed(expression):
    """Whether an SPDX expression can be satisfied by allowed licenses: any
    alternative of an OR, every part of an AND; a WITH exception only adds
    permissions."""
    tokens = _license_tokens(expression)
    position = 0

    def take():
        nonlocal position
        token = tokens[position]
        position += 1
        return token

    def peek():
        return tokens[position] if position < len(tokens) else None

    def any_of():
        allowed = all_of()
        while peek() == "OR":
            take()
            allowed = all_of() or allowed
        return allowed

    def all_of():
        allowed = single()
        while peek() == "AND":
            take()
            allowed = single() and allowed
        return allowed

    def single():
        token = take()
        if token == "(":
            allowed = any_of()
            if take() != ")":
                raise ValueError("unbalanced")
            return allowed
        if token in ("AND", "OR", "WITH", ")"):
            raise ValueError("operator without operand")
        if peek() == "WITH":
            take()
            take()
        return token in DECLARED_ALLOWED

    try:
        allowed = any_of()
    except (IndexError, ValueError):
        return False
    return allowed and position == len(tokens)


def _declared_entry(ecosystem, name, version, declared, directory, used_by):
    if not declared:
        raise BuildError(f"{ecosystem} package {name}@{version} declares no license")
    if not declared_license_allowed(declared):
        raise BuildError(f"{ecosystem} package {name}@{version} is licensed {declared!r}, which is not on the allowlist")
    licensed, notices = licenses._license_files(Path(directory))
    return licenses.Entry(f"{ecosystem}/{name}", version, [declared], licensed + notices, [used_by])


def rust_entries(metadata_by_target):
    """The crates linked into the desktop binary (normal dependencies only,
    never build or dev ones), across every target's `cargo metadata`."""
    crates = {}
    for metadata in metadata_by_target:
        packages = {package["id"]: package for package in metadata["packages"]}
        nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
        root = metadata["resolve"]["root"]
        pending, seen = [root], {root}
        while pending:
            for dependency in nodes[pending.pop()]["deps"]:
                linked = any(kind.get("kind") is None for kind in dependency.get("dep_kinds", []))
                if linked and dependency["pkg"] not in seen:
                    seen.add(dependency["pkg"])
                    pending.append(dependency["pkg"])
        for package_id in seen - {root}:
            package = packages[package_id]
            crates[(package["name"], package["version"])] = package
    entries = [_declared_entry("crates.io", name, version, package.get("license"), Path(package["manifest_path"]).parent, DESKTOP_PACKAGE)
               for (name, version), package in crates.items()]
    return sorted(entries, key=lambda entry: (entry.module, entry.version))


def _npm_license(manifest):
    declared = manifest.get("license")
    if isinstance(declared, dict):
        declared = declared.get("type")
    if not declared and isinstance(manifest.get("licenses"), list):
        declared = " OR ".join(item.get("type", "") for item in manifest["licenses"] if isinstance(item, dict))
    return declared


def npm_entries(pnpm_list):
    """The production npm packages the webview bundle is built from, from
    `pnpm list --prod --json --depth Infinity`."""
    packages = {}

    def walk(dependencies):
        for name, dependency in sorted((dependencies or {}).items()):
            key = (name, dependency["version"])
            if key not in packages:
                packages[key] = Path(dependency["path"])
            walk(dependency.get("dependencies"))

    for project in pnpm_list:
        walk(project.get("dependencies"))
    entries = []
    for (name, version), directory in packages.items():
        manifest = json.loads((directory / "package.json").read_text(encoding="utf-8"))
        entries.append(_declared_entry("npm", name, version, _npm_license(manifest), directory, "webview"))
    return sorted(entries, key=lambda entry: (entry.module, entry.version))


def merged_build_info(infos):
    """One component's modules across its per-architecture builds."""
    modules = {}
    for info in infos:
        for module in info.modules:
            modules.setdefault((module.path, module.source[1]), module)
    return licenses.BuildInfo(infos[0].go_version, infos[0].main, [modules[key] for key in sorted(modules)])


def write_notices(root, layout, *, version, commit, dirty, spec, go_version, go_root, beacon_license, go_entries, rust, npm, signed):
    resources = root / layout.resources
    notices_dir = resources / "LICENSES"
    notices_dir.mkdir(parents=True, exist_ok=True)
    own = {"LICENSES/backplane-companion-MIT.txt": build_bundle.COMPANION_LICENSE_FILE,
           "LICENSES/beacon-MIT.txt": beacon_license, "LICENSES/go-BSD-3-Clause.txt": build_bundle.go_license(go_root)}
    for name, source_file in own.items():
        shutil.copyfile(source_file, resources / name)
    entries = go_entries + rust + npm
    placed = bundle.copy_licenses(entries, resources, {beacon_license: "LICENSES/beacon-MIT.txt"})
    header = [
        f"{PRODUCT} {version} for {layout.platform}: third-party notices",
        "",
        f"{PRODUCT}, backplane-companion: MIT (LICENSES/backplane-companion-MIT.txt)",
        f"beacon-hooks, beacon-otelcol: MIT, Asymptote Labs agent-beacon {spec['commit']} (LICENSES/beacon-MIT.txt)",
        f"Go standard library and runtime {go_version}: BSD-3-Clause (LICENSES/go-BSD-3-Clause.txt)",
        "",
        "Every Go module linked into the companion and Beacon, every Rust crate linked into the app",
        "and every npm package its interface is built from follows, with its license text.",
    ]
    (resources / "THIRD_PARTY_NOTICES.txt").write_text(bundle.notices(header, entries, placed), encoding="utf-8")
    licenses_prefix = (Path(layout.resources) / "LICENSES").as_posix()
    companion_notices = [f"{licenses_prefix}/backplane-companion-MIT.txt", f"{licenses_prefix}/go-BSD-3-Clause.txt"]
    beacon_notices = [f"{licenses_prefix}/beacon-MIT.txt", f"{licenses_prefix}/go-BSD-3-Clause.txt"]
    components = [bundle.component(root, Path(companion).name, companion, build_bundle.COMPANION_LICENSE, companion_notices,
                                   version=version, commit=commit) for companion in layout.companions]
    components += [
        bundle.component(root, "beacon-hooks", layout.beacon_hooks, "MIT", beacon_notices, source_commit=spec["commit"]),
        bundle.component(root, "beacon-otelcol", layout.beacon_otelcol, "MIT", beacon_notices, source_commit=spec["commit"],
                         builder_version=BUILDER_VERSION),
    ]
    macos_signing_state = {"signed": signed} if layout.goos == "darwin" else None
    manifest = bundle.manifest(version=version, commit=commit, source_dirty=dirty, goos=layout.goos, goarch=layout.goarch,
                               go_version=go_version, components=components, entries=entries, placed=placed,
                               macos_signing=macos_signing_state)
    (resources / bundle.MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def tauri_overlay(contents, version=None, updater_artifacts=False):
    overlay = {"bundle": {"targets": ["app", "dmg"], "macOS": {
        "files": {relative: str(contents / relative) for relative in PREBUILT_CONTENTS},
        "entitlements": str(ENTITLEMENTS),
        "hardenedRuntime": True,
    }}}
    if updater_artifacts:
        overlay["bundle"]["createUpdaterArtifacts"] = True
    if version:
        overlay["version"] = version
    return overlay


def tauri_command(overlay_path):
    return ["pnpm", "tauri", "build", "--target", UNIVERSAL_TRIPLE, "--bundles", "app,dmg", "--config", str(overlay_path), "--ci",
            "--", "--locked", "--offline"]


def _is_signing_variable(name):
    return name.startswith(_SIGNING_VARIABLE_PREFIXES) or name in _SIGNING_VARIABLES


def refuse_signing_environment(environment):
    """Under the security hold nothing may be signed: an unsigned build
    refuses to start while any signing material is in its environment.
    Only the variable names are reported."""
    present = sorted(name for name in environment if _is_signing_variable(name))
    if present:
        raise BuildError(f"signing material in the environment ({', '.join(present)}): this build is unsigned; unset them first")


def scrub_signing_environment(environment):
    """Once the signing configuration is read, no child (go, cargo, pnpm, the
    collector builder) needs any of it; Tauri gets its own mapped copy."""
    for name in [name for name in environment if _is_signing_variable(name)]:
        del environment[name]


def _owner_only(path, mode):
    return stat.S_IMODE(path.stat().st_mode) & ~mode == 0


def updater_key(directory=UPDATER_KEY_DIR):
    """The updater signing key's path and password. Errors name paths only."""
    key_path = directory / UPDATER_KEY_FILE
    if not key_path.is_file():
        raise BuildError(f"--updater-artifacts needs the updater key at {key_path} (pnpm tauri signer generate -w {key_path})")
    if not _owner_only(directory, 0o700):
        raise BuildError(f"{directory} must be 0700: it holds the updater signing key")
    if not _owner_only(key_path, 0o600):
        raise BuildError(f"{key_path} must be 0600")
    password = ""
    password_path = directory / UPDATER_PASSWORD_FILE
    if password_path.exists():
        if not _owner_only(password_path, 0o600):
            raise BuildError(f"{password_path} must be 0600")
        for line in password_path.read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition("=")
            if name.strip() == UPDATER_PASSWORD_VARIABLE:
                password = value.strip()
    return UpdaterKey(key_path, password)


def tauri_environment(inherited, signing, key_path, updater=None):
    """Tauri's signing and notarization variables, mapped from the Developer ID
    ones (macos_signing), plus the updater key when asked. Keys reach Tauri only as file
    paths; without an API key Tauri skips notarization."""
    environment = {name: value for name, value in inherited.items() if not _is_signing_variable(name)}
    # bundle_dmg.sh otherwise lays out the DMG window by scripting Finder,
    # which blocks a headless build on an automation prompt.
    environment["CI"] = "true"
    environment["APPLE_SIGNING_IDENTITY"] = signing.identity if signing else AD_HOC
    if signing and signing.notary and key_path:
        environment["APPLE_API_KEY"] = signing.notary.key_id
        environment["APPLE_API_ISSUER"] = signing.notary.issuer
        environment["APPLE_API_KEY_PATH"] = str(key_path)
    if updater:
        environment["TAURI_SIGNING_PRIVATE_KEY"] = str(updater.key_path)
        environment[UPDATER_PASSWORD_VARIABLE] = updater.password
    return environment


def finish_release(app, dmg, signing):
    """After Tauri notarized and stapled the app: notarize and staple the DMG
    it signed, then check both tickets. Nothing without notarization."""
    if not signing or not signing.notary:
        return None
    notarization = macos_signing.notarize_file(dmg, signing)
    macos_signing.staple(dmg, signing)
    macos_signing.validate_staple(app, signing)
    macos_signing.validate_staple(dmg, signing)
    return notarization


def preflight_toolchain():
    if platform.system() != "Darwin":
        raise BuildError("the desktop app builds on macOS only")
    for command in ("lipo", "pnpm", "cargo", "rustup", "codesign"):
        if not shutil.which(command):
            raise BuildError(f"{command} is not on PATH")
    installed = run("rustup", "target", "list", "--installed").split()
    missing = [target for target in RUST_TARGETS if target not in installed]
    if missing:
        raise BuildError(f"missing Rust targets: {', '.join(missing)} (rustup target add {' '.join(missing)})")


def cargo_metadata(target):
    return json.loads(run("cargo", "metadata", "--locked", "--offline", "--format-version", "1", "--filter-platform", target, cwd=TAURI))


def built_bundle(version, updater_artifacts=False):
    bundle_dir = TAURI / "target" / UNIVERSAL_TRIPLE / "release" / "bundle"
    app = bundle_dir / "macos" / f"{PRODUCT}.app"
    dmg = bundle_dir / "dmg" / f"{PRODUCT}_{version}_universal.dmg"
    archive = signature = None
    expected = [app, dmg]
    if updater_artifacts:
        archive = bundle_dir / "macos" / f"{PRODUCT}.app.tar.gz"
        signature = bundle_dir / "macos" / f"{PRODUCT}.app.tar.gz.sig"
        expected += [archive, signature]
    for path in expected:
        if not path.exists():
            raise BuildError(f"Tauri did not produce {path}")
    return BuiltBundle(app, dmg, archive, signature)


def build(arguments):
    preflight_toolchain()
    signing = build_bundle.macos_signing_for(["darwin/arm64"], notarize=not arguments.skip_notarize) if arguments.sign else None
    updater = updater_key() if arguments.updater_artifacts else None
    scrub_signing_environment(os.environ)
    version = arguments.version or json.loads((TAURI / "tauri.conf.json").read_text(encoding="utf-8"))["version"]
    spec = build_bundle.pinned_spec()
    commit, dirty = build_bundle.source_revision()
    host = json.loads(run("go", "env", "-json", "GOMODCACHE", "GOROOT"))
    output = arguments.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="backplane-desktop-") as directory:
        temporary = Path(directory)
        source = download_source(spec, temporary, arguments.beacon_archive.resolve() if arguments.beacon_archive else None)
        run("go", "install", "go.opentelemetry.io/collector/cmd/builder@" + BUILDER_VERSION,
            env=dict(os.environ, CGO_ENABLED="0", GOTOOLCHAIN="local", GOBIN=str(temporary / "bin")))
        thin = {"backplane-companion": {}, "beacon-hooks": {}, "beacon-otelcol": {}}
        infos = {name: [] for name in thin}
        for architecture in ARCHITECTURES:
            stage = temporary / architecture
            (stage / "beacon").mkdir(parents=True)
            companion = stage / build_bundle.build_companion(stage, "darwin", architecture, version, commit)[0]
            hooks = build_bundle.build_hooks(source, stage, "darwin", architecture)
            otelcol = build_bundle.build_otelcol(source, stage, "darwin", architecture, temporary / "bin" / "builder")
            for name, binary in (("backplane-companion", companion), ("beacon-hooks", hooks), ("beacon-otelcol", otelcol)):
                info = licenses.read_build_info(binary)
                if build_bundle.links_beacon_updater(info):
                    raise BuildError(f"{name} links Beacon's self-updater ({build_bundle.BEACON_UPDATER_MODULE})")
                thin[name][architecture] = binary
                infos[name].append(info)
        universal = temporary / "universal"
        universal.mkdir()
        binaries = {name: lipo(thin[name], universal / (COMPANION_UNIVERSAL if name == "backplane-companion" else name)) for name in thin}
        go_version = infos["backplane-companion"][0].go_version
        contents = stage_contents(temporary / "app" / "Contents", binaries, spec, go_version,
                                  lambda paths: macos_signing.sign(paths, signing or macos_signing.Signing(AD_HOC)))
        go_entries = licenses.inventory({name: merged_build_info(found) for name, found in infos.items()}, Path(host["GOMODCACHE"]),
                                        beacon_license=source / "LICENSE")
        run("pnpm", "install", "--frozen-lockfile", "--offline", cwd=DESKTOP)
        rust = rust_entries([cargo_metadata(target) for target in RUST_TARGETS])
        npm = npm_entries(json.loads(run("pnpm", "list", "--prod", "--json", "--depth", "Infinity", cwd=DESKTOP)))
        write_notices(contents, MACOS_LAYOUT, version=version, commit=commit, dirty=dirty, spec=spec, go_version=go_version,
                      go_root=Path(host["GOROOT"]), beacon_license=source / "LICENSE", go_entries=go_entries, rust=rust, npm=npm,
                      signed=signing is not None)
        overlay = temporary / "tauri.bundle.json"
        overlay.write_text(json.dumps(tauri_overlay(contents, version, arguments.updater_artifacts), indent=2), encoding="utf-8")
        key_file = macos_signing.private_key_file(signing) if signing else contextlib.nullcontext()
        with key_file as key_path:
            subprocess.run(tauri_command(overlay), cwd=DESKTOP, env=tauri_environment(os.environ, signing, key_path, updater), check=True)
        built = built_bundle(version, arguments.updater_artifacts)
        app, dmg = built.app, built.dmg
        notarization = finish_release(app, dmg, signing)
    shipped_app, shipped_dmg = output / app.name, output / dmg.name
    if shipped_app.exists():
        shutil.rmtree(shipped_app)
    # ditto keeps the signatures, extended attributes and stapled tickets intact.
    run("ditto", str(app), str(shipped_app))
    run("ditto", str(dmg), str(shipped_dmg))
    result = {"app": str(shipped_app), "dmg": str(shipped_dmg), "version": version,
              "signing": "developer_id" if signing else "ad_hoc", "notarization": notarization or "skipped",
              "third_party": {"go": len(go_entries), "rust": len(rust), "npm": len(npm)}}
    if built.archive:
        # Tauri archives the app after signing (and notarizing) it; the .sig covers the archive.
        for key, source in (("updater_archive", built.archive), ("updater_signature", built.signature)):
            shutil.copyfile(source, output / source.name)
            result[key] = str(output / source.name)
    return result


def main(argv=None):
    print(json.dumps(build(parse_arguments(argv)), indent=2))


if __name__ == "__main__":
    build_bundle.exit_on_termination()
    try:
        main()
    except (BuildError, build_bundle.BuildError, licenses.LicenseError, macos_signing.SigningError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"build_desktop: {error}")
