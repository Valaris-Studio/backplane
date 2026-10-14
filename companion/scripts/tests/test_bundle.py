# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import hashlib
import json
import os
import sys
import tarfile
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bundle  # noqa: E402
from licenses import Entry  # noqa: E402


def write(path, content, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    path.chmod(mode)
    return path


class BundleTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.stage = self.root / "backplane-companion-1.2.3-linux-amd64"
        write(self.stage / "backplane-companion", b"companion", 0o755)
        write(self.stage / "beacon" / "beacon-hooks", b"hooks", 0o755)
        write(self.stage / "beacon" / "artifact.json", b"{}")

    def tearDown(self):
        self.directory.cleanup()

    def test_checksums_cover_every_file_and_detect_tampering(self):
        sums = bundle.write_checksums(self.stage)
        self.assertEqual(sums["beacon/beacon-hooks"], hashlib.sha256(b"hooks").hexdigest())
        lines = (self.stage / "SHA256SUMS").read_text(encoding="utf-8").splitlines()
        self.assertEqual([line.split("  ", 1)[1] for line in lines], ["backplane-companion", "beacon/artifact.json", "beacon/beacon-hooks"])
        self.assertEqual(bundle.verify_checksums(self.stage), [])
        (self.stage / "beacon" / "beacon-hooks").write_bytes(b"changed")
        write(self.stage / "extra.txt", b"x")
        (self.stage / "beacon" / "artifact.json").unlink()
        self.assertEqual(sorted(bundle.verify_checksums(self.stage)), ["beacon/artifact.json: missing", "beacon/beacon-hooks: checksum mismatch", "extra.txt: not listed"])

    def test_licenses_are_copied_under_unique_flat_names(self):
        cache = self.root / "cache"
        mit = write(cache / "a" / "LICENSE", b"MIT text")
        notice = write(cache / "a" / "NOTICE", b"notice")
        other = write(cache / "b" / "LICENSE", b"BSD text")
        beacon_license = write(self.root / "beacon-LICENSE", b"Beacon MIT")
        entries = [
            Entry("example.com/a", "v1.0.0", ["Apache-2.0"], [mit, notice], ["backplane-companion"]),
            Entry("example.com/B/x", "v2.0.0", ["BSD-3-Clause"], [other], ["beacon-otelcol"]),
            Entry("github.com/asymptote-labs/agent-beacon/collector-builder/exporter/x", "(devel)", ["MIT"], [beacon_license], ["beacon-otelcol"]),
        ]
        placed = bundle.copy_licenses(entries, self.stage, {beacon_license: "LICENSES/beacon-MIT.txt"})
        self.assertEqual(placed[mit], "LICENSES/example.com_a@v1.0.0-LICENSE")
        self.assertEqual(placed[notice], "LICENSES/example.com_a@v1.0.0-NOTICE")
        self.assertEqual(placed[other], "LICENSES/example.com_B_x@v2.0.0-LICENSE")
        self.assertEqual(placed[beacon_license], "LICENSES/beacon-MIT.txt")
        self.assertEqual((self.stage / placed[notice]).read_bytes(), b"notice")
        self.assertFalse((self.stage / "LICENSES" / "beacon-MIT.txt").exists(), "a preset notice is written by its owner")

    def test_manifest_names_components_licenses_flags_and_files(self):
        lic = write(self.root / "LICENSE", b"MPL text")
        dual = write(self.root / "dual" / "LICENSE", b"MIT and Apache")
        entries = [
            Entry("example.com/mpl", "v1.0.0", ["MPL-2.0"], [lic], ["beacon-otelcol"]),
            Entry("gopkg.in/yaml.v3", "v3.0.1", ["MIT", "Apache-2.0"], [dual], ["backplane-companion"]),
        ]
        placed = {lic: "LICENSES/example.com_mpl@v1.0.0-LICENSE", dual: "LICENSES/gopkg.in_yaml.v3@v3.0.1-LICENSE"}
        components = [
            bundle.component(self.stage, "backplane-companion", "backplane-companion", "MIT", ["LICENSES/backplane-companion-MIT.txt"], version="1.2.3"),
            bundle.component(self.stage, "beacon-hooks", "beacon/beacon-hooks", "MIT", ["LICENSES/beacon-MIT.txt"], source_commit="b" * 40),
        ]
        manifest = bundle.manifest(
            version="1.2.3", commit="c" * 40, source_dirty=False, goos="linux", goarch="amd64", go_version="go1.26.2",
            components=components, entries=entries, placed=placed,
        )
        self.assertEqual(manifest["target"], {"goos": "linux", "goarch": "amd64"})
        self.assertEqual(manifest["components"][0]["sha256"], hashlib.sha256(b"companion").hexdigest())
        self.assertEqual(manifest["components"][1]["source_commit"], "b" * 40)
        self.assertEqual(manifest["third_party"], [{
            "module": "example.com/mpl", "version": "v1.0.0", "license": "MPL-2.0", "licenses": ["MPL-2.0"],
            "notices": ["LICENSES/example.com_mpl@v1.0.0-LICENSE"], "used_by": ["beacon-otelcol"],
        }, {
            "module": "gopkg.in/yaml.v3", "version": "v3.0.1", "license": "MIT AND Apache-2.0", "licenses": ["MIT", "Apache-2.0"],
            "notices": ["LICENSES/gopkg.in_yaml.v3@v3.0.1-LICENSE"], "used_by": ["backplane-companion"],
        }])
        self.assertEqual([flag["module"] for flag in manifest["license_flags"]], ["example.com/mpl"])
        json.dumps(manifest)

    def test_notices_list_every_module_with_its_text(self):
        lic = write(self.root / "LICENSE", b"Permission is hereby granted")
        entries = [Entry("example.com/a", "v1.0.0", ["MIT"], [lic], ["backplane-companion", "beacon-hooks"])]
        text = bundle.notices(["Header line"], entries, {lic: "LICENSES/example.com_a@v1.0.0-LICENSE"})
        self.assertTrue(text.startswith("Header line\n"))
        for want in ["example.com/a v1.0.0", "License: MIT", "Used by: backplane-companion, beacon-hooks", "Permission is hereby granted"]:
            self.assertIn(want, text)

    def test_archives_are_reproducible_and_keep_modes(self):
        first = bundle.archive(self.stage, self.root / "one", "linux")
        os.utime(self.stage / "backplane-companion", (time.time() + 1000, time.time() + 1000))
        second = bundle.archive(self.stage, self.root / "two", "linux")
        self.assertEqual(first.name, "backplane-companion-1.2.3-linux-amd64.tar.gz")
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with tarfile.open(first) as archive:
            member = archive.getmember("backplane-companion-1.2.3-linux-amd64/backplane-companion")
            self.assertEqual((member.mode, member.mtime, member.uid, member.uname), (0o755, 0, 0, ""))
        windows = bundle.archive(self.stage, self.root / "three", "windows")
        again = bundle.archive(self.stage, self.root / "four", "windows")
        self.assertEqual(windows.suffix, ".zip")
        self.assertEqual(windows.read_bytes(), again.read_bytes())
        with zipfile.ZipFile(windows) as archive:
            self.assertIn("backplane-companion-1.2.3-linux-amd64/beacon/artifact.json", archive.namelist())


if __name__ == "__main__":
    unittest.main()
