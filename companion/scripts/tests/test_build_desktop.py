# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import json
import plistlib
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_desktop  # noqa: E402
import bundle  # noqa: E402
import macos_signing  # noqa: E402
from test_macos_signing import ENVIRONMENT, IDENTITY, ISSUER, KEY_ID, P8, SECRETS, SUBMISSION, FakeTools, completed  # noqa: E402

# These read the desktop app's own Tauri config; the scripts can land before it.
needs_desktop = unittest.skipUnless(
    build_desktop.TAURI.is_dir(), "reads companion/desktop, which lands separately"
)

SPEC = {"commit": "c" * 40, "archive_sha256": "a" * 64}


class DmgNotaryTools(FakeTools):
    """FakeTools that accepts a DMG submission and answers stapler."""

    def __init__(self, staple_exit=0, **kwargs):
        super().__init__(**kwargs)
        self.staple_exit = staple_exit

    def __call__(self, *command):
        if command[:3] == ("xcrun", "notarytool", "submit"):
            self.commands.append(list(command))
            self.submitted = Path(command[3]).name
            key = Path(command[command.index("--key") + 1])
            self.key_seen = (key, key.read_bytes(), stat.S_IMODE(key.stat().st_mode))
            return completed(command, stdout=json.dumps({"id": SUBMISSION, "status": self.status}))
        if command[:2] == ("xcrun", "stapler"):
            self.commands.append(list(command))
            echoed = " ".join(SECRETS) if self.echo_secrets else ""
            return completed(command, self.staple_exit, stdout=f"The staple and validate action worked! {echoed}")
        return super().__call__(*command)


class ArgumentsTest(unittest.TestCase):
    def test_parse_arguments_defaults_to_an_unsigned_build(self):
        arguments = build_desktop.parse_arguments(["--output", "dist"])
        self.assertFalse(arguments.sign)
        self.assertFalse(arguments.skip_notarize)

    def test_parse_arguments_refuses_skip_notarize_without_sign(self):
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            build_desktop.parse_arguments(["--output", "dist", "--skip-notarize"])


class UniversalTest(unittest.TestCase):
    def test_lipo_combines_both_architectures_into_one_binary(self):
        calls = []
        with mock.patch.object(build_desktop, "run", lambda *command, **_: calls.append(command) or ""):
            output = build_desktop.lipo({"arm64": Path("/a/companion"), "amd64": Path("/b/companion")}, Path("/out/x"))
        self.assertEqual(output, Path("/out/x"))
        self.assertEqual(calls, [("lipo", "-create", "-output", "/out/x", "/a/companion", "/b/companion")])

    def test_lipo_refuses_a_missing_architecture(self):
        with self.assertRaises(build_desktop.BuildError):
            build_desktop.lipo({"arm64": Path("/a/companion")}, Path("/out/x"))

    def test_the_universal_companion_carries_the_tauri_triple(self):
        self.assertEqual(build_desktop.COMPANION_UNIVERSAL, "backplane-companion-universal-apple-darwin")


class StageContentsTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.binaries = {}
        for name in ("backplane-companion", "beacon-hooks", "beacon-otelcol"):
            self.binaries[name] = self.root / "universal" / name
            self.binaries[name].parent.mkdir(exist_ok=True)
            self.binaries[name].write_bytes(name.encode("ascii"))
            self.binaries[name].chmod(0o755)
        self.signed = []

    def sign(self, paths):
        for path in paths:
            self.signed.append(path)
            path.write_bytes(path.read_bytes() + b"-signed")

    def stage(self):
        return build_desktop.stage_contents(self.root / "Contents", self.binaries, SPEC, "go1.26.9", self.sign, otelcol_overrides={})

    def test_stage_contents_puts_the_companion_in_macos_and_beacon_in_resources(self):
        contents = self.stage()
        self.assertEqual((contents / "MacOS" / "backplane-companion").read_bytes(), b"backplane-companion-signed")
        for name in ("beacon-hooks", "beacon-otelcol"):
            self.assertTrue((contents / "Resources" / "beacon" / name).is_file(), name)
        self.assertFalse((contents / "MacOS" / "beacon").exists())
        self.assertTrue((contents / "MacOS" / "backplane-companion").stat().st_mode & 0o100)

    def test_stage_contents_records_the_signed_bytes_in_the_beacon_manifests(self):
        contents = self.stage()
        beacon = contents / "Resources" / "beacon"
        for binary, manifest_name in (("beacon-hooks", "artifact.json"), ("beacon-otelcol", "otelcol.json")):
            manifest = json.loads((beacon / manifest_name).read_text(encoding="utf-8"))
            self.assertEqual(manifest["path"], binary)
            self.assertEqual(manifest["sha256"], bundle.sha256(beacon / binary))
            self.assertTrue((beacon / binary).read_bytes().endswith(b"-signed"))
            self.assertEqual(manifest["source_commit"], SPEC["commit"])
            self.assertEqual(manifest["goos"], "darwin")
            # The companion refuses a manifest naming another GOARCH; a universal binary runs on both.
            self.assertNotIn("goarch", manifest)
            self.assertEqual(manifest["architectures"], ["amd64", "arm64"])
            self.assertEqual(manifest["notices"], ["../LICENSES/beacon-MIT.txt"])

    def test_stage_contents_signs_before_it_hashes(self):
        self.stage()
        self.assertEqual(sorted(path.name for path in self.signed), ["backplane-companion", "beacon-hooks", "beacon-otelcol"])

    def test_stage_contents_refuses_a_missing_binary(self):
        del self.binaries["beacon-otelcol"]
        with self.assertRaises(build_desktop.BuildError):
            self.stage()


class MacosNoticesTest(unittest.TestCase):
    def test_write_notices_keeps_the_macos_app_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            contents = root / "Contents"
            for relative in ("MacOS/backplane-companion", "Resources/beacon/beacon-hooks", "Resources/beacon/beacon-otelcol"):
                (contents / relative).parent.mkdir(parents=True, exist_ok=True)
                (contents / relative).write_bytes(relative.encode("ascii"))
            (root / "go-root").mkdir()
            (root / "go-root" / "LICENSE").write_text("Go license\n", encoding="utf-8")
            (root / "beacon-LICENSE").write_text("MIT beacon\n", encoding="utf-8")
            manifest = build_desktop.write_notices(contents, build_desktop.MACOS_LAYOUT, version="0.2.0", commit="d" * 40, dirty=False,
                                                   spec=SPEC, go_version="go1.26.2", go_root=root / "go-root",
                                                   beacon_license=root / "beacon-LICENSE", go_entries=[], rust=[], npm=[], signed=False)
            resources = contents / "Resources"
            self.assertEqual(json.loads((resources / "manifest.json").read_text(encoding="utf-8")), manifest)
            self.assertEqual(manifest["target"], {"goos": "darwin", "goarch": "universal"})
            self.assertEqual(manifest["macos_signing"], {"signed": False})
            self.assertEqual([(component["name"], component["path"], component["notices"]) for component in manifest["components"]], [
                ("backplane-companion", "MacOS/backplane-companion",
                 ["Resources/LICENSES/backplane-companion-MIT.txt", "Resources/LICENSES/go-BSD-3-Clause.txt"]),
                ("beacon-hooks", "Resources/beacon/beacon-hooks", ["Resources/LICENSES/beacon-MIT.txt", "Resources/LICENSES/go-BSD-3-Clause.txt"]),
                ("beacon-otelcol", "Resources/beacon/beacon-otelcol", ["Resources/LICENSES/beacon-MIT.txt", "Resources/LICENSES/go-BSD-3-Clause.txt"]),
            ])
            self.assertEqual(manifest["components"][2]["builder_version"], build_desktop.BUILDER_VERSION)
            notices = (resources / "THIRD_PARTY_NOTICES.txt").read_text(encoding="utf-8")
            self.assertTrue(notices.startswith("Backplane Companion 0.2.0 for macOS (universal): third-party notices\n"))
            for name in ("backplane-companion-MIT.txt", "beacon-MIT.txt", "go-BSD-3-Clause.txt"):
                self.assertTrue((resources / "LICENSES" / name).is_file(), name)


