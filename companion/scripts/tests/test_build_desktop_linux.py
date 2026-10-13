# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_desktop  # noqa: E402
import build_desktop_linux  # noqa: E402
import bundle  # noqa: E402
import desktop_payload  # noqa: E402

# These read the desktop app's own Tauri config; the scripts can land before it.
needs_desktop = unittest.skipUnless(
    build_desktop.TAURI.is_dir(), "reads companion/desktop, which lands separately"
)

SPEC = {"commit": "c" * 40, "archive_sha256": "a" * 64}
SIGNING_ENVIRONMENTS = [
    {"TAURI_SIGNING_PRIVATE_KEY": "updater-secret-bytes"},
    {"TAURI_SIGNING_RPM_KEY": "rpm-secret-bytes"},
    {"DEVELOPER_ID_APP": "Developer ID Application: Someone (TEAM123456)"},
    {"APPLE_CERTIFICATE": "certificate-secret-bytes"},
    {"AC_API_KEY_P8": "notary-secret-bytes"},
    {"TAURI_WINDOWS_SIGNTOOL_PATH": "C:/signtool.exe"},
    {"WINDOWS_CERTIFICATE": "pfx-secret-bytes"},
    {"WINDOWS_CERTIFICATE_PASSWORD": "pfx-password-bytes"},
    {"WINDOWS_CERTIFICATE_THUMBPRINT": "thumbprint-bytes"},
    {"AZURE_CLIENT_SECRET": "azure-secret-bytes"},
    {"AZURE_TENANT_ID": "azure-tenant-bytes"},
    {"AZURE_CODE_SIGNING_ACCOUNT_NAME": "azure-account-bytes"},
    {"GPG_KEY": "gpg-secret-bytes"},
    {"GPG_PASSPHRASE": "gpg-passphrase-bytes"},
    {"GNUPGHOME": "/home/x/.gnupg-secret-bytes"},
    {"SIGNTOOL_PATH": "C:/signtool-secret-bytes.exe"},
]


def fake_binaries(root, names):
    binaries = {}
    for name in names:
        binary = root / "go" / name
        binary.parent.mkdir(parents=True, exist_ok=True)
        binary.write_bytes(f"{name}-bytes".encode("ascii"))
        binary.chmod(0o755)
        binaries[name] = binary
    return binaries


def write_fake_notices(payload, layout, root):
    go_root = root / "go-root"
    go_root.mkdir(exist_ok=True)
    (go_root / "LICENSE").write_text("Go license\n", encoding="utf-8")
    beacon_license = root / "beacon-LICENSE"
    beacon_license.write_text("MIT beacon\n", encoding="utf-8")
    return build_desktop.write_notices(payload, layout, version="0.2.0", commit="d" * 40, dirty=False, spec=SPEC, go_version="go1.26.2",
                                       go_root=go_root, beacon_license=beacon_license, go_entries=[], rust=[], npm=[], signed=False)


class GuardTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.output = Path(directory.name) / "out"

    def test_signing_env_present_aborts_build(self):
        for signing in SIGNING_ENVIRONMENTS:
            with self.subTest(signing=list(signing)):
                environment = {"PATH": "/usr/bin", "HOME": "/home/x", **signing}
                with mock.patch.dict(os.environ, environment, clear=True), \
                        mock.patch.object(build_desktop_linux, "run") as run, \
                        mock.patch("subprocess.run") as subprocess_run, \
                        self.assertRaises(build_desktop.BuildError) as raised:
                    build_desktop_linux.build(build_desktop_linux.parse_arguments(["--output", str(self.output)]))
                message = str(raised.exception)
                self.assertIn(next(iter(signing)), message)
                self.assertNotIn(next(iter(signing.values())), message)
                run.assert_not_called()
                subprocess_run.assert_not_called()
                self.assertFalse(self.output.exists())

    def test_signing_guard_passes_an_environment_without_signing_material(self):
        build_desktop.refuse_signing_environment({"PATH": "/usr/bin", "HOME": "/home/x", "TAURI_ENV_DEBUG": "false"})

    def test_updater_artifacts_flag_rejected_on_linux(self):
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            build_desktop_linux.parse_arguments(["--output", "dist", "--updater-artifacts"])

    def test_parse_arguments_defaults_to_the_container_build(self):
        arguments = build_desktop_linux.parse_arguments(["--output", "dist"])
        self.assertFalse(arguments.no_container)

    def test_non_container_linux_build_refuses_on_darwin_host(self):
        with mock.patch.object(build_desktop_linux.shutil, "which", return_value="/usr/bin/tool"), \
                self.assertRaises(build_desktop.BuildError) as raised:
            build_desktop_linux.preflight_toolchain("Darwin", container=False)
        self.assertIn("container", str(raised.exception))

    def test_non_container_linux_build_runs_on_a_linux_host(self):
        with mock.patch.object(build_desktop_linux.shutil, "which", return_value="/usr/bin/tool"):
            build_desktop_linux.preflight_toolchain("Linux", container=False)

    def test_container_build_refuses_without_docker(self):
        which = {"go": "/usr/bin/go", "pnpm": "/usr/bin/pnpm", "cargo": "/usr/bin/cargo"}
        with mock.patch.object(build_desktop_linux.shutil, "which", side_effect=which.get), \
                self.assertRaises(build_desktop.BuildError) as raised:
            build_desktop_linux.preflight_toolchain("Darwin", container=True)
        self.assertIn("docker", str(raised.exception))


class LinuxPayloadTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.binaries = fake_binaries(self.root, ["backplane-companion", "beacon-hooks", "beacon-otelcol"])
        self.payload = self.root / "payload"

    def stage(self):
        return desktop_payload.stage_payload(self.payload, self.binaries, SPEC, "go1.26.2", "linux", "amd64")

    def test_stage_payload_puts_the_companion_beside_the_gui_and_beacon_under_it(self):
        payload = self.stage()
        self.assertEqual((payload / "backplane-companion").read_bytes(), b"backplane-companion-bytes")
        self.assertTrue((payload / "backplane-companion").stat().st_mode & 0o100)
        for name in ("beacon-hooks", "beacon-otelcol"):
            self.assertTrue((payload / "beacon" / name).stat().st_mode & 0o100, name)

    def test_stage_payload_writes_the_companion_sha256_for_appimage_staging(self):
        payload = self.stage()
        digest = bundle.sha256(payload / "backplane-companion")
        self.assertEqual((payload / "backplane-companion.sha256").read_text(encoding="utf-8"), f"{digest}  backplane-companion\n")

    def test_beacon_manifests_name_linux_amd64(self):
        beacon = self.stage() / "beacon"
        for binary, manifest_name in (("beacon-hooks", "artifact.json"), ("beacon-otelcol", "otelcol.json")):
            manifest = json.loads((beacon / manifest_name).read_text(encoding="utf-8"))
            self.assertEqual(manifest["path"], binary)
            self.assertEqual(manifest["sha256"], bundle.sha256(beacon / binary))
            self.assertEqual((manifest["goos"], manifest["goarch"]), ("linux", "amd64"))
            self.assertEqual(manifest["notices"], ["../LICENSES/beacon-MIT.txt"])

    def test_stage_payload_refuses_a_missing_binary(self):
        del self.binaries["beacon-otelcol"]
        with self.assertRaises(build_desktop.BuildError):
            self.stage()

    def test_manifest_names_linux_amd64(self):
        payload = self.stage()
        manifest = write_fake_notices(payload, desktop_payload.LINUX_LAYOUT, self.root)
        self.assertEqual(manifest["target"], {"goos": "linux", "goarch": "amd64"})
        self.assertNotIn("macos_signing", manifest)
        self.assertEqual([(component["name"], component["path"]) for component in manifest["components"]], [
            ("backplane-companion", "backplane-companion"),
            ("beacon-hooks", "beacon/beacon-hooks"),
            ("beacon-otelcol", "beacon/beacon-otelcol"),
        ])
        self.assertEqual(manifest["components"][0]["notices"], ["LICENSES/backplane-companion-MIT.txt", "LICENSES/go-BSD-3-Clause.txt"])
        self.assertEqual(json.loads((payload / "manifest.json").read_text(encoding="utf-8")), manifest)
        notices = (payload / "THIRD_PARTY_NOTICES.txt").read_text(encoding="utf-8")
        self.assertTrue(notices.startswith("Backplane Companion 0.2.0 for Linux (x86_64): third-party notices\n"))
        for name in ("backplane-companion-MIT.txt", "beacon-MIT.txt", "go-BSD-3-Clause.txt"):
            self.assertTrue((payload / "LICENSES" / name).is_file(), name)

    def test_require_payload_accepts_a_complete_payload(self):
        payload = self.stage()
        write_fake_notices(payload, desktop_payload.LINUX_LAYOUT, self.root)
        desktop_payload.require_payload(payload, "linux")

    def test_missing_companion_binary_fails_before_tauri(self):
        payload = self.stage()
        write_fake_notices(payload, desktop_payload.LINUX_LAYOUT, self.root)
        (payload / "backplane-companion").unlink()
        runner = mock.Mock()
        with self.assertRaises(build_desktop.BuildError) as raised:
            build_desktop_linux.package(self.root, self.root / "out", runner)
        self.assertIn("backplane-companion", str(raised.exception))
        runner.assert_not_called()

    def test_missing_companion_digest_fails_before_tauri(self):
        payload = self.stage()
        write_fake_notices(payload, desktop_payload.LINUX_LAYOUT, self.root)
        (payload / "backplane-companion.sha256").unlink()
        runner = mock.Mock()
        with self.assertRaises(build_desktop.BuildError):
            build_desktop_linux.package(self.root, self.root / "out", runner)
        runner.assert_not_called()


