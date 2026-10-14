# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import json
import os
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_bundle  # noqa: E402
import bundle  # noqa: E402
import licenses  # noqa: E402
import macos_signing  # noqa: E402
from test_macos_signing import ENVIRONMENT, ISSUER, KEY_ID, P8, P8_BASE64, SUBMISSION, FakeTools  # noqa: E402

SCRIPTS = Path(__file__).resolve().parents[1]


class BuildBundleTest(unittest.TestCase):
    def test_local_replacements_become_relative(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            module = root / "collector-builder" / "dist" / "beacon-otelcol"
            module.mkdir(parents=True)
            go_mod = module / "go.mod"
            go_mod.write_text(
                f"module x\n\nreplace example.com/exporter v0.0.0 => {root}/collector-builder/exporter/x\n"
                "replace example.com/other => ../../../other\nreplace example.com/y => example.com/y v1.0.0\n",
                encoding="utf-8",
            )
            build_bundle.relative_local_replacements(go_mod, module)
            self.assertEqual(go_mod.read_text(encoding="utf-8").splitlines()[2:], [
                "replace example.com/exporter v0.0.0 => ../../exporter/x",
                "replace example.com/other => ../../../other",
                "replace example.com/y => example.com/y v1.0.0",
            ])

    def test_the_companion_ships_under_its_own_mit_license(self):
        self.assertEqual(build_bundle.COMPANION_LICENSE, "MIT")
        verdict = licenses.judge_files([build_bundle.COMPANION_LICENSE_FILE])[build_bundle.COMPANION_LICENSE_FILE]
        self.assertEqual((verdict.licenses, verdict.problem), (["MIT"], None))
        self.assertIn("Copyright (c) 2026 Valaris Studio", build_bundle.COMPANION_LICENSE_FILE.read_text(encoding="utf-8"))

    def test_beacon_self_updater_is_detected(self):
        clean = licenses.BuildInfo("go1.26.2", licenses.BEACON_PREFIX + "cli/beacon-hooks", [licenses.Module("golang.org/x/sys", "v1")])
        linked = licenses.BuildInfo("go1.26.2", "example.com/main", [licenses.Module(build_bundle.BEACON_UPDATER_MODULE, "v0")])
        main = licenses.BuildInfo("go1.26.2", build_bundle.BEACON_UPDATER_MODULE, [])
        self.assertFalse(build_bundle.links_beacon_updater(clean))
        self.assertTrue(build_bundle.links_beacon_updater(linked))
        self.assertTrue(build_bundle.links_beacon_updater(main))


class BuildTargetSigningTest(unittest.TestCase):
    """build_target with the Go builds and the license scan replaced, so only
    the order of signing, manifests and checksums is under test."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "LICENSE").write_text("MIT License\n", encoding="utf-8")
        (self.root / "go").mkdir()
        (self.root / "go" / "LICENSE").write_text("BSD\n", encoding="utf-8")
        self.seen_by_build_info = {}

        def built(path, name):
            path.write_bytes(b"unsigned " + name.encode("ascii"))
            return path

        def read_build_info(binary):
            self.seen_by_build_info[binary.name] = binary.read_bytes()
            return licenses.BuildInfo("go1.26.9", "example.com/" + binary.name)

        patches = [
            mock.patch.object(build_bundle, "build_companion", lambda stage, goos, *_: [built(stage / build_bundle.exe(goos, "backplane-companion"), "companion").name]),
            mock.patch.object(build_bundle, "build_hooks", lambda source, stage, goos, *_: built(stage / "beacon" / build_bundle.exe(goos, "beacon-hooks"), "hooks")),
            mock.patch.object(build_bundle, "build_otelcol", lambda source, stage, goos, *_: built(stage / "beacon" / build_bundle.exe(goos, "beacon-otelcol"), "otelcol")),
            mock.patch.object(licenses, "read_build_info", read_build_info),
            mock.patch.object(licenses, "inventory", lambda *_, **__: []),
            mock.patch.object(macos_signing.time, "sleep"),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def stale_archives(self, target):
        goos, goarch = target.split("/")
        dist = self.root / "dist"
        dist.mkdir(exist_ok=True)
        stale = [dist / f"backplane-companion-1.0.0-{goos}-{goarch}{suffix}" for suffix in (".tar.gz", ".zip")]
        for archive in stale:
            archive.write_bytes(b"from an earlier build")
        return stale

    def build(self, target, signing=None):
        spec = {"commit": "c" * 40, "archive_sha256": "a" * 64}
        return build_bundle.build_target(target, self.root / "dist", self.source, None, spec, "1.0.0", "d" * 40, False,
                                         self.root / "modcache", self.root / "go", signing=signing)

    def test_signed_darwin_manifests_record_the_signed_bytes(self):
        tools = FakeTools()
        signing = macos_signing.from_environment(ENVIRONMENT, notarize=True, system="Darwin")
        with mock.patch.object(macos_signing, "tool", tools):
            stage, manifest, notarization = self.build("darwin/arm64", signing)
        self.assertEqual(notarization["status"], "Accepted")
        for name in ("backplane-companion", "beacon-hooks", "beacon-otelcol"):
            self.assertTrue(self.seen_by_build_info[name].endswith(b"-signed"), name)
        for binary, beacon_manifest in (("beacon-hooks", "artifact.json"), ("beacon-otelcol", "otelcol.json")):
            recorded = json.loads((stage / "beacon" / beacon_manifest).read_text(encoding="utf-8"))["sha256"]
            self.assertEqual(recorded, bundle.sha256(stage / "beacon" / binary))
            self.assertTrue((stage / "beacon" / binary).read_bytes().endswith(b"-signed"))
        for component in manifest["components"]:
            self.assertEqual(component["sha256"], bundle.sha256(stage / component["path"]))
        self.assertEqual(bundle.verify_checksums(stage), [])

    def test_a_failed_signed_build_leaves_no_stale_archive(self):
        stale = self.stale_archives("darwin/arm64")
        signing = macos_signing.from_environment(ENVIRONMENT, notarize=True, system="Darwin")
        with mock.patch.object(macos_signing, "tool", FakeTools(status="Invalid")):
            with self.assertRaises(macos_signing.SigningError):
                self.build("darwin/arm64", signing)
        for archive in stale:
            self.assertFalse(archive.exists(), archive.name)

    def test_the_manifest_records_how_a_darwin_bundle_was_signed(self):
        notarized = macos_signing.from_environment(ENVIRONMENT, notarize=True, system="Darwin")
        signed_only = macos_signing.from_environment(ENVIRONMENT, notarize=False, system="Darwin")
        with mock.patch.object(macos_signing, "tool", FakeTools()):
            cases = [(notarized, {"signed": True, "notarization": {"id": SUBMISSION, "status": "Accepted"}}),
                     (signed_only, {"signed": True, "notarization": None}),
                     (None, {"signed": False, "notarization": None})]
            for signing, expected in cases:
                stage, manifest, _ = self.build("darwin/arm64", signing)
                self.assertEqual(manifest["macos_signing"], expected)
                self.assertEqual(json.loads((stage / bundle.MANIFEST).read_text(encoding="utf-8"))["macos_signing"], expected)
            _, linux, _ = self.build("linux/amd64", notarized)
        self.assertNotIn("macos_signing", linux)

    def test_signing_leaves_other_platforms_alone(self):
        tools = FakeTools()
        signing = macos_signing.from_environment(ENVIRONMENT, notarize=True, system="Darwin")
        with mock.patch.object(macos_signing, "tool", tools):
            stage, _, notarization = self.build("linux/amd64", signing)
        self.assertIsNone(notarization)
        self.assertEqual(tools.commands, [])
        self.assertEqual((stage / "beacon" / "beacon-hooks").read_bytes(), b"unsigned hooks")

    def test_an_unsigned_darwin_build_never_touches_the_binaries(self):
        with mock.patch.object(macos_signing, "tool", side_effect=AssertionError("no signing tool may run")):
            stage, _, notarization = self.build("darwin/amd64")
        self.assertIsNone(notarization)
        for path, content in (("backplane-companion", b"unsigned companion"), ("beacon/beacon-hooks", b"unsigned hooks"),
                              ("beacon/beacon-otelcol", b"unsigned otelcol")):
            self.assertEqual((stage / path).read_bytes(), content)
        self.assertEqual(bundle.verify_checksums(stage), [])


class SigningEnvironmentTest(unittest.TestCase):
    def test_no_child_process_sees_the_notary_credentials(self):
        with mock.patch.dict(os.environ, ENVIRONMENT):
            with mock.patch.object(macos_signing, "tool", FakeTools()), \
                    mock.patch.object(build_bundle.platform, "system", return_value="Darwin"):
                signing = build_bundle.macos_signing_for(["darwin/arm64", "linux/amd64"], notarize=True)
            self.assertEqual((signing.notary.key_id, signing.notary.issuer, signing.notary.p8), (KEY_ID, ISSUER, P8))
            dump = "import json, os; print(json.dumps(dict(os.environ)))"
            children = [build_bundle.run(sys.executable, "-c", dump),
                        build_bundle.run(sys.executable, "-c", dump, env=build_bundle.go_environment("darwin", "arm64")),
                        macos_signing.tool(sys.executable, "-c", dump).stdout]
        for seen in children:
            for value in (KEY_ID, ISSUER, P8_BASE64):
                self.assertNotIn(value, seen)
            self.assertFalse({"AC_API_KEY_ID", "AC_API_ISSUER", "AC_API_KEY_P8"} & json.loads(seen).keys())

    def test_signing_needs_a_darwin_target(self):
        with mock.patch.dict(os.environ, ENVIRONMENT):
            with self.assertRaisesRegex(build_bundle.BuildError, "darwin target"):
                build_bundle.macos_signing_for(["linux/amd64"], notarize=True)


@unittest.skipUnless(os.name == "posix", "SIGTERM delivery")
class TerminationTest(unittest.TestCase):
    def test_sigterm_during_notarization_deletes_the_key(self):
        program = f"""
import sys, tempfile, time
from pathlib import Path
sys.path.insert(0, {str(SCRIPTS)!r})
import build_bundle, macos_signing

def tool(*command):
    if command[:3] == ("xcrun", "notarytool", "submit"):
        print(command[command.index("--key") + 1], flush=True)
        time.sleep(60)
    raise AssertionError(command)

macos_signing.tool = tool
build_bundle.exit_on_termination()
signing = macos_signing.from_environment({ENVIRONMENT!r}, notarize=True, system="Darwin")
with tempfile.TemporaryDirectory() as directory:
    binary = Path(directory) / "backplane-companion"
    binary.write_bytes(b"signed")
    macos_signing.notarize([binary], signing)
"""
        process = subprocess.Popen([sys.executable, "-c", program], stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8")
        try:
            key = Path(process.stdout.readline().strip())
            self.assertTrue(key.is_file(), process.stderr.read() if not key.name else key)
            process.send_signal(signal.SIGTERM)
            process.wait(timeout=30)
        finally:
            if process.poll() is None:
                process.kill()
            process.stdout.close()
            process.stderr.close()
        self.assertEqual(process.returncode, 128 + signal.SIGTERM)
        self.assertFalse(key.exists())
        self.assertFalse(key.parent.exists())


if __name__ == "__main__":
    unittest.main()