METADATA_ROOT = "path+file:///w/src-tauri#backplane-companion-desktop@0.1.0"


def crate(root, name, version, license_id, license_file=True):
    directory = root / f"{name}-{version}"
    directory.mkdir(parents=True)
    (directory / "Cargo.toml").write_text("[package]\n", encoding="utf-8")
    if license_file:
        (directory / "LICENSE-MIT").write_text(f"{name} license text\n", encoding="utf-8")
    return {"id": f"registry+https://github.com/rust-lang/crates.io-index#{name}@{version}", "name": name, "version": version,
            "license": license_id, "manifest_path": str(directory / "Cargo.toml")}


def metadata(packages, edges):
    ids = {package["name"]: package["id"] for package in packages}
    ids["backplane-companion-desktop"] = METADATA_ROOT
    nodes = [{"id": ids[name], "deps": [{"pkg": ids[dep], "dep_kinds": [{"kind": kind, "target": None}]} for dep, kind in deps]}
             for name, deps in edges.items()]
    root_package = {"id": METADATA_ROOT, "name": "backplane-companion-desktop", "version": "0.1.0", "license": "MIT", "manifest_path": "/w/Cargo.toml"}
    return {"packages": [root_package, *packages], "resolve": {"root": METADATA_ROOT, "nodes": nodes}}


class RustLicensesTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def test_rust_entries_follow_only_normal_dependencies(self):
        packages = [crate(self.root, "serde", "1.0.0", "MIT OR Apache-2.0"), crate(self.root, "cc", "1.2.0", "MIT/Apache-2.0"),
                    crate(self.root, "tempfile", "3.0.0", "MIT"), crate(self.root, "itoa", "1.0.0", "MIT")]
        tree = metadata(packages, {"backplane-companion-desktop": [("serde", None), ("cc", "build"), ("tempfile", "dev")],
                                   "serde": [("itoa", None)], "cc": [], "tempfile": [], "itoa": []})
        entries = build_desktop.rust_entries([tree])
        self.assertEqual([(entry.module, entry.version) for entry in entries], [("crates.io/itoa", "1.0.0"), ("crates.io/serde", "1.0.0")])
        self.assertEqual(entries[1].expression, "MIT OR Apache-2.0")
        self.assertEqual([path.name for path in entries[1].files], ["LICENSE-MIT"])

    def test_rust_entries_merge_both_targets(self):
        arm = metadata([crate(self.root / "a", "serde", "1.0.0", "MIT")], {"backplane-companion-desktop": [("serde", None)], "serde": []})
        intel = metadata([crate(self.root / "b", "serde", "1.0.0", "MIT"), crate(self.root / "b", "libc", "0.2.0", "MIT OR Apache-2.0")],
                         {"backplane-companion-desktop": [("serde", None), ("libc", None)], "serde": [], "libc": []})
        self.assertEqual([entry.module for entry in build_desktop.rust_entries([arm, intel])], ["crates.io/libc", "crates.io/serde"])

    def test_rust_entries_refuse_a_crate_without_a_declared_license(self):
        tree = metadata([crate(self.root, "mystery", "0.1.0", None)], {"backplane-companion-desktop": [("mystery", None)], "mystery": []})
        with self.assertRaisesRegex(build_desktop.BuildError, "mystery"):
            build_desktop.rust_entries([tree])

    def test_rust_entries_refuse_a_copyleft_only_crate(self):
        tree = metadata([crate(self.root, "gpl", "1.0.0", "GPL-3.0-only")], {"backplane-companion-desktop": [("gpl", None)], "gpl": []})
        with self.assertRaisesRegex(build_desktop.BuildError, "gpl"):
            build_desktop.rust_entries([tree])