class LinuxTauriConfigurationTest(unittest.TestCase):
    def overlay(self):
        return build_desktop_linux.tauri_overlay(Path("/context"), Path("/cargo-target"), "0.2.0")

    def test_linux_bundle_lists_companion_in_usr_lib(self):
        bundle_config = self.overlay()["bundle"]
        gui = "/cargo-target/x86_64-unknown-linux-gnu/release/backplane-companion-desktop"
        installed = {"/usr/lib/backplane-companion": "/context/payload", "/usr/lib/backplane-companion/backplane-companion-desktop": gui}
        # The deb's files overwrite Tauri's /usr/bin copy of the GUI with the
        # launcher; the rpm gets it as its main binary (container_script).
        self.assertEqual(bundle_config["linux"]["deb"]["files"], {**installed, "/usr/bin/backplane-companion-desktop": "/context/launcher"})
        self.assertEqual(bundle_config["linux"]["rpm"]["files"], installed)

    def test_appimage_carries_the_companion_beside_the_gui_it_runs(self):
        # The AppImage runs usr/bin/backplane-companion-desktop from its mount
        # and stages the companion found beside it, checked against its sha256.
        self.assertEqual(self.overlay()["bundle"]["linux"]["appimage"]["files"], {"/usr/bin": "/context/payload"})

    def test_linux_overlay_never_creates_updater_artifacts(self):
        overlay = self.overlay()
        self.assertIs(overlay["bundle"]["createUpdaterArtifacts"], False)
        self.assertEqual(overlay["version"], "0.2.0")

    def test_launcher_runs_the_gui_from_its_trusted_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            launcher = build_desktop_linux.write_launcher(Path(directory) / "launcher")
            text = launcher.read_text(encoding="utf-8")
            self.assertTrue(text.startswith("#!/bin/sh\n"))
            self.assertIn('exec /usr/lib/backplane-companion/backplane-companion-desktop "$@"\n', text)
            self.assertEqual(stat.S_IMODE(launcher.stat().st_mode), 0o755)

    @needs_desktop
    def test_linux_config_depends_on_xdg_utils_without_appindicator(self):
        # The Tauri CLI itself adds WebKitGTK 4.1 and GTK 3 (checked on the
        # built deb by check_depends); the config adds what it cannot know.
        path = build_desktop.TAURI / "tauri.linux.conf.json"
        linux = json.loads(path.read_text(encoding="utf-8"))["bundle"]["linux"]
        self.assertIn("xdg-utils", linux["deb"]["depends"])
        self.assertIn("xdg-utils", linux["rpm"]["depends"])
        self.assertNotIn("appindicator", path.read_text(encoding="utf-8").lower())

    @needs_desktop
    def test_linux_config_targets_deb_rpm_and_appimage_without_updater(self):
        config = json.loads((build_desktop.TAURI / "tauri.linux.conf.json").read_text(encoding="utf-8"))
        self.assertEqual(config["bundle"]["targets"], ["deb", "rpm", "appimage"])
        self.assertIs(config["bundle"]["createUpdaterArtifacts"], False)
        # The window block from DK-L-desk stays.
        self.assertTrue(config["app"]["windows"][0]["decorations"])

    @needs_desktop
    def test_menu_entries_run_the_launcher_from_the_path(self):
        # deb and rpm both carry the launcher at /usr/bin, and the AppImage
        # renders the deb's template, so Tauri's default entry serves all three.
        linux = json.loads((build_desktop.TAURI / "tauri.linux.conf.json").read_text(encoding="utf-8"))["bundle"]["linux"]
        self.assertNotIn("desktopTemplate", linux["deb"])
        self.assertNotIn("desktopTemplate", linux["rpm"])

    def test_tauri_command_builds_deb_rpm_and_appimage_for_x86_64(self):
        command = build_desktop_linux.tauri_command(Path("/context/tauri.linux.bundle.json"))
        self.assertEqual(command[:3], ["pnpm", "tauri", "build"])
        for flag, value in (("--target", "x86_64-unknown-linux-gnu"), ("--bundles", "deb,appimage"),
                            ("--config", "/context/tauri.linux.bundle.json")):
            self.assertEqual(command[command.index(flag) + 1], value)
        self.assertIn("--ci", command)
        self.assertEqual(command[command.index("--") + 1:], ["--locked"])

    def test_rpm_bundle_command_bundles_only_the_rpm_without_compiling(self):
        command = build_desktop_linux.rpm_bundle_command(Path("/context/tauri.linux.bundle.json"))
        self.assertEqual(command[:3], ["pnpm", "tauri", "bundle"])
        for flag, value in (("--target", "x86_64-unknown-linux-gnu"), ("--bundles", "rpm"), ("--config", "/context/tauri.linux.bundle.json")):
            self.assertEqual(command[command.index(flag) + 1], value)
        self.assertIn("--ci", command)


