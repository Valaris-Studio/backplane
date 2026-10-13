# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""Builds the host bundle end to end, so it is opt-in: it needs the Go
toolchain, the module cache (or network) and a few minutes.

    BACKPLANE_BUNDLE_TEST=1 [BACKPLANE_BEACON_ARCHIVE=beacon.tar.gz] \\
        python3 -m unittest discover -s scripts/tests
"""

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import bundle  # noqa: E402
import licenses  # noqa: E402

VERSION = "0.0.0-bundle-test"


@unittest.skipUnless(os.environ.get("BACKPLANE_BUNDLE_TEST") == "1", "set BACKPLANE_BUNDLE_TEST=1 to build the host bundle")
class HostBundleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="backplane-bundle-test-")
        output = Path(cls.directory.name) / "dist"
        command = [sys.executable, str(SCRIPTS / "build_bundle.py"), "--output", str(output), "--target", "host", "--version", VERSION]
        if os.environ.get("BACKPLANE_BEACON_ARCHIVE"):
            command += ["--beacon-archive", os.environ["BACKPLANE_BEACON_ARCHIVE"]]
        result = json.loads(subprocess.run(command, check=True, capture_output=True, encoding="utf-8", timeout=1800).stdout)
        (cls.target, built), = result.items()
        cls.stage = Path(built["bundle"])
        cls.archive = Path(built["archive"])
        cls.executable = cls.stage / ("backplane-companion.exe" if cls.target.startswith("windows/") else "backplane-companion")
        # No BACKPLANE_* variable: the bundle must find its own artifacts.
        cls.environment = {"PATH": os.environ.get("PATH", ""), "HOME": str(Path(cls.directory.name) / "home"), "LANG": "en_US.UTF-8"}
        for key in ("SYSTEMROOT", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA"):
            if key in os.environ:
                cls.environment[key] = os.environ[key]

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_checksums_and_manifest_describe_the_bundle(self):
        self.assertEqual(bundle.verify_checksums(self.stage), [])
        self.assertTrue(self.archive.is_file())
        manifest = json.loads((self.stage / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["version"], VERSION)
        self.assertEqual(f"{manifest['target']['goos']}/{manifest['target']['goarch']}", self.target)
        for component in manifest["components"]:
            self.assertEqual(component["sha256"], bundle.sha256(self.stage / component["path"]), component["name"])
            for notice in component["notices"]:
                self.assertTrue((self.stage / notice).is_file(), notice)
        self.assertGreater(len(manifest["third_party"]), 0)
        for module in manifest["third_party"]:
            for notice in module["notices"]:
                self.assertTrue((self.stage / notice).is_file(), notice)
        self.assertIn("THIRD_PARTY_NOTICES.txt", (self.stage / "SHA256SUMS").read_text(encoding="utf-8"))
        companion = next(component for component in manifest["components"] if component["name"] == "backplane-companion")
        self.assertEqual(companion["license"], "MIT")
        own_license = self.stage / companion["notices"][0]
        self.assertEqual(licenses.judge_files([own_license])[own_license].licenses, ["MIT"])
        self.assertIn("Valaris Studio", own_license.read_text(encoding="utf-8"))
        self.assertIn("backplane-companion: MIT", (self.stage / "THIRD_PARTY_NOTICES.txt").read_text(encoding="utf-8"))

    def test_version_reports_the_stamp_and_the_bundled_artifacts(self):
        output = subprocess.run([str(self.executable), "version"], check=True, capture_output=True, encoding="utf-8", env=self.environment, timeout=60)
        report = json.loads(output.stdout)
        self.assertEqual(report["version"], VERSION)
        self.assertEqual(len(report["commit"]), 40)
        for name, manifest in [("beacon_hooks", "artifact.json"), ("beacon_otelcol", "otelcol.json")]:
            artifact = report["artifacts"][name]
            self.assertTrue(artifact["verified"], artifact)
            self.assertEqual(Path(artifact["manifest"]).resolve(), (self.stage / "beacon" / manifest).resolve())

    def test_run_finds_the_bundled_artifacts_without_environment(self):
        data = Path(self.directory.name) / "data"
        log = Path(self.directory.name) / "run.log"
        # A fresh data directory holds no installation, so the keyring is never read.
        process = subprocess.Popen([str(self.executable), "run", "--data-dir", str(data), "--log", str(log)],
                                   env=self.environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and "not_connected" not in (log.read_text(encoding="utf-8") if log.exists() else ""):
                time.sleep(0.1)
        finally:
            process.send_signal(signal.SIGTERM if hasattr(signal, "SIGTERM") else signal.CTRL_BREAK_EVENT)
            process.wait(timeout=30)
        text = log.read_text(encoding="utf-8")
        self.assertIn("not_connected", text)
        for name, manifest in [("beacon_hooks", "artifact.json"), ("beacon_otelcol", "otelcol.json")]:
            self.assertIn(f"{name} verified ", text)
            line = next(line for line in text.splitlines() if f"{name} verified " in line)
            self.assertEqual(Path(line.split(" verified ", 1)[1].split(" sha256:", 1)[0]).resolve(), (self.stage / "beacon" / manifest).resolve())


if __name__ == "__main__":
    unittest.main()