class DeclaredLicenseTest(unittest.TestCase):
    def test_declared_license_allowed_accepts_permissive_expressions(self):
        for expression in ("MIT", "MIT OR Apache-2.0", "MIT/Apache-2.0", "Apache-2.0 / MIT", "(MIT OR Apache-2.0) AND Unicode-3.0",
                           "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT", "Unlicense OR MIT", "BSD-3-Clause AND MIT", "Zlib"):
            self.assertTrue(build_desktop.declared_license_allowed(expression), expression)

    def test_declared_license_allowed_refuses_copyleft_and_nonsense(self):
        for expression in ("GPL-3.0-only", "MIT AND GPL-2.0-or-later", "LicenseRef-Proprietary", "", "MIT OR", "(MIT"):
            self.assertFalse(build_desktop.declared_license_allowed(expression), expression)

    def test_declared_license_allowed_takes_any_permissive_alternative(self):
        self.assertTrue(build_desktop.declared_license_allowed("GPL-2.0-only OR MIT"))


class NpmLicensesTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def package(self, name, version, license_id, with_file=True):
        path = self.root / name.replace("/", "+") / version
        path.mkdir(parents=True)
        manifest = {"name": name, "version": version}
        if license_id is not None:
            manifest["license"] = license_id
        (path / "package.json").write_text(json.dumps(manifest), encoding="utf-8")
        if with_file:
            (path / "LICENSE").write_text(f"{name} license\n", encoding="utf-8")
        return {"version": version, "path": str(path)}

    def test_npm_entries_walk_the_production_tree_once_per_package(self):
        react = self.package("react", "19.3.0", "MIT")
        tree = [{"name": "backplane-companion-desktop", "dependencies": {
            "react": react,
            "motion": {**self.package("motion", "13.4.4", "MIT"), "dependencies": {"react": react, "tslib": self.package("tslib", "2.8.1", "0BSD")}},
            "@tauri-apps/api": self.package("@tauri-apps/api", "2.12.0", "Apache-2.0 OR MIT"),
        }}]
        entries = build_desktop.npm_entries(tree)
        self.assertEqual([(entry.module, entry.version) for entry in entries],
                         [("npm/@tauri-apps/api", "2.12.0"), ("npm/motion", "13.4.4"), ("npm/react", "19.3.0"), ("npm/tslib", "2.8.1")])
        self.assertEqual([path.name for path in entries[2].files], ["LICENSE"])

    def test_npm_entries_refuse_a_package_without_a_license(self):
        tree = [{"name": "x", "dependencies": {"left-pad": self.package("left-pad", "1.0.0", None)}}]
        with self.assertRaisesRegex(build_desktop.BuildError, "left-pad"):
            build_desktop.npm_entries(tree)


class TauriConfigurationTest(unittest.TestCase):
    @needs_desktop
    def test_entitlements_grant_the_webview_only_jit(self):
        entitlements = plistlib.loads(build_desktop.ENTITLEMENTS.read_bytes())
        self.assertEqual(entitlements, {"com.apple.security.cs.allow-jit": True})

    def test_tauri_overlay_copies_prebuilt_code_unsigned_by_tauri(self):
        # Tauri signs externalBin sidecars with the app's entitlements, so the
        # companion rides in macOS.files, which Tauri copies but never re-signs.
        overlay = build_desktop.tauri_overlay(Path("/stage/Contents"))
        bundle_config = overlay["bundle"]
        self.assertNotIn("externalBin", bundle_config)
        self.assertEqual(bundle_config["targets"], ["app", "dmg"])
        self.assertEqual(bundle_config["macOS"]["files"], {
            "MacOS/backplane-companion": "/stage/Contents/MacOS/backplane-companion",
            "Resources/beacon": "/stage/Contents/Resources/beacon",
            "Resources/LICENSES": "/stage/Contents/Resources/LICENSES",
            "Resources/THIRD_PARTY_NOTICES.txt": "/stage/Contents/Resources/THIRD_PARTY_NOTICES.txt",
            "Resources/manifest.json": "/stage/Contents/Resources/manifest.json",
        })
        self.assertEqual(bundle_config["macOS"]["entitlements"], str(build_desktop.ENTITLEMENTS))
        self.assertTrue(bundle_config["macOS"]["hardenedRuntime"])

    def test_tauri_command_builds_the_universal_app_and_dmg_offline(self):
        command = build_desktop.tauri_command(Path("/tmp/overlay.json"))
        self.assertEqual(command[:3], ["pnpm", "tauri", "build"])
        for flag, value in (("--target", "universal-apple-darwin"), ("--bundles", "app,dmg"), ("--config", "/tmp/overlay.json")):
            self.assertEqual(command[command.index(flag) + 1], value)
        self.assertEqual(command[command.index("--") + 1:], ["--locked", "--offline"])