CARGO_TOML = """[dependencies]
tauri = { version = "=2.12.0", features = ["tray-icon", "image-png", "macos-private-api"] }
tauri-plugin-positioner = { version = "=2.4.0", features = ["tray-icon"] }
"""


class RpmDirectoryOwnershipTest(unittest.TestCase):
    """Tauri's rpm lists only files, so rpm never removes the directories under
    /usr/lib/backplane-companion; a %postun script clears them on erase."""

    def run_script(self, install_root, argument):
        with tempfile.TemporaryDirectory() as directory:
            script = build_desktop_linux.write_rpm_post_remove(Path(directory) / "postun.sh", install_root=str(install_root))
            subprocess.run(["sh", str(script), argument], check=True)

    def installed_tree(self, root):
        for relative in ("beacon", "LICENSES/go", "LICENSES/rust"):
            (root / relative).mkdir(parents=True)
        return root

    def test_rpm_overlay_runs_the_post_remove_script_and_the_deb_does_not(self):
        linux = build_desktop_linux.tauri_overlay(Path("/context"), Path("/cargo-target"), "0.2.0")["bundle"]["linux"]
        self.assertEqual(linux["rpm"]["postRemoveScript"], "/context/rpm-postun.sh")
        self.assertNotIn("postRemoveScript", linux["deb"])

    def test_post_remove_script_targets_the_install_root_by_default(self):
        with tempfile.TemporaryDirectory() as directory:
            script = build_desktop_linux.write_rpm_post_remove(Path(directory) / "postun.sh")
            text = script.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("#!/bin/sh\n"))
        self.assertIn("/usr/lib/backplane-companion", text)

    def test_erase_removes_the_empty_install_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.installed_tree(Path(directory) / "usr" / "lib" / "backplane-companion")
            self.run_script(root, "0")
            self.assertFalse(root.exists())
            self.assertTrue(root.parent.is_dir())

    def test_upgrade_leaves_the_install_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.installed_tree(Path(directory) / "backplane-companion")
            self.run_script(root, "1")
            self.assertTrue((root / "beacon").is_dir())
            self.assertTrue((root / "LICENSES" / "go").is_dir())

    def test_erase_keeps_a_directory_that_still_holds_a_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.installed_tree(Path(directory) / "backplane-companion")
            (root / "beacon" / "left-by-someone").write_text("x", encoding="utf-8")
            self.run_script(root, "0")
            self.assertTrue((root / "beacon" / "left-by-someone").is_file())
            self.assertFalse((root / "LICENSES").exists())

    def test_post_remove_script_never_stops_on_an_error(self):
        with tempfile.TemporaryDirectory() as directory:
            text = build_desktop_linux.write_rpm_post_remove(Path(directory) / "postun.sh").read_text(encoding="utf-8")
        commands = [line.strip() for line in text.splitlines() if not line.lstrip().startswith("#")]
        self.assertFalse(any(line.startswith("set ") for line in commands), text)
        self.assertIn("# Deliberately no set -e", text)
        self.assertTrue(text.rstrip().endswith("exit 0"))

    def test_erase_of_an_already_missing_root_succeeds(self):
        with tempfile.TemporaryDirectory() as directory:
            self.run_script(Path(directory) / "never-installed", "0")


