# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import json
import os
import platform
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "verify_macos_app.sh"
ALLOW_JIT = {"com.apple.security.cs.allow-jit": True}
UNIVERSAL = ("x86_64", "arm64")
EXIT_SKIPPED = 3

# Each slice answers only `argv[1] == subcommand`, so a test can tell which
# slice ran: a slice built with a nonzero exit fails even the right subcommand.
STUB_SOURCE = """#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (HANG) sleep(600);
  if (MARKER[0]) { FILE *launched = fopen(MARKER, "w"); if (launched) fclose(launched); }
  if (argc != 2 || strcmp(argv[1], SUBCOMMAND) != 0) return 64;
#ifdef __x86_64__
  int status = X86_64_EXIT;
#else
  int status = ARM64_EXIT;
#endif
  fputs(REPLY, stdout);
  return status;
}
"""


def rosetta_available():
    return platform.system() == "Darwin" and subprocess.run(["arch", "-x86_64", "/usr/bin/true"], capture_output=True).returncode == 0


@unittest.skipUnless(platform.system() == "Darwin" and shutil.which("codesign"), "needs macOS codesign")
class VerifyMacosAppTest(unittest.TestCase):
    """A stand-in app built from /usr/bin/true, ad hoc signed, so each check
    can be failed on purpose without a real build."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.app = self.root / "Backplane Companion.app"
        self.macos = self.app / "Contents" / "MacOS"
        self.macos.mkdir(parents=True)
        (self.app / "Contents" / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": "dev.backplane.companion.test", "CFBundleExecutable": "backplane-companion-desktop",
            "CFBundlePackageType": "APPL", "LSUIElement": True}))
        self.entitlements = self.root / "entitlements.plist"
        self.entitlements.write_bytes(plistlib.dumps(ALLOW_JIT))

    def code(self, path, entitlements=False):
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile("/usr/bin/true", path)
        path.chmod(0o755)
        command = ["codesign", "--force", "--options", "runtime", "--sign", "-"]
        if entitlements:
            command += ["--entitlements", str(self.entitlements)]
        subprocess.run(command + [str(path)], check=True, capture_output=True)

    def seal(self):
        subprocess.run(["codesign", "--force", "--options", "runtime", "--sign", "-", "--entitlements", str(self.entitlements), str(self.app)],
                       check=True, capture_output=True)

    def verify(self, path_prefix=None):
        environment = dict(os.environ)
        if path_prefix:
            environment["PATH"] = f"{path_prefix}{os.pathsep}{environment['PATH']}"
        return subprocess.run([str(SCRIPT), str(self.app)], capture_output=True, encoding="utf-8", env=environment)

    def stub(self, path, subcommand, reply="ok\n", architectures=UNIVERSAL, x86_64_exit=0, arm64_exit=0, marker="", hang=False):
        """A fat Mach-O built from STUB_SOURCE, then ad hoc signed like `code`."""
        path.parent.mkdir(parents=True, exist_ok=True)
        source = self.root / f"{path.name}.c"
        defines = {"SUBCOMMAND": subcommand, "REPLY": reply, "MARKER": marker}
        header = "".join(f"#define {name} {json.dumps(value)}\n" for name, value in defines.items())
        header += f"#define X86_64_EXIT {x86_64_exit}\n#define ARM64_EXIT {arm64_exit}\n#define HANG {int(hang)}\n"
        source.write_text(header + STUB_SOURCE, encoding="utf-8")
        slices = []
        for architecture in architectures:
            slice_path = self.root / f"{path.name}.{architecture}"
            subprocess.run(["clang", "-arch", architecture, "-o", str(slice_path), str(source)], check=True, capture_output=True)
            slices.append(str(slice_path))
        subprocess.run(["lipo", "-create", "-output", str(path)] + slices, check=True, capture_output=True)
        subprocess.run(["codesign", "--force", "--options", "runtime", "--sign", "-"] + (["--entitlements", str(self.entitlements)] if path.name == "backplane-companion-desktop" else []) + [str(path)],
                       check=True, capture_output=True)

    def build_complete(self, architectures=None, **slice_overrides):
        """A bundle every check passes: fat stubs that answer the smoke subcommands,
        the companion reporting both Beacon artifacts verified from Resources/beacon."""
        architectures = architectures or {}
        resources = self.app / "Contents" / "Resources"
        beacon = resources / "beacon"
        beacon.mkdir(parents=True)
        for name in ("artifact.json", "otelcol.json"):
            (beacon / name).write_text("{}", encoding="utf-8")
        (resources / "THIRD_PARTY_NOTICES.txt").write_text("notices", encoding="utf-8")
        (resources / "manifest.json").write_text("{}", encoding="utf-8")
        (resources / "LICENSES").mkdir()
        (resources / "LICENSES" / "MIT.txt").write_text("MIT", encoding="utf-8")
        version = json.dumps({"version": "0.1.0", "artifacts": {
            "beacon_hooks": {"verified": True, "manifest": str(beacon / "artifact.json")},
            "beacon_otelcol": {"verified": True, "manifest": str(beacon / "otelcol.json")}}}) + "\n"
        self.desktop_marker = self.root / "desktop-was-launched"
        binaries = {
            "backplane-companion-desktop": (self.macos / "backplane-companion-desktop", {"subcommand": "--help", "marker": str(self.desktop_marker)}),
            "backplane-companion": (self.macos / "backplane-companion", {"subcommand": "version", "reply": version}),
            "beacon-hooks": (beacon / "beacon-hooks", {"subcommand": "version", "reply": "dev\n"}),
            "beacon-otelcol": (beacon / "beacon-otelcol", {"subcommand": "components", "reply": "receivers: []\n"}),
        }
        for name, (path, options) in binaries.items():
            self.stub(path, architectures=architectures.get(name, UNIVERSAL), **{**options, **slice_overrides.get(name, {})})
        self.seal()

    def rosetta_absent_path(self):
        """A PATH directory whose `arch` refuses x86_64 the way it does without Rosetta."""
        directory = self.root / "no-rosetta-bin"
        directory.mkdir()
        fake_arch = directory / "arch"
        fake_arch.write_text('#!/bin/sh\n'
                             'if [ "$1" = "-x86_64" ]; then echo "arch: posix_spawnp: $2: Bad CPU type in executable" >&2; exit 1; fi\n'
                             'exec /usr/bin/arch "$@"\n', encoding="utf-8")
        fake_arch.chmod(0o755)
        return directory

    def build(self, companion_entitlements=False):
        self.code(self.macos / "backplane-companion-desktop", entitlements=True)
        self.code(self.macos / "backplane-companion", entitlements=companion_entitlements)
        beacon = self.app / "Contents" / "Resources" / "beacon"
        self.code(beacon / "beacon-hooks")
        self.code(beacon / "beacon-otelcol")
        self.seal()

    def test_verify_passes_the_signature_and_entitlement_checks_of_a_well_formed_bundle(self):
        self.build()
        result = self.verify()
        for line in ("PASS  codesign --verify --deep --strict", "PASS  app executable: entitlements are exactly [com.apple.security.cs.allow-jit]",
                     "PASS  nested companion: entitlements are exactly [none]", "PASS  nested companion: hardened runtime",
                     "PASS  LSUIElement is true (menu bar only, no Dock icon)"):
            self.assertIn(line, result.stdout)
        self.assertIn("INFO  spctl -a -t exec (app) rejected (expected without notarization)", result.stdout)

    def test_verify_fails_when_the_nested_companion_carries_entitlements(self):
        self.build(companion_entitlements=True)
        result = self.verify()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("FAIL  nested companion: entitlements [com.apple.security.cs.allow-jit], want [none]", result.stdout)

    def test_verify_fails_when_beacon_sits_in_contents_macos(self):
        self.build()
        (self.macos / "beacon").mkdir()
        (self.macos / "beacon" / "artifact.json").write_text("{}", encoding="utf-8")
        result = self.verify()
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL  Contents/MacOS/beacon exists", result.stdout)

    def test_verify_fails_a_companion_that_is_not_universal_or_cannot_report_its_version(self):
        self.build()
        result = self.verify()
        self.assertEqual(result.returncode, 1)
        # /usr/bin/true is x86_64 + arm64e and has no `version` subcommand.
        self.assertIn("FAIL  companion is not universal (x86_64 arm64e)", result.stdout)
        self.assertIn("FAIL  backplane-companion version failed", result.stdout)

    @unittest.skipUnless(rosetta_available(), "needs Rosetta 2 (or an Intel Mac)")
    def test_verify_runs_x86_64_slice_under_rosetta(self):
        # The arm64 slices fail, so only an x86_64 run of each binary can pass the smoke.
        failing_arm64 = {"arm64_exit": 1}
        self.build_complete(**{name: failing_arm64 for name in ("backplane-companion", "beacon-hooks", "beacon-otelcol")})
        result = self.verify()
        for line in ("PASS  x86_64 smoke: backplane-companion version", "PASS  x86_64 smoke: beacon-hooks version",
                     "PASS  x86_64 smoke: beacon-otelcol components"):
            self.assertIn(line, result.stdout)
        self.assertIn("INFO  backplane-companion-desktop is not launched", result.stdout)

    @unittest.skipUnless(rosetta_available(), "needs Rosetta 2 (or an Intel Mac)")
    def test_verify_passes_a_complete_bundle_including_the_x86_64_smoke(self):
        self.build_complete()
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("FAIL", result.stdout)
        self.assertNotIn("SKIP", result.stdout)
        self.assertIn("verify_macos_app: all checks passed", result.stdout)

    @unittest.skipUnless(rosetta_available(), "needs Rosetta 2 (or an Intel Mac)")
    def test_verify_fails_when_x86_64_slice_cannot_run(self):
        self.build_complete(**{"beacon-hooks": {"x86_64_exit": 1}})
        result = self.verify()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("FAIL  x86_64 smoke: beacon-hooks version", result.stdout)
        self.assertIn("PASS  x86_64 smoke: backplane-companion version", result.stdout)

    @unittest.skipUnless(rosetta_available(), "needs Rosetta 2 (or an Intel Mac)")
    def test_verify_fails_when_x86_64_slice_prints_nothing(self):
        self.build_complete(**{"beacon-otelcol": {"reply": ""}})
        result = self.verify()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("FAIL  x86_64 smoke: beacon-otelcol components", result.stdout)

    @unittest.skipUnless(rosetta_available(), "needs Rosetta 2 (or an Intel Mac)")
    def test_verify_fails_when_x86_64_slice_hangs_past_the_deadline(self):
        self.build_complete(**{"beacon-otelcol": {"hang": True}})
        result = subprocess.run([str(SCRIPT), str(self.app)], capture_output=True, encoding="utf-8", timeout=20,
                                env=dict(os.environ, VERIFY_MACOS_APP_SMOKE_DEADLINE_SECONDS="2"))
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("FAIL  x86_64 smoke: beacon-otelcol components", result.stdout)

    def test_verify_fails_when_x86_64_slice_missing(self):
        for name, label in (("backplane-companion", "companion"), ("beacon-hooks", "beacon-hooks"),
                            ("beacon-otelcol", "beacon-otelcol"), ("backplane-companion-desktop", "app executable")):
            with self.subTest(binary=name):
                self.setUp()
                self.build_complete(architectures={name: ("arm64",)})
                result = self.verify()
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(f"FAIL  {label} is not universal (arm64)", result.stdout)
                if name != "backplane-companion-desktop":
                    self.assertIn(f"FAIL  x86_64 smoke: {name} has no x86_64 slice", result.stdout)
                    self.assertNotIn(f"PASS  x86_64 smoke: {name}", result.stdout)

    def test_verify_reports_rosetta_absent_as_skipped_not_pass(self):
        self.build_complete()
        result = self.verify(path_prefix=self.rosetta_absent_path())
        self.assertEqual(result.returncode, EXIT_SKIPPED, result.stdout)
        self.assertIn("SKIP  x86_64 smoke: Rosetta 2 is not installed", result.stdout)
        self.assertNotIn("PASS  x86_64 smoke", result.stdout)
        self.assertNotIn("all checks passed", result.stdout)
        self.assertIn("SKIPPED", result.stdout.splitlines()[-1])

    def test_verify_fails_rather_than_skips_when_rosetta_is_absent_and_a_check_fails(self):
        self.build_complete(architectures={"beacon-hooks": ("arm64",)})
        result = self.verify(path_prefix=self.rosetta_absent_path())
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("FAIL  beacon-hooks is not universal (arm64)", result.stdout)

    def test_verify_never_launches_the_desktop_gui(self):
        self.build_complete()
        result = self.verify()
        self.assertFalse(self.desktop_marker.exists(), result.stdout)
        self.assertIn("PASS  app executable is universal (x86_64 arm64)", result.stdout)

    def test_verify_fails_unnotarized_builds_when_notarization_is_expected(self):
        self.build()
        result = subprocess.run([str(SCRIPT), str(self.app), "--expect-notarized"], capture_output=True, encoding="utf-8")
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL  spctl -a -t exec (app)", result.stdout)

    def test_verify_fails_without_an_app_bundle(self):
        result = subprocess.run([str(SCRIPT), str(self.root / "missing.app")], capture_output=True, encoding="utf-8")
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL  no app bundle", result.stdout)


if __name__ == "__main__":
    unittest.main()