class TauriEnvironmentTest(unittest.TestCase):
    INHERITED = {"PATH": "/usr/bin", "HOME": "/home/x", "APPLE_ID": "someone@example.com", "APPLE_PASSWORD": "app-specific",
                 "APPLE_CERTIFICATE": "cert", "AC_API_KEY_P8": "should-never-pass", "DEVELOPER_ID_APP": IDENTITY}

    def test_tauri_environment_maps_the_developer_id_credentials(self):
        signing = macos_signing.from_environment(ENVIRONMENT, notarize=True, system="Darwin")
        environment = build_desktop.tauri_environment(self.INHERITED, signing, Path("/private/key.p8"))
        self.assertEqual(environment["APPLE_SIGNING_IDENTITY"], IDENTITY)
        self.assertEqual(environment["APPLE_API_KEY"], KEY_ID)
        self.assertEqual(environment["APPLE_API_ISSUER"], ISSUER)
        self.assertEqual(environment["APPLE_API_KEY_PATH"], "/private/key.p8")
        self.assertEqual(environment["PATH"], "/usr/bin")

    def test_tauri_environment_passes_no_secret_and_no_foreign_apple_credentials(self):
        signing = macos_signing.from_environment(ENVIRONMENT, notarize=True, system="Darwin")
        environment = build_desktop.tauri_environment(self.INHERITED, signing, Path("/private/key.p8"))
        for name in ("APPLE_ID", "APPLE_PASSWORD", "APPLE_CERTIFICATE", "AC_API_KEY_P8", "AC_API_KEY_ID", "AC_API_ISSUER"):
            self.assertNotIn(name, environment)
        for value in environment.values():
            for secret in SECRETS:
                self.assertNotIn(secret, value)

    def test_tauri_environment_without_notarization_gives_tauri_no_api_key(self):
        signing = macos_signing.from_environment({"DEVELOPER_ID_APP": IDENTITY}, notarize=False, system="Darwin")
        environment = build_desktop.tauri_environment(self.INHERITED, signing, None)
        self.assertEqual(environment["APPLE_SIGNING_IDENTITY"], IDENTITY)
        for name in ("APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"):
            self.assertNotIn(name, environment)

    def test_tauri_environment_unsigned_build_is_ad_hoc(self):
        environment = build_desktop.tauri_environment(self.INHERITED, None, None)
        self.assertEqual(environment["APPLE_SIGNING_IDENTITY"], "-")
        self.assertNotIn("APPLE_API_KEY", environment)

    def test_tauri_environment_skips_the_finder_dmg_layout(self):
        # bundle_dmg.sh drives Finder over AppleScript unless CI is set, which
        # hangs a headless build on an automation prompt.
        environment = build_desktop.tauri_environment(self.INHERITED, None, None)
        self.assertEqual(environment["CI"], "true")


class ScrubTest(unittest.TestCase):
    def test_scrub_signing_environment_leaves_no_signing_material_for_any_child(self):
        environment = dict(TauriEnvironmentTest.INHERITED, SPARKLE_ED_PRIVATE_KEY="sparkle", TEAM_ID="TEAM123456",
                           TAURI_SIGNING_PRIVATE_KEY="updater", AC_API_ISSUER=ISSUER)
        build_desktop.scrub_signing_environment(environment)
        self.assertEqual(environment, {"PATH": "/usr/bin", "HOME": "/home/x"})