class CliManifestTest(unittest.TestCase):
    def test_cli_manifest_drops_the_tauri_tray_feature_that_positioner_still_enables(self):
        rewritten = build_desktop_linux.without_cli_tray_probe(CARGO_TOML)
        self.assertEqual(rewritten, CARGO_TOML.replace('"tray-icon", "image-png"', '"image-png"'))

    @needs_desktop
    def test_cli_manifest_matches_the_real_desktop_manifest(self):
        real = (build_desktop.TAURI / "Cargo.toml").read_text(encoding="utf-8")
        rewritten = build_desktop_linux.without_cli_tray_probe(real)
        tauri_line = next(line for line in rewritten.splitlines() if line.startswith("tauri = "))
        self.assertNotIn("tray-icon", tauri_line)
        self.assertIn("image-png", tauri_line)
        self.assertEqual(len(rewritten.splitlines()), len(real.splitlines()))

    def test_cli_manifest_refuses_when_positioner_no_longer_enables_the_tray(self):
        manifest = CARGO_TOML.replace('tauri-plugin-positioner = { version = "=2.4.0", features = ["tray-icon"] }',
                                      'tauri-plugin-positioner = "=2.4.0"')
        with self.assertRaises(build_desktop.BuildError):
            build_desktop_linux.without_cli_tray_probe(manifest)

    def test_cli_manifest_refuses_an_unrecognised_tauri_dependency(self):
        with self.assertRaises(build_desktop.BuildError):
            build_desktop_linux.without_cli_tray_probe(CARGO_TOML.replace("tauri = {", "tauri={"))


