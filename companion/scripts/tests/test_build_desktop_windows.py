# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_desktop  # noqa: E402
import build_desktop_windows  # noqa: E402
import desktop_payload  # noqa: E402
from test_build_desktop_linux import SIGNING_ENVIRONMENTS, SPEC, fake_binaries, write_fake_notices  # noqa: E402

# These read the desktop app's own Tauri config; the scripts can land before it.
needs_desktop = unittest.skipUnless(
    build_desktop.TAURI.is_dir(), "reads companion/desktop, which lands separately"
)

WINDOWS_BINARIES = ["backplane-companion.exe", "backplane-companiond.exe", "beacon-hooks.exe", "beacon-otelcol.exe"]


def portable_executable(certificate_table_size=0, pe32_plus=True):
    """The PE headers up to the data directories, with the certificate
    (Authenticode) table entry set to the given size."""
    optional_header = 0x40 + 4 + 20
    directories = optional_header + (112 if pe32_plus else 96)
    image = bytearray(directories + 16 * 8)
    image[0:2] = b"MZ"
    struct.pack_into("<I", image, 0x3C, 0x40)
    image[0x40:0x44] = b"PE\0\0"
    struct.pack_into("<H", image, optional_header, 0x20B if pe32_plus else 0x10B)
    struct.pack_into("<II", image, directories + 4 * 8, 0x1000 if certificate_table_size else 0, certificate_table_size)
    return bytes(image)


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
                        mock.patch.object(build_desktop_windows, "run") as run, \
                        mock.patch("subprocess.run") as subprocess_run, \
                        self.assertRaises(build_desktop.BuildError) as raised:
                    build_desktop_windows.build(build_desktop_windows.parse_arguments(["--output", str(self.output)]))
                self.assertIn(next(iter(signing)), str(raised.exception))
                self.assertNotIn(next(iter(signing.values())), str(raised.exception))
                run.assert_not_called()
                subprocess_run.assert_not_called()
                self.assertFalse(self.output.exists())

    def test_updater_artifacts_flag_rejected_on_windows(self):
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            build_desktop_windows.parse_arguments(["--output", "dist", "--updater-artifacts"])

    def test_preflight_accepts_the_cross_toolchain(self):
        with mock.patch.object(build_desktop_windows.shutil, "which", return_value="/opt/bin/tool"), \
                mock.patch.object(build_desktop_windows, "run", return_value="x86_64-pc-windows-msvc\naarch64-apple-darwin"):
            build_desktop_windows.preflight_toolchain()

    def test_preflight_refuses_a_missing_cross_tool(self):
        for missing in ("cargo-xwin", "makensis", "clang-cl", "lld-link"):
            with self.subTest(missing=missing), \
                    mock.patch.object(build_desktop_windows.shutil, "which", side_effect=lambda tool: None if tool == missing else "/opt/bin/" + tool), \
                    mock.patch.object(build_desktop_windows, "run", return_value="x86_64-pc-windows-msvc"), \
                    self.assertRaises(build_desktop.BuildError) as raised:
                build_desktop_windows.preflight_toolchain()
            self.assertIn(missing, str(raised.exception))

    def test_preflight_refuses_a_missing_rust_target(self):
        with mock.patch.object(build_desktop_windows.shutil, "which", return_value="/opt/bin/tool"), \
                mock.patch.object(build_desktop_windows, "run", return_value="aarch64-apple-darwin"), \
                self.assertRaises(build_desktop.BuildError) as raised:
            build_desktop_windows.preflight_toolchain()
        self.assertIn("x86_64-pc-windows-msvc", str(raised.exception))


class WindowsPayloadTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.binaries = fake_binaries(self.root, WINDOWS_BINARIES)
        self.payload = self.root / "payload"

    def stage(self):
        payload = desktop_payload.stage_payload(self.payload, self.binaries, SPEC, "go1.26.2", "windows", "amd64")
        write_fake_notices(payload, desktop_payload.WINDOWS_LAYOUT, self.root)
        return payload

    def test_stage_payload_carries_both_companion_executables_beside_the_gui(self):
        payload = self.stage()
        for name in ("backplane-companion.exe", "backplane-companiond.exe"):
            self.assertEqual((payload / name).read_bytes(), f"{name}-bytes".encode("ascii"))
        self.assertFalse((payload / "backplane-companion.sha256").exists())

    def test_beacon_manifests_name_windows_amd64(self):
        beacon = self.stage() / "beacon"
        manifest = json.loads((beacon / "artifact.json").read_text(encoding="utf-8"))
        self.assertEqual((manifest["path"], manifest["goos"], manifest["goarch"]), ("beacon-hooks.exe", "windows", "amd64"))
        manifest = json.loads((beacon / "otelcol.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["path"], "beacon-otelcol.exe")

    def test_manifest_names_windows_amd64(self):
        manifest = json.loads((self.stage() / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["target"], {"goos": "windows", "goarch": "amd64"})
        self.assertNotIn("macos_signing", manifest)
        self.assertEqual([component["path"] for component in manifest["components"]], [
            "backplane-companion.exe", "backplane-companiond.exe", "beacon/beacon-hooks.exe", "beacon/beacon-otelcol.exe"])

    def test_missing_companion_binary_fails_before_tauri(self):
        for name in ("backplane-companion.exe", "backplane-companiond.exe", "beacon/beacon-hooks.exe"):
            with self.subTest(name=name):
                payload = self.stage()
                (payload / name).unlink()
                runner = mock.Mock()
                with self.assertRaises(build_desktop.BuildError) as raised:
                    build_desktop_windows.package(payload, self.root / "overlay.json", runner)
                self.assertIn(name, str(raised.exception))
                runner.assert_not_called()

    def test_windows_overlay_ships_both_companion_exes_and_beacon_as_resources(self):
        payload = self.stage()
        overlay = build_desktop_windows.tauri_overlay(payload, "0.2.0")
        resources = overlay["bundle"]["resources"]
        for name in ("backplane-companion.exe", "backplane-companiond.exe", "beacon/beacon-hooks.exe", "beacon/beacon-otelcol.exe",
                     "beacon/artifact.json", "beacon/otelcol.json", "manifest.json", "THIRD_PARTY_NOTICES.txt",
                     "LICENSES/backplane-companion-MIT.txt"):
            self.assertEqual(resources[str(payload / name)], name)
        self.assertEqual(len(resources), sum(1 for path in payload.rglob("*") if path.is_file()))
        self.assertIs(overlay["bundle"]["createUpdaterArtifacts"], False)
        self.assertEqual(overlay["version"], "0.2.0")


class WindowsTauriConfigurationTest(unittest.TestCase):
    def config(self):
        return json.loads((build_desktop.TAURI / "tauri.windows.conf.json").read_text(encoding="utf-8"))

    @needs_desktop
    def test_windows_nsis_per_user_embeds_webview_bootstrapper(self):
        windows = self.config()["bundle"]["windows"]
        self.assertEqual(windows["nsis"]["installMode"], "currentUser")
        self.assertEqual(windows["webviewInstallMode"]["type"], "embedBootstrapper")
        self.assertEqual(self.config()["bundle"]["targets"], ["nsis"])

    @needs_desktop
    def test_windows_config_names_no_signing_and_no_updater(self):
        config = self.config()
        text = json.dumps(config).lower()
        for key in ("certificatethumbprint", "signcommand", "timestampurl", "digestalgorithm"):
            self.assertNotIn(key, text)
        self.assertIs(config["bundle"]["createUpdaterArtifacts"], False)
        # The window block from DK-W-desk stays.
        self.assertEqual(config["app"]["windows"][0]["label"], "popover")

    @needs_desktop
    def test_installer_hooks_install_under_local_programs(self):
        # Tauri's per-user default is %LOCALAPPDATA%\<product>; the trusted
        # install location (contract v1.5) is %LOCALAPPDATA%\Programs\<product>.
        hooks = build_desktop.TAURI / self.config()["bundle"]["windows"]["nsis"]["installerHooks"]
        text = hooks.read_text(encoding="utf-8")
        self.assertIn("!macro NSIS_HOOK_PREINSTALL", text)
        self.assertIn('StrCpy $INSTDIR "$LOCALAPPDATA\\Programs\\${PRODUCTNAME}"', text)
        self.assertIn('${If} $INSTDIR == "$LOCALAPPDATA\\${PRODUCTNAME}"', text)
        self.assertIn("SetOutPath $INSTDIR", text)

    def hooks(self):
        return (build_desktop.TAURI / self.config()["bundle"]["windows"]["nsis"]["installerHooks"]).read_text(encoding="utf-8")

    def macro(self, name):
        text = self.hooks()
        start = text.index(f"!macro {name}\n")
        return text[start:text.index("!macroend", start)]

    @needs_desktop
    def test_preinstall_removes_the_default_folder_tauri_created_only_if_empty(self):
        # Tauri's Install section runs SetOutPath on its default before the hook.
        body = self.macro("NSIS_HOOK_PREINSTALL")
        self.assertIn('    RMDir "$LOCALAPPDATA\\${PRODUCTNAME}"\n', body)
        self.assertLess(body.index("SetOutPath $INSTDIR"), body.index('RMDir "$LOCALAPPDATA\\${PRODUCTNAME}"'))

    @needs_desktop
    def test_postuninstall_removes_the_empty_default_folder_and_the_webview_profile(self):
        body = self.macro("NSIS_HOOK_POSTUNINSTALL")
        identifier = json.loads((build_desktop.TAURI / "tauri.conf.json").read_text(encoding="utf-8"))["identifier"]
        self.assertEqual(identifier, "dev.backplane.companion.desktop")
        self.assertIn(f'RMDir /r "$LOCALAPPDATA\\{identifier}"\n', body)
        self.assertIn('RMDir "$LOCALAPPDATA\\${PRODUCTNAME}"\n', body)

    @needs_desktop
    def test_postuninstall_guards_an_empty_local_app_data_and_an_update(self):
        body = self.macro("NSIS_HOOK_POSTUNINSTALL")
        guard = body.index('${If} $LOCALAPPDATA != ""')
        self.assertLess(guard, body.index("RMDir"))
        self.assertIn("${AndIf} $UpdateMode <> 1", body)
        self.assertIn("SetShellVarContext current", body)

    @needs_desktop
    def test_hooks_never_recursively_delete_anything_but_the_exact_webview_profile(self):
        recursive = [line.strip() for line in self.hooks().splitlines() if line.strip().upper().startswith("RMDIR /R")]
        self.assertEqual(recursive, ['RMDir /r "$LOCALAPPDATA\\dev.backplane.companion.desktop"'])
        for line in self.hooks().splitlines():
            self.assertNotRegex(line.strip(), r'(?i)^RMDir\s+(/r\s+)?"?\$LOCALAPPDATA"?\s*$')
            self.assertNotIn("Backplane\\", line, "the Go companion's data dir belongs to its own uninstall")

    def test_tauri_command_cross_builds_nsis_with_cargo_xwin(self):
        command = build_desktop_windows.tauri_command(Path("/tmp/overlay.json"))
        self.assertEqual(command[:3], ["pnpm", "tauri", "build"])
        for flag, value in (("--runner", "cargo-xwin"), ("--target", "x86_64-pc-windows-msvc"), ("--bundles", "nsis"),
                            ("--config", "/tmp/overlay.json")):
            self.assertEqual(command[command.index(flag) + 1], value)
        self.assertIn("--ci", command)
        self.assertEqual(command[command.index("--") + 1:], ["--locked", "--offline"])

    def test_tauri_environment_passes_no_signing_material(self):
        inherited = {"PATH": "/usr/bin", "HOME": "/home/x", "TAURI_SIGNING_PRIVATE_KEY": "secret", "TAURI_WINDOWS_SIGNTOOL_PATH": "x",
                     "WINDOWS_CERTIFICATE": "pfx", "AZURE_CLIENT_SECRET": "azure", "GPG_KEY": "gpg", "SIGNTOOL_PATH": "x"}
        environment = build_desktop_windows.tauri_environment(inherited)
        self.assertEqual(environment, {"PATH": "/usr/bin", "HOME": "/home/x", "CI": "true"})


class UnsignedTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def write(self, name, data):
        path = self.root / name
        path.write_bytes(data)
        return path

    def test_require_unsigned_accepts_executables_without_a_certificate_table(self):
        for pe32_plus in (True, False):
            build_desktop_windows.require_unsigned([self.write(f"plain-{pe32_plus}.exe", portable_executable(0, pe32_plus))])

    def test_require_unsigned_refuses_an_authenticode_signed_executable(self):
        signed = self.write("signed.exe", portable_executable(4096))
        with self.assertRaises(build_desktop.BuildError) as raised:
            build_desktop_windows.require_unsigned([self.write("plain.exe", portable_executable()), signed])
        self.assertIn("signed.exe", str(raised.exception))

    def test_require_unsigned_refuses_a_file_that_is_not_an_executable(self):
        with self.assertRaises(build_desktop.BuildError):
            build_desktop_windows.require_unsigned([self.write("text.exe", b"not a program")])

    def test_collect_artifacts_refuses_updater_archives_and_signatures(self):
        self.write("Backplane Companion_0.2.0_x64-setup.exe", portable_executable())
        desktop_payload.collect_artifacts(self.root, build_desktop_windows.PACKAGE_SUFFIXES)
        for name in ("Backplane Companion_0.2.0_x64-setup.nsis.zip", "Backplane Companion_0.2.0_x64-setup.exe.sig"):
            with self.subTest(name=name):
                updater = self.write(name, b"updater")
                with self.assertRaises(build_desktop.BuildError):
                    desktop_payload.collect_artifacts(self.root, build_desktop_windows.PACKAGE_SUFFIXES)
                updater.unlink()


if __name__ == "__main__":
    unittest.main()