class WindowsAndLinuxSigningScrubTest(unittest.TestCase):
    NAMES = ("WINDOWS_CERTIFICATE", "WINDOWS_CERTIFICATE_PASSWORD", "WINDOWS_CERTIFICATE_THUMBPRINT", "AZURE_CLIENT_ID",
             "AZURE_CLIENT_SECRET", "AZURE_TENANT_ID", "AZURE_CODE_SIGNING_ACCOUNT_NAME", "GPG_KEY", "GPG_PASSPHRASE", "GNUPGHOME",
             "SIGNTOOL_PATH")

    def test_tauri_environment_strips_windows_azure_gpg_and_signtool_material(self):
        inherited = dict(TauriEnvironmentTest.INHERITED, **{name: "secret" for name in self.NAMES})
        environment = build_desktop.tauri_environment(inherited, None, None)
        for name in self.NAMES:
            self.assertNotIn(name, environment)
        self.assertEqual(environment["PATH"], "/usr/bin")

    def test_refuse_signing_environment_aborts_on_each_family(self):
        for name in self.NAMES:
            with self.subTest(name=name), self.assertRaises(build_desktop.BuildError):
                build_desktop.refuse_signing_environment({"PATH": "/usr/bin", name: "secret"})


class UpdaterArtifactsTest(unittest.TestCase):
    PASSWORD = "generated-updater-password"

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.keys = Path(directory.name) / "signing"
        self.keys.mkdir(mode=0o700)
        self.key = self.keys / "tauri-updater.key"
        self.key.write_text("untrusted comment: rsign encrypted secret key\nSECRET-KEY-BYTES\n", encoding="utf-8")
        self.key.chmod(0o600)
        self.env_file = self.keys / "tauri-updater.env"
        self.env_file.write_text(f"TAURI_SIGNING_PRIVATE_KEY_PASSWORD={self.PASSWORD}\n", encoding="utf-8")
        self.env_file.chmod(0o600)

    def test_parse_arguments_updater_artifacts_is_opt_in(self):
        self.assertFalse(build_desktop.parse_arguments(["--output", "dist"]).updater_artifacts)
        self.assertTrue(build_desktop.parse_arguments(["--output", "dist", "--updater-artifacts"]).updater_artifacts)

    def test_tauri_overlay_creates_updater_artifacts_only_when_asked(self):
        self.assertNotIn("createUpdaterArtifacts", build_desktop.tauri_overlay(Path("/stage/Contents"))["bundle"])
        overlay = build_desktop.tauri_overlay(Path("/stage/Contents"), "0.2.0", updater_artifacts=True)
        self.assertIs(overlay["bundle"]["createUpdaterArtifacts"], True)
        self.assertEqual(overlay["bundle"]["targets"], ["app", "dmg"])

    def test_updater_key_reads_the_key_path_and_password_without_exposing_them(self):
        key = build_desktop.updater_key(self.keys)
        self.assertEqual(key.key_path, self.key)
        self.assertEqual(key.password, self.PASSWORD)
        self.assertNotIn(self.PASSWORD, repr(key))
        self.assertNotIn("SECRET-KEY-BYTES", repr(key))

    def test_updater_key_without_a_password_file_uses_an_empty_password(self):
        self.env_file.unlink()
        self.assertEqual(build_desktop.updater_key(self.keys).password, "")

    def test_updater_key_refuses_a_missing_key_naming_only_its_path(self):
        self.key.unlink()
        with self.assertRaisesRegex(build_desktop.BuildError, "tauri-updater.key"):
            build_desktop.updater_key(self.keys)

    def test_updater_key_refuses_a_key_readable_by_others(self):
        for mode in (0o640, 0o604):
            self.key.chmod(mode)
            with self.assertRaisesRegex(build_desktop.BuildError, "0600") as caught:
                build_desktop.updater_key(self.keys)
            self.assertNotIn("SECRET-KEY-BYTES", str(caught.exception))

    def test_updater_key_refuses_a_password_file_readable_by_others(self):
        self.env_file.chmod(0o644)
        with self.assertRaisesRegex(build_desktop.BuildError, "0600") as caught:
            build_desktop.updater_key(self.keys)
        self.assertNotIn(self.PASSWORD, str(caught.exception))

    def test_updater_key_refuses_an_open_signing_directory(self):
        self.keys.chmod(0o755)
        self.addCleanup(self.keys.chmod, 0o700)
        with self.assertRaisesRegex(build_desktop.BuildError, "0700"):
            build_desktop.updater_key(self.keys)

    def test_tauri_environment_maps_the_updater_key_for_tauri_only(self):
        key = build_desktop.updater_key(self.keys)
        environment = build_desktop.tauri_environment(TauriEnvironmentTest.INHERITED, None, None, key)
        self.assertEqual(environment["TAURI_SIGNING_PRIVATE_KEY"], str(self.key))
        self.assertEqual(environment["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"], self.PASSWORD)
        for value in environment.values():
            self.assertNotIn("SECRET-KEY-BYTES", value)

    def test_tauri_environment_never_forwards_an_inherited_updater_key(self):
        inherited = dict(TauriEnvironmentTest.INHERITED, TAURI_SIGNING_PRIVATE_KEY="foreign-key",
                         TAURI_SIGNING_PRIVATE_KEY_PASSWORD="foreign-password")
        environment = build_desktop.tauri_environment(inherited, None, None)
        self.assertFalse([name for name in environment if name.startswith("TAURI_SIGNING_")])
        key = build_desktop.updater_key(self.keys)
        environment = build_desktop.tauri_environment(inherited, None, None, key)
        self.assertNotIn("foreign-key", environment.values())
        self.assertNotIn("foreign-password", environment.values())

    def test_scrub_signing_environment_removes_the_updater_password(self):
        environment = {"PATH": "/usr/bin", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": self.PASSWORD,
                       "TAURI_SIGNING_PRIVATE_KEY": str(self.key)}
        build_desktop.scrub_signing_environment(environment)
        self.assertEqual(environment, {"PATH": "/usr/bin"})

    def make_bundle(self, root, version, archive=True, signature=True):
        bundle_dir = root / "target" / build_desktop.UNIVERSAL_TRIPLE / "release" / "bundle"
        (bundle_dir / "macos" / f"{build_desktop.PRODUCT}.app").mkdir(parents=True)
        (bundle_dir / "dmg").mkdir()
        (bundle_dir / "dmg" / f"{build_desktop.PRODUCT}_{version}_universal.dmg").write_bytes(b"dmg")
        if archive:
            (bundle_dir / "macos" / f"{build_desktop.PRODUCT}.app.tar.gz").write_bytes(b"tar")
        if signature:
            (bundle_dir / "macos" / f"{build_desktop.PRODUCT}.app.tar.gz.sig").write_text("c2ln", encoding="utf-8")
        return bundle_dir

    def test_built_bundle_returns_the_updater_archive_and_signature(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(build_desktop, "TAURI", Path(directory)):
            bundle_dir = self.make_bundle(Path(directory), "0.2.0")
            built = build_desktop.built_bundle("0.2.0", updater_artifacts=True)
            self.assertEqual(built.archive, bundle_dir / "macos" / f"{build_desktop.PRODUCT}.app.tar.gz")
            self.assertEqual(built.signature, bundle_dir / "macos" / f"{build_desktop.PRODUCT}.app.tar.gz.sig")

    def test_built_bundle_refuses_an_unsigned_updater_archive(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(build_desktop, "TAURI", Path(directory)):
            self.make_bundle(Path(directory), "0.2.0", signature=False)
            with self.assertRaisesRegex(build_desktop.BuildError, ".sig"):
                build_desktop.built_bundle("0.2.0", updater_artifacts=True)

    def test_built_bundle_without_updater_artifacts_needs_no_archive(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(build_desktop, "TAURI", Path(directory)):
            self.make_bundle(Path(directory), "0.2.0", archive=False, signature=False)
            built = build_desktop.built_bundle("0.2.0")
            self.assertIsNone(built.archive)
            self.assertIsNone(built.signature)


class NotaryKeyFileTest(unittest.TestCase):
    def test_private_key_file_is_owner_only_and_removed_afterwards(self):
        signing = macos_signing.from_environment(ENVIRONMENT, notarize=True, system="Darwin")
        with macos_signing.private_key_file(signing) as key:
            self.assertEqual(key.read_bytes(), P8)
            self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(key.parent.stat().st_mode), 0o700)
        self.assertFalse(key.exists())
        self.assertFalse(key.parent.exists())

    def test_private_key_file_is_removed_when_the_build_fails(self):
        signing = macos_signing.from_environment(ENVIRONMENT, notarize=True, system="Darwin")
        with self.assertRaises(subprocess.CalledProcessError):
            with macos_signing.private_key_file(signing) as key:
                raise subprocess.CalledProcessError(1, "tauri")
        self.assertFalse(key.exists())

    def test_private_key_file_without_notarization_yields_nothing(self):
        signing = macos_signing.from_environment({"DEVELOPER_ID_APP": IDENTITY}, notarize=False, system="Darwin")
        with macos_signing.private_key_file(signing) as key:
            self.assertIsNone(key)


class FinishReleaseTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.app = Path(directory.name) / "Backplane Companion.app"
        self.app.mkdir()
        self.dmg = Path(directory.name) / "Backplane Companion_0.1.0_universal.dmg"
        self.dmg.write_bytes(b"dmg")

    def finish(self, tools, environment=ENVIRONMENT, notarize=True):
        signing = macos_signing.from_environment(environment, notarize=notarize, system="Darwin")
        with mock.patch.object(macos_signing, "tool", tools):
            return build_desktop.finish_release(self.app, self.dmg, signing)

    def test_finish_release_notarizes_and_staples_the_dmg_and_validates_both_staples(self):
        tools = DmgNotaryTools()
        self.assertEqual(self.finish(tools), {"id": SUBMISSION, "status": "Accepted"})
        self.assertEqual(tools.submitted, self.dmg.name)
        key, content, mode = tools.key_seen
        self.assertEqual((content, mode), (P8, 0o600))
        self.assertFalse(key.exists())
        staplers = [command[2:] for command in tools.commands if command[:2] == ["xcrun", "stapler"]]
        self.assertIn(["staple", str(self.dmg)], staplers)
        self.assertIn(["validate", str(self.app)], staplers)
        self.assertIn(["validate", str(self.dmg)], staplers)
        self.assertLess(staplers.index(["staple", str(self.dmg)]), staplers.index(["validate", str(self.dmg)]))

    def test_finish_release_without_notarization_contacts_no_apple_service(self):
        tools = DmgNotaryTools()
        self.assertIsNone(self.finish(tools, environment={"DEVELOPER_ID_APP": IDENTITY}, notarize=False))
        self.assertFalse(any(command[0] == "xcrun" for command in tools.commands))

    def test_finish_release_fails_on_a_staple_error_without_leaking_the_key(self):
        with self.assertRaises(macos_signing.SigningError) as raised:
            self.finish(DmgNotaryTools(staple_exit=65, echo_secrets=True))
        self.assertIn("stapler", str(raised.exception))
        for secret in SECRETS:
            self.assertNotIn(secret, str(raised.exception))

    def test_finish_release_fails_on_a_rejected_dmg(self):
        with self.assertRaisesRegex(macos_signing.SigningError, "Invalid"):
            self.finish(DmgNotaryTools(status="Invalid"))


if __name__ == "__main__":
    unittest.main()