class ContainerTest(unittest.TestCase):
    def command(self):
        return build_desktop_linux.docker_command(Path("/scratch/context"), Path("/dist/linux"), "echo build")

    def test_container_command_is_amd64_and_removed_afterwards(self):
        command = self.command()
        self.assertEqual(command[:3], ["docker", "run", "--rm"])
        self.assertEqual(command[command.index("--platform") + 1], "linux/amd64")
        self.assertEqual(command[-3:], ["bash", "-c", "echo build"])

    def test_container_command_mounts_the_context_read_only_and_the_output(self):
        mounts = self.mounts()
        self.assertEqual(mounts["/context"], ("/scratch/context", "ro"))
        self.assertEqual(mounts["/out"], ("/dist/linux", None))

    def test_container_command_never_bind_mounts_a_target_dir(self):
        mounts = self.mounts()
        for inside in ("/cargo-target", "/usr/local/cargo/registry", "/pnpm-store"):
            source, _ = mounts[inside]
            self.assertNotIn("/", source, inside)

    def test_container_command_forwards_no_environment(self):
        command = self.command()
        self.assertFalse({"-e", "--env", "--env-file"} & set(command))

    def mounts(self):
        command = self.command()
        mounts = {}
        for index, argument in enumerate(command):
            if argument == "-v":
                parts = command[index + 1].split(":")
                mounts[parts[1]] = (parts[0], parts[2] if len(parts) > 2 else None)
        return mounts

    def test_container_script_builds_from_a_private_copy_and_copies_only_the_packages(self):
        script = build_desktop_linux.container_script(Path("/context"), Path("/out"), Path("/cargo-target"), Path("/pnpm-store"))
        self.assertIn("cp -a /context/desktop /work/desktop", script)
        self.assertIn("pnpm install --frozen-lockfile --store-dir /pnpm-store", script)
        self.assertIn(" ".join(build_desktop_linux.tauri_command(Path("/context/tauri.linux.bundle.json"))), script)
        self.assertIn("/cargo-target/x86_64-unknown-linux-gnu/release/bundle/deb/", script)
        self.assertNotIn("TAURI_SIGNING", script)
        self.assertTrue(script.startswith("set -euo pipefail\n"))


    def test_container_script_seeds_an_emulation_runnable_appimage_plugin_before_tauri(self):
        # Under amd64 emulation an AppImage with its magic bytes intact fails
        # with "Exec format error"; Tauri zeroes them for linuxdeploy but not
        # for the appimage plugin it downloads, unless one is already cached.
        lines = build_desktop_linux.container_script(Path("/context"), Path("/out"), Path("/cargo-target"), Path("/pnpm-store")).splitlines()
        plugin = '"${XDG_CACHE_HOME:-$HOME/.cache}/tauri/linuxdeploy-plugin-appimage.AppImage"'
        seed = next(index for index, line in enumerate(lines)
                    if line == f"install -m 755 /context/{build_desktop_linux.APPIMAGE_PLUGIN} {plugin}")
        patch = next(index for index, line in enumerate(lines) if "dd if=/dev/zero bs=1 count=3 seek=8 conv=notrunc" in line and plugin in line)
        tauri = next(index for index, line in enumerate(lines) if " tauri build " in line)
        self.assertLess(seed, patch)
        self.assertLess(patch, tauri)
        self.assertFalse(any(line.startswith("curl ") for line in lines), "the container downloads nothing unverified")

    def test_container_script_bundles_the_rpm_with_the_launcher_as_its_main_binary(self):
        # The rpm builder keeps Tauri's /usr/bin entry for the main binary, so
        # the rpm is bundled from a private target dir whose "main binary" is
        # the launcher; the real cargo target is never touched.
        lines = build_desktop_linux.container_script(Path("/context"), Path("/out"), Path("/cargo-target"), Path("/pnpm-store")).splitlines()
        rpm_release = "/work/rpm-target/x86_64-unknown-linux-gnu/release"
        build = next(index for index, line in enumerate(lines) if " tauri build " in line)
        seed = lines.index(f"install -D -m 755 /context/launcher {rpm_release}/backplane-companion-desktop")
        bundle_rpm = lines.index("CARGO_TARGET_DIR=/work/rpm-target " + " ".join(build_desktop_linux.rpm_bundle_command(Path("/context/tauri.linux.bundle.json"))))
        self.assertLess(build, seed)
        self.assertLess(seed, bundle_rpm)
        self.assertIn(f"{rpm_release}/bundle/rpm/*.rpm", lines[-1])
        self.assertNotIn("/cargo-target/x86_64-unknown-linux-gnu/release/bundle/rpm", "\n".join(lines))


class AppImagePluginTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.target = Path(directory.name) / build_desktop_linux.APPIMAGE_PLUGIN

    def opener(self, data):
        def urlopen(url, timeout):
            self.requested = url
            return io.BytesIO(data)
        return urlopen

    def test_appimage_plugin_is_a_pinned_release_not_the_moving_continuous_tag(self):
        self.assertNotIn("continuous", build_desktop_linux.APPIMAGE_PLUGIN_URL)
        self.assertRegex(build_desktop_linux.APPIMAGE_PLUGIN_SHA256, r"^[0-9a-f]{64}$")

    def test_fetch_appimage_plugin_keeps_a_download_matching_its_pinned_sha256(self):
        data = b"plugin bytes"
        with mock.patch.object(build_desktop_linux, "APPIMAGE_PLUGIN_SHA256", hashlib.sha256(data).hexdigest()):
            build_desktop_linux.fetch_appimage_plugin(self.target, self.opener(data))
        self.assertEqual(self.target.read_bytes(), data)
        self.assertEqual(self.requested, build_desktop_linux.APPIMAGE_PLUGIN_URL)

    def test_fetch_appimage_plugin_hash_mismatch_aborts_and_leaves_nothing(self):
        with self.assertRaises(build_desktop.BuildError) as raised:
            build_desktop_linux.fetch_appimage_plugin(self.target, self.opener(b"tampered plugin"))
        self.assertIn("sha256", str(raised.exception))
        self.assertFalse(self.target.exists())
        self.assertEqual(list(self.target.parent.iterdir()), [])


class DependsTest(unittest.TestCase):
    def test_check_debian_depends_accepts_webkit_gtk_and_xdg_utils(self):
        build_desktop_linux.check_depends("xdg-utils, libwebkit2gtk-4.1-0, libgtk-3-0")

    def test_check_debian_depends_rejects_appindicator(self):
        for depends in ("xdg-utils, libwebkit2gtk-4.1-0, libgtk-3-0, libayatana-appindicator3-1",
                        "xdg-utils, libwebkit2gtk-4.1-0, libgtk-3-0, libappindicator3-1"):
            with self.subTest(depends=depends), self.assertRaises(build_desktop.BuildError):
                build_desktop_linux.check_depends(depends)

    def test_check_debian_depends_rejects_a_package_without_webkit(self):
        with self.assertRaises(build_desktop.BuildError):
            build_desktop_linux.check_depends("xdg-utils, libgtk-3-0")


class ArtifactsTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.out = Path(directory.name)
        for name in ("Backplane Companion_0.2.0_amd64.deb", "Backplane Companion-0.2.0-1.x86_64.rpm",
                     "Backplane Companion_0.2.0_amd64.AppImage"):
            (self.out / name).write_bytes(name.encode("utf-8"))

    def test_collect_artifacts_returns_each_package_with_its_size_and_sha256(self):
        artifacts = desktop_payload.collect_artifacts(self.out, build_desktop_linux.PACKAGE_SUFFIXES)
        self.assertEqual(sorted(artifact["file"] for artifact in artifacts), sorted(path.name for path in self.out.iterdir()))
        for artifact in artifacts:
            path = self.out / artifact["file"]
            self.assertEqual(artifact["sha256"], bundle.sha256(path))
            self.assertEqual(artifact["bytes"], path.stat().st_size)

    def test_collect_artifacts_refuses_updater_archives_and_signatures(self):
        for name in ("Backplane Companion_0.2.0_amd64.AppImage.tar.gz", "Backplane Companion_0.2.0_amd64.AppImage.sig"):
            with self.subTest(name=name):
                (self.out / name).write_bytes(b"updater")
                with self.assertRaises(build_desktop.BuildError):
                    desktop_payload.collect_artifacts(self.out, build_desktop_linux.PACKAGE_SUFFIXES)
                (self.out / name).unlink()

    def test_collect_artifacts_refuses_a_missing_package(self):
        (self.out / "Backplane Companion-0.2.0-1.x86_64.rpm").unlink()
        with self.assertRaises(build_desktop.BuildError):
            desktop_payload.collect_artifacts(self.out, build_desktop_linux.PACKAGE_SUFFIXES)


if __name__ == "__main__":
    unittest.main()
